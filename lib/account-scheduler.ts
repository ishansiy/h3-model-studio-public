import {generationImages,sessionImageInputsKey} from './generation-inputs';
import {hyperFlowFastSessionKey,usesHyperFlowFastPreset} from './hyperflow-config';
import { generationInput, UUID } from './generation-api';
import { cachedAccountResources, getAccountResources } from './account-resources';
import { createGenerationBudget, type TimingRow } from './generation-budget';
import { IntegrationError } from './integration-api';
import type { GenerationParams } from './model-catalog';
import { resourcesCacheKey } from './resources';
import { enqueue } from './session-queue';
import { account, db, type Job } from './store';

type QueueStorage = Pick<D1Database, 'prepare'>;
type QueueAccount = { id: string; name: string; username: string };
type Candidate = QueueAccount & {
  session_id: string | null;
  session_status: string | null;
  session_model: string | null;
  session_profile: string | null;
  expires_at: number | null;
  stop_requested_at: number | null;
  pending: number;
  legacy_busy: number | boolean;
  session_warm: number | boolean;
  supports_image_inputs: string | null;
  supports_hyperflow_fast: string | null;
  last_assigned_at: number | null;
  resources: string | null;
};

async function accountCandidates(d: QueueStorage, owner: string) {
  const { results } = await d.prepare(`SELECT a.id,a.name,a.username,s.id AS session_id,s.status AS session_status,
    s.model_id AS session_model,s.profile AS session_profile,s.expires_at,s.stop_requested_at,
    (SELECT count(*) FROM jobs j WHERE j.session_id=s.id AND j.status IN ('queued','running')) AS pending,
    EXISTS(SELECT 1 FROM jobs j WHERE j.session_id=s.id AND j.status='completed') AS session_warm,
    EXISTS(SELECT 1 FROM jobs j WHERE j.owner=a.owner AND j.account_id=a.id AND j.session_id IS NULL
      AND j.status IN ('submitting','submission_unknown','queued','running')) AS legacy_busy,
    (SELECT j.created_at FROM jobs j WHERE j.owner=a.owner AND j.account_id=a.id ORDER BY j.created_at DESC LIMIT 1) AS last_assigned_at,
    r.value AS resources, cap.value AS supports_image_inputs, fast.value AS supports_hyperflow_fast
    FROM accounts a
    LEFT JOIN gpu_sessions s ON s.owner=a.owner AND s.account_id=a.id AND s.status NOT IN ('completed','failed')
    LEFT JOIN settings r ON r.id=?||a.id
    LEFT JOIN settings cap ON cap.id=?||s.id
    LEFT JOIN settings fast ON fast.id=?||s.id
    WHERE a.owner=? AND a.deleted_at IS NULL`).bind(resourcesCacheKey(owner,''), sessionImageInputsKey(''), hyperFlowFastSessionKey(''), owner).all<Candidate>();

  return results;
}

function isCompatible(row: Candidate, params: GenerationParams, now: number) {
  return !row.legacy_busy && (!row.session_id ||
    (['active','queued','submitting'].includes(row.session_status ?? '') &&
    row.stop_requested_at === null && Number(row.expires_at) - now >= 600_000 &&
    row.session_model === params.modelId && row.session_profile === (params.runtimeProfile || 'standard') &&
    Number(row.pending) < 20 && (!generationImages(params).length || row.supports_image_inputs === '1') &&
    (!usesHyperFlowFastPreset(params) || row.supports_hyperflow_fast === '1')));
}

export async function refreshSchedulingResources(owner: string, input: unknown) {
  const d = db();
  const id = requestId(input);
  if (id && await d.prepare('SELECT id FROM jobs WHERE owner=? AND id=?').bind(owner, id).first()) return;
  const params = generationInput(input);
  if (params.accountId) return;
  const now = Date.now();
  const candidates = (await accountCandidates(d, owner))
    .filter(row => isCompatible(row, params, now) && !cachedAccountResources(row.resources, now));
  await Promise.allSettled(candidates.map(async row => {
    const stored = await account(owner, row.id);
    if (stored) await getAccountResources(stored);
  }));
}

