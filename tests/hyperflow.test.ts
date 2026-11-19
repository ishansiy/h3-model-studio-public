import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {buildModelNotebook} from '../lib/model-runners';
import {validateGenerationParams,modelForCategory} from '../lib/model-catalog';
import {HYPERFLOW} from '../lib/hyperflow-config';
import {NodeDatabase} from '../lib/node-runtime';
import {enqueue,finishQueueJob} from '../lib/session-queue';
const params={category:'video',modelId:HYPERFLOW.id,prompt:'海边少女；声音：海浪。',width:608,height:352,duration:5,steps:6,seed:'3609155487304108365'};
assert.equal(modelForCategory('video').id,'h3');assert.equal(modelForCategory('image').id,'z-image-turbo');
for(const steps of [4,6,8])assert.equal(validateGenerationParams({...params,steps}).steps,steps);
for(const p of [{steps:20},{steps:50},{steps:5},{mode:'turbo'},{runtimeProfile:'fp16'},{runtimeProfile:'ck'},{duration:4.46},{width:1344}])assert.throws(()=>validateGenerationParams({...params,...p}));
const nb=JSON.parse(buildModelNotebook(params,'https://studio.test/api/worker/test','a'.repeat(64)));
const code=nb.cells.filter((c:any)=>c.cell_type==='code').map((c:any)=>c.source);
assert.ok(code.some((s:string)=>s.includes(HYPERFLOW.revision)));assert.ok(code.some((s:string)=>s.includes(HYPERFLOW.comfyCommit)));assert.ok(!code.some((s:string)=>s.includes('"diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors":')));
const python=spawnSync('python3',['-c',`import ast,json,sys,types
n=json.load(sys.stdin);cells=[c['source'] for c in n['cells'] if c['cell_type']=='code'];[compile(c,'cell','exec') for c in cells];cells=[ast.literal_eval(ast.parse(c).body[0].value) if c.startswith('_STUDIO_CELL_SOURCE=') else c for c in cells]
for c in cells:
 for node in ast.walk(ast.parse(c)):
  if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='custom_node_code' for t in node.targets) and isinstance(node.value,ast.Constant):compile(node.value.value,'custom','exec')
source=next(c for c in cells if 'def build_h3_workflow(' in c);tree=ast.parse(source);defs=[a for a in tree.body if isinstance(a,ast.FunctionDef)]
scope={'HYPERFLOW_CHECKPOINT':'${HYPERFLOW.checkpoint}','DIFFUSION_NAME':'${HYPERFLOW.checkpoint}','TEXT_ENCODER_NAME':'text','VIDEO_VAE_NAME':'video','AUDIO_VAE_NAME':'audio','torch':types.SimpleNamespace(cuda=types.SimpleNamespace(device_count=lambda:2)),'MULTIGPU_NODE_AVAILABLE':True,'USE_TURBO':False,'RUNTIME_PROFILE':'standard','GENERATION_MODE':'Flash','SAMPLER_NAME':'res_multistep'}
exec(compile(ast.Module(body=defs,type_ignores=[]),'workflow','exec'),scope)
for steps in [4,6,8]:
 g,c=scope['build_h3_workflow'](prompt='x',width=608,height=352,duration_seconds=5,steps=steps,seed=123,use_gpu1_clip=True,filename_prefix='fresh-uuid')
 assert g['6']['class_type']=='HyperFlowLoader' and g['6']['inputs']['weights_in']=='disk'
 assert g['9']['class_type']=='HyperFlowSigmas' and g['9']['inputs']['steps']==steps
 assert g['17']['inputs']['sampler_name']=='euler' and g['16']['inputs']['model']==['121',0]
 assert g['121']['class_type']=='StudioHyperFlowAudit' and g['121']['inputs']['nonce']=='fresh-uuid'
 assert g['14']['inputs']['noise']==['122',0] and c['sampler']=='euler' and c['cfg']==1 and c['frames']==124
 assert '119' not in g and '120' not in g
print('Python与工作流通过')`],{input:JSON.stringify(nb),encoding:'utf8'});assert.equal(python.status,0,python.stderr);
const d=new NodeDatabase('',':memory:');await d.ready;
try{
 const q=await enqueue(d as any,'owner',{id:'a',name:'测试',username:'owner'},crypto.randomUUID(),params);assert.equal(q.session!.model_id,HYPERFLOW.id);assert.match(q.session!.kernel_ref,/studio-hflash-/);
 await assert.rejects(enqueue(d as any,'owner',{id:'a',name:'测试',username:'owner'},crypto.randomUUID(),{...params,modelId:'h3',mode:'quality',steps:20}),/切换模型/);
 await d.prepare("UPDATE jobs SET status='running',claim_token='claim',artifact_key='key',artifact_bytes=1,artifact_sha='sha' WHERE id=?").bind(q.row.id).run();
 const m:any={model_id:HYPERFLOW.id,model_repo:HYPERFLOW.repo,model_revision:HYPERFLOW.revision,comfyui_commit:HYPERFLOW.comfyCommit,nodes_commit:HYPERFLOW.nodesCommit,gguf_commit:HYPERFLOW.ggufCommit,runtime_profile:'standard',video_sha256:'sha',resolved_config:{...params,frames:124,sampler:'euler',cfg:1},media_validation:{width:608,height:352,frames:124,fps:24,audio_channels:2,full_decode_passed:true},hyperflow_proof:{model_id:HYPERFLOW.id,executed:true,two_time:true,quantization:'Q4_K_M',forward_calls:6,nonce:q.row.id}};
 const finish=(metadata:any)=>finishQueueJob(d as any,q.session!,{jobId:q.row.id,claimToken:'claim',status:'completed',metadata},async()=>({size:1}));
 await assert.rejects(finish({...m,hyperflow_proof:{...m.hyperflow_proof,forward_calls:0}}),/采样证明/);await assert.rejects(finish({...m,model_id:'h3'}),/采样证明/);await assert.rejects(finish({...m,resolved_config:{...m.resolved_config,sampler:'res_multistep'}}),/采样证明/);
 assert.equal((await finish(m)).status,'completed');
}finally{await d.close();}
console.log('通过：HyperFlow独立参数/调度/执行器、原模型默认保留、会话隔离、实际采样证明与成片交付。');
