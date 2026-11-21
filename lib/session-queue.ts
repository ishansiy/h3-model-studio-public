import {generationImages,sessionImageInputsKey} from './generation-inputs';
import {HYPERFLOW,hyperFlowFastSessionKey,usesHyperFlowFastPreset} from './hyperflow-config';
import {validateGenerationParams as validateParams,generationSteps,jobModel,modelById} from './model-catalog';
import {samplingSteps,frameCount} from './parameters';
import {controlHash,createControlToken} from './job-control';
export type GpuSession={id:string;owner:string;account_id:string;username:string;status:string;profile:string;category?:string;model_id?:string;token_hash:string;worker_id:string|null;kernel_ref:string;version:number|null;kernel_session_id:number|null;created_at:number;expires_at:number;heartbeat_at:number;idle_since:number|null;stop_requested_at:number|null;last_error:string|null;sync_lease:number};
export const SESSION_IDLE_MS=300_000;
export const liveSession=(s:GpuSession)=>!['completed','failed'].includes(s.status);
export class QueueError extends Error{constructor(message:string,public status=400){super(message);}}
type QueueStorage=Pick<D1Database,'prepare'>;
export const getSession=(d:QueueStorage,id:string)=>d.prepare('SELECT * FROM gpu_sessions WHERE id=?').bind(id).first<GpuSession>();
export const sessionView=(s:GpuSession)=>({id:s.id,accountId:s.account_id,category:s.category||'video',modelId:jobModel(s),status:s.status,profile:s.profile,kernelRef:s.kernel_ref,version:s.version,createdAt:s.created_at,heartbeatAt:s.heartbeat_at,idleSince:s.idle_since,idleTimeoutSeconds:SESSION_IDLE_MS/1000,stopRequestedAt:s.stop_requested_at,error:s.last_error});
export async function enqueue(d:QueueStorage,owner:string,a:{id:string;username:string;name:string},id:string,input:unknown,now=Date.now()){
 const params=validateParams(input),profile=params.runtimeProfile||'standard';const modelId=params.modelId,category=params.category;
 if(!['standard','ck','fp16'].includes(profile))throw new QueueError('请选择原精度、混合精度或注意力加速计算方案。');
 const existing=await d.prepare('SELECT * FROM jobs WHERE owner=? AND id=?').bind(owner,id).first<any>();if(existing)return {row:existing,session:existing.session_id?await getSession(d,existing.session_id):null,launch:null};
 const makeToken=createControlToken(),sid=crypto.randomUUID();let launch:{token:string;params:typeof params}|null=null;
 await d.prepare("INSERT OR IGNORE INTO gpu_sessions(id,owner,account_id,username,status,profile,token_hash,kernel_ref,created_at,expires_at,category,model_id) SELECT ?,?,?,?,'submitting',?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE account_id=? AND session_id IS NULL AND status IN ('submitting','queued','running','submission_unknown'))").bind(sid,owner,a.id,a.username,profile,await controlHash(makeToken),`${a.username}/studio-${modelId==='h3'?'h3':modelId==='hyperflow-h3-flash'?'hflash':'zimage'}-${sid.slice(0,12)}`,now,now+43200_000,category,modelId,a.id).run();
 let s=await d.prepare("SELECT * FROM gpu_sessions WHERE owner=? AND account_id=? AND status NOT IN ('completed','failed')").bind(owner,a.id).first<GpuSession>();
 if(!s)throw new QueueError('该账户还有旧版任务，请等远端结束后再创建连续会话。',409);
 if(s.id===sid){
  launch={token:makeToken,params};
  if(modelId===HYPERFLOW.id)await d.prepare('INSERT INTO settings(id,value) VALUES(?,?),(?,?)').bind(sessionImageInputsKey(s.id),'1',hyperFlowFastSessionKey(s.id),'1').run();
  else await d.prepare('INSERT INTO settings(id,value) VALUES(?,?)').bind(sessionImageInputsKey(s.id),'1').run();
 }
 if(generationImages(params).length&&!launch&&!await d.prepare("SELECT id FROM settings WHERE id=? AND value='1'").bind(sessionImageInputsKey(s.id)).first()){
  throw new QueueError('当前 GPU 会话需要重新启动以支持图片输入。',409);
 }
 if(s.stop_requested_at||!['submitting','submission_unknown','queued','active'].includes(s.status))throw new QueueError('GPU会话正在退出，请确认结束后再提交。',409);
 if(s.expires_at-now<600_000)throw new QueueError('GPU会话接近最长时限，请结束后重新开启。',409);
 if(jobModel(s)!==modelId)throw new QueueError(`该账户当前会话运行${modelById(jobModel(s))?.name||jobModel(s)}，请等会话结束或先结束会话，再切换模型。`,409);
 if(!launch&&usesHyperFlowFastPreset(params)&&!await d.prepare("SELECT id FROM settings WHERE id=? AND value='1'").bind(hyperFlowFastSessionKey(s.id)).first()){
  throw new QueueError('当前 GPU 会话早于双 T4 快档，等会话正常结束后再提交，或使用空闲计算账户。',409);
 }
 if(s.profile!==profile)throw new QueueError(`当前GPU会话使用${s.profile==='ck'?'注意力加速':s.profile==='fp16'?'混合精度加速':'原精度计算'}。请沿用此方案，或结束会话后再切换。`,409);
 const insert=await d.prepare("INSERT OR IGNORE INTO jobs(id,owner,account_id,account_name,username,params,status,kernel_ref,session_id,created_at,updated_at,stage,total_steps,category,model_id) SELECT ?,?,?,?,?,?,'queued',?,?,?,?,'等待会话处理',?,?,? WHERE EXISTS(SELECT 1 FROM gpu_sessions WHERE id=? AND status IN ('submitting','submission_unknown','queued','active')) AND (SELECT COUNT(*) FROM jobs WHERE session_id=? AND status IN ('queued','running'))<20").bind(id,owner,a.id,a.name,a.username,JSON.stringify(params),s.kernel_ref,s.id,now,now,generationSteps(params),category,modelId,s.id,s.id).run();
 const row=await d.prepare('SELECT * FROM jobs WHERE owner=? AND id=?').bind(owner,id).first<any>();
 if(!row){if(launch)await d.prepare("UPDATE gpu_sessions SET status='failed',last_error='未创建首条任务' WHERE id=?").bind(s.id).run();throw new QueueError('当前队列已满或会话正在退出，请稍后重试。',409);}
 if(!insert.meta.changes)launch=null;
 await d.prepare('UPDATE gpu_sessions SET idle_since=NULL WHERE id=?').bind(s.id).run();
 return {row,session:s,launch};
}
export async function authenticateWorker(d:D1Database,request:Request,sid:string,workerId:string,now=Date.now()){
 const token=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
 if(!/^[a-f0-9-]{36}$/.test(workerId)||!/^[a-f0-9]{64}$/.test(token))throw new QueueError('会话凭证无效。',401);
 const s=await getSession(d,sid);if(!s||s.expires_at<now||!liveSession(s)||await controlHash(token)!==s.token_hash)throw new QueueError('会话凭证无效或已到期。',401);
 const lock=await d.prepare('UPDATE gpu_sessions SET worker_id=? WHERE id=? AND (worker_id IS NULL OR worker_id=?)').bind(workerId,sid,workerId).run();if(!lock.meta.changes)throw new QueueError('该GPU会话已有工作进程。',409);return s;
}
export async function workerPoll(d:D1Database,s:GpuSession,now=Date.now()){
 await d.prepare("UPDATE gpu_sessions SET heartbeat_at=?,last_error=NULL,status=CASE WHEN status IN ('submitting','queued','submission_unknown') THEN 'active' ELSE status END WHERE id=?").bind(now,s.id).run();
 s=(await getSession(d,s.id))!;
 if(s.stop_requested_at||['stopping','closing'].includes(s.status))return {stopSession:true,job:null};
 await d.prepare("UPDATE gpu_sessions SET status='closing' WHERE id=? AND status='active' AND idle_since IS NOT NULL AND idle_since<=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE session_id=? AND status IN ('queued','running'))").bind(s.id,now-SESSION_IDLE_MS,s.id).run();
 if((await getSession(d,s.id))!.status==='closing')return {stopSession:true,job:null};
 const nonce=crypto.randomUUID();await d.prepare("UPDATE jobs SET status='running',claim_token=?,stage='开始处理',updated_at=? WHERE id=(SELECT id FROM jobs WHERE session_id=? AND status='queued' ORDER BY created_at,id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM jobs WHERE session_id=? AND status='running') AND EXISTS(SELECT 1 FROM gpu_sessions WHERE id=? AND status='active' AND stop_requested_at IS NULL)").bind(nonce,now,s.id,s.id,s.id).run();
 const row=await d.prepare("SELECT * FROM jobs WHERE session_id=? AND status='running'").bind(s.id).first<any>();
 if(row)await d.prepare('UPDATE gpu_sessions SET idle_since=NULL WHERE id=?').bind(s.id).run();else await d.prepare('UPDATE gpu_sessions SET idle_since=COALESCE(idle_since,?) WHERE id=?').bind(now,s.id).run();
 return {stopSession:false,job:row?{id:row.id,claimToken:row.claim_token,params:JSON.parse(row.params),stopRequested:!!row.stop_requested_at}:null};
}
export async function workerHeartbeat(d:D1Database,s:GpuSession,value:any,now=Date.now()){
 await d.prepare("UPDATE gpu_sessions SET heartbeat_at=?,last_error=NULL,status=CASE WHEN ?=1 THEN 'closing' WHEN status IN ('submitting','queued','submission_unknown') THEN 'active' ELSE status END WHERE id=?").bind(now,value.exiting?1:0,s.id).run();
 if(value.jobId&&value.claimToken){const stage=typeof value.stage==='string'?value.stage.slice(0,180):'正在生成';const step=Number.isFinite(value.step)?Math.max(0,Math.floor(value.step)):0;await d.prepare("UPDATE jobs SET stage=CASE WHEN stop_requested_at IS NULL THEN ? ELSE '正在取消当前任务' END,step=MIN(total_steps,?),updated_at=? WHERE id=? AND session_id=? AND claim_token=? AND status='running'").bind(stage,step,now,value.jobId,s.id,value.claimToken).run();}
 const fresh=(await getSession(d,s.id))!,row=await d.prepare("SELECT id,stop_requested_at FROM jobs WHERE session_id=? AND status='running'").bind(s.id).first<any>();return {stopSession:!!fresh.stop_requested_at||['closing','stopping'].includes(fresh.status),jobId:row?.id,stopJob:!!row?.stop_requested_at,hasPending:!!(await d.prepare("SELECT id FROM jobs WHERE session_id=? AND status='queued' LIMIT 1").bind(s.id).first())};
}
export async function finishQueueJob(d:D1Database,s:GpuSession,value:any,hasArtifact:(key:string)=>Promise<{size:number}|null>,now=Date.now()){
 const row=await d.prepare('SELECT * FROM jobs WHERE session_id=? AND id=? AND claim_token=?').bind(s.id,value.jobId,value.claimToken).first<any>();if(!row)throw new QueueError('任务租约不匹配。',409);
 if(['completed','cancelled','failed'].includes(row.status))return row;
 if(row.status!=='running')throw new QueueError('该任务尚未领取。',409);
 const cancelled=!!row.stop_requested_at||!!s.stop_requested_at||value.status==='cancelled';let status=cancelled?'cancelled':value.status==='completed'?'completed':'failed';
 if(status==='completed'){
  const p=JSON.parse(row.params),m=value.metadata,c=m?.resolved_config,v=m?.media_validation;
  const inputs=generationImages(p);
  if(inputs.length&&(m?.generation_type!==p.generationType||
    inputs.some(([role,id])=>m?.generation_inputs?.[role]!==id)||
    (p.strength!==undefined&&m?.generation_strength!==p.strength))){
   throw new QueueError('缺少实际使用输入图片的校验证明。',409);
  }
  if((row.category||'video')==='image'){
   if(!m||m.model_id!==row.model_id||m.category!=='image'||m.runtime_profile!==s.profile||!c||c.width!==p.width||c.height!==p.height||c.steps!==p.steps||String(c.seed)!==String(p.seed)||!m.image_validation?.full_decode_passed||m.image_validation.width!==p.width||m.image_validation.height!==p.height||m.image_validation.format!=='png')throw new QueueError('图片参数或完整解码证明不匹配。',409);
  }else{
  if(!m||m.runtime_profile!==s.profile||!c||c.width!==p.width||c.height!==p.height||c.steps!==samplingSteps(p)||String(c.seed)!==String(p.seed)||c.frames!==frameCount(p.duration)||!v?.full_decode_passed||v.frames!==c.frames||v.width!==p.width||v.height!==p.height||v.fps!==24||v.audio_channels!==2)throw new QueueError('成片参数或完整解码证明不匹配。',409);
  if(row.model_id==='hyperflow-h3-flash'){const h=m.hyperflow_proof;if(m.model_id!==HYPERFLOW.id||m.model_repo!==HYPERFLOW.repo||m.model_revision!==HYPERFLOW.revision||m.nodes_commit!==HYPERFLOW.nodesCommit||m.gguf_commit!==HYPERFLOW.ggufCommit||m.comfyui_commit!==HYPERFLOW.comfyCommit||!h||h.model_id!==HYPERFLOW.id||h.executed!==true||h.two_time!==true||h.quantization!==HYPERFLOW.quantization||!Number.isInteger(h.forward_calls)||h.forward_calls<c.steps||typeof h.nonce!=='string'||!h.nonce.includes(row.id)||c.sampler!=='euler'||c.cfg!==1)throw new QueueError('HyperFlow模型或实际采样证明不匹配。',409);}else if(m.hyperflow_proof)throw new QueueError('H3原版不能使用HyperFlow执行器。',409);
  if(usesHyperFlowFastPreset(p)&&await d.prepare("SELECT id FROM settings WHERE id=? AND value='1'").bind(hyperFlowFastSessionKey(s.id)).first()){
   const proof=m.hyperflow_precision_proof, head=proof?.head_parallel;
   if(head?.enabled!==true||head.backend!=='dual_t4_full_attention_heads_v1'||!Number.isInteger(head.calls)||head.calls<1
    ||!Array.isArray(head.devices)||head.devices.length!==2||head.devices[0]!=='cuda:0'||head.devices[1]!=='cuda:1'
    ||head.full_key_value_sequence!==true||head.sparse!==false||head.quantized_attention!==false
    ||proof.resident_policy?.enabled!==true||!Array.isArray(m.devices)||m.devices.length!==2||!m.devices.every((name:unknown)=>typeof name==='string'&&name.includes('T4'))){
    throw new QueueError('缺少本次双 T4 快档的实际执行证明。',409);
   }
  }
  if(s.profile==='ck'&&(m.attention_proof?.backend!=='comfy_kitchen_int8'||m.attention_proof?.executed!==true))throw new QueueError('缺少实际注意力执行证明。',409);
  if(s.profile==='fp16'&&(m.precision_proof?.backend!=='h3_safe_fp16_branches'||m.precision_proof?.executed!==true||m.precision_proof?.residual_dtype!=='torch.float32'||m.precision_proof?.branch_dtype!=='torch.float16'||m.precision_proof?.clamping!==false||m.precision_proof?.weights_unchanged!==true||m.precision_proof?.fp32_condition_preserved!==true||m.precision_proof?.fp32_outputs_preserved!==true||!Number.isInteger(m.precision_proof?.fast_blocks)||m.precision_proof.fast_blocks<50))throw new QueueError('缺少实际混合精度执行证明。',409);
  if(s.profile==='standard'&&m.precision_proof)throw new QueueError('原精度计算不应启用混合精度。',409);
  if(['standard','fp16'].includes(s.profile)&&m.attention_proof)throw new QueueError('标准计算不应启用注意力量化。',409);
  }
  const artifact=row.artifact_key?await hasArtifact(row.artifact_key):null;if(!artifact||artifact.size!==row.artifact_bytes||(row.category==='image'?m.artifact_sha256:m.video_sha256)!==row.artifact_sha)throw new QueueError('成片尚未完整上传。',409);
 }
 const error=status==='failed'?String(value.error||'生成失败').replace(/(?:KGAT_|H3AK_)[\w-]+/g,'[隐藏]').slice(0,1200):null;
 await d.batch([d.prepare("UPDATE jobs SET status=CASE WHEN stop_requested_at IS NOT NULL THEN 'cancelled' ELSE ? END,stage=CASE WHEN stop_requested_at IS NOT NULL THEN '已取消当前任务' ELSE ? END,step=CASE WHEN ?='completed' THEN total_steps ELSE step END,metadata=?,error=?,updated_at=? WHERE id=? AND session_id=? AND status='running'").bind(status,status==='completed'?(row.category==='image'?'图片已生成':'视频已生成'):status==='cancelled'?'已取消当前任务':'生成失败',status,value.metadata?JSON.stringify(value.metadata):null,error,now,row.id,s.id),d.prepare('UPDATE gpu_sessions SET idle_since=?,heartbeat_at=? WHERE id=?').bind(now,now,s.id)]);
 return d.prepare('SELECT * FROM jobs WHERE id=?').bind(row.id).first<any>();
}
export async function cancelQueuedJob(d:D1Database,owner:string,id:string,now=Date.now()){
 const row=await d.prepare('SELECT * FROM jobs WHERE owner=? AND id=?').bind(owner,id).first<any>();if(!row?.session_id)throw new QueueError('连续任务不存在。',404);
 await d.prepare("UPDATE jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,stage=CASE WHEN status='queued' THEN '已取消排队' ELSE '正在取消当前任务' END,stop_requested_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(now,now,id).run();
 return d.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<any>();
}
export async function stopGpuSession(d:D1Database,owner:string,id:string,now=Date.now()){
 const s=await getSession(d,id);if(!s||s.owner!==owner)throw new QueueError('会话不存在。',404);
 await d.batch([d.prepare("UPDATE gpu_sessions SET status='stopping',stop_requested_at=COALESCE(stop_requested_at,?) WHERE id=? AND status NOT IN ('completed','failed')").bind(now,id),d.prepare("UPDATE jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,stage=CASE WHEN status='queued' THEN '会话结束，已取消排队' ELSE '正在取消当前任务' END,stop_requested_at=COALESCE(stop_requested_at,?),updated_at=? WHERE session_id=? AND status IN ('queued','running')").bind(now,now,id)]);return (await getSession(d,id))!;
}
