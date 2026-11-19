import type {KaggleCredential} from './proxy';
import { kaggle, verifyAccount, KaggleError, cleanError } from "./kaggle";

export type ResourceQuota = { resource:"GPU"|"TPU"; usedHours:number; remainingHours:number; totalHours:number; reservedHours:number|null; extended:boolean; refreshAt:string|null };
export type AccountResources = { status:"connected"|"invalid"|"unavailable"; checkedAt:number; quotas:ResourceQuota[]; error:string|null; quotaError:string|null };
export const resourcesCacheKey = (owner:string,id:string) => `account-resources:${owner}:${id}`;

function durationHours(value:unknown):number|null {
  if (!value || typeof value !== "object") return null;
  const v=value as {seconds?:unknown;nanos?:unknown};
  const seconds=Number(v.seconds ?? 0), nanos=Number(v.nanos ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds<0 || nanos<0 || nanos>=1e9) return null;
  return (seconds+nanos/1e9)/3600;
}
export function parseQuotas(data:any):ResourceQuota[] {
  const date=typeof data?.quotaRefreshTime === "string" && Number.isFinite(Date.parse(data.quotaRefreshTime)) ? new Date(data.quotaRefreshTime).toISOString() : null;
  return (["GPU","TPU"] as const).flatMap(resource=>{
    const row=data?.[resource === "GPU" ? "gpuQuota" : "tpuQuota"];
    if (!row) return [];
    const used=durationHours(row.timeUsed), total=durationHours(row.totalTimeAllowed);
    if (used === null || total === null) return [];
    return [{resource,usedHours:used,totalHours:total,remainingHours:Math.max(0,total-used),reservedHours:durationHours(row.timeReserved),extended:row.isPayToScaleEnabled === true,refreshAt:date}];
  });
}
export async function queryAccountResources(token:KaggleCredential,username:string):Promise<AccountResources> {
  const value:AccountResources={status:"connected",checkedAt:Date.now(),quotas:[],error:null,quotaError:null};
  try { await verifyAccount(token,username); }
  catch(e) {
    value.status=e instanceof KaggleError && [401,403].includes(e.status) ? "invalid" : "unavailable";
    value.error=cleanError(e); return value;
  }
  try {
    value.quotas=parseQuotas(await kaggle(token,"quota"));
    if (!value.quotas.length) value.quotaError="Kaggle 未提供额度数据，请在账户设置中确认计算权限。";
  } catch(e) {
    value.quotaError=e instanceof KaggleError && [401,403].includes(e.status)
      ? "账户已验证，但无法读取计算额度。请在 Kaggle 确认权限及账户验证状态。"
      : "额度暂时查询失败，请稍后刷新。";
  }
  value.checkedAt=Date.now();
  return value;
}
