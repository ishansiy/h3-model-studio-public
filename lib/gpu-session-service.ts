import {storedVideoResponse} from './stored-video';
import {env} from "./node-runtime";
import {account,db,decrypt,accountCredential,type Job} from './store';
import {cleanError,kaggle,KaggleError,queryFor} from './kaggle';
import {explicitSessionId} from './job-control';
import {buildModelNotebook} from './model-runners';
import {getSession,liveSession,QueueError,type GpuSession} from './session-queue';
export async function launchSession(s:GpuSession,launch:{token:string;params:any},origin:string){
 const fresh=await getSession(db(),s.id);if(fresh?.stop_requested_at){await db().prepare("UPDATE gpu_sessions SET status='completed' WHERE id=?").bind(s.id).run();return;}
 const a=await account(s.owner,s.account_id);if(!a)throw new QueueError('账户已移除。',409);
 try{
  const r=await kaggle(await accountCredential(a),'push',{}, {slug:s.kernel_ref,newTitle:s.kernel_ref.split('/')[1],text:buildModelNotebook(launch.params,`${origin}/api/worker/${s.id}`,launch.token),language:'python',kernelType:'notebook',isPrivate:true,enableGpu:true,enableTpu:false,enableInternet:true,machineShape:'NvidiaTeslaT4',kernelExecutionType:1,sessionTimeoutSeconds:43200});
  if(r.error)throw new KaggleError(r.error,400);const ref=String(r.ref||new URL(r.url).pathname).replace(/^\/?code\//,'').replace(/^\//,'');if(ref!==s.kernel_ref||!r.versionNumber)throw new KaggleError('提交返回信息待确认。',0);
  await db().batch([db().prepare("UPDATE gpu_sessions SET version=?,kernel_session_id=?,status=CASE WHEN status='submitting' THEN 'queued' ELSE status END,last_error=NULL WHERE id=?").bind(r.versionNumber,explicitSessionId(r),s.id),db().prepare("UPDATE jobs SET version=? WHERE session_id=?").bind(r.versionNumber,s.id)]);
 }catch(e){
  const uncertain=e instanceof KaggleError&&(e.status===0||e.status>=500);await db().prepare("UPDATE gpu_sessions SET status=?,last_error=? WHERE id=? AND status='submitting'").bind(uncertain?'submission_unknown':'failed',cleanError(e),s.id).run();
  if(!uncertain)await db().prepare("UPDATE jobs SET status='failed',stage='会话提交失败',error=?,updated_at=? WHERE session_id=? AND status='queued'").bind(cleanError(e),Date.now(),s.id).run();
 }
}
export async function syncGpuSession(owner:string,id:string){
 let s=await getSession(db(),id);if(!s||s.owner!==owner)throw new QueueError('会话不存在。',404);if(!liveSession(s))return s;
 if(s.status==='active'&&s.heartbeat_at>Date.now()-30_000)return s;
 const lock=await db().prepare('UPDATE gpu_sessions SET sync_lease=? WHERE id=? AND sync_lease<?').bind(Date.now()+30_000,id,Date.now()).run();if(!lock.meta.changes)return s;
 try{
  const a=await account(owner,s.account_id);if(!a)throw new Error('对应账户已移除。');const token=await accountCredential(a);
  if(!s.version){
   const rows=await kaggle(token,'list',{group:'profile',user:s.username,search:s.id.slice(0,12),pageSize:'20'});const found=Array.isArray(rows)?rows.find((x:any)=>x.ref===s!.kernel_ref):null;
   if(!found){await db().prepare('UPDATE gpu_sessions SET last_error=? WHERE id=?').bind(Date.now()-s.created_at>300_000?'尚未查到对应Notebook，保留会话锁定且不会重复提交。':null,id).run();return (await getSession(db(),id))!;}
   const pull=await kaggle(token,'pull',queryFor(s.kernel_ref));const version=pull.metadata?.currentVersionNumber;if(!version)throw new Error('无法确认Notebook版本。');await db().batch([db().prepare('UPDATE gpu_sessions SET version=? WHERE id=?').bind(version,id),db().prepare('UPDATE jobs SET version=? WHERE session_id=?').bind(version,id)]);s=(await getSession(db(),id))!;
  }
  const state=await kaggle(token,'status',queryFor(s.kernel_ref,s.version));const status=String(state.status).toLowerCase().replaceAll('_','');
  if(['complete','error','cancelled','canceled','cancelacknowledged'].includes(status)){
   const normal=status==='complete'||!!s.stop_requested_at||s.status==='closing';
   await db().batch([db().prepare('UPDATE gpu_sessions SET status=?,last_error=?,sync_lease=0 WHERE id=?').bind(normal?'completed':'failed',normal?null:cleanError(state.failureMessage||'Kaggle会话已中断。'),id),db().prepare("UPDATE jobs SET status=CASE WHEN stop_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,stage=CASE WHEN stop_requested_at IS NOT NULL THEN '已取消' ELSE '会话结束，任务未完成' END,error=CASE WHEN stop_requested_at IS NOT NULL THEN NULL ELSE ? END,updated_at=? WHERE session_id=? AND status IN ('queued','running')").bind('GPU会话已结束；该任务没有完整交付，未自动重跑。',Date.now(),id)]);
  }else if(s.heartbeat_at&&s.heartbeat_at<Date.now()-90_000){await db().prepare('UPDATE gpu_sessions SET last_error=? WHERE id=?').bind('会话心跳暂时中断，仍在核对Kaggle状态，不会重复启动GPU。',id).run();}
 }catch(e){await db().prepare('UPDATE gpu_sessions SET last_error=? WHERE id=?').bind(cleanError(e),id).run();}
 finally{await db().prepare('UPDATE gpu_sessions SET sync_lease=0 WHERE id=?').bind(id).run();}
 return (await getSession(db(),id))!;
}
export async function queueVideoResponse(request:Request,row:Job){return storedVideoResponse(request,row,env.BUCKET);}
