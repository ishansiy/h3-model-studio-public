import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import sharp from 'sharp';
import {NodeDatabase,NodeBucket} from '../lib/node-runtime';
import {CATEGORIES,MODEL_CATALOG,validateGenerationParams} from '../lib/model-catalog';
import {enqueue,getSession,finishQueueJob} from '../lib/session-queue';
import {workerApi} from '../lib/session-worker-api';
import {storedVideoResponse} from '../lib/stored-video';
import {buildModelNotebook} from '../lib/model-runners';
import {storeInputImage,inputImageResponse,checkInputImages} from '../lib/input-images';
import {DUAL_T4_RUNTIME} from '../lib/image-placement';
const image={category:'image',modelId:'z-image-turbo',prompt:'清晨的海边玻璃小屋',width:512,height:512,steps:9,seed:'12345'};
const placement=spawnSync('python3',['-c',`import ast,sys
tree=ast.parse(sys.stdin.read());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_resident_split')
scope={};exec(compile(ast.Module(body=[fn],type_ignores=[]),'planner','exec'),scope);plan=scope['_resident_split']
assert plan([1]*10,2,[8,8])==(4,(6,6))
assert plan([1]*10,2,[5,9])==(2,(4,8))
assert plan([723641344]*30,24619634944-723641344*30,[int(11.5*1024**3),int(12.5*1024**3)],[int(14.5*1024**3)]*2)[0]==13
for blocks,other,limits in [([5,1,1,1],1,[7,3]),([3,4,2,5,1],2,[9,10])]:
 split,sizes=plan(blocks,other,limits);assert 0<split<len(blocks);assert sum(sizes)==sum(blocks)+other;assert all(a<=b for a,b in zip(sizes,limits))
try:plan([4,4],4,[5,5]);raise AssertionError('accepted insufficient VRAM')
except RuntimeError:pass
print('placement passed')`],{input:DUAL_T4_RUNTIME,encoding:'utf8'});assert.equal(placement.status,0,placement.stderr);
for(const c of CATEGORIES)assert.equal(MODEL_CATALOG.filter(m=>m.category===c.id&&m.id===c.defaultModelId).length,1);
assert.equal(validateGenerationParams(image).modelId,'z-image-turbo');
for(const patch of [{modelId:'h3'},{category:'video'},{steps:20},{width:2048},{duration:5},{mode:'quality'},{runtimeProfile:'ck'},{runtimeProfile:'fp16'},{seed:'18446744073709551616'}])assert.throws(()=>validateGenerationParams({...image,...patch}));
const legacy={prompt:'海边',width:608,height:352,duration:5,mode:'quality',steps:20,seed:1};assert.equal(validateGenerationParams(legacy).modelId,'h3');assert.throws(()=>validateGenerationParams({...legacy,category:'video',modelId:'z-image-turbo'}));
const d=new NodeDatabase('',':memory:');await d.ready;const db=d as unknown as D1Database,bucket=new NodeBucket(d),a={id:'a',name:'测试账户',username:'testuser'},id=crypto.randomUUID();
try{
 const q=await enqueue(db,'owner',a,id,image);assert.ok(q.launch);assert.equal(q.session!.category,'image');assert.equal(q.session!.model_id,'z-image-turbo');assert.equal(q.row.total_steps,9);assert.equal(q.row.category,'image');
 const duplicate=await enqueue(db,'owner',a,id,image);assert.equal(duplicate.launch,null);
 await assert.rejects(enqueue(db,'owner',a,crypto.randomUUID(),legacy),/切换模型/);assert.equal((await d.prepare('SELECT COUNT(*) AS n FROM gpu_sessions').first<any>()).n,1);
 const worker=crypto.randomUUID(),base=`https://studio.test/api/worker/${q.session!.id}`,headers={'Authorization':'Bearer '+q.launch!.token,'X-H3-Worker':worker};
 const poll=await workerApi(new Request(base+'/poll',{method:'POST',headers,body:'{}'}),['worker',q.session!.id,'poll'],db,bucket as any);assert.equal(poll.status,200);const current=(await poll.json() as any).job;assert.equal(current.id,id);
 const bytes=await sharp({create:{width:512,height:512,channels:3,background:'#c9a06a'}}).png().toBuffer(),sha=createHash('sha256').update(bytes).digest('hex');
 const upload=()=>new Request(base+`/artifact/${id}?claim=${current.claimToken}`,{method:'PUT',headers:{...headers,'Content-Type':'image/png','Content-Length':String(bytes.length),'X-Artifact-SHA256':sha},body:new Uint8Array(bytes)});
 const uploaded=await workerApi(upload(),['worker',q.session!.id,'artifact',id],db,bucket as any);assert.equal(uploaded.status,200);
 const row=await d.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<any>();assert.equal(row.artifact_mime,'image/png');assert.equal(row.artifact_sha,sha);
 const s=(await getSession(db,q.session!.id))!,metadata={category:'image',model_id:'z-image-turbo',runtime_profile:'standard',resolved_config:{width:512,height:512,steps:9,seed:'12345'},image_validation:{format:'png',width:512,height:512,full_decode_passed:true},artifact_sha256:sha};
 await assert.rejects(finishQueueJob(db,s,{jobId:id,claimToken:current.claimToken,status:'completed',metadata:{...metadata,image_validation:{...metadata.image_validation,full_decode_passed:false}}},key=>bucket.head(key)),/解码证明/);
 const done=await finishQueueJob(db,s,{jobId:id,claimToken:current.claimToken,status:'completed',metadata},key=>bucket.head(key));assert.equal(done.status,'completed');assert.equal(done.stage,'图片已生成');
 const media=await storedVideoResponse(new Request('https://studio.test/artifact'),done,bucket as any);assert.equal(media.headers.get('Content-Type'),'image/png');assert.match(media.headers.get('Content-Disposition')!,/\.png/);assert.deepEqual(Buffer.from(await media.arrayBuffer()),bytes);
 const range=await storedVideoResponse(new Request('https://studio.test/artifact',{headers:{Range:'bytes=0-7'}}),done,bucket as any);assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
 const inputRequest=(body:Buffer)=>new Request('https://studio.test/api/inputs',{method:'POST',headers:{'Content-Type':'image/png'},body:new Uint8Array(body)});
 const source=await storeInputImage(inputRequest(bytes),'owner',bucket as any);
 const mask=await sharp({create:{width:512,height:512,channels:3,background:'#ffffff'}}).png().toBuffer();
 const maskInput=await storeInputImage(inputRequest(mask),'owner',bucket as any);
 const wrongMask=await sharp({create:{width:256,height:256,channels:3,background:'#ffffff'}}).png().toBuffer();
 const wrongSize=await storeInputImage(inputRequest(wrongMask),'owner',bucket as any);
 await assert.rejects(checkInputImages('owner',{sourceImage:source.id,maskImage:wrongSize.id},bucket as any),/尺寸/);
 const conditional=validateGenerationParams({...image,generationType:'inpaint',sourceImage:source.id,maskImage:maskInput.id});
 assert.equal(conditional.strength,1);
 assert.throws(()=>validateGenerationParams({...conditional,maskImage:undefined}),/上传/);
 assert.throws(()=>validateGenerationParams({...image,generationType:'image-to-image',sourceImage:source.id,strength:0.1}),/重绘幅度/);
 await checkInputImages('owner',conditional,bucket as any);
 await assert.rejects(checkInputImages('other',conditional,bucket as any),/找不到/);
 assert.equal((await inputImageResponse('other',source.id,bucket as any)).status,404);
 const next=await enqueue(db,'owner',a,crypto.randomUUID(),conditional);assert.equal(next.launch,null);
 const claim2=await(await workerApi(new Request(base+'/poll',{method:'POST',headers,body:'{}'}),['worker',s.id,'poll'],db,bucket as any)).json() as any;
 assert.equal(claim2.job.params.sourceImage,source.id);
 const workerInput=(claim:string,role:string,workerHeaders=headers)=>workerApi(
  new Request(base+`/inputs/${claim2.job.id}/${role}?claim=${claim}`,{headers:workerHeaders}),
  ['worker',s.id,'inputs',claim2.job.id,role],db,bucket as any);
 assert.equal((await workerInput('wrong','sourceImage')).status,409);
 assert.equal((await workerInput(claim2.job.claimToken,'firstFrame')).status,404);
 assert.equal((await workerInput(claim2.job.claimToken,'sourceImage',{'Authorization':'Bearer '+'b'.repeat(64),'X-H3-Worker':worker})).status,401);
 const sourceRead=await workerInput(claim2.job.claimToken,'sourceImage');assert.equal(sourceRead.status,200);
 assert.equal(createHash('sha256').update(Buffer.from(await sourceRead.arrayBuffer())).digest('hex'),source.id);
 const editFinish=(extra:Record<string,unknown>)=>finishQueueJob(db,s,
  {jobId:claim2.job.id,claimToken:claim2.job.claimToken,status:'completed',metadata:{...metadata,...extra}},key=>bucket.head(key));
 await assert.rejects(editFinish({}),/校验证明/);
 const bad=new Request(base+`/artifact/${claim2.job.id}?claim=${claim2.job.claimToken}`,{method:'PUT',headers:{...headers,'Content-Type':'image/png','Content-Length':'5','X-Artifact-SHA256':'a'.repeat(64)},body:'notpng'});assert.equal((await workerApi(bad,['worker',s.id,'artifact',claim2.job.id],db,bucket as any)).status,400);
 await d.query('UPDATE jobs SET stop_requested_at=? WHERE id=?',[Date.now(),claim2.job.id]);assert.equal((await workerApi(new Request(base+`/artifact/${claim2.job.id}?claim=${claim2.job.claimToken}`,{method:'PUT',headers}),['worker',s.id,'artifact',claim2.job.id],db,bucket as any)).status,409);
 const notebook=JSON.parse(buildModelNotebook(image,base,'a'.repeat(64)));assert.ok(notebook.cells.some((c:any)=>String(c.source).includes('ZImagePipeline')));assert.ok(!JSON.stringify(notebook).includes(image.prompt));
 const python=spawnSync('python3',['-c','import sys,json,ast; n=json.load(sys.stdin); code=[c["source"] for c in n["cells"] if c["cell_type"]=="code"]; [compile(c,"cell","exec") for c in code]; code=[ast.literal_eval(ast.parse(c).body[0].value) if c.startswith("_STUDIO_CELL_SOURCE=") else c for c in code]; children=[ast.literal_eval(a.value) for c in code for a in ast.walk(ast.parse(c)) if isinstance(a,ast.Assign) and any(isinstance(t,ast.Name) and t.id=="_CHILD_SOURCE" for t in a.targets)]; [compile(c,"child","exec") for c in children]; assert children and "a"*64 not in children[0]; print("ok")'],{input:JSON.stringify(notebook),encoding:'utf8'});assert.equal(python.status,0,python.stderr);
 console.log('通过：分类默认模型、参数隔离、旧H3兼容、模型会话隔离、图像任务领取/PNG完整解码上传/校验/下载、取消保护、Notebook Python编译。');
}finally{await d.close();}
const dir=mkdtempSync(join(tmpdir(),'model-studio-migration-'));try{const path=join(dir,'old.db'),old=new DatabaseSync(path);old.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,account_id TEXT,status TEXT,session_id TEXT,created_at BIGINT); CREATE TABLE gpu_sessions(id TEXT PRIMARY KEY,account_id TEXT,status TEXT,owner TEXT,created_at BIGINT);');old.exec("INSERT INTO jobs(id,owner,account_id,status,created_at) VALUES('old','owner','a','completed',1)");old.close();const migrated=new NodeDatabase('',path);await migrated.ready;const row=await migrated.prepare("SELECT category,model_id FROM jobs WHERE id='old'").first<any>();assert.equal(row.category,'video');assert.equal(row.model_id,'h3');await migrated.close();console.log('通过：既有数据库无损升级，历史H3任务自动保留视频类别和模型。');}finally{rmSync(dir,{recursive:true,force:true});}
