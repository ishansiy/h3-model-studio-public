import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {HEAD_PARALLEL_CORE,HEAD_PARALLEL_INSTALL} from '../lib/hyperflow-head-parallel';
const test=spawnSync('python3',['-c',`import json,ast,sys,types,math,random
s=json.load(sys.stdin);tree=ast.parse(s['install']);fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_hf_head_attention')
class C:
 def __init__(self,t):self.t=t
 def peek(self):assert self.t is not None;return self.t
 def take(self):t=self.peek();self.t=None;return t
x=types.SimpleNamespace(dtype='half',device=types.SimpleNamespace(index=0),shape=(1,8,128,64));proof={'calls':0};fallback=[]
ctx={'_hf_mm':types.SimpleNamespace(AttentionTensorContainer=C),'torch':types.SimpleNamespace(float16='half'),'_hf_head_active':proof,'_hf_head_core':lambda q,k,v:'parallel','_hf_head_original_attention':lambda *a,**k:fallback.append(a) or 'original'}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'adapter','exec'),ctx);f=ctx['_hf_head_attention']
q,k,v=[C(x) for _ in range(3)];assert f(q,k,v,8,skip_reshape=True,mask=None)=='parallel' and q.t is None and proof['calls']==1
q,k,v=[C(x) for _ in range(3)];assert f(q,k,v,8,skip_reshape=True,mask='mask')=='original' and q.t is x
audit=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_hf_head_audit');assert [x.arg for x in audit.args.args]==['self','model','nonce']
m=types.SimpleNamespace(forward=lambda *a:None,_studio_hf_mixed_stats={});model=types.SimpleNamespace(model=types.SimpleNamespace(diffusion_model=m));scope={'_hf_head_audit_original':lambda self,model,nonce:(model,),'_hf_head_job_enabled':lambda nonce:nonce!='disabled'}
exec(compile(ast.Module(body=[audit],type_ignores=[]),'audit','exec'),scope);af=scope['_hf_head_audit'];af(None,model,'a');m._hf_head_stats.update(calls=282,gpu1_released=True);af(None,model,'a');assert m._hf_head_stats['calls']==282
old_forward=m.forward;af(None,model,'b');assert m._hf_head_stats['calls']==0 and not m._hf_head_stats['gpu1_released'] and m.forward is old_forward
af(None,model,'disabled');assert not m._hf_head_stats['enabled'];assert m.forward() is None
# 注意力沿头独立：拆头仍保留每个头的全部query/key/value，不改变softmax范围和头顺序。
rng=random.Random(9);q,k,v=[[[rng.uniform(-1,1) for d in range(3)] for row in range(5)] for head in range(8)],None,None
k=[[[rng.uniform(-1,1) for d in range(3)] for row in range(5)] for head in range(8)];v=[[[rng.uniform(-1,1) for d in range(3)] for row in range(5)] for head in range(8)]
def attention(q,k,v):
 out=[]
 for qh,kh,vh in zip(q,k,v):
  rows=[]
  for qr in qh:
   logits=[sum(a*b for a,b in zip(qr,kr))/math.sqrt(3) for kr in kh];ex=[math.exp(x-max(logits)) for x in logits];weights=[x/sum(ex) for x in ex]
   rows.append([sum(weights[i]*vh[i][d] for i in range(5)) for d in range(3)])
  out.append(rows)
 return out
full=attention(q,k,v);split=attention(q[:4],k[:4],v[:4])+attention(q[4:],k[4:],v[4:]);assert full==split
compile(s['core'],'core','exec')
`],{input:JSON.stringify({core:HEAD_PARALLEL_CORE,install:HEAD_PARALLEL_INSTALL}),encoding:'utf8'});assert.equal(test.status,0,test.stderr);
console.log('通过：完整K/V拆头数学一致、头顺序保留、容器仅在适用时消费、不支持的mask回到原路径；GPU另做预检。');

import {buildHyperFlowNotebook} from '../lib/hyperflow';
import {validateHyperFlow} from '../lib/hyperflow-config';
for(const [width,height,steps] of [[1024,768,4],[1024,768,6],[608,352,4],[1024,768,8]] as const){const n=buildHyperFlowNotebook(validateHyperFlow({prompt:'海边',width,height,steps,duration:5,seed:20260803}),'https://studio.test/api/worker/session','a'.repeat(64),{safeMixed:true,resident:true,headParallel:true});assert.ok(n.includes('dual_t4_full_attention_heads_v1')&&n.includes('hyperflow_active_job.json'));}
console.log('通过：1024×768 的 4 步与 6 步采样使用同一双卡 Notebook 模板。');
