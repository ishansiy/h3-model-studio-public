import {API_SPEC} from '../../../../lib/api-spec';
export function GET(){
 const configured=process.env.RENDER_EXTERNAL_URL||process.env.PUBLIC_BASE_URL;
 const servers=configured?[{url:new URL(configured).origin}]:API_SPEC.servers;
 return Response.json({...API_SPEC,servers},{headers:{'Cache-Control':'public, max-age=300'}});
}
