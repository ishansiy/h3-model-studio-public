import { generationInput, UUID } from './generation-api';
import { IntegrationError } from './integration-api';
import type { GenerationParams } from './model-catalog';
import { resourcesCacheKey, type AccountResources } from './resources';
import { enqueue } from './session-queue';
import type { Job } from './store';

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
  last_assigned_at: number | null;
  resources: string | null;
};

function temporarilyUnavailable(raw: string | null, now: number) {
  if (!raw) return false;
  try {
    const resources = JSON.parse(raw) as AccountResources;
    const age = now - resources.checkedAt;
    if (!Number.isFinite(age) || age < 0 || age > 120_000) return false;
    if (resources.status === 'invalid') return true;
    const quota = resources.quotas?.find(item => item.resource === 'GPU');
    return quota?.remainingHours === 0 && (!quota.refreshAt || Date.parse(quota.refreshAt) > now);
  } catch {
    return false;
  }
}

async function autoAccount(d: QueueStorage, owner: string, params: GenerationParams, now: number) {
  const { results } = await d.prepare(`SELECT a.id,a.name,a.username,s.id AS session_id,s.status AS session_status,
    s.model_id AS session_model,s.profile AS session_profile,s.expires_at,s.stop_requested_at,
    (SELECT count(*) FROM jobs j WHERE j.session_id=s.id AND j.status IN ('queued','running')) AS pending,
    EXISTS(SELECT 1 FROM jobs j WHERE j.owner=a.owner AND j.account_id=a.id AND j.session_id IS NULL
      AND j.status IN ('submitting','submission_unknown','queued','running')) AS legacy_busy,
    (SELECT j.created_at FROM jobs j WHERE j.owner=a.owner AND j.account_id=a.id ORDER BY j.created_at DESC LIMIT 1) AS last_assigned_at,
    r.value AS resources
    FROM accounts a
    LEFT JOIN gpu_sessions s ON s.owner=a.owner AND s.account_id=a.id AND s.status NOT IN ('completed','failed')
    LEFT JOIN settings r ON r.id=?||a.id
    WHERE a.owner=? AND a.deleted_at IS NULL`).bind(resourcesCacheKey(owner,''), owner).all<Candidate>();

  if (!results.length) throw new IntegrationError('请先接入一个 Kaggle 计算账户。',409,'no_available_account');
  const candidates = results.filter(row => {
    if (row.legacy_busy || temporarilyUnavailable(row.resources, now)) return false;
    if (!row.session_id) return true;
    return ['active','queued','submitting'].includes(row.session_status ?? '') &&
      row.stop_requested_at === null && Number(row.expires_at) - now >= 600_000 &&
      row.session_model === params.modelId && row.session_profile === (params.runtimeProfile || 'standard') &&
      Number(row.pending) < 20;
  });

  const priority = (row: Candidate) => !row.session_id ? 1 : Number(row.pending) === 0 ? 0 : 2;
  const account = candidates.sort((a,b) => priority(a) - priority(b) ||
    Number(a.pending) - Number(b.pending) ||
    Number(a.last_assigned_at ?? 0) - Number(b.last_assigned_at ?? 0) || a.id.localeCompare(b.id))[0];
  if (!account) throw new IntegrationError('暂无可分配的计算账户。请在「计算资源」检查账户权限、额度和会话状态。',409,'no_available_account');
  return account;
}

// 调用方在同一事务内完成挑选和入队，提交 Kaggle 在事务结束后执行。
export async function queueGeneration(d: QueueStorage, owner: string, input: unknown, now = Date.now()) {
  const id = input && typeof input === 'object' && 'requestId' in input && typeof input.requestId === 'string' && UUID.test(input.requestId)
    ? input.requestId : null;
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
