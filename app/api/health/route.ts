import {checkStorage} from '../../../lib/node-runtime';
export const dynamic='force-dynamic';
export async function GET(){try{await checkStorage();return Response.json({ok:true});}catch{return Response.json({ok:false},{status:503});}}
