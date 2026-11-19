import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {H3_SAFE_MIXED_NODE} from '../lib/h3-mixed';
const result=spawnSync('python3',['-c',`import ast,sys,types,math,contextlib
source=ast.parse(sys.stdin.read());fn=next(n for n in ast.walk(source) if isinstance(n,ast.FunctionDef) and n.name=='_h3_mix_block')
class Tensor:
 def __init__(self,value,dtype='float32'):self.value=value;self.dtype=dtype;self.shape=(1,);self.device='cuda:0'
 def to(self,dtype):return Tensor(self.value,dtype)
 def float(self):return self.to('float32')
 def clone(self):return Tensor(self.value,self.dtype)
class OOM(RuntimeError):pass
calls=[];saved=[]
def original(self,x,*args,**kwargs):calls.append(x.value);return Tensor(x.value+100)
def finite(t):return types.SimpleNamespace(all=lambda:types.SimpleNamespace(item=lambda:math.isfinite(t.value)))
def mod(x,gate,branch,segments):x.value+=gate.value*branch.value;return x
stats={'executed':False,'fast_blocks':0,'fallback_blocks':0}
scope={'torch':types.SimpleNamespace(float32='float32',float16='float16',isfinite=finite,cuda=types.SimpleNamespace(OutOfMemoryError=OOM,empty_cache=lambda:None)),
 '_h3_mix_sdpa':lambda *a:contextlib.nullcontext(),'_H3MixBackend':types.SimpleNamespace(EFFICIENT_ATTENTION='efficient'),
 '_h3_mix_mm':types.SimpleNamespace(_mod_scale_shift=lambda x,shift,scale,segments:Tensor(x.value*(1+scale.value)+shift.value),_mod_gate=mod),
 '_h3_mix_stats':stats,'_h3_mix_save':lambda:saved.append(dict(stats)),'_h3_mix_original_block':original}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'mixed-guard','exec'),scope)
block=types.SimpleNamespace(adaln_proj=lambda t:[Tensor(n) for n in (0,0,1,0,0,1)],norm1=lambda x:x.clone(),norm2=lambda x:x.clone(),attn=lambda x,**kwargs:Tensor(2),mlp=lambda x:Tensor(3))
x=Tensor(7);out=scope['_h3_mix_block'](block,x,None,None,None)
assert out.value==12 and x.value==7 and not calls and stats['fast_blocks']==1
# 非有限输出不能截断或交付，完整退回原FP32块，原输入不可被部分计算污染。
block.mlp=lambda x:Tensor(float('inf'));out=scope['_h3_mix_block'](block,x,None,None,None)
assert out.value==107 and x.value==7 and calls==[7] and stats['fallback_blocks']==1
# CUDA OOM使用相同回退路径；其他编程错误必须暴露，避免掩盖故障。
def oom(x):raise OOM('allocation failed')
block.mlp=oom;out=scope['_h3_mix_block'](block,x,None,None,None);assert out.value==107 and calls==[7,7]
def broken(x):raise ValueError('unexpected bug')
block.mlp=broken
try:scope['_h3_mix_block'](block,x,None,None,None)
except ValueError:pass
else:raise AssertionError('unrelated error was hidden')
assert x.value==7
`],{input:H3_SAFE_MIXED_NODE,encoding:'utf8'});
assert.equal(result.status,0,result.stderr);
console.log('通过：混合精度保留输入、非有限数值/OOM完整退回原FP32、不裁剪、不隐藏其他错误。');
