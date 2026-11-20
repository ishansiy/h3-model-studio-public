import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { IMAGE_ID, INPUT_IMAGE_MAX_BYTES, generationImages, type GenerationInputs } from './generation-inputs';
import { IntegrationError } from './integration-api';

const mediaTypes = new Map([['image/png','png'],['image/jpeg','jpeg'],['image/webp','webp']]);
const inputKey = (owner: string, id: string) =>
  `input/${createHash('sha256').update(owner).digest('hex')}/${id}.png`;

export async function storeInputImage(request: Request, owner: string, bucket: R2Bucket) {
  const type = mediaTypes.get(request.headers.get('Content-Type') || '');
  if (!type) throw new IntegrationError('请上传 PNG、JPEG 或 WebP 图片。',415,'unsupported_media_type');
  const knownLength = Number(request.headers.get('Content-Length') || 0);
  if (knownLength > INPUT_IMAGE_MAX_BYTES) throw new IntegrationError('输入图片最大 8 MB。',413,'body_too_large');
  if (!request.body) throw new IntegrationError('未收到图片。',400,'invalid_image');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > INPUT_IMAGE_MAX_BYTES) {
        await reader.cancel();
        throw new IntegrationError('输入图片最大 8 MB。',413,'body_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let normalized;
  try {
    const image = sharp(Buffer.concat(chunks), {limitInputPixels:16_777_216, failOn:'warning'});
    const info = await image.metadata();
    if (info.format !== type || Number(info.pages ?? 1) !== 1) throw Error();
    normalized = await image.autoOrient().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true})
      .png().toBuffer({resolveWithObject:true});
  } catch {
    throw new IntegrationError('图片无法完整解码。请上传单帧 PNG、JPEG 或 WebP。',400,'invalid_image');
  }
  const id = createHash('sha256').update(normalized.data).digest('hex');
  const key = inputKey(owner,id);
  if (!await bucket.head(key)) {
    await bucket.put(key, normalized.data, {sha256:id,httpMetadata:{contentType:'image/png',cacheControl:'private, no-store'}});
  }
  return {id,width:normalized.info.width,height:normalized.info.height};
}

export async function checkInputImages(owner: string, params: GenerationInputs, bucket: R2Bucket) {
  const inputs = new Set(generationImages(params).map(([,id]) => id));
  const objects = await Promise.all([...inputs].map(id => bucket.head(inputKey(owner,id))));
  if (objects.some(object=>!object)) {
    throw new IntegrationError('找不到引用的输入图片，请重新上传。',404,'input_not_found');
  }
  if (params.sourceImage && params.maskImage) {
    const [source,mask] = await Promise.all(
      [params.sourceImage,params.maskImage].map(id => bucket.get(inputKey(owner,id))),
    );
    if (!source || !mask) throw new IntegrationError('找不到原图或蒙版。',404,'input_not_found');
    const bytes = async (object:R2ObjectBody) => Buffer.from(await new Response(object.body).arrayBuffer());
    const [sourceBytes,maskBytes] = await Promise.all([bytes(source),bytes(mask)]);
    const [sourceInfo,maskPixels] = await Promise.all([
      sharp(sourceBytes).metadata(),
      sharp(maskBytes).greyscale().removeAlpha().raw().toBuffer({resolveWithObject:true}),
    ]);
    if (sourceInfo.width!==maskPixels.info.width || sourceInfo.height!==maskPixels.info.height) {
      throw new IntegrationError('蒙版与原图的尺寸必须相同。',400,'invalid_mask');
    }
    if (!maskPixels.data.some(pixel=>pixel>=128)) {
      throw new IntegrationError('蒙版没有白色重绘区域。',400,'invalid_mask');
    }
  }
}

export async function inputImageResponse(owner: string, id: string, bucket: R2Bucket) {
  const image = IMAGE_ID.test(id) ? await bucket.get(inputKey(owner,id)) : null;
  if (!image) return Response.json({error:'找不到输入图片。',code:'input_not_found'},{status:404});
  return new Response(image.body,{headers:{
    'Content-Type':'image/png','Content-Length':String(image.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
  }});
}
