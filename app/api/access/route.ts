import {publicRequest} from '../../../lib/public-url';
import { handleAccessRequest } from "../../../lib/access";
import { siteAccessConfig } from "../../../lib/access-runtime";
import { db } from "../../../lib/store";
export const dynamic="force-dynamic";
async function route(request:Request){
  try{return await handleAccessRequest(publicRequest(request),siteAccessConfig(),async(key,now)=>{
    const next=JSON.stringify({attempts:1,expires:now+15*60_000});
    const result=await db().prepare("INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=CASE WHEN json_extract(settings.value,'$.expires')<=? THEN excluded.value ELSE json_set(settings.value,'$.attempts',json_extract(settings.value,'$.attempts')+1) END RETURNING value").bind(key,next,now).first<{value:string}>();
    if(!result)throw new Error("访问检查失败。");return JSON.parse(result.value);
  });}catch{return Response.json({error:"访问验证暂时不可用，请稍后重试。"},{status:503,headers:{"Cache-Control":"no-store"}});}
}
export {route as POST,route as DELETE};
