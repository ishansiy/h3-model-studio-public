export const ckPreflight = `
if RUNTIME_PROFILE == "ck":
    print("@@H3_PROGRESS@@"+json.dumps({"stage":"检查 T4 注意力加速支持","step":0,"steps":STEPS}),flush=True)
    _ck_probe = r'''
import torch, comfy_kitchen as ck, json
from pathlib import Path
device=torch.device('cuda:0')
if not ck.int8_attention_is_available(device):
    raise RuntimeError('当前GPU或comfy-kitchen不支持INT8注意力，拒绝下载模型和假加速。')
torch.manual_seed(20260803)
q,k,v=[torch.randn(1,4,128,128,device=device,dtype=torch.float32) for _ in range(3)]
actual=ck.int8_attention(q,k,v)
container_actual=ck.int8_attention_from_prequantized(ck.prequantize_int8_attention(q,k,v))
if not torch.isfinite(container_actual).all().item():
    raise RuntimeError("预量化注意力预检数值异常。")
expected=torch.nn.functional.scaled_dot_product_attention(q,k,v)
torch.cuda.synchronize()
error=(actual.float()-expected.float()).abs().mean().item()
if not torch.isfinite(actual).all().item() or error>0.02:
    raise RuntimeError('注意力预检数值异常，停止实验。')
print('H3_CK_PREFLIGHT '+json.dumps({'available':True,'mean_absolute_error':error,'gpu':torch.cuda.get_device_name(0)}),flush=True)
'''
    run_checked([sys.executable,"-c",_ck_probe],cwd=COMFY_DIR)
    print("@@H3_PROGRESS@@"+json.dumps({"stage":"下载模型到本地磁盘","step":0,"steps":STEPS}),flush=True)
`;

export const ckAuditNode = `
import os as _os
if _os.environ.get("H3_CK_AUDIT_PATH"):
    import comfy_kitchen as _ck
    import json as _json
    from pathlib import Path as _Path
    _ck_audited = False
    def _audit_ck_call(original, call_path):
        def audited(*args, **kwargs):
            global _ck_audited
            result = original(*args, **kwargs)
            if not _ck_audited:
                proof = {"backend":"comfy_kitchen_int8","output_dtype":str(result.dtype),"shape":list(result.shape),"executed":True,"call_path":call_path}
                _Path(_os.environ["H3_CK_AUDIT_PATH"]).write_text(_json.dumps(proof))
                print("H3_CK_ACTIVE "+_json.dumps(proof),flush=True)
                _ck_audited = True
            return result
        return audited
    _ck.int8_attention = _audit_ck_call(_ck.int8_attention,"direct")
    _ck.int8_attention_from_prequantized = _audit_ck_call(_ck.int8_attention_from_prequantized,"prequantized")

`;

export const ckWorkflow = `
    if RUNTIME_PROFILE == "ck":
        _attention_inputs = OBJECT_INFO.get("ModelAttentionBackend",{}).get("input",{})
        _attention_schema = _attention_inputs.get("required",{}).get("attention") or _attention_inputs.get("optional",{}).get("attention") or [[],{}]
        _attention_options = _attention_schema[0] if isinstance(_attention_schema[0],list) else (_attention_schema[1].get("options",[]) if len(_attention_schema)>1 and isinstance(_attention_schema[1],dict) else [])
        (FINAL_OUTPUT_DIR/"minimax_h3_attention_schema.json").write_text(json.dumps(_attention_schema))
        if "comfy kitchen attention" not in _attention_options:
            raise RuntimeError("本版本注意力后端不可用，拒绝静默回退。")
        _source = workflow["16"]["inputs"]["model"]
        workflow["121"]={"class_type":"ModelAttentionBackend","inputs":{"model":_source,"attention":"comfy kitchen attention"}}
        workflow["16"]["inputs"]["model"]=["121",0]
        workflow["9"]["inputs"]["model"]=["121",0]
`;
