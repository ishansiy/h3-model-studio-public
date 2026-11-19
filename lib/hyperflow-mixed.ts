// HyperFlow 专用安全分支：不修改 GGUF 权重、采样器或步数；只在候选实测显式启用。
export const HYPERFLOW_SAFE_MIXED_NODE=String.raw`
import types as _hf_types
import time as _hf_time
import comfy.ldm.minimax.model as _hf_mm
import torch.nn.functional as _hf_f
from torch.nn.attention import sdpa_kernel as _hf_sdpa, SDPBackend as _HFBackend

def _studio_install_hyperflow_mixed(model):
    if getattr(model,"_studio_hf_mixed_installed",False):return
    stats={"backend":"hyperflow_safe_fp16_branches_v1","executed":False,"fast_blocks":0,"fallback_blocks":0,"block_count":len(model.blocks),"forward_calls":0,"factorized_mlps":0,"weights_unchanged":True,"residual_dtype":"torch.float32","branch_dtype":"torch.float16","condition_fp32":True,"outputs_fp32":True,"clamping":False,"out_projection_scale":64,"mlp_projection_scale":256,"forward_wall_seconds":[]}
    model._studio_hf_mixed_stats=stats
    # 逐实例包装低秩 MLP，避免其 override 绕过 H3 基类补丁，也不污染其他模型。
    for block in model.blocks:
        original_block=block.forward
        original_mlp=block.mlp.forward
        original_proj=block.attn.out_proj.forward
        if block.mlp.__class__.__name__=="FactorizedMLP":stats["factorized_mlps"]+=1
        def projection(t,_original=original_proj):
            if t.dtype!=torch.float16:return _original(t)
            return _original((t/64.0).half()).float().mul_(64.0)
        block.attn.out_proj.forward=projection
        def mlp(self,x,_original=original_mlp):
            if x.dtype!=torch.float16:return _original(x)
            u=self.fc1(x);gate,hidden=u.chunk(2,dim=-1);scaled=torch.empty_like(gate)
            for first in range(0,gate.shape[0],2048):
                part=_hf_f.silu(gate[first:first+2048].float()).mul_(hidden[first:first+2048].float()).div_(256.0)
                scaled[first:first+2048].copy_(part.half())
            del u,gate,hidden,part
            return self.fc2(scaled).float().mul_(256.0)
        block.mlp.forward=_hf_types.MethodType(mlp,block.mlp)
        def forward(self,x,t_emb,mod_segments,rope_freqs,transformer_options={},attention=None,_original=original_block):
            work=h=att=branch=result=None;ok=False
            try:
                work=x.float().clone()
                shift_msa,scale_msa,gate_msa,shift_mlp,scale_mlp,gate_mlp=self.adaln_proj(t_emb)
                h=_hf_mm._mod_scale_shift(self.norm1(work),shift_msa,scale_msa,mod_segments).half()
                with _hf_sdpa([_HFBackend.EFFICIENT_ATTENTION]):
                    att=(self.attn if attention is None else attention)(h,rope_freqs=rope_freqs,transformer_options=transformer_options)
                work=_hf_mm._mod_gate(work,gate_msa,att.float(),mod_segments)
                h=_hf_mm._mod_scale_shift(self.norm2(work),shift_mlp,scale_mlp,mod_segments).half()
                branch=self.mlp(h);result=_hf_mm._mod_gate(work,gate_mlp,branch.float(),mod_segments)
                if not torch.isfinite(result).all().item():raise FloatingPointError("HyperFlow FP16分支超范围")
                ok=True
            except (torch.cuda.OutOfMemoryError,FloatingPointError):pass
            if ok:
                stats["executed"]=True;stats["fast_blocks"]+=1;return result
            work=h=att=branch=result=None;torch.cuda.empty_cache();stats["fallback_blocks"]+=1
            return _original(x,t_emb,mod_segments,rope_freqs,transformer_options=transformer_options,attention=attention)
        block.forward=_hf_types.MethodType(forward,block)
    original_forward=model.forward
    def tracked_forward(*args,**kwargs):
        torch.cuda.synchronize(0);started=_hf_time.perf_counter()
        result=original_forward(*args,**kwargs)
        torch.cuda.synchronize(0);stats["forward_wall_seconds"].append(_hf_time.perf_counter()-started);stats["forward_calls"]+=1
        _HFPath("/kaggle/working/hyperflow_precision_proof.json").write_text(_hf_json.dumps(stats))
        return result
    model.forward=tracked_forward;model._studio_hf_mixed_installed=True
`;

/** 只修改独立候选 Notebook；生产仍可使用原 GGUF 路径。 */
export function enableHyperFlowSafeMixed(n:any){
 let node=0,worker=0;
 for(const c of n.cells){if(c.cell_type!=='code')continue;let s:string=c.source;
  if(s.includes('(custom_node_dir / "__init__.py").write_text')){
   s=s.replace('(custom_node_dir / "__init__.py").write_text',`custom_node_code += ${JSON.stringify(HYPERFLOW_SAFE_MIXED_NODE)}\n(custom_node_dir / "__init__.py").write_text`);
   // audit 字符串本身在 Notebook 内以 JSON 编码，单独追加类方法包装以保持锚点明确。
   s=s.replace('(custom_node_dir / "__init__.py").write_text',`custom_node_code += ${JSON.stringify('\n_hf_audit_original=StudioHyperFlowAudit.audit\ndef _hf_mixed_audit(self,model,nonce):\n    m=model.model.diffusion_model\n    _studio_install_hyperflow_mixed(m)\n    if getattr(m,"_studio_hf_job_nonce",None)!=nonce:\n        stats=m._studio_hf_mixed_stats\n        stats.update(executed=False,fast_blocks=0,fallback_blocks=0,forward_calls=0,forward_wall_seconds=[])\n        if "resident_policy" in stats:stats["resident_policy"]["memory_samples"]=[]\n        m._studio_hf_job_nonce=nonce\n    return _hf_audit_original(self,model,nonce)\nStudioHyperFlowAudit.audit=_hf_mixed_audit\n')}\n(custom_node_dir / "__init__.py").write_text`);node++;
  }
  if(s.includes('_hf_proof=json.loads(')){
   s=s.replace('            _session_upload(current,path,digest)','            _precision=json.loads(Path("/kaggle/working/hyperflow_precision_proof.json").read_text())\n            if not _precision.get("executed") or _precision.get("fast_blocks",0)+_precision.get("fallback_blocks",0)!=STEPS*47:raise RuntimeError("HyperFlow混合精度证明不完整")\n            metadata.update({"hyperflow_precision_proof":_precision,"benchmark_suite":"hyperflow_safe_mixed_20261118","software":{"torch":torch.__version__,"cuda":torch.version.cuda},"devices":[torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]})\n            _session_upload(current,path,digest)');worker++;
  }
  c.source=s;
 }
 if(node!==1||worker!==1)throw Error('HyperFlow混合精度模板锚点不匹配');return n;
}
