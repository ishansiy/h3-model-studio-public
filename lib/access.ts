// 单人工作室只需密码会话；账户与任务沿用固定的原主人数据空间。
export const ACCESS_COOKIE = "h3_site_access";
export const ACCESS_SECONDS = 24 * 60 * 60;
const ITERATIONS = 100_000;
const encode = (value:string) => new TextEncoder().encode(value);
const hex = (value:ArrayBuffer|Uint8Array) => Array.from(new Uint8Array(value instanceof Uint8Array ? value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength) as ArrayBuffer : value),n=>n.toString(16).padStart(2,"0")).join("");
const bytes = (value:string) => Uint8Array.from(value.match(/../g) || [],n=>parseInt(n,16));
export type AccessConfig = {verifier?:string;sessionSecret?:string};
export function accessConfigured(config:AccessConfig):boolean {
  return /^v1:[0-9a-f]{64}:[0-9a-f]{64}$/.test(config.verifier || "") && /^[0-9a-f]{64}$/.test(config.sessionSecret || "");
}
export async function passwordVerifier(password:string,salt=crypto.getRandomValues(new Uint8Array(32))):Promise<string> {
  const key=await crypto.subtle.importKey("raw",encode(password),"PBKDF2",false,["deriveBits"]);
  const hash=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:ITERATIONS},key,256);
  return `v1:${hex(salt)}:${hex(hash)}`;
}
export async function verifyPassword(password:string,config:AccessConfig):Promise<boolean> {
  if(!accessConfigured(config) || !password || password.length>256)return false;
  const [,salt,wanted]=config.verifier!.split(":");
  const actual=(await passwordVerifier(password,bytes(salt))).split(":")[2];
  let difference=0;for(let i=0;i<wanted.length;i++)difference|=actual.charCodeAt(i)^wanted.charCodeAt(i);
  return difference===0;
}
async function signingKey(config:AccessConfig){return crypto.subtle.importKey("raw",bytes(config.sessionSecret!),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);}
export async function issueAccessSession(config:AccessConfig,now=Date.now()):Promise<string> {
  if(!accessConfigured(config))throw new Error("访问密码尚未配置。");
  const payload=`v1.${Math.floor(now/1000)+ACCESS_SECONDS}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const signature=await crypto.subtle.sign("HMAC",await signingKey(config),encode(`${payload}|${config.verifier}`));
  return `${payload}.${hex(signature)}`;
}
export async function hasAccessSession(value:string|undefined,config:AccessConfig,now=Date.now()):Promise<boolean> {
  if(!accessConfigured(config) || !value || !/^v1\.\d{10}\.[0-9a-f]{32}\.[0-9a-f]{64}$/.test(value))return false;
  const [version,expires,nonce,signature]=value.split("."), seconds=Math.floor(now/1000);
  if(Number(expires)<=seconds || Number(expires)>seconds+ACCESS_SECONDS)return false;
  return crypto.subtle.verify("HMAC",await signingKey(config),bytes(signature),encode(`${version}.${expires}.${nonce}|${config.verifier}`));
}
export function accessCookieFromRequest(request:Request):string|undefined {
  return request.headers.get("Cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${ACCESS_COOKIE}=`))?.slice(ACCESS_COOKIE.length+1);
}
export function accessCookie(value:string,request:Request,clear=false):string {
  const url=new URL(request.url), local=url.protocol==="http:" && ["127.0.0.1","localhost"].includes(url.hostname);
  return `${ACCESS_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear?0:ACCESS_SECONDS}${local?"":"; Secure"}`;
}
export async function rateLimitKey(ip:string,config:AccessConfig):Promise<string> {
  if(!accessConfigured(config))throw new Error("访问密码尚未配置。");
  return "access-rate:"+hex(await crypto.subtle.sign("HMAC",await signingKey(config),encode(ip)));
}
export type AccessLimiter = (key:string,now:number)=>Promise<{attempts:number;expires:number}>;
export async function handleAccessRequest(request:Request,config:AccessConfig,limit:AccessLimiter):Promise<Response> {
  const reply=(error:string,status:number,extra:Record<string,string>={})=>Response.json({error},{status,headers:{"Cache-Control":"no-store",...extra}});
  if(request.headers.get("Origin")!==new URL(request.url).origin)return reply("请求来源不匹配。",403);
  if(request.method==="DELETE")return Response.json({ok:true},{headers:{"Cache-Control":"no-store","Set-Cookie":accessCookie("",request,true)}});
  if(request.method!=="POST")return reply("不支持的请求。",405);
  if(!accessConfigured(config))return reply("站点访问密码尚未配置，请联系站点主人。",503);
  // CF-Connecting-IP 由平台边缘提供；只持久保存它的 HMAC，不保存原始地址。
  const now=Date.now(), allowance=await limit(await rateLimitKey(request.headers.get("CF-Connecting-IP") || "unavailable",config),now);
  if(allowance.attempts>10)return reply("尝试次数过多，请稍后再试。",429,{"Retry-After":String(Math.max(1,Math.ceil((allowance.expires-now)/1000)))});
  const text=await request.text();if(text.length>4096)return reply("密码输入过长。",400);
  let body:any;try{body=JSON.parse(text);}catch{return reply("请求格式无效。",400);}
  if(typeof body?.password!=="string" || !(await verifyPassword(body.password,config)))return reply("访问密码不正确。",401);
  return Response.json({ok:true},{headers:{"Cache-Control":"no-store","Set-Cookie":accessCookie(await issueAccessSession(config),request)}});
}
