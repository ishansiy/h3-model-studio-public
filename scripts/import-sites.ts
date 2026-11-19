/** 从原站点只读复制最近历史与成片；不导出任何账户密钥，不修改原站点。 */
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {NodeDatabase,NodeBucket,validateEnvironment} from '../lib/node-runtime';
export async function importSites(source:string,password:string){
 validateEnvironment();const origin=new URL(source);if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname)))throw Error('原站点必须使用HTTPS。');
 const login=await fetch(new URL('/api/access',origin),{method:'POST',redirect:'error',headers:{Origin:origin.origin,'Content-Type':'application/json'},body:JSON.stringify({password}),signal:AbortSignal.timeout(20000)});if(!login.ok)throw Error('原站点密码验证失败。');const cookie=login.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw Error('原站点没有返回密码会话。');
 async function get(path:string){const r=await fetch(new URL(path,origin),{headers:{Cookie:cookie!},redirect:'error',signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('原站点资料或成片读取失败；尚未完成迁移，请保留原站点。');return r;}
 const jobs=(await (await get('/api/jobs')).json() as any).jobs,accounts=(await (await get('/api/accounts')).json() as any).accounts,sessions=(await (await get('/api/sessions')).json() as any).sessions;
 if(!Array.isArray(jobs)||!Array.isArray(accounts)||!Array.isArray(sessions))throw Error('原站点响应不兼容。');if(jobs.length>=100)throw Error('原站点接口最多返回100条；已拒绝不完整迁移，请改用完整数据库导出。');
 if(jobs.some(j=>!['completed','failed','cancelled'].includes(j.status))||sessions.some(s=>!['completed','failed'].includes(s.status)))throw Error('原站点还有活动任务或会话，请先确认结束，避免重复运行。');
 const d=new NodeDatabase(),bucket=new NodeBucket(d),owner=process.env.BOOTSTRAP_OWNER_ID||'owner';await d.ready;
 try{
  if(await d.prepare('SELECT id FROM jobs LIMIT 1').first()||await d.prepare('SELECT id FROM accounts LIMIT 1').first())throw Error('目标数据库必须为空；不会覆盖已有记录。');
  const statements:any[]=[],allAccounts=new Map<string,any>();for(const a of accounts)allAccounts.set(a.id,a);for(const j of jobs)if(!allAccounts.has(j.accountId))allAccounts.set(j.accountId,{id:j.accountId,name:j.accountName,username:j.username,created_at:j.createdAt});
  for(const a of allAccounts.values())statements.push(d.prepare('INSERT INTO accounts(id,owner,name,username,cipher,hint,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)').bind(a.id,owner,a.name,a.username,'','待重连',a.created_at,Date.now()));
  for(const s of sessions)statements.push(d.prepare('INSERT INTO gpu_sessions(id,owner,account_id,username,status,profile,token_hash,kernel_ref,version,created_at,expires_at,heartbeat_at,stop_requested_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(s.id,owner,s.accountId,allAccounts.get(s.accountId)?.username||'unknown',s.status,s.profile,'imported-terminal-session',s.kernelRef,s.version,s.createdAt,s.createdAt+43200000,s.heartbeatAt||0,s.stopRequestedAt,s.error));
  let videos=0;
  for(const j of jobs){let key:string|null=null,sha:string|null=null,size:number|null=null;
   if(j.status==='completed'){key='import/'+owner+'/'+j.id+'.mp4';const response=await get('/api/jobs/'+encodeURIComponent(j.id)+'/video');if(!response.headers.get('content-type')?.includes('video/mp4'))throw Error('原站点成片格式不匹配。');const reader=response.body!.getReader(),chunks:Buffer[]=[];let bytes=0;for(;;){const x=await reader.read();if(x.done)break;bytes+=x.value.byteLength;if(bytes>100*1024*1024){await reader.cancel();throw Error('成片超过100MB。');}chunks.push(Buffer.from(x.value));}const data=Buffer.concat(chunks);if(!data.length)throw Error('原站点成片为空。');sha=createHash('sha256').update(data).digest('hex');size=data.length;await bucket.put(key,data,{sha256:sha,httpMetadata:{contentType:'video/mp4'}});videos++;}
   statements.push(d.prepare('INSERT INTO jobs(id,owner,account_id,account_name,username,params,status,kernel_ref,session_id,artifact_key,artifact_sha,artifact_bytes,version,kernel_session_id,stop_requested_at,created_at,updated_at,stage,step,total_steps,error,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(j.id,owner,j.accountId,j.accountName,j.username,JSON.stringify(j.params),j.status,j.kernelRef,j.sessionId,key,sha,size,j.version,j.kernelSessionId,j.stopRequestedAt,j.createdAt,j.updatedAt,j.stage,j.step,j.totalSteps,j.error,j.metadata?JSON.stringify(j.metadata):null));
  }
  await d.batch(statements);console.log(`已复制${jobs.length}条历史、${sessions.length}个终态会话、${videos}份成片。原站点未更改。请在新站点重新连接账户并创建新的专用API密钥。`);
 }finally{await d.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let muted=false;const output=new Writable({write(chunk,_encoding,done){if(!muted)process.stdout.write(chunk);done();}}),rl=createInterface({input:process.stdin,output,terminal:!!process.stdin.isTTY});try{if(!process.stdin.isTTY)throw Error('请在交互终端运行迁移，密码不会写入命令参数。');const source=await rl.question('原站点HTTPS地址：');process.stdout.write('原站点访问密码（隐藏输入）：');muted=true;const password=await rl.question('');muted=false;process.stdout.write('\n');await importSites(source.trim(),password);}catch(e){muted=false;console.error(e instanceof Error?e.message:'迁移失败，原站点未更改。');process.exitCode=1;}finally{muted=false;rl.close();}}
