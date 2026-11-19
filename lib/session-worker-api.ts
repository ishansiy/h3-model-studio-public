import {readImageUpload} from './image-artifacts';
import {FixedLengthStream} from './node-runtime';
import {authenticateWorker,finishQueueJob,workerHeartbeat,workerPoll,QueueError} from './session-queue';
const answer=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function queueJson(request:Request){if(Number(request.headers.get('Content-Length')||0)>65536)throw new QueueError('请求过大。',413);const raw=await request.text();if(new TextEncoder().encode(raw).length>65536)throw new QueueError('请求过大。',413);try{return JSON.parse(raw||'{}');}catch{throw new QueueError('请求格式无效。');}}
export async function workerApi(request:Request,path:string[],database:D1Database,bucket:R2Bucket|undefined){
 try{
  const s=await authenticateWorker(database,request,path[1],request.headers.get('X-H3-Worker')||'');
  if(path[2]==='probe'&&path.length===3&&request.method==='PUT'){
   if(!bucket)throw new QueueError('成片存储尚未配置。',503);
   if(Number(request.headers.get('Content-Length')||0)!==14||await request.text()!=='H3_QUEUE_PROBE')throw new QueueError('探测请求无效。');
   const key=`probe/${s.id}/${s.worker_id||request.headers.get('X-H3-Worker')}`;await bucket.put(key,'H3_QUEUE_PROBE');const object=await bucket.get(key);if(!object||await object.text()!=='H3_QUEUE_PROBE')throw new QueueError('存储验证失败。',503);await bucket.delete(key);return answer({ok:true});
  }
  if(path[2]==='artifact'&&path.length===4&&request.method==='PUT'){
   if(!bucket)throw new QueueError('作品存储尚未配置。',503);
   const claim=new URL(request.url).searchParams.get('claim')||'';
   const row=await database.prepare("SELECT * FROM jobs WHERE session_id=? AND id=? AND claim_token=? AND status='running' AND stop_requested_at IS NULL").bind(s.id,path[3],claim).first<any>();
   if(!row||s.stop_requested_at||row.category!=='image'||s.category!=='image'||row.model_id!==s.model_id)throw new QueueError('图片任务不存在、已取消或租约不匹配。',409);
   const sha=request.headers.get('X-Artifact-SHA256')||'';if(!/^[a-f0-9]{64}$/.test(sha))throw new QueueError('图片校验和无效。');
   const params=JSON.parse(row.params),bytes=await readImageUpload(request,params.width,params.height),key=`studio/${s.owner}/${s.id}/${row.id}/${claim}.png`;
   await bucket.put(key,bytes,{sha256:sha,httpMetadata:{contentType:'image/png',cacheControl:'private, no-store'}});
   const update=await database.prepare("UPDATE jobs SET artifact_key=?,artifact_sha=?,artifact_bytes=?,artifact_mime='image/png' WHERE id=? AND session_id=? AND claim_token=? AND status='running' AND stop_requested_at IS NULL AND EXISTS(SELECT 1 FROM gpu_sessions WHERE id=? AND stop_requested_at IS NULL)").bind(key,sha,bytes.length,row.id,s.id,claim,s.id).run();
   if(!update.meta.changes){await bucket.delete(key);throw new QueueError('任务已取消。',409);}return answer({ok:true});
  }
  if(path[2]==='video'&&path.length===4&&request.method==='PUT'){
   if(!bucket)throw new QueueError('成片存储尚未配置。',503);
   const claim=new URL(request.url).searchParams.get('claim')||'';const row=await database.prepare("SELECT * FROM jobs WHERE session_id=? AND id=? AND claim_token=? AND status='running' AND stop_requested_at IS NULL").bind(s.id,path[3],claim).first<any>();if(!row||s.stop_requested_at||row.category==='image')throw new QueueError('任务已取消或上传租约无效。',409);
   const size=Number(request.headers.get('Content-Length')),sha=request.headers.get('X-Video-SHA256')||'';if(!Number.isSafeInteger(size)||size<1||size>100*1024*1024||!/^[a-f0-9]{64}$/.test(sha)||request.headers.get('Content-Type')!=='video/mp4'||!request.body)throw new QueueError('成片上传参数无效或超过100MB。',413);
   const key=`h3/${s.owner}/${s.id}/${row.id}/${claim}.mp4`;
   const fixed=new FixedLengthStream(size);
   await Promise.all([request.body.pipeTo(fixed.writable),bucket.put(key,fixed.readable,{sha256:sha,httpMetadata:{contentType:'video/mp4',cacheControl:'private, no-store'}})]);
   const update=await database.prepare("UPDATE jobs SET artifact_key=?,artifact_sha=?,artifact_bytes=?,artifact_mime='video/mp4' WHERE id=? AND session_id=? AND claim_token=? AND status='running' AND stop_requested_at IS NULL").bind(key,sha,size,row.id,s.id,claim).run();if(!update.meta.changes){await bucket.delete(key);throw new QueueError('任务已取消。',409);}return answer({ok:true});
  }
  if(request.method!=='POST'||path.length!==3)return answer({error:'接口不存在。'},404);
  if(path[2]==='poll')return answer(await workerPoll(database,s));
  const value=await queueJson(request);
  if(path[2]==='heartbeat')return answer(await workerHeartbeat(database,s,value));
  if(path[2]==='finish'){const row=await finishQueueJob(database,s,value,async key=>bucket?bucket.head(key):null);return answer({ok:true,status:row.status});}
  return answer({error:'接口不存在。'},404);
 }catch(e){return answer({error:e instanceof QueueError?e.message:'会话请求暂时失败。'},e instanceof QueueError?e.status:503);}
}
