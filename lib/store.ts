import {jobCategory,jobModel} from './model-catalog';
import {validateProxyUrl,type KaggleCredential} from './proxy';
import {and,eq,isNull} from 'drizzle-orm';
import {accounts,jobs} from './db/schema';
import {env,storage} from './node-runtime';
import { verifyAccount } from "./kaggle";
import { resourcesCacheKey } from "./resources";
import { persistVerifiedAccount } from "./account-persistence";
export type Account = typeof accounts.$inferSelect;
export type Job = { category?:string;model_id?:string;artifact_mime?:string|null; session_id?:string|null;claim_token?:string|null;artifact_key?:string|null;artifact_sha?:string|null;artifact_bytes?:number|null; id: string; owner: string; account_id: string; account_name: string; username: string; params: string; status: string; kernel_ref: string; version: number | null; kernel_session_id: number | null; control_hash: string | null; stop_requested_at: number | null; created_at: number; updated_at: number; stage: string; step: number; total_steps: number; error: string | null; metadata: string | null; sync_lease: number };
export const ACTIVE = ["submitting", "queued", "running", "submission_unknown"];
export function db() { if (!env.DB) throw new Error("数据库尚未配置。"); return env.DB; }
async function key() {
  const secret = env.KAGGLE_CIPHER_KEY;
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) throw new Error("密钥加密服务尚未配置。");
  const bytes = Uint8Array.from(secret.match(/../g)!, x => parseInt(x,16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt","decrypt"]);
}
const b64 = (bytes: Uint8Array) => btoa(Array.from(bytes, n => String.fromCharCode(n)).join(""));
const unb64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function encrypt(token: string) { const iv = crypto.getRandomValues(new Uint8Array(12)); const data = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, await key(), new TextEncoder().encode(token)); return b64(iv) + "." + b64(new Uint8Array(data)); }
export async function decrypt(value: string) { const [iv,data] = value.split("."); return new TextDecoder().decode(await crypto.subtle.decrypt({ name:"AES-GCM", iv: unb64(iv) }, await key(), unb64(data))); }
export const proxySettingKey=(owner:string,id:string)=>`account-proxy:${owner}:${id}`;
export async function accountCredential(a:Account):Promise<KaggleCredential>{const token=await decrypt(a.cipher);const setting=await db().prepare('SELECT value FROM settings WHERE id=?').bind(proxySettingKey(a.owner,a.id)).first<{value:string}>();if(!setting)return token;let value;try{value=JSON.parse(await decrypt(setting.value));}catch{throw Error('代理配置无法解密，已停止请求。');}return {token,proxyUrl:validateProxyUrl(value.url)};}
export async function saveAccount(owner: string, name: string, token: string, manualUsername = "",proxyUrl?:string) {
  let connection:KaggleCredential=token;
  if(proxyUrl)connection={token,proxyUrl:validateProxyUrl(proxyUrl)};
  else if(manualUsername){const old=await db().prepare('SELECT * FROM accounts WHERE owner=? AND username=? AND deleted_at IS NULL').bind(owner,manualUsername.toLowerCase()).first<Account>();if(old){const c=await accountCredential(old);if(typeof c!=='string')connection={...c,token};}}
  else if(await db().prepare("SELECT id FROM settings WHERE id LIKE ? LIMIT 1").bind(`account-proxy:${owner}:%`).first())throw Error('工作室已使用账户代理，请填写Kaggle用户名或代理地址，避免身份验证误用直连。');
  const username = await verifyAccount(connection, manualUsername); const cipher = await encrypt(token); const now = Date.now();
  const id=await persistVerifiedAccount(db(),owner,username,name,cipher,token.slice(-4),now,proxyUrl?await encrypt(JSON.stringify({url:validateProxyUrl(proxyUrl)})):undefined);
  await db().prepare("DELETE FROM settings WHERE id=?").bind(resourcesCacheKey(owner,id)).run();
  return id;
}
export async function bootstrap(owner: string) {
  if (!env.BOOTSTRAP_KAGGLE_TOKEN || !env.BOOTSTRAP_OWNER_ID || owner!==env.BOOTSTRAP_OWNER_ID) return;
  const flag = `bootstrap:${owner}`;
  if (await db().prepare("SELECT id FROM settings WHERE id=?").bind(flag).first()) return;
  const accountId = await saveAccount(owner, "主账户", env.BOOTSTRAP_KAGGLE_TOKEN, env.BOOTSTRAP_KAGGLE_USERNAME || "");
  if (env.BOOTSTRAP_JOB_JSON) {
    const seed = JSON.parse(env.BOOTSTRAP_JOB_JSON);
    const a = await account(owner,accountId);
    if (a && typeof seed.id === "string" && typeof seed.kernelRef === "string" && seed.kernelRef.startsWith(a.username+"/")) {
      await db().prepare("INSERT OR IGNORE INTO jobs(id,owner,account_id,account_name,username,params,status,kernel_ref,version,created_at,updated_at,stage,total_steps) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?)").bind(seed.id,owner,accountId,"主账户",a.username,JSON.stringify(seed.params),seed.kernelRef,seed.version,seed.createdAt,Date.now(),"读取已有测试任务",20).run();
    }
  }
  await db().prepare("INSERT OR IGNORE INTO settings(id,value) VALUES(?,?)").bind(flag,"done").run();
}
export async function account(owner: string, id: string) {
  const database=storage();
  if (!database.orm) {
    return db().prepare('SELECT * FROM accounts WHERE owner=? AND id=? AND deleted_at IS NULL').bind(owner,id).first<Account>();
  }
  await database.ready;
  const [row]=await database.orm.select().from(accounts)
    .where(and(eq(accounts.owner,owner),eq(accounts.id,id),isNull(accounts.deleted_at))).limit(1);
  return row??null;
}
export async function job(owner: string, id: string): Promise<Job|null> {
  const database=storage();
  if (!database.orm) return db().prepare('SELECT * FROM jobs WHERE owner=? AND id=?').bind(owner,id).first<Job>();
  await database.ready;
  const [row]=await database.orm.select().from(jobs).where(and(eq(jobs.owner,owner),eq(jobs.id,id))).limit(1);
  return row??null;
}
export function jobView(j: Job) { return { id:j.id,category:jobCategory(j),modelId:jobModel(j),artifactMime:j.artifact_mime||(jobCategory(j)==='image'?'image/png':'video/mp4'),accountId:j.account_id,accountName:j.account_name,username:j.username,params:JSON.parse(j.params),status:j.status,kernelRef:j.kernel_ref,version:j.version,kernelSessionId:j.kernel_session_id,sessionId:j.session_id||null,canStop:!!(j.session_id||j.kernel_session_id||j.control_hash),stopRequestedAt:j.stop_requested_at,createdAt:j.created_at,updatedAt:j.updated_at,stage:j.stage,step:j.step,totalSteps:j.total_steps,error:j.error,metadata:j.metadata ? JSON.parse(j.metadata) : null }; }
