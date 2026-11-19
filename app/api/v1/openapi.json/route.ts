import {API_SPEC} from '../../../../lib/api-spec';
export function GET(){return Response.json(API_SPEC,{headers:{'Cache-Control':'public, max-age=300'}});}
