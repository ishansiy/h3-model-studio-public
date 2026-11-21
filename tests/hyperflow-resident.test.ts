import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {HYPERFLOW_RESIDENT_NODE,enableHyperFlowResident} from '../lib/hyperflow-resident';
const p=spawnSync('python3',['-c',`import ast,sys,types
source=ast.parse(sys.stdin.read());audit=next(n for n in ast.walk(source) if isinstance(n,ast.FunctionDef) and n.name=='_hf_resident_audit');assert [a.arg for a in audit.args.args]==['self','model','nonce'];fn=next(n for n in ast.walk(source) if isinstance(n,ast.FunctionDef) and n.name=='memory_required')
policy={'enabled':True,'activation_budget_bytes':6*1024**3,'original_estimate_bytes':[],'selected_estimate_bytes':[]}
scope={'policy':policy,'original_memory':lambda shape,cond:shape[0]}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'memory-estimator','exec'),scope)
f=scope['memory_required'];assert f(None,[2*1024**3])==2*1024**3;assert f(None,[13*1024**3])==6*1024**3
assert policy['original_estimate_bytes']==[2*1024**3,13*1024**3] and policy['selected_estimate_bytes']==[2*1024**3,6*1024**3]
policy['enabled']=False;assert f(None,[13*1024**3])==13*1024**3
assert 'torch.float16' not in sys.stdin.read()
# 同一模型在 5 秒、10 秒和普通任务之间切换预算，无需重新加载。
m=types.SimpleNamespace(forward=lambda *a:None,_studio_hf_mixed_stats={})
p=types.SimpleNamespace(model=types.SimpleNamespace(diffusion_model=m,memory_required=lambda *_:13*1024**3))
ctx={'_hf_resident_audit_original':lambda self,p,nonce:p,'_hf_resident_budget':lambda nonce:nonce*1024**3,'_hf_types':types}
exec(compile(ast.Module(body=[audit],type_ignores=[]),'resident-audit','exec'),ctx)
check=ctx['_hf_resident_audit']
for budget,expected in [(6,6),(11,11),(6,6),(0,13)]:
 check(None,p,budget)
 assert p.model.memory_required([1])==expected*1024**3
`],{input:HYPERFLOW_RESIDENT_NODE,encoding:'utf8'});assert.equal(p.status,0,p.stderr);
assert.throws(()=>enableHyperFlowResident({cells:[]}),/锚点/);
assert.ok(!HYPERFLOW_RESIDENT_NODE.includes('silu('));assert.ok(!HYPERFLOW_RESIDENT_NODE.includes('sdpa_kernel'));
console.log('通过：显存估算封顶保留较小估算、记录原值与峰值；不改数学运算或精度。');

import {buildHyperFlowNotebook} from '../lib/hyperflow';
import {validateHyperFlow} from '../lib/hyperflow-config';
for(const [width,height,steps,duration] of [[1024,768,4,5],[1024,768,6,5],[1024,768,4,10]] as const){
 const p=validateHyperFlow({prompt:'海边',width,height,steps,duration,seed:20260803});
 const n=buildHyperFlowNotebook(p,'https://studio.test/api/worker/session','a'.repeat(64),{safeMixed:true,resident:true});
 assert.ok(n.includes('hyperflow_active_job.json')&&n.includes('hyperflow_1024_fp16_budget_v1'));
}
console.log('通过：两档均注入逐任务显存策略。');
const n=buildHyperFlowNotebook(validateHyperFlow({prompt:'海边',width:1024,height:768,duration:5,steps:6,seed:20260803}),'https://studio.test/api/worker/session','a'.repeat(64),{safeMixed:true,resident:true});
const reuse=spawnSync('python3',['-c',`import ast,json,sys,types
n=json.load(sys.stdin);snippets=[]
for c in n['cells']:
 if c['cell_type']=='code':
  for a in ast.walk(ast.parse(c['source'])):
   if isinstance(a,ast.Constant) and isinstance(a.value,str) and 'def _hf_mixed_audit' in a.value:snippets.append(a.value)
source=ast.parse(snippets[0]);fn=next(x for x in source.body if isinstance(x,ast.FunctionDef) and x.name=='_hf_mixed_audit')
stats={'executed':True,'fast_blocks':282,'fallback_blocks':0,'forward_calls':6,'forward_wall_seconds':[1]*6,'factorized_mlps':17,'resident_policy':{'memory_samples':[1],'original_estimate_bytes':[13]}}
m=types.SimpleNamespace(_studio_hf_mixed_stats=stats);wrapper=types.SimpleNamespace(model=types.SimpleNamespace(diffusion_model=m));scope={'_studio_install_hyperflow_mixed':lambda m:None,'_hf_audit_original':lambda self,model,nonce:(model,)}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'audit','exec'),scope);f=scope['_hf_mixed_audit'];f(None,wrapper,'first');assert stats['fast_blocks']==0 and stats['forward_calls']==0 and stats['resident_policy']['memory_samples']==[] and stats['factorized_mlps']==17
stats['fast_blocks']=47;f(None,wrapper,'first');assert stats['fast_blocks']==47
f(None,wrapper,'second');assert stats['fast_blocks']==0 and m._studio_hf_job_nonce=='second' and m._studio_hf_mixed_stats is stats
`],{input:n,encoding:'utf8'});assert.equal(reuse.status,0,reuse.stderr);
console.log('通过：同会话新任务按nonce重置精度/显存证明，同一任务重复审计保留进度。');
import {HEAD_PARALLEL_INSTALL} from '../lib/hyperflow-head-parallel';
const gate=spawnSync('python3',['-c',`import ast,json,sys,tempfile,pathlib
sources=json.load(sys.stdin)
with tempfile.TemporaryDirectory() as d:
 path=pathlib.Path(d)/'job.json'
 for source,name in sources:
  fn=next(x for x in ast.parse(source).body if isinstance(x,ast.FunctionDef) and x.name==name);scope={'_HFPath':lambda _:path,'_hf_json':json}
  exec(compile(ast.Module(body=[fn],type_ignores=[]),'guard','exec'),scope);f=scope[name]
  assert not f('job')
  for width,height,frames,steps,budget in [(1024,768,124,4,6),(1024,768,124,6,6),(1024,768,243,4,11),(1024,768,243,6,0),(1024,768,243,8,0),(608,352,243,4,0),(1024,768,226,4,0),(1024,768,260,4,0),(608,352,124,4,0),(1024,768,141,4,0),(1024,768,124,8,0)]:
   path.write_text(json.dumps({'jobId':'job','width':width,'height':height,'frames':frames,'steps':steps}))
   actual=f('prefix-job')
   assert actual==(budget*1024**3 if name=='_hf_resident_budget' else bool(budget))
   assert not f('different-nonce')
  path.write_text('bad json');assert not f('job')
`],{input:JSON.stringify([[HYPERFLOW_RESIDENT_NODE,'_hf_resident_budget'],[HEAD_PARALLEL_INSTALL,'_hf_head_job_enabled']]),encoding:'utf8'});assert.equal(gate.status,0,gate.stderr);
console.log('通过：同一会话按逐任务尺寸/帧数/步数/nonce开关；切回标准档或更长视频恢复原策略，配置缺失/损坏不启用。');
