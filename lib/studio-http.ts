import {checkInputImages,inputImageResponse,storeInputImage} from './input-images';
import {generationImages} from './generation-inputs';
import {generationInput} from './generation-api';
import {MODEL_CATALOG,CATEGORIES} from './model-catalog';
import {publicUrl,samePublicOrigin} from './public-url';
import {accountProxyRoute} from './account-proxy';
import {getSession,sessionView,stopGpuSession,cancelQueuedJob,QueueError} from "./session-queue";
import {queueGeneration,refreshSchedulingResources} from './account-scheduler';
import {launchSession,syncGpuSession,queueVideoResponse} from "./gpu-session-service";
import {workerApi,queueJson} from "./session-worker-api";
import {modelCacheSources} from "./model-cache";
import {requestJobStop,confirmExternalStop} from "./job-stop";
import {explicitSessionId, controlHash, createControlToken, readControl} from "./job-control";
import { env, storage } from "./node-runtime";
import { getWorkspaceOwner } from "./workspace-runtime";
import { account, bootstrap, db, decrypt, accountCredential, job, jobView, saveAccount, type Account, type Job } from "./store";
import { cleanError, findFile, kaggle, KaggleError, liveProgress, output, queryFor } from "./kaggle";
import { buildNotebook } from "./notebook";
import { samplingSteps, validateParams } from "./parameters";
import { resourcesCacheKey } from "./resources";
import { getAccountResources } from './account-resources';
import { accessCookieFromRequest,hasAccessSession } from "./access";
import { siteAccessConfig } from "./access-runtime";
import { listIntegrationKeys,createIntegrationKey,revokeIntegrationKey,readSmallJson,IntegrationError } from "./integration-api";