async function autoAccount(d: QueueStorage, owner: string, params: GenerationParams, now: number) {
  const results = await accountCandidates(d, owner);
  if (!results.length) throw new IntegrationError('请先接入一个 Kaggle 计算账户。',409,'no_available_account');
  const compatible = results.filter(row => isCompatible(row, params, now));
  if (!compatible.length) {
    throw new IntegrationError('暂无匹配的空闲账号或 GPU 会话。',409,'no_available_account');
  }
  const { results: history } = await d.prepare("SELECT params,metadata FROM jobs WHERE owner=? AND model_id=? AND status='completed' AND artifact_key IS NOT NULL AND metadata IS NOT NULL ORDER BY updated_at DESC LIMIT 60")
    .bind(owner, params.modelId).all<TimingRow>();
  const estimate = createGenerationBudget(history);
  const { results: pending } = await d.prepare("SELECT session_id,params FROM jobs WHERE owner=? AND model_id=? AND session_id IS NOT NULL AND status IN ('queued','running')")
    .bind(owner, params.modelId).all<{session_id: string; params: string}>();
  const booked = new Map<string, number>();
  for (const job of pending) {
    const p = JSON.parse(job.params) as GenerationParams;
    booked.set(job.session_id, (booked.get(job.session_id) ?? 0) + estimate(p, false));
  }

  let readable = false;
  const candidates = compatible.flatMap(row => {
    const resources = cachedAccountResources(row.resources, now);
    if (resources?.status !== 'connected') return [];
    const gpu = resources.quotas?.find(quota => quota.resource === 'GPU');
    if (!gpu || !Number.isFinite(gpu.remainingHours) || gpu.remainingHours < 0) return [];
    readable = true;
    const remaining = gpu.remainingHours * 3600 - (now - resources.checkedAt) / 1000;
    const reserved = row.session_id ? booked.get(row.session_id) ?? 0 : 0;
    const needed = reserved + estimate(params, !row.session_warm);
    const remainingSession = row.expires_at ? (Number(row.expires_at) - now) / 1000 - 600 : Infinity;
    return remaining >= needed && remainingSession >= needed ? [{ ...row, reserved }] : [];
  });

  const priority = (row: Candidate) => !row.session_id ? 1 : Number(row.pending) === 0 ? 0 : 2;
  const account = candidates.sort((a,b) => priority(a) - priority(b) ||
    a.reserved - b.reserved || Number(a.pending) - Number(b.pending) ||
    Number(a.last_assigned_at ?? 0) - Number(b.last_assigned_at ?? 0) || a.id.localeCompare(b.id))[0];
  if (!account) {
    if (!readable) throw new IntegrationError('暂时无法确认可用账号的 GPU 额度，请在「计算资源」刷新额度后重试。',409,'gpu_quota_unavailable');
    throw new IntegrationError('没有账号的剩余 GPU 时间或会话时间能覆盖本次任务和现有队列的预估耗时。',409,'insufficient_gpu_time');
  }
  return account;
}

// 调用方在同一事务内完成挑选和入队，提交 Kaggle 在事务结束后执行。
function requestId(input: unknown) {
  return input && typeof input === 'object' && 'requestId' in input && typeof input.requestId === 'string' && UUID.test(input.requestId)
    ? input.requestId : null;
}

export async function queueGeneration(d: QueueStorage, owner: string, input: unknown, now = Date.now()) {
  const id = requestId(input);
  const existing = id
    ? await d.prepare('SELECT * FROM jobs WHERE owner=? AND id=?').bind(owner,id).first<Job>()
    : null;
  const params = generationInput(input, existing ? { accountId:existing.account_id, params:JSON.parse(existing.params) } : undefined);
  if (existing) return { row: existing, replayed: true, launch: null, session: null };

  const pick = params.accountId
    ? await d.prepare('SELECT id,name,username FROM accounts WHERE owner=? AND id=? AND deleted_at IS NULL').bind(owner,params.accountId).first<QueueAccount>()
    : await autoAccount(d, owner, params, now);
  if (!pick) throw new IntegrationError('请选择已连接的 Kaggle 账户。',404,'not_found');
  const result = await enqueue(d, owner, pick, params.requestId, params, now);
  return { ...result, replayed: false };
}
