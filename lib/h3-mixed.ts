// 安全缩放思路参考 Amduraznak/minimax-h3-fp16-fix（MIT），授权见 docs/third-party/minimax-h3-fp16-fix-LICENSE。
// 针对T4的局部混合精度：权重及FP32残差/条件/输出保持原路径，矩阵分支用FP16。
// 溢出时整块回到原FP32运算，不裁剪数值、不更改生成参数。
export const H3_SAFE_MIXED_NODE=String.raw`
import os as _h3_mix_os
if _h3_mix_os.environ.get("H3_SAFE_MIXED_AUDIT"):
    import comfy.ldm.minimax.model as _h3_mix_mm
    import torch.nn.functional as _h3_mix_f
    from torch.nn.attention import sdpa_kernel as _h3_mix_sdpa, SDPBackend as _H3MixBackend
    from pathlib import Path as _H3MixPath
    import json as _h3_mix_json
    _h3_mix_original_init=_h3_mix_mm.DiTBlock.__init__
    _h3_mix_original_block=_h3_mix_mm.DiTBlock.forward
    _h3_mix_original_mlp=_h3_mix_mm.MLP.forward
    _h3_mix_original_attention=_h3_mix_mm.optimized_attention
    _h3_mix_stats={"backend":"h3_safe_fp16_branches","executed":False,"fast_blocks":0,"fallback_blocks":0,"residual_dtype":"torch.float32","branch_dtype":"torch.float16","weights_unchanged":True,"fp32_condition_preserved":True,"fp32_outputs_preserved":True,"clamping":False,"out_projection_scale":64,"mlp_projection_scale":256,"swiglu_chunk_rows":2048}

    def _h3_mix_save():
        _H3MixPath(_h3_mix_os.environ["H3_SAFE_MIXED_AUDIT"]).write_text(_h3_mix_json.dumps(_h3_mix_stats))

    def _h3_mix_attention(q,k,v,heads,**kwargs):
        source=q.peek() if isinstance(q,_h3_mix_mm.AttentionTensorContainer) else q
        if source.dtype==torch.float16:_h3_mix_stats["attention_input_dtype"]=str(source.dtype)
        result=_h3_mix_original_attention(q,k,v,heads,**kwargs)
        if source.dtype==torch.float16:_h3_mix_stats["attention_output_dtype"]=str(result.dtype)
        return result

    def _h3_mix_init(self,*args,**kwargs):
        _h3_mix_original_init(self,*args,**kwargs)
        original=self.attn.out_proj.forward
        def safe_projection(t):
            if t.dtype!=torch.float16:return original(t)
            raw=original((t/64.0).to(torch.float16))
            _h3_mix_stats["out_projection_raw_dtype"]=str(raw.dtype)
            return raw.to(torch.float32).mul_(64.0)
        self.attn.out_proj.forward=safe_projection

    def _h3_mix_mlp(self,x):
        if x.dtype!=torch.float16:return _h3_mix_original_mlp(self,x)
        u=self.fc1(x)
        _h3_mix_stats["mlp_up_dtype"]=str(u.dtype)
        gate,up=u.chunk(2,dim=-1)
        scaled=torch.empty_like(gate)
        # SwiGLU仍用FP32；仅分行计算逐点函数，避免完整FP32中间数组占用显存。
        for first in range(0,gate.shape[0],2048):
            last=min(first+2048,gate.shape[0])
            part=_h3_mix_f.silu(gate[first:last].float()).mul_(up[first:last].float()).div_(256.0)
            scaled[first:last].copy_(part.to(torch.float16))
        del u,gate,up,part
        raw=self.fc2(scaled)
        _h3_mix_stats["mlp_down_dtype"]=str(raw.dtype)
        return raw.float().mul_(256.0)

    def _h3_mix_block(self,x,t_emb,mod_segments,rope_freqs,transformer_options={},attention=None):
        work=h=att=branch=result=None
        success=False
        try:
            # 保留输入供数值异常/OOM时完整回退，混合路径不修改原输入。
            work=x.to(torch.float32).clone()
            shift_msa,scale_msa,gate_msa,shift_mlp,scale_mlp,gate_mlp=self.adaln_proj(t_emb)
            h=_h3_mix_mm._mod_scale_shift(self.norm1(work),shift_msa,scale_msa,mod_segments).to(torch.float16)
            attend=self.attn if attention is None else attention
            with _h3_mix_sdpa([_H3MixBackend.EFFICIENT_ATTENTION]):
                att=attend(h,rope_freqs=rope_freqs,transformer_options=transformer_options)
            work=_h3_mix_mm._mod_gate(work,gate_msa,att.float(),mod_segments)
            h=_h3_mix_mm._mod_scale_shift(self.norm2(work),shift_mlp,scale_mlp,mod_segments).to(torch.float16)
            branch=self.mlp(h)
            result=_h3_mix_mm._mod_gate(work,gate_mlp,branch.float(),mod_segments)
            if not torch.isfinite(result).all().item():raise FloatingPointError("FP16分支数值超范围")
            success=True
        except (torch.cuda.OutOfMemoryError,FloatingPointError):
            pass
        if success:
            _h3_mix_stats["executed"]=True;_h3_mix_stats["fast_blocks"]+=1
            _h3_mix_stats["last_rows"]=int(x.shape[0]);_h3_mix_stats["last_device"]=str(x.device)
            _h3_mix_save()
            return result
        work=h=att=branch=result=None
        torch.cuda.empty_cache()
        _h3_mix_stats["fallback_blocks"]+=1;_h3_mix_save()
        return _h3_mix_original_block(self,x,t_emb,mod_segments,rope_freqs,transformer_options=transformer_options,attention=attention)

    _h3_mix_mm.DiTBlock.__init__=_h3_mix_init
    _h3_mix_mm.DiTBlock.forward=_h3_mix_block
    _h3_mix_mm.MLP.forward=_h3_mix_mlp
    _h3_mix_mm.optimized_attention=_h3_mix_attention
`;