function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control":"no-store" } }); }
function fail(message: string, status = 400) { return json({error:message},status); }
async function sync(owner: string, id: string) {
  let row = await job(owner,id); if (!row) throw new Error("任务不存在。");
  if (["completed","failed","cancelled"].includes(row.status)) return row;
  if(row.session_id){await syncGpuSession(owner,row.session_id);return (await job(owner,id))!;}
  const lease = await db().prepare("UPDATE jobs SET sync_lease=? WHERE owner=? AND id=? AND status!='cancelled' AND sync_lease<?").bind(Date.now()+30000,owner,id,Date.now()).run();
  if (!lease.meta.changes) return row;
  try {
    const a = await account(owner,row.account_id); if (!a) throw new Error("此任务对应的账户已移除。"); const token = await accountCredential(a);
    if (row.status === "submission_unknown" || row.status === "submitting") {
      const items = await kaggle(token,"list",{group:"profile",search:row.id.slice(0,12),pageSize:"20"});
      const match = Array.isArray(items) ? items.find((v:any)=>v.title?.includes(row!.id.slice(0,12))) : null;
      if (!match) { if (Date.now()-row.created_at > 5*60_000) await db().prepare("UPDATE jobs SET status='failed',stage='提交未完成',error=? WHERE owner=? AND id=? AND status!='cancelled'").bind("未找到对应 Notebook，未重复提交。请确认账户后重新生成。",owner,id).run(); return (await job(owner,id))!; }
      const pulled = await kaggle(token,"pull",queryFor(match.ref));
      await db().prepare("UPDATE jobs SET kernel_ref=?,version=?,status='queued',error=NULL WHERE owner=? AND id=? AND status!='cancelled'").bind(match.ref,pulled.metadata.currentVersionNumber,owner,id).run(); row = (await job(owner,id))!;
    }
    const state = await kaggle(token,"status",queryFor(row.kernel_ref,row.version));
    const status = String(state.status).toLowerCase().replaceAll("_", "");
    row = (await job(owner,id))!;
    const sessionId=explicitSessionId(state);
    if(sessionId) await db().prepare("UPDATE jobs SET kernel_session_id=? WHERE owner=? AND id=? AND status!='cancelled'").bind(sessionId,owner,id).run();
    if (["cancelacknowledged","cancelled","canceled"].includes(status) || (row.stop_requested_at && ["complete","error"].includes(status))) {
      await db().prepare("UPDATE jobs SET status='cancelled',stage='已停止',error=NULL,updated_at=? WHERE owner=? AND id=? AND status!='cancelled'").bind(Date.now(),owner,id).run();
      return (await job(owner,id))!;
    }
    if (status === "complete") {
      const data = await output(token,row.kernel_ref,row.version);
      if (!findFile(data,"minimax_h3_final.mp4")) throw new Error("Notebook 已结束，但未找到最终视频。请查看 Kaggle 日志。");
      let metadata = null; const metadataUrl = findFile(data,"minimax_h3_run_metadata.json");
      if (metadataUrl) { const r = await fetch(metadataUrl,{signal:AbortSignal.timeout(10000)}); if (r.ok) metadata = await r.json(); }
      await db().prepare("UPDATE jobs SET status='completed',stage='视频已生成',step=total_steps,metadata=?,error=NULL,updated_at=? WHERE owner=? AND id=? AND status!='cancelled'").bind(metadata ? JSON.stringify(metadata) : null,Date.now(),owner,id).run();
    } else if (status === "error") {
      let detail = state.failureMessage || "Kaggle 运行失败，请打开 Notebook 查看日志。";
      const data = await output(token,row.kernel_ref,row.version).catch(()=>null);
      if (data?.log) { try { const events = JSON.parse(data.log); const errors = events.filter((e:any)=>/RuntimeError|Error:|Exception:|OutOfMemory/i.test(e.data || "")); if (errors.length) detail = errors.slice(-3).map((e:any)=>e.data).join(" "); } catch {} }
      await db().prepare("UPDATE jobs SET status='failed',stage='生成失败',error=?,updated_at=? WHERE owner=? AND id=? AND status!='cancelled'").bind(cleanError(detail),Date.now(),owner,id).run();
    } else {
      const progress = status === "running" ? await liveProgress(token,row.kernel_ref,row.version) : null;
      await db().prepare("UPDATE jobs SET status=?,stage=?,step=?,error=NULL,updated_at=? WHERE owner=? AND id=? AND status!='cancelled'").bind(status === "running" ? "running" : "queued",(row.stop_requested_at ? "正在停止，等待 Kaggle 确认" : progress?.stage) || (status === "running" ? row.stage === "等待 Kaggle 分配 GPU" ? "安装依赖与下载模型" : row.stage : "等待 Kaggle 分配 GPU"),progress ? Math.min(row.total_steps,Math.max(0,Math.round(progress.step))) : row.step,Date.now(),owner,id).run();
    }
  } catch (e) {
    if (row.stop_requested_at || e instanceof KaggleError || (e instanceof Error && e.name === "TimeoutError")) { await db().prepare("UPDATE jobs SET error=? WHERE owner=? AND id=? AND status!='cancelled'").bind(cleanError(e),owner,id).run(); }
    else { await db().prepare("UPDATE jobs SET status='failed',stage='生成失败',error=?,updated_at=? WHERE owner=? AND id=? AND status!='cancelled'").bind(cleanError(e),Date.now(),owner,id).run(); }
  } finally { await db().prepare("UPDATE jobs SET sync_lease=0 WHERE owner=? AND id=? AND status!='cancelled'").bind(owner,id).run(); }
  return (await job(owner,id))!;
}
export async function studioRoute(request: Request, context: { params: Promise<{path:string[]}> }) {
  const {path} = await context.params;
  if(path[0]==="worker"&&path.length>=3)return workerApi(request,path,db(),env.BUCKET);
  if(request.method==="GET" && path.length===3 && path[0]==="jobs" && path[2]==="control") return readControl(request,db(),path[1]);
  if(!(await hasAccessSession(accessCookieFromRequest(request),siteAccessConfig())))return fail("请先输入站点访问密码。",401);
  let owner:string;try{owner=getWorkspaceOwner();}catch{return fail("单人工作室尚未配置，请联系站点主人。",503);}
  if (request.method !== "GET" && request.headers.has("Origin") && !samePublicOrigin(request)) return fail("请求来源不匹配。",403);
  return dispatchStudio(request,path,owner);
}
export async function dispatchStudio(request:Request,path:string[],owner:string){
  const url=publicUrl(request);
  try {
    if(path[0]==="models"&&path.length===1&&request.method==="GET")return json({categories:CATEGORIES,models:MODEL_CATALOG});
    if(path[0]==="integration-keys"){
      if(request.method==="GET"&&path.length===1)return json({keys:await listIntegrationKeys(db(),owner)});
      if(!samePublicOrigin(request))return fail("请求来源不匹配。",403);
      if(request.method==="POST"&&path.length===1){
        const value=await readSmallJson(request);
        if(typeof value?.name!=="string"||value.name.length>40)return fail("密钥名称最多 40 个字符。");
        return json(await createIntegrationKey(db(),owner,value.name,Date.now(),value.scopes),201);
      }
      if(request.method==="DELETE"&&path.length===2){await revokeIntegrationKey(db(),owner,path[1]);return json({ok:true});}
      return fail("接口不存在。",404);
    }
    if(path[0]==="accounts"&&path.length===3&&path[2]==="proxy")return await accountProxyRoute(request,owner,path[1]);
    if (path[0] === "accounts" && path.length === 1 && request.method === "GET") {
      await bootstrap(owner);
      const result = await db().prepare("SELECT a.id,a.name,a.username,a.hint,a.created_at,EXISTS(SELECT 1 FROM jobs j WHERE j.account_id=a.id AND j.status IN ('submitting','queued','running','submission_unknown')) OR EXISTS(SELECT 1 FROM gpu_sessions s WHERE s.account_id=a.id AND s.status NOT IN ('completed','failed')) AS busy,EXISTS(SELECT 1 FROM settings p WHERE p.id='account-proxy:'||a.owner||':'||a.id) AS proxy_enabled FROM accounts a WHERE a.owner=? AND a.deleted_at IS NULL ORDER BY a.created_at").bind(owner).all();
      return json({accounts:result.results});
    }
    if (path[0] === "accounts" && path.length === 1 && request.method === "POST") {
      const value = await request.json() as any;
      if (typeof value.token !== "string" || typeof value.name !== "string") return fail("请填写账户名称和 API Token。");
      const count = await db().prepare("SELECT COUNT(*) AS n FROM accounts WHERE owner=? AND deleted_at IS NULL").bind(owner).first<{n:number}>();
      if ((count?.n || 0) >= 20) return fail("最多可连接 20 个账户。");
      const id = await saveAccount(owner,value.name,value.token.trim(),typeof value.username === "string" ? value.username : "",typeof value.proxyUrl === "string"&&value.proxyUrl.trim()?value.proxyUrl:undefined); return json({id},201);
    }
    if (path[0] === "accounts" && path.length === 3 && path[2] === "resources" && request.method === "GET") {
      const a = await account(owner,path[1]); if (!a) return fail("账户不存在。",404);
      return json({resources:await getAccountResources(a,url.searchParams.get("refresh")==="1")});
    }
    if (path[0] === "accounts" && path[1] && request.method === "DELETE") {
      const busy = await db().prepare("SELECT id FROM jobs WHERE owner=? AND account_id=? AND status IN ('submitting','queued','running','submission_unknown')").bind(owner,path[1]).first();
      const sessionBusy=await db().prepare("SELECT id FROM gpu_sessions WHERE owner=? AND account_id=? AND status NOT IN ('completed','failed')").bind(owner,path[1]).first();
      if (busy||sessionBusy) return fail("该账户仍有任务或GPU会话，请结束后再移除。",409);
      await db().prepare("UPDATE accounts SET deleted_at=?,cipher='' WHERE owner=? AND id=?").bind(Date.now(),owner,path[1]).run();await db().prepare("DELETE FROM settings WHERE id=?").bind(`account-proxy:${owner}:${path[1]}`).run(); return json({ok:true});
    }
    if(path[0]==="jobs"&&path.length===2&&request.method==="GET"){
      const row=await job(owner,path[1]);return row?json({job:jobView(row)}):fail("任务不存在。",404);
    }
    if (path[0] === "jobs" && path.length === 1 && request.method === "GET") {
      const result = await db().prepare("SELECT * FROM jobs WHERE owner=? ORDER BY created_at DESC LIMIT 100").bind(owner).all<Job>(); return json({jobs:result.results.map(jobView)});
    }
    if(path[0]==="sessions"&&path.length===1&&request.method==="GET"){
      const rows=await db().prepare("SELECT * FROM gpu_sessions WHERE owner=? ORDER BY created_at DESC LIMIT 30").bind(owner).all<any>();
      const sessions=[];for(const row of rows.results){const current=["completed","failed"].includes(row.status)?row:await syncGpuSession(owner,row.id);sessions.push(sessionView(current));}return json({sessions});
    }
    if(path[0]==="sessions"&&path.length===3&&path[2]==="stop"&&request.method==="POST")return json({session:sessionView(await stopGpuSession(db(),owner,path[1]))},202);
    if(path[0]==="sessions"&&path.length===3&&path[2]==="confirm-ended"&&request.method==="POST"){
      const value=await queueJson(request);if(value.confirmation!=="stopped-or-deleted-on-kaggle")return fail("请先确认已在Kaggle停止此会话。");
      const session=await getSession(db(),path[1]);if(!session||session.owner!==owner)return fail("会话不存在。",404);
      await db().batch([db().prepare("UPDATE gpu_sessions SET status='completed',stop_requested_at=COALESCE(stop_requested_at,?),last_error='用户确认已在Kaggle结束' WHERE id=?").bind(Date.now(),session.id),db().prepare("UPDATE jobs SET status='cancelled',stage='已停止（用户确认在Kaggle结束会话）',stop_requested_at=COALESCE(stop_requested_at,?),updated_at=? WHERE session_id=? AND status IN ('queued','running')").bind(Date.now(),Date.now(),session.id)]);return json({ok:true});
    }
    if(path[0]==='inputs'){
      const bucket=env.BUCKET;
      if(!bucket)return fail('输入图片存储尚未配置。',503);
      if(path.length===1&&request.method==='POST')return json(await storeInputImage(request,owner,bucket),201);
      if(path.length===2&&request.method==='GET')return inputImageResponse(owner,path[1],bucket);
      return fail('接口不存在。',404);
    }
    if (path[0] === "jobs" && path.length === 1 && request.method === "POST") {
      const value=await queueJson(request);
      if(generationImages(value || {}).length){
        if(!env.BUCKET)return fail('输入图片存储尚未配置。',503);
        const params=generationInput(value);
        await checkInputImages(owner,params,env.BUCKET);
      }
      await refreshSchedulingResources(owner,value);
      const result=await storage().atomic(d=>queueGeneration(d,owner,value));
      if(result.launch&&result.session)await launchSession(result.session,result.launch,url.origin);
      const row=result.launch?(await job(owner,result.row.id))??result.row:result.row;
      return json({job:jobView(row),replayed:result.replayed},result.replayed?200:201);
    }
    if(path[0]==="jobs" && path.length===3 && path[2]==="confirm-ended" && request.method==="POST"){
      const input=await readSmallJson(request);
      const row=await job(owner,path[1]);if(row?.session_id)return fail("请在GPU会话面板确认已在Kaggle结束，以同步处理整个队列。",409);
      const result=await confirmExternalStop(db(),owner,path[1],input.confirmation==="stopped-or-deleted-on-kaggle");
      return result.row?json({job:jobView(result.row)},result.status):fail(result.error!,result.status);
    }
    if (path[0] === "jobs" && path.length===3 && path[2] === "stop" && request.method === "POST") {
      const row=await job(owner,path[1]);if(row?.session_id)return json({job:jobView(await cancelQueuedJob(db(),owner,row.id))},row.status==="queued"?200:202);
      const result=await requestJobStop(db(),owner,path[1],async(accountId,sessionId)=>{
        const a=await account(owner,accountId);if(!a)throw new Error("对应账户已移除。");
        const response=await kaggle(await accountCredential(a),`cancel-session/${sessionId}`,{},{});
        if(response.errorMessage||response.error_message)throw new Error(response.errorMessage||response.error_message);
      });
      return result.row?json({job:jobView(result.row)},result.status):fail(result.error!,result.status);
    }
    if (path[0] === "jobs" && path[1] && path[2] === "sync" && request.method === "POST") return json({job:jobView(await sync(owner,path[1]))});
    if (path[0] === "jobs" && path[1] && ["video","artifact"].includes(path[2]) && path.length===3 && request.method === "GET") {
      const row = await job(owner,path[1]); if (!row || row.status !== "completed") return fail("作品尚未生成。",404);if(path[2]==="video"&&row.category==="image")return fail("这是图片作品，请使用作品接口。",400);
      if(row.session_id||row.artifact_key)return queueVideoResponse(request,row);
      const a = await account(owner,row.account_id); if (!a) return fail("请重新连接该 Kaggle 账户以下载视频。",410);
      const data = await output(await accountCredential(a),row.kernel_ref,row.version); const file = findFile(data,"minimax_h3_final.mp4"); if (!file) return fail("Kaggle 视频文件暂时不可用。",404);
      const range = request.headers.get("Range"); const response = await fetch(file,{headers:range ? {Range:range} : undefined});
      if (!response.ok) return fail("视频读取失败，请稍后重试。",502);
      const headers = new Headers({"Content-Type":"video/mp4","Cache-Control":"private, no-store","Accept-Ranges":"bytes","Content-Disposition":`${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="H3-${row.id.slice(0,8)}.mp4"`});
      for (const k of ["Content-Length","Content-Range"]) { const v = response.headers.get(k); if (v) headers.set(k,v); }
      return new Response(response.body,{status:response.status,headers});
    }
    return fail("接口不存在。",404);
  } catch (e) {
    if(e instanceof IntegrationError)return json({error:cleanError(e),code:e.code},e.status);
    return fail(cleanError(e),e instanceof QueueError ? e.status : e instanceof KaggleError && [401,403].includes(e.status) ? 403 : 400);
  }
}

