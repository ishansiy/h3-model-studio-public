import {enableHyperFlowHeadParallel} from './hyperflow-head-parallel';
import {enableHyperFlowResident} from './hyperflow-resident';
import {enableHyperFlowSafeMixed} from './hyperflow-mixed';
import {buildSessionNotebook} from './session-notebook';
import {HYPERFLOW,validateHyperFlow,type HyperFlowParams} from './hyperflow-config';
const audit=String.raw`
import json as _hf_json
from pathlib import Path as _HFPath
class StudioHyperFlowAudit:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required":{"model":("MODEL",),"nonce":("STRING",{"default":""})}}
    RETURN_TYPES=("MODEL",)
    FUNCTION="audit"
    CATEGORY="Studio/HyperFlow"
    def audit(self,model,nonce):
        m=model.model.diffusion_model
        if not hasattr(m,"endpoint_time_embedder") or "endpoint_state" not in m.time_embedder.__dict__:
            raise RuntimeError("HyperFlow two-time模型未实际载入，停止生成。")
        m._studio_hyperflow_proof={"model_id":"hyperflow-h3-flash","executed":False,"forward_calls":0,"two_time":True,"blocks":len(m.blocks),"quantization":"Q4_K_M","nonce":nonce}
        if not getattr(m,"_studio_hyperflow_wrapped",False):
            original=m.forward
            def forward(*args,**kwargs):
                output=original(*args,**kwargs)
                proof=m._studio_hyperflow_proof;proof["forward_calls"]+=1;proof["executed"]=True
                _HFPath("/kaggle/working/hyperflow_execution_proof.json").write_text(_hf_json.dumps(proof))
                return output
            m.forward=forward;m._studio_hyperflow_wrapped=True
        _HFPath("/kaggle/working/hyperflow_execution_proof.json").unlink(missing_ok=True)
        return (model,)
NODE_CLASS_MAPPINGS["StudioHyperFlowAudit"]=StudioHyperFlowAudit
`;
const download=String.raw`
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from huggingface_hub import hf_hub_download
_download_start=time.perf_counter()
os.environ.setdefault("HF_HOME",str(SESSION_ROOT/"hf_home"))
MODEL_FILES={"diffusion_models/"+HYPERFLOW_CHECKPOINT:HYPERFLOW_BYTES,"text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors":15687142551,"vae/minimax_h3_video_vae_fp16.safetensors":5207808496,"vae/minimax_h3_audio_vae_fp32.safetensors":605254808}
models_root=COMFY_DIR/"models";models_root.mkdir(parents=True,exist_ok=True)
def download_model(item):
    relative_path,expected_bytes=item;target=models_root/relative_path;target.parent.mkdir(parents=True,exist_ok=True)
    if target.is_file() and target.stat().st_size==expected_bytes:return
    is_hyperflow=relative_path.startswith("diffusion_models/")
    repo=HYPERFLOW_REPO if is_hyperflow else MODEL_REPO;revision=HYPERFLOW_REVISION if is_hyperflow else MODEL_REVISION
    filename="fl2va_gguf/"+HYPERFLOW_CHECKPOINT if is_hyperflow else relative_path
    # 直接落目标文件，不保留两份大权重；Hub下载按固定revision验证内容。
    downloaded=Path(hf_hub_download(repo_id=repo,revision=revision,filename=filename,local_dir=models_root,token=HF_TOKEN or os.environ.get("HF_TOKEN")))
    if downloaded.stat().st_size!=expected_bytes:raise RuntimeError("模型文件大小不符："+relative_path)
    if downloaded!=target:os.replace(downloaded,target)
    print("模型就绪："+relative_path,flush=True)
with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(download_model,MODEL_FILES.items()))
manifest={name:{"path":str(models_root/name),"bytes":(models_root/name).stat().st_size,"repo":HYPERFLOW_REPO if name.startswith("diffusion_models/") else MODEL_REPO,"revision":HYPERFLOW_REVISION if name.startswith("diffusion_models/") else MODEL_REVISION} for name in MODEL_FILES}
(FINAL_OUTPUT_DIR/"hyperflow_model_manifest.json").write_text(json.dumps(manifest,indent=2))
STAGE_TIMINGS["download_seconds"]=time.perf_counter()-_download_start
`;
function replace(source:string,from:string,to:string){if(!source.includes(from))throw Error('HyperFlow模板锚点不匹配：'+from.slice(0,65));return source.replace(from,to);}
export function buildHyperFlowNotebook(params:HyperFlowParams,base:string,token:string,options:{safeMixed?:boolean;resident?:boolean;headParallel?:boolean}={}){
 params=validateHyperFlow(params as unknown as Record<string,unknown>);
 const n=JSON.parse(buildSessionNotebook(params,base,token));
 for(const c of n.cells){if(c.cell_type!=='code')continue;let s:string=c.source;
  if(s.includes('COMFY_REF = ')){
   s=s.replace(/COMFY_REF = "[a-f0-9]+"/,`COMFY_REF = ${JSON.stringify(HYPERFLOW.comfyCommit)}`);
   s+=`\nHYPERFLOW_REPO=${JSON.stringify(HYPERFLOW.repo)}\nHYPERFLOW_REVISION=${JSON.stringify(HYPERFLOW.revision)}\nHYPERFLOW_CHECKPOINT=${JSON.stringify(HYPERFLOW.checkpoint)}\nHYPERFLOW_BYTES=${HYPERFLOW.bytes}\nHYPERFLOW_NODES_COMMIT=${JSON.stringify(HYPERFLOW.nodesCommit)}\nHYPERFLOW_GGUF_COMMIT=${JSON.stringify(HYPERFLOW.ggufCommit)}\n`;
  }
  if(s.includes('MIN_RECOMMENDED_FREE_GIB = '))s=s.replace(/MIN_RECOMMENDED_FREE_GIB = [^\n]+/,'MIN_RECOMMENDED_FREE_GIB = 34.0');
  if(s.includes('_setup_start = time.perf_counter()'))s+=`\nfor _url,_name,_ref in [("https://github.com/city96/ComfyUI-GGUF.git","ComfyUI-GGUF",HYPERFLOW_GGUF_COMMIT),("https://github.com/Video-Rebirth/ComfyUI-HyperFlow-Flash.git","ComfyUI-HyperFlow-Flash",HYPERFLOW_NODES_COMMIT)]:\n    _dest=COMFY_DIR/"custom_nodes"/_name\n    if not (_dest/".git").exists():run_checked(["git","clone","--depth","1",_url,str(_dest)])\n    run_checked(["git","fetch","--depth","1","origin",_ref],cwd=_dest)\n    run_checked(["git","checkout","--force","FETCH_HEAD"],cwd=_dest)\n    if subprocess.check_output(["git","rev-parse","HEAD"],cwd=_dest,text=True).strip()!=_ref:raise RuntimeError("HyperFlow节点版本不符")\n    if (_dest/"requirements.txt").exists():run_checked([sys.executable,"-m","pip","install","-q","-r",str(_dest/"requirements.txt")])\nSTAGE_TIMINGS["setup_seconds"]=time.perf_counter()-_setup_start\n`;
  if(s.includes('(custom_node_dir / "__init__.py").write_text'))s=replace(s,'(custom_node_dir / "__init__.py").write_text',`custom_node_code += ${JSON.stringify(audit)}\n(custom_node_dir / "__init__.py").write_text`);
  if(s.includes('_download_start = time.perf_counter()'))s='_session_progress("下载HyperFlow模型与音视频组件",0)\n'+download;
  if(s.includes('fingerprint = hashlib.sha256'))s=replace(s,'fingerprint = hashlib.sha256','command += ["--disable-comfy-compiler", "--fast-disk"]\nfingerprint = hashlib.sha256');
  if(s.includes('REQUIRED_NODE_TYPES = ['))s=s.replace('"UNETLoader",','"HyperFlowLoader", "HyperFlowSigmas", "StudioHyperFlowAudit",');
  if(s.includes('def build_h3_workflow(')){
   s=replace(s,'DIFFUSION_NAME = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"','DIFFUSION_NAME = HYPERFLOW_CHECKPOINT');
   s=replace(s,'"class_type": "UNETLoader"','"class_type": "HyperFlowLoader"');s=replace(s,'"weight_dtype": "default"','"weights_in": "disk"');
   s=replace(s,'    return workflow, {','    workflow["121"]={"class_type":"StudioHyperFlowAudit","inputs":{"model":["6",0],"nonce":filename_prefix}}\n    workflow["16"]["inputs"]["model"]=["121",0]\n    workflow["9"]={"class_type":"HyperFlowSigmas","inputs":{"model":["121",0],"steps":int(steps)}}\n    workflow["17"]["inputs"]["sampler_name"]="euler"\n    return workflow, {');
   s=replace(s,'"sampler": SAMPLER_NAME','"sampler": "euler", "cfg": 1.0, "model_id": "hyperflow-h3-flash"');
  }
  if(s.includes('_requested_dual=bool(')){
   s=replace(s,'        PROMPT=p["prompt"]','        if p.get("modelId")!="hyperflow-h3-flash" or p.get("runtimeProfile","standard")!="standard":raise RuntimeError("HyperFlow会话收到不兼容任务。")\n        PROMPT=p["prompt"]');
   s=replace(s,'            _session_upload(current,path,digest)',`            _hf_proof=json.loads((FINAL_OUTPUT_DIR/"hyperflow_execution_proof.json").read_text())\n            if not _hf_proof.get("executed") or _hf_proof.get("forward_calls",0)<STEPS:raise RuntimeError("HyperFlow缺少实际完整采样证明。")\n            metadata.update({"model_id":"hyperflow-h3-flash","model_repo":HYPERFLOW_REPO,"model_revision":HYPERFLOW_REVISION,"companion_repo":MODEL_REPO,"companion_revision":MODEL_REVISION,"nodes_commit":HYPERFLOW_NODES_COMMIT,"gguf_commit":HYPERFLOW_GGUF_COMMIT,"hyperflow_proof":_hf_proof})\n            _session_upload(current,path,digest)`);
  }
  c.source=s;
 }
 if(options.safeMixed)enableHyperFlowSafeMixed(n);
 if(options.safeMixed&&options.resident)enableHyperFlowResident(n);
 if(options.safeMixed&&options.headParallel)enableHyperFlowHeadParallel(n);
 return JSON.stringify(n);
}
