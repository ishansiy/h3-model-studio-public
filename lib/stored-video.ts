import {QueueError} from './session-queue';
export async function storedVideoResponse(request:Request,row:{id:string;artifact_key?:string|null;category?:string},bucket:R2Bucket|undefined){
 if(!bucket||!row.artifact_key)throw new QueueError('成片存储暂不可用。',503);
 const head=await bucket.head(row.artifact_key);if(!head)throw new QueueError('视频文件不存在。',404);
 const range=request.headers.get('Range');let offset=0,length=head.size;
 if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${head.size}`}});if(!m[1]){length=Math.min(head.size,Number(m[2]));offset=head.size-length;}else{offset=Number(m[1]);const end=m[2]?Math.min(Number(m[2]),head.size-1):head.size-1;length=end-offset+1;}if(offset>=head.size||length<=0)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${head.size}`}});}
 const object=await bucket.get(row.artifact_key,{range:{offset,length}});if(!object)throw new QueueError('视频文件不存在。',404);
 const isImage=row.category==='image';const headers=new Headers({'Content-Type':isImage?'image/png':'video/mp4','Content-Length':String(length),'Accept-Ranges':'bytes','Cache-Control':'private, no-store','Content-Disposition':`${new URL(request.url).searchParams.get('download')==='1'?'attachment':'inline'}; filename="Studio-${row.id.slice(0,8)}.${isImage?'png':'mp4'}"`});if(range)headers.set('Content-Range',`bytes ${offset}-${offset+length-1}/${head.size}`);return new Response(object.body,{status:range?206:200,headers});
}
