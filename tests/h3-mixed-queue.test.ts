import assert from 'node:assert/strict';
import {NodeDatabase} from '../lib/node-runtime';
import {enqueue,workerPoll,finishQueueJob} from '../lib/session-queue';
import {validateParams,frameCount} from '../lib/parameters';
const p={prompt:'夕阳海边，画质对照',mode:'quality',width:512,height:288,duration:4,steps:20,seed:123,runtimeProfile:'fp16'};
assert.equal(validateParams(p).runtimeProfile,'fp16');assert.throws(()=>validateParams({...p,mode:'turbo',steps:8}),/仅验证原版/);
const d=new NodeDatabase('',':memory:');await d.ready;const db=d as unknown as D1Database;
try{
 const a={id:'a',name:'测试',username:'test'},q=await enqueue(db,'owner',a,'mixed',p);assert.equal(q.session!.profile,'fp16');
 await assert.rejects(enqueue(db,'owner',a,'other',{...p,runtimeProfile:'standard'}),/混合精度加速/);
 const current=await workerPoll(db,q.session!),claim=current.job!.claimToken;
 await d.prepare('UPDATE jobs SET artifact_key=?,artifact_sha=?,artifact_bytes=? WHERE id=?').bind('video','a'.repeat(64),100,'mixed').run();
 const m={runtime_profile:'fp16',resolved_config:{...p,frames:frameCount(p.duration)},media_validation:{full_decode_passed:true,width:512,height:288,frames:107,fps:24,audio_channels:2},video_sha256:'a'.repeat(64)};
 const finish=(metadata:any)=>finishQueueJob(db,q.session!,{jobId:'mixed',claimToken:claim,status:'completed',metadata},async()=>({size:100}));
 await assert.rejects(finish(m),/混合精度执行证明/);
 const proof={backend:'h3_safe_fp16_branches',executed:true,fast_blocks:1000,residual_dtype:'torch.float32',branch_dtype:'torch.float16',clamping:false,weights_unchanged:true,fp32_condition_preserved:true,fp32_outputs_preserved:true};
 for(const patch of [{executed:false},{clamping:true},{fast_blocks:0},{residual_dtype:'torch.float16'},{weights_unchanged:false},{fp32_condition_preserved:false},{fp32_outputs_preserved:false},{fast_blocks:undefined}])await assert.rejects(finish({...m,precision_proof:{...proof,...patch}}),/混合精度执行证明/);
 await assert.rejects(finish({...m,precision_proof:proof,attention_proof:{backend:'comfy_kitchen_int8'}}),/不应启用注意力量化/);
 const done=await finish({...m,precision_proof:proof});assert.equal(done.status,'completed');
 console.log('通过：FP16独立会话、Turbo拒绝、原精度隔离、缺失/错误精度证明拒绝、完整参数与媒体证明后交付。');
}finally{await d.close();}
