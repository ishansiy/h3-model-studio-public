import sharp from 'sharp';
import {QueueError} from './session-queue';

export async function readImageUpload(request:Request,width:number,height:number){
 const size=Number(request.headers.get('Content-Length'));
 if(request.headers.get('Content-Type')!=='image/png'||!Number.isSafeInteger(size)||size<1||size>20*1024*1024||!request.body)throw new QueueError('图片上传只支持20MB以内的PNG。',413);
 const chunks:Uint8Array[]=[];let length=0;const reader=request.body.getReader();
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>size){await reader.cancel();throw new QueueError('图片上传长度不匹配。',400);}chunks.push(part.value);}}finally{reader.releaseLock();}
 if(length!==size)throw new QueueError('图片上传不完整。',400);
 const bytes=Buffer.concat(chunks);
 if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new QueueError('图片格式校验失败。',400);
 try{
  const decoded=await sharp(bytes,{limitInputPixels:1024*1024,failOn:'warning'}).raw().toBuffer({resolveWithObject:true});
  if(decoded.info.width!==width||decoded.info.height!==height)throw Error();
 }catch{throw new QueueError('PNG完整解码或尺寸校验失败。',400);}
 return bytes;
}
