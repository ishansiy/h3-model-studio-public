import {handleGenerationApi} from '../../../../lib/generation-api';
import {authenticateIntegration,IntegrationError} from '../../../../lib/integration-api';
import {db,job,jobView,type Job} from '../../../../lib/store';
import {getWorkspaceOwner} from '../../../../lib/workspace-runtime';
import {dispatchStudio} from '../../../../lib/studio-http';
export const dynamic='force-dynamic';
async function route(request:Request,context:{params:Promise<{path:string[]}>}){
 const {path}=await context.params;
 return handleGenerationApi(request,path,{
  authenticate:async(r,scope)=>{let workspace:string;try{workspace=getWorkspaceOwner();}catch{throw new IntegrationError('工作室尚未配置。',503,'workspace_unconfigured');}const owner=await authenticateIntegration(r,db(),Date.now(),scope);if(owner!==workspace)throw new IntegrationError('密钥不属于当前工作室。',401,'invalid_api_key');return owner;},
  find:async(owner,id)=>{const row=await job(owner,id);return row?jobView(row):null;},
  list:async(owner,limit,cursor)=>{
   const anchor=cursor?await job(owner,cursor):null;if(cursor&&!anchor)throw new IntegrationError('分页游标不存在。',400,'invalid_pagination');
   const q=anchor?db().prepare('SELECT * FROM jobs WHERE owner=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?').bind(owner,anchor.created_at,anchor.created_at,anchor.id,limit+1):db().prepare('SELECT * FROM jobs WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT ?').bind(owner,limit+1);
   const rows=(await q.all<Job>()).results;return {jobs:rows.slice(0,limit).map(jobView),nextCursor:rows.length>limit?rows[limit-1].id:null};
  },
  execute:dispatchStudio,
 });
}
export const GET=route;export const POST=route;export const DELETE=route;export const PUT=route;export const PATCH=route;export const OPTIONS=route;
