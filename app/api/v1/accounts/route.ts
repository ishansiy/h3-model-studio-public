import { account,db,saveAccount } from "../../../../lib/store";
import { handleAccountIntegration,type ConnectedAccount } from "../../../../lib/integration-api";
import {getWorkspaceOwner} from "../../../../lib/workspace-runtime";
export const dynamic="force-dynamic";
const view=(a:ConnectedAccount)=>({id:a.id,name:a.name,username:a.username,hint:a.hint,created_at:a.created_at});
async function route(request:Request){let owner:string;try{owner=getWorkspaceOwner();}catch{return Response.json({error:"单人工作室尚未配置。",code:"workspace_unconfigured"},{status:503,headers:{"Cache-Control":"no-store"}});}return handleAccountIntegration(request,{
  database:db(),
  workspaceOwner:owner,
  list:async owner=>{const rows=await db().prepare("SELECT id,name,username,hint,created_at FROM accounts WHERE owner=? AND deleted_at IS NULL ORDER BY created_at").bind(owner).all<ConnectedAccount>();return rows.results.map(view);},
  save:async(owner,input)=>{const id=await saveAccount(owner,input.name,input.token,input.username);const row=await account(owner,id);if(!row)throw new Error("保存未完成。");return view(row);},
});}
export const GET=route;export const POST=route;export const DELETE=route;export const PUT=route;export const PATCH=route;export const OPTIONS=route;