export const H3_SAFE_MIXED_PREFLIGHT=String.raw`
print("H3_SAFE_MIXED_PREFLIGHT",flush=True)
_probe=r'''
import torch,comfy_kitchen as ck,json
from torch.nn.attention import sdpa_kernel,SDPBackend
with torch.cuda.device(0):
    torch.manual_seed(20261115)
    q,k,v=[torch.randn(1,4,128,128,device="cuda",dtype=torch.float16) for _ in range(3)]
    with sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION]):out=torch.nn.functional.scaled_dot_product_attention(q,k,v)
    if not torch.isfinite(out).all().item():raise RuntimeError("FP16注意力异常")
    # 验证当前Comfy Kitchen支持FP16 Q/K与FP32 RoPE及归一化权重。
    q,k=[torch.randn(1,128,4,128,device="cuda",dtype=torch.float16) for _ in range(2)]
    angles=torch.randn(128,48,device="cuda",dtype=torch.float32)
    c,s=angles.cos(),angles.sin();rope=torch.stack([c,-s,s,c],dim=-1).reshape(1,128,1,48,2,2)
    weight=torch.ones(128,device="cuda",dtype=torch.float32)
    ck.rms_rope_split_half_(q,k,rope,weight,weight,epsilon=1e-5,rot_dim=96)
    if not torch.isfinite(q).all().item():raise RuntimeError("FP16 RoPE异常")
    # 2的幂缩放避免线性层FP16输出溢出，FP32恢复输出。
    a=torch.full((4,8),64.,device="cuda",dtype=torch.float16);w=torch.full((8,8),128.,device="cuda",dtype=torch.float16)
    restored=torch.nn.functional.linear(a/64.,w).float()*64.
    if not torch.equal(restored,torch.nn.functional.linear(a.float(),w.float())):raise RuntimeError("安全缩放预检失败")
    u=torch.randn(4100,32,device="cuda",dtype=torch.float16);g,b=u.chunk(2,dim=-1)
    expected=(torch.nn.functional.silu(g.float())*b.float()/256.).half();actual=torch.empty_like(g)
    for first in range(0,len(g),2048):actual[first:first+2048]=(torch.nn.functional.silu(g[first:first+2048].float())*b[first:first+2048].float()/256.).half()
    if not torch.equal(actual,expected):raise RuntimeError("分块SwiGLU不等价")
    print(json.dumps({"backend":"h3_safe_fp16_branches","gpu":torch.cuda.get_device_name(0),"rope_fp32":True,"power_of_two_scaling":True,"swiglu_chunk_exact":True}))
'''
run_checked([sys.executable,"-c",_probe],cwd=COMFY_DIR)
`;

export function enableH3SafeMixedBase(n:any){
 n.cells[9].source+=H3_SAFE_MIXED_PREFLIGHT;
 n.cells[11].source=n.cells[11].source.replace('(custom_node_dir / "__init__.py").write_text',`custom_node_code += ${JSON.stringify(H3_SAFE_MIXED_NODE)}\n(custom_node_dir / "__init__.py").write_text`);
 n.cells[15].source=n.cells[15].source.replace('fingerprint = hashlib.sha256','env["H3_SAFE_MIXED_AUDIT"]="/kaggle/working/h3_safe_mixed_proof.json"\nif "--disable-comfy-compiler" not in command:command.append("--disable-comfy-compiler")\nfingerprint = hashlib.sha256');
 return n;
}
export function enableH3SafeMixedWorker(n:any){
 n.cells[21].source=n.cells[21].source.replace('metadata={','precision_proof=json.loads(Path("/kaggle/working/h3_safe_mixed_proof.json").read_text())\n            if not precision_proof.get("executed"):raise RuntimeError("没有实际混合精度执行证明。")\n            metadata={"precision_proof":precision_proof,');
 return n;
}
export function enableH3SafeMixedStandalone(n:any){
 n.cells[21].source=n.cells[21].source.replace('run_metadata = {','MIXED_PRECISION_PROOF=json.loads(Path("/kaggle/working/h3_safe_mixed_proof.json").read_text())\nif not MIXED_PRECISION_PROOF.get("executed"):raise RuntimeError("没有实际混合精度执行证明。")\nrun_metadata = {"precision_proof":MIXED_PRECISION_PROOF,');
 return n;
}
