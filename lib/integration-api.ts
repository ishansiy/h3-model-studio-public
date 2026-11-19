export const KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const KEY_LIMIT = 5;
export const REQUESTS_PER_MINUTE = 20;
export const API_SCOPES=["accounts:read","accounts:write","models:read","jobs:read","jobs:write"] as const;
export const LEGACY_SCOPES="accounts:read accounts:write";
export function parseScopes(value:unknown):string{
 if(value===undefined)return LEGACY_SCOPES;
 if(!Array.isArray(value)||!value.length||value.some(s=>!API_SCOPES.includes(s)))throw new IntegrationError("请选择有效的 API 权限。",400,"invalid_scopes");
 return [...new Set(value)].sort().join(" ");
}
type KeyRow = {scopes?:string;id:string;owner:string;name:string;hint:string;created_at:number;expires_at:number;revoked_at:number|null;last_used_at:number|null};
export type ConnectedAccount = {id:string;name:string;username:string;hint:string;created_at:number};
export class IntegrationError extends Error { constructor(message:string,public status:number,public code:string){super(message);} }
const hex=(v:Uint8Array)=>Array.from(v,n=>n.toString(16).padStart(2,"0")).join("");
export async function keyHash(value:string){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))));}
export function newIntegrationToken(){return "H3AK_"+hex(crypto.getRandomValues(new Uint8Array(32)));}
export function keyView(row:KeyRow){return {id:row.id,name:row.name,hint:row.hint,createdAt:row.created_at,expiresAt:row.expires_at,lastUsedAt:row.last_used_at,scope:row.scopes||LEGACY_SCOPES};}
export async function listIntegrationKeys(database:D1Database,owner:string,now=Date.now()){
  const rows=await database.prepare("SELECT id,owner,name,hint,created_at,expires_at,revoked_at,last_used_at,scopes FROM integration_keys WHERE owner=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC").bind(owner,now).all<KeyRow>();
  return rows.results.map(keyView);
}
export async function createIntegrationKey(database:D1Database,owner:string,name:string,now=Date.now(),requestedScopes?:unknown){
  const scopes=parseScopes(requestedScopes);
  const token=newIntegrationToken(),id=crypto.randomUUID(),hash=await keyHash(token);
  const result=await database.prepare("INSERT INTO integration_keys(id,owner,name,hash,hint,created_at,expires_at,scopes) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM integration_keys WHERE owner=? AND revoked_at IS NULL AND expires_at>?)<?")
    .bind(id,owner,name.trim().slice(0,40)||"账户接入脚本",hash,token.slice(-6),now,now+KEY_LIFETIME_MS,scopes,owner,now,KEY_LIMIT).run();
  if(!result.meta.changes)throw new IntegrationError("最多保留 5 个有效 API 密钥，请先撤销不再使用的密钥。",409,"key_limit");
  return {token,key:{id,name:name.trim().slice(0,40)||"账户接入脚本",hint:token.slice(-6),createdAt:now,expiresAt:now+KEY_LIFETIME_MS,lastUsedAt:null,scope:scopes}};
}
export async function revokeIntegrationKey(database:D1Database,owner:string,id:string,now=Date.now()){
  const result=await database.prepare("UPDATE integration_keys SET revoked_at=? WHERE owner=? AND id=? AND revoked_at IS NULL").bind(now,owner,id).run();
  if(!result.meta.changes)throw new IntegrationError("API 密钥不存在或已撤销。",404,"key_not_found");
}
export async function authenticateIntegration(request:Request,database:D1Database,now=Date.now(),requiredScope?:string){
  const header=request.headers.get("Authorization")||"";
  if(!/^Bearer H3AK_[0-9a-f]{64}$/.test(header))throw new IntegrationError("请使用工作室 API 密钥作为 Bearer Token。",401,"invalid_api_key");
  const hash=await keyHash(header.slice(7)),window=Math.floor(now/60000);
  // 单条更新同时校验撤销/到期并计数，多个 Worker 的并发请求不能绕过限流。
  const row=await database.prepare("UPDATE integration_keys SET last_used_at=?,rate_count=CASE WHEN rate_window=? THEN rate_count+1 ELSE 1 END,rate_window=? WHERE hash=? AND revoked_at IS NULL AND expires_at>? RETURNING owner,rate_count,scopes")
    .bind(now,window,window,hash,now).first<{owner:string;rate_count:number;scopes?:string}>();
  if(!row)throw new IntegrationError("API 密钥无效、已过期或已撤销。",401,"invalid_api_key");
  if(row.rate_count>REQUESTS_PER_MINUTE)throw new IntegrationError("请求过于频繁，每个密钥每分钟最多 20 次。",429,"rate_limited");
  if(requiredScope&&!(row.scopes||LEGACY_SCOPES).split(" ").includes(requiredScope))throw new IntegrationError("此 API 密钥缺少所需权限。",403,"insufficient_scope");
  return row.owner;
}
export async function readSmallJson(request:Request,maxBytes=8192){
  if(request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase()!=="application/json")throw new IntegrationError("请使用 application/json。",415,"invalid_content_type");
  if(Number(request.headers.get("Content-Length"))>maxBytes)throw new IntegrationError("请求内容过大。",413,"body_too_large");
  const reader=request.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
  if(reader){try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>maxBytes){await reader.cancel();throw new IntegrationError("请求内容过大。",413,"body_too_large");}chunks.push(part.value);}}finally{reader.releaseLock();}}
  const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new IntegrationError("JSON 格式无效。",400,"invalid_json");}
}
export function accountInput(value:unknown){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new IntegrationError("请提交账户信息。",400,"invalid_account");
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!["name","token","username"].includes(k)))throw new IntegrationError("仅支持 name、token 和可选 username 字段。",400,"invalid_account");
  if(typeof v.token!=="string"||!/^KGAT_[\w-]{16,512}$/.test(v.token.trim()))throw new IntegrationError("请输入有效的 Kaggle API Token。",400,"invalid_account");
  if(v.name!==undefined&&(typeof v.name!=="string"||v.name.length>40))throw new IntegrationError("账户名称最多 40 个字符。",400,"invalid_account");
  if(v.username!==undefined&&(typeof v.username!=="string"||!/^[a-zA-Z0-9_-]{2,64}$/.test(v.username)))throw new IntegrationError("用户名格式无效。",400,"invalid_account");
  return {name:typeof v.name==="string"?v.name:"",token:v.token.trim(),username:typeof v.username==="string"?v.username:""};
}
type Dependencies={database:D1Database;workspaceOwner?:string;list:(owner:string)=>Promise<ConnectedAccount[]>;save:(owner:string,input:ReturnType<typeof accountInput>)=>Promise<ConnectedAccount>};
export async function handleAccountIntegration(request:Request,deps:Dependencies){
  const reply=(data:unknown,status=200,extra:Record<string,string>={})=>Response.json(data,{status,headers:{"Cache-Control":"no-store",...extra}});
  try{
    if(!["GET","POST"].includes(request.method))return reply({error:"只支持 GET 与 POST。",code:"method_not_allowed"},405,{Allow:"GET, POST"});
    // API 专用认证不接受访问密码、浏览器 cookie 或调用者指定的 owner。
    const owner=await authenticateIntegration(request,deps.database,Date.now(),request.method==="GET"?"accounts:read":"accounts:write");
    if(deps.workspaceOwner&&owner!==deps.workspaceOwner)throw new IntegrationError("API 密钥不属于当前工作室。",401,"invalid_api_key");
    if(request.method==="GET")return reply({accounts:await deps.list(owner)});
    const input=accountInput(await readSmallJson(request));
    return reply({account:await deps.save(owner,input)},200);
  }catch(error){
    if(error instanceof IntegrationError)return reply({error:error.message,code:error.code},error.status,error.status===429?{"Retry-After":String(60-Math.floor(Date.now()/1000)%60)}:{});
    // 下游错误不能回显提交的密钥、密文、异常调用栈或其他账户资料。
    return reply({error:"账户验证或保存失败，请检查 Kaggle Token、用户名与账户数量后重试。",code:"account_verification_failed"},400);
  }
}
