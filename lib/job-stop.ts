import {cleanError} from "./kaggle";
export async function requestJobStop(database:D1Database,owner:string,id:string,cancel:(accountId:string,sessionId:number)=>Promise<void>) {
  const get=()=>database.prepare("SELECT * FROM jobs WHERE owner=? AND id=?").bind(owner,id).first<any>();
  const row=await get();
  if(!row)return {status:404,error:"任务不存在。"};
  if(["completed","failed","cancelled"].includes(row.status))return {status:200,row};
  if(row.stop_requested_at)return {status:202,row};
  if(!row.kernel_session_id&&!row.control_hash)return {status:409,error:"此历史任务没有运行控制信息，请在 Kaggle 页面停止。新任务已支持工作室停止。"};
  if(row.kernel_session_id){try{await cancel(row.account_id,row.kernel_session_id);}catch(e){return {status:409,error:cleanError(e)};}}
  // Keep the active status and account lock until a remote terminal state is observed.
  await database.prepare("UPDATE jobs SET stop_requested_at=COALESCE(stop_requested_at,?),stage='正在停止，等待 Kaggle 确认',error=NULL WHERE owner=? AND id=? AND status NOT IN ('completed','failed','cancelled')").bind(Date.now(),owner,id).run();
  return {status:202,row:await get()};
}

// Explicit owner attestation. This does not claim an API-verified remote cancellation.
export async function confirmExternalStop(database:D1Database,owner:string,id:string,confirmed:boolean){
  if(!confirmed)return {status:400,error:"请先确认已在 Kaggle 后台停止或删除此任务。"};
  const get=()=>database.prepare("SELECT * FROM jobs WHERE owner=? AND id=?").bind(owner,id).first<any>();
  const row=await get();if(!row)return {status:404,error:"任务不存在。"};
  if(["completed","failed","cancelled"].includes(row.status))return {status:200,row};
  const now=Date.now();
  await database.prepare("UPDATE jobs SET status='cancelled',stage='已停止（用户确认在 Kaggle 后台结束）',error=NULL,updated_at=?,stop_requested_at=COALESCE(stop_requested_at,?),metadata=json_set(COALESCE(metadata,'{}'),'$.termination',json(?)) WHERE owner=? AND id=? AND status IN ('submitting','queued','running','submission_unknown')").bind(now,now,JSON.stringify({source:"user-confirmed-external-stop",confirmedAt:now}),owner,id).run();
  return {status:200,row:await get()};
}
