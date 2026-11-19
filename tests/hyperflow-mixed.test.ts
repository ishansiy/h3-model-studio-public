import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {HYPERFLOW_SAFE_MIXED_NODE} from '../lib/hyperflow-mixed';
const result=spawnSync('python3',['-c',`import ast,sys,types,math,contextlib
source=ast.parse(sys.stdin.read());fn=next(n for n in ast.walk(source) if isinstance(n,ast.FunctionDef) and n.name=='forward')
class Tensor:
 def __init__(self,value,dtype='float32'):self.value=value;self.dtype=dtype;self.shape=(1,);self.device='cuda:0'
 def to(self,dtype):return Tensor(self.value,dtype)
 def float(self):return self.to('float32')
 def half(self):return self.to('float16')
 def clone(self):return Tensor(self.value,self.dtype)
class OOM(RuntimeError):pass
calls=[];saved=[]
def original(x,*args,**kwargs):calls.append(x.value);return Tensor(x.value+100)
def finite(t):return types.SimpleNamespace(all=lambda:types.SimpleNamespace(item=lambda:math.isfinite(t.value)))
def mod(x,gate,branch,segments):x.value+=gate.value*branch.value;return x
stats={'executed':False,'fast_blocks':0,'fallback_blocks':0}
scope={'torch':types.SimpleNamespace(float32='float32',float16='float16',isfinite=finite,cuda=types.SimpleNamespace(OutOfMemoryError=OOM,empty_cache=lambda:None)),
 '_hf_sdpa':lambda *a:contextlib.nullcontext(),'_HFBackend':types.SimpleNamespace(EFFICIENT_ATTENTION='efficient'),
 '_hf_mm':types.SimpleNamespace(_mod_scale_shift=lambda x,shift,scale,segments:Tensor(x.value*(1+scale.value)+shift.value),_mod_gate=mod),
 'stats':stats,'original_block':original}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'mixed-guard','exec'),scope)
block=types.SimpleNamespace(adaln_proj=lambda t:[Tensor(n) for n in (0,0,1,0,0,1)],norm1=lambda x:x.clone(),norm2=lambda x:x.clone(),attn=lambda x,**kwargs:Tensor(2),mlp=lambda x:Tensor(3))
x=Tensor(7);out=scope['forward'](block,x,None,None,None)
assert out.value==12 and x.value==7 and not calls and stats['fast_blocks']==1
# 非有限输出不能截断或交付，完整退回原FP32块，原输入不可被部分计算污染。
block.mlp=lambda x:Tensor(float('inf'));out=scope['forward'](block,x,None,None,None)
assert out.value==107 and x.value==7 and calls==[7] and stats['fallback_blocks']==1
# CUDA OOM使用相同回退路径；其他编程错误必须暴露，避免掩盖故障。
def oom(x):raise OOM('allocation failed')
block.mlp=oom;out=scope['forward'](block,x,None,None,None);assert out.value==107 and calls==[7,7]
def broken(x):raise ValueError('unexpected bug')
block.mlp=broken
try:scope['forward'](block,x,None,None,None)
except ValueError:pass
else:raise AssertionError('unrelated error was hidden')
assert x.value==7
`],{input:HYPERFLOW_SAFE_MIXED_NODE,encoding:'utf8'});
assert.equal(result.status,0,result.stderr);
console.log('通过：混合精度保留输入、非有限数值/OOM完整退回原FP32、不裁剪、不隐藏其他错误。');

import {buildHyperFlowNotebook} from '../lib/hyperflow';
import {validateHyperFlow} from '../lib/hyperflow-config';
const params=validateHyperFlow({prompt:'海边',width:608,height:352,duration:5,steps:6,seed:20260803});
const baseline=JSON.parse(buildHyperFlowNotebook(params,'https://studio.test/api/worker/session','a'.repeat(64)));
const mixed=JSON.parse(buildHyperFlowNotebook(params,'https://studio.test/api/worker/session','a'.repeat(64),{safeMixed:true}));
const codes=(n:any)=>n.cells.filter((c:any)=>c.cell_type==='code').map((c:any)=>c.source).join('\n');
assert.ok(!codes(baseline).includes('hyperflow_safe_fp16_branches_v1'));
assert.ok(codes(mixed).includes('hyperflow_safe_fp16_branches_v1'));
assert.ok(codes(mixed).includes('hyperflow_precision_proof'));
console.log('通过：原GGUF路径可保留，专用混合精度显式启用并要求实际执行证明。');
