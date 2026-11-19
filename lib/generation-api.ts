import {IntegrationError,readSmallJson} from './integration-api';
import {MODEL_CATALOG,modelById,validateGenerationParams} from './model-catalog';
import {siteMaxSeconds} from './site-options';
import {randomVideoSeed} from './parameters';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUT_FIELDS=['requestId','accountId','category','modelId','prompt','mode','width','height','duration','steps','seed','runtimeProfile'];
export function generationInput(value:unknown,previous?:{accountId:string;params:any}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new IntegrationError('请提交生成参数。',400,'invalid_request');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!INPUT_FIELDS.includes(k)))throw new IntegrationError('包含未支持的字段，请参考 API 文档。',400,'invalid_request');
 if(typeof v.requestId!=='string'||!UUID.test(v.requestId)||typeof v.accountId!=='string'||!UUID.test(v.accountId))throw new IntegrationError('requestId、accountId 必须为 UUID。',400,'invalid_request');
 const model=modelById(String(v.modelId??(v.category==='image'?'z-image-turbo':'h3')));
 if(!model)throw new IntegrationError('模型不存在。',400,'invalid_parameters');
 let params;
 try{params=validateGenerationParams({...model.defaults,...(model.id==='h3'?{duration:Math.min(model.defaults.duration,siteMaxSeconds(Number(v.width??model.defaults.width),Number(v.height??model.defaults.height))),steps:v.mode==='turbo'?8:model.defaults.steps}:{}),...v,seed:v.seed===undefined?(previous?.params.seed??randomVideoSeed()):v.seed});}
 catch(e){throw new IntegrationError((e as Error).message,400,'invalid_parameters');}
 if(previous&&(previous.accountId!==v.accountId||JSON.stringify(previous.params)!==JSON.stringify(params)))throw new IntegrationError('requestId 已用于不同参数，请使用新的 UUID。',409,'idempotency_conflict');
 return {requestId:v.requestId,accountId:v.accountId,...params};
}
type Deps={authenticate:(r:Request,scope:string)=>Promise<string>;find:(owner:string,id:string)=>Promise<{accountId:string;params:any}|null>;list:(owner:string,limit:number,cursor:string|null)=>Promise<{jobs:any[];nextCursor:string|null}>;execute:(r:Request,path:string[],owner:string)=>Promise<Response>};
export function apiReply(data:unknown,status=200,headers:Record<string,string>={}){return Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});}
export async function handleGenerationApi(request:Request,path:string[],deps:Deps){
 const requestTrace=crypto.randomUUID();let response:Response;
 try{
  const resource=path[0],action=path[2];
  const methods=resource==='models'&&path.length===1?['GET']:resource==='jobs'&&path.length===1?['GET','POST']:resource==='jobs'&&path.length===2&&UUID.test(path[1])?['GET']:resource==='jobs'&&path.length===3&&UUID.test(path[1])?action==='artifact'?['GET']:['cancel','sync'].includes(action)?['POST']:[]:[];
  if(!methods.length)throw new IntegrationError('接口不存在。',404,'not_found');
  if(!methods.includes(request.method)){response=apiReply({error:'请求方法不支持。',code:'method_not_allowed'},405,{Allow:methods.join(', ')});}
  else{
   const scope=resource==='models'?'models:read':request.method==='GET'||action==='sync'?'jobs:read':'jobs:write';
   const owner=await deps.authenticate(request,scope);
   if(resource==='models')response=apiReply({models:MODEL_CATALOG});
   else if(path.length===1&&request.method==='GET'){
    const u=new URL(request.url),n=u.searchParams.get('limit')||'20',cursor=u.searchParams.get('cursor');
    if(!/^[0-9]+$/.test(n)||Number(n)<1||Number(n)>100||(cursor!==null&&!UUID.test(cursor)))throw new IntegrationError('limit 为 1–100，cursor 为上一页返回的任务 UUID。',400,'invalid_pagination');
    response=apiReply(await deps.list(owner,Number(n),cursor));
   }else if(path.length===1&&request.method==='POST'){
    const raw=await readSmallJson(request,32768);
    const id=typeof raw?.requestId==='string'&&UUID.test(raw.requestId)?raw.requestId:null;
    const old=id?await deps.find(owner,id):null;
    const input=generationInput(raw,old??undefined);
    response=old?await deps.execute(new Request(request.url,{method:'GET'}),['jobs',input.requestId],owner):await deps.execute(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),['jobs'],owner);
    if(response.ok){const data:any=await response.json();generationInput(raw,{accountId:data.job.accountId,params:data.job.params});response=apiReply({...data,replayed:!!old},old?200:202,{Location:`/api/v1/jobs/${input.requestId}`});}
   }else{
    if(path.length===3){const existing=await deps.find(owner,path[1]);if(!existing)throw new IntegrationError('任务不存在。',404,'not_found');}
    response=await deps.execute(request,action==='cancel'?['jobs',path[1],'stop']:path,owner);
   }
   if(!response.ok&&response.headers.get('Content-Type')?.includes('application/json')){const data:any=await response.json();response=apiReply({error:data.error||'请求失败。',code:data.code||({400:'invalid_request',401:'invalid_api_key',403:'forbidden',404:'not_found',409:'conflict',410:'artifact_gone',429:'rate_limited'} as Record<number,string>)[response.status]||'upstream_error'},response.status);}
  }
 }catch(e){
  const known=e instanceof IntegrationError;
  response=apiReply({error:known?e.message:'服务暂时不可用，请稍后重试。',code:known?e.code:'internal_error'},known?e.status:500,known&&e.status===429?{'Retry-After':String(60-Math.floor(Date.now()/1000)%60)}:{});
 }
 response.headers.set('X-Request-Id',requestTrace);return response;
}
