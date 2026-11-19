import {account,accountCredential,db,decrypt,encrypt,proxySettingKey} from './store';
import {accountFetch,proxyLabel,validateProxyUrl} from './proxy';
import {verifyAccount} from './kaggle';
import {resourcesCacheKey} from './resources';
import {readSmallJson} from './integration-api';
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function accountProxyRoute(request:Request,owner:string,id:string,network={verify:verifyAccount,fetch:accountFetch}){
 const a=await account(owner,id);if(!a)return reply({error:'账户不存在。'},404);
 const key=proxySettingKey(owner,id),stored=await db().prepare('SELECT value FROM settings WHERE id=?').bind(key).first<{value:string}>();
 let prior:{url:string}|null=null;if(stored){try{prior=JSON.parse(await decrypt(stored.value));}catch{return reply({error:'原代理配置无法读取，请检查主密钥。'},503);}}
 const view=(url:string|null)=>({enabled:!!url,label:url?proxyLabel(url):'直连',hasSavedAddress:!!url});
 if(request.method==='GET')return reply({proxy:view(prior?.url||null)});
 if(request.method!=='POST')return reply({error:'不支持的请求。'},405);
 const value=await readSmallJson(request);if(!['save','test'].includes(value.action)||typeof value.enabled!=='boolean')return reply({error:'代理操作无效。'},400);
 const busySql="EXISTS(SELECT 1 FROM jobs WHERE owner=? AND account_id=? AND status IN ('submitting','queued','running','submission_unknown')) OR EXISTS(SELECT 1 FROM gpu_sessions WHERE owner=? AND account_id=? AND status NOT IN ('completed','failed'))";
 const busy=await db().prepare('SELECT '+busySql+' AS busy').bind(owner,id,owner,id).first<{busy:boolean}>();if(busy?.busy)return reply({error:'账户有活动任务或GPU会话，结束后才能更改或测试代理。'},409);
 if(!value.enabled){if(value.action==='test')return reply({error:'请先开启账户代理。'},400);const removed=await db().prepare('DELETE FROM settings WHERE id=? AND NOT ('+busySql+')').bind(key,owner,id,owner,id).run();if(prior&&!removed.meta.changes)return reply({error:'账户刚开始运行，代理未更改。'},409);await db().prepare('DELETE FROM settings WHERE id=?').bind(resourcesCacheKey(owner,id)).run();return reply({proxy:view(null)});}
 let url:string;try{url=validateProxyUrl(typeof value.proxyUrl==='string'&&value.proxyUrl.trim()?value.proxyUrl:prior?.url);}catch{return reply({error:'请输入有效的HTTP/HTTPS或SOCKS5代理地址。'},400);}
 try{
  const token=await decrypt(a.cipher),connection={token,proxyUrl:url};await network.verify(connection,a.username);
  const response=await network.fetch(connection,'https://api.ipify.org?format=json',{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error();const data:any=await response.json();if(typeof data.ip!=='string'||!/^[0-9a-fA-F:.]{3,64}$/.test(data.ip))throw Error();
  if(value.action==='save'){
   const result=await db().prepare('INSERT INTO settings(id,value) SELECT ?,? WHERE NOT ('+busySql+') ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(key,await encrypt(JSON.stringify({url,checkedAt:Date.now(),exitIp:data.ip})),owner,id,owner,id).run();if(!result.meta.changes)return reply({error:'账户刚开始运行，代理未更改。'},409);
   await db().prepare('DELETE FROM settings WHERE id=?').bind(resourcesCacheKey(owner,id)).run();
  }
  return reply({proxy:view(url),test:{connected:true,exitIp:data.ip,checkedAt:Date.now()},saved:value.action==='save'});
 }catch{return reply({error:'代理测试未通过，配置未更改，请检查地址、认证、连通性和Kaggle密钥。请求没有回退直连。'},400);}
}
