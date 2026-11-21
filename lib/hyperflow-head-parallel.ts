import {attachHyperFlowJobConfig,HYPERFLOW_DUAL_T4_JOB_CONDITION} from './hyperflow-resident';
// 两卡按注意力头分工；每个头仍读取完整K/V，不做稀疏化或降精度。
export const HEAD_PARALLEL_CORE=String.raw`
import torch
import torch.nn.functional as F
from torch.nn.attention import sdpa_kernel, SDPBackend
from concurrent.futures import ThreadPoolExecutor
class HeadParallelSDPA:
    def __init__(self):
        self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix="hf-sdpa-gpu1")
    def __call__(self,q,k,v):
        b,heads,rows,dim=q.shape
        if heads<2 or heads%2 or q.dtype!=torch.float16 or q.device.index!=0:raise ValueError("不支持的双卡注意力输入")
        cut=heads//2
        torch.cuda.synchronize(0)
        def remote():
            with torch.inference_mode(),torch.cuda.device(1):
                qr,kr,vr=[x[:,cut:].to("cuda:1") for x in (q,k,v)]
                with sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION]):
                    out=F.scaled_dot_product_attention(qr,kr,vr,dropout_p=0.0,is_causal=False)
                torch.cuda.synchronize(1)
                return out
        future=self.pool.submit(remote)
        try:
            with sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION]):
                left=F.scaled_dot_product_attention(q[:,:cut],k[:,:cut],v[:,:cut],dropout_p=0.0,is_causal=False)
            output=torch.empty((b,rows,heads,dim),device=q.device,dtype=q.dtype)
            output[:,:,:cut].copy_(left.transpose(1,2));del left
            right=future.result()
            output[:,:,cut:].copy_(right.transpose(1,2));del right
            return output.reshape(b,rows,heads*dim)
        except BaseException:
            # 加入远端任务后才能把OOM交给外层原精度回退，避免两条计算路径并行争抢显存。
            try:future.result()
            except BaseException:pass
            raise
`;
export const HEAD_PARALLEL_INSTALL=String.raw`
from .head_parallel_core import HeadParallelSDPA
import comfy.model_management as _hf_head_mm
_hf_head_core=HeadParallelSDPA()
_hf_head_original_attention=_hf_mm.optimized_attention
_hf_head_active=None

def _hf_head_attention(q,k,v,heads,**kwargs):
    peek=lambda x:x.peek() if isinstance(x,_hf_mm.AttentionTensorContainer) else x
    qt,kt,vt=map(peek,(q,k,v))
    active=_hf_head_active
    preferred=kwargs.get("preferred_attention")
    allowed=(active is not None and qt.dtype==torch.float16 and qt.device.index==0 and heads>=2 and heads%2==0 and kwargs.get("skip_reshape",False) and not kwargs.get("skip_output_reshape",False) and kwargs.get("mask") is None and not kwargs.get("enable_gqa",False) and kwargs.get("scale") is None and not kwargs.get("transformer_options",{}).get("optimized_attention_override") and (preferred is None or preferred.function is None))
    if not allowed:return _hf_head_original_attention(q,k,v,heads,**kwargs)
    take=lambda x:x.take() if isinstance(x,_hf_mm.AttentionTensorContainer) else x
    qt,kt,vt=map(take,(q,k,v))
    result=_hf_head_core(qt,kt,vt)
    active["calls"]+=1;active["heads"]=heads;active["rows"]=int(qt.shape[2]);active["head_dim"]=int(qt.shape[3]);active["devices"]=["cuda:0","cuda:1"]
    return result
_hf_mm.optimized_attention=_hf_head_attention
def _hf_head_job_enabled(nonce):
    try:
        config=_hf_json.loads(_HFPath("/kaggle/working/hyperflow_active_job.json").read_text())
        return ${HYPERFLOW_DUAL_T4_JOB_CONDITION}
    except (OSError,ValueError,TypeError):return False
_hf_head_audit_original=StudioHyperFlowAudit.audit

def _hf_head_audit(self,model,nonce):
    result=_hf_head_audit_original(self,model,nonce)
    m=model.model.diffusion_model
    if not hasattr(m,"_hf_head_stats"):
        proof={"backend":"dual_t4_full_attention_heads_v1","calls":0,"dtype":"torch.float16","full_key_value_sequence":True,"sparse":False,"quantized_attention":False,"gpu1_released":False}
        m._hf_head_stats=proof
        m._studio_hf_mixed_stats["head_parallel"]=proof
        old_forward=m.forward
        def forward(*args,**kwargs):
            global _hf_head_active
            if not proof["enabled"]:return old_forward(*args,**kwargs)
            if not proof["gpu1_released"]:
                with torch.cuda.device(1):
                    _hf_head_mm.free_memory(torch.cuda.get_device_properties(1).total_memory,torch.device("cuda:1"))
                    torch.cuda.empty_cache()
                    proof["gpu1_free_bytes"]=torch.cuda.mem_get_info(1)[0]
                    if proof["gpu1_free_bytes"]<4*1024**3:raise RuntimeError("第二张T4未释放足够显存，拒绝假双卡加速")
                proof["gpu1_released"]=True
            _hf_head_active=proof
            try:return old_forward(*args,**kwargs)
            finally:_hf_head_active=None
        m._studio_hf_mixed_stats["head_parallel"]=proof
        m.forward=forward
    m._hf_head_stats["enabled"]=_hf_head_job_enabled(nonce)
    if getattr(m,"_hf_head_nonce",None)!=nonce:
        m._hf_head_stats.update(calls=0,gpu1_released=False)
        m._hf_head_nonce=nonce
    return result
StudioHyperFlowAudit.audit=_hf_head_audit
`;
const preflight=String.raw`
import importlib.util,json,torch
path=__import__("pathlib").Path(__import__("sys").argv[1])
spec=importlib.util.spec_from_file_location("hf_head_core",path);core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
if torch.cuda.device_count()!=2:raise RuntimeError("双卡预检需要两张GPU")
runner=core.HeadParallelSDPA();results=[]
with torch.inference_mode(),torch.cuda.device(0):
    for rows in [256,2048]:
        torch.manual_seed(20261118);q,k,v=[torch.randn(1,8,rows,128,device="cuda:0",dtype=torch.float16) for _ in range(3)]
        with core.sdpa_kernel([core.SDPBackend.EFFICIENT_ATTENTION]):expected=torch.nn.functional.scaled_dot_product_attention(q,k,v,dropout_p=0.0,is_causal=False)
        actual=runner(q,k,v).reshape(1,rows,8,128).transpose(1,2)
        delta=(expected.float()-actual.float()).abs();mae=delta.mean().item();max_error=delta.max().item()
        if not torch.isfinite(actual).all().item() or mae>2e-4 or max_error>2e-3:raise RuntimeError("双卡预检数值差异过大")
        results.append({"rows":rows,"mean_absolute_error":mae,"max_absolute_error":max_error})
print("HF_HEAD_PREFLIGHT "+json.dumps(results),flush=True)
(path.parent/"head_parallel_preflight.json").write_text(json.dumps(results))
runner.pool.shutdown()
`;
export function enableHyperFlowHeadParallel(n:any){
 attachHyperFlowJobConfig(n);
 let count=0;for(const c of n.cells){if(c.cell_type==='code'&&c.source.includes('_session_upload(current,path,digest)'))c.source=c.source.replace('            _session_upload(current,path,digest)','            metadata["head_parallel_preflight"]=json.loads((custom_node_dir/"head_parallel_preflight.json").read_text())\n            _session_upload(current,path,digest)');
 if(c.cell_type==='code'&&c.source.includes('(custom_node_dir / "__init__.py").write_text')){
  c.source=c.source.replace('(custom_node_dir / "__init__.py").write_text',`(custom_node_dir / "head_parallel_core.py").write_text(${JSON.stringify(HEAD_PARALLEL_CORE)})\ncustom_node_code += ${JSON.stringify(HEAD_PARALLEL_INSTALL)}\n(custom_node_dir / "__init__.py").write_text`);
  c.source+=`\nrun_checked([sys.executable,"-c",${JSON.stringify(preflight)},str(custom_node_dir/"head_parallel_core.py")],cwd=COMFY_DIR)\n`;count++;
 }}if(count!==1)throw Error('HyperFlow双卡注意力模板锚点不匹配');return n;
}
