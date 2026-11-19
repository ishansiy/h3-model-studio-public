import {guardedSessionSource} from './session-stop';
import {sessionWorkerPrelude} from './session-worker';
import type {ImageParams} from './model-catalog';
import {DUAL_T4_RUNTIME} from './image-placement';

export const ZIMAGE_REVISION='f332072aa78be7aecdf3ee76d5c247082da564a6';
export const IMAGE_DEPENDENCIES=['diffusers==0.38.0','transformers==4.57.6','accelerate==1.15.0','safetensors==0.8.0','sentencepiece==0.2.1','Pillow==12.0.0'] as const;

const imageLoop=String.raw`
import sys, subprocess, hashlib, gc
from pathlib import Path

os.environ.setdefault("USE_TF","0")
os.environ.setdefault("USE_FLAX","0")
import torch
from diffusers import ZImagePipeline
from PIL import Image
if not torch.cuda.is_available():raise RuntimeError("当前计算会话没有可用GPU。")
`+DUAL_T4_RUNTIME+String.raw`

_session_progress("下载并加载Z-Image-Turbo",0)
_load_started=time.perf_counter()
# 使用原始浮点权重；不使用int8、NF4等量化，也不把未实测吞吐作为性能承诺。
_NATIVE_BF16=torch.cuda.get_device_capability(0)[0]>=8
# Z-Image在T4上转FP16会溢出；使用FP32与逐层卸载，保留原权重和步数。
_DTYPE=torch.bfloat16 if _NATIVE_BF16 else torch.float32
if _NATIVE_BF16:
    pipe=ZImagePipeline.from_pretrained("Tongyi-MAI/Z-Image-Turbo",revision=_IMAGE_REVISION,torch_dtype=_DTYPE,low_cpu_mem_usage=True,use_safetensors=True)
    pipe.enable_model_cpu_offload(gpu_id=0)
else:pipe=_load_resident_pipeline()
pipe.vae.enable_tiling()
_model_load_seconds=time.perf_counter()-_load_started
_READY=True
_image_index=0
_output=Path('/kaggle/working/model-studio');_output.mkdir(parents=True,exist_ok=True)

def _image_callback(_pipe,step,_timestep,callback_kwargs):
    _session_progress("正在生成图片",int(step)+1)
    latent=callback_kwargs.get("latents")
    if latent is not None and not torch.isfinite(latent).all().item():raise RuntimeError("生成出现非有限数值，已停止，未交付无效图片。")
    if _JOB_CANCEL.is_set() or _SESSION_STOP.is_set():raise RuntimeError("当前图片任务已取消。")
    return callback_kwargs

def _image_finish(payload):
    for attempt in range(4):
        try:return _session_call("finish",payload)
        except Exception:
            if attempt==3:raise
            time.sleep(2**attempt)

try:
    while _QUEUE_JOB and not _SESSION_STOP.is_set():
        current=_QUEUE_JOB;p=current["params"];started=time.perf_counter()
        try:
            if p.get("category")!="image" or p.get("modelId")!="z-image-turbo":raise RuntimeError("任务模型与当前GPU会话不匹配。")
            if _JOB_CANCEL.is_set():raise RuntimeError("当前图片任务已取消。")
            _EXECUTING=True;_session_progress("正在生成图片",0)
            for device_id in range(torch.cuda.device_count()):torch.cuda.reset_peak_memory_stats(device_id)
            call_prompt={"prompt":p["prompt"]}
            _prompt_seconds=0.0
            if not _NATIVE_BF16:
                _session_progress("编码提示词并切换常驻权重",0)
                prompt_started=time.perf_counter();call_prompt={"prompt_embeds":_resident_prompt(pipe,p["prompt"])}
                _prompt_seconds=time.perf_counter()-prompt_started
            _session_progress("双GPU生成图片" if not _NATIVE_BF16 else "正在生成图片",0)
            denoise_started=time.perf_counter()
            result=pipe(**call_prompt,width=p["width"],height=p["height"],num_inference_steps=9,guidance_scale=0.0,generator=torch.Generator("cuda:0").manual_seed(int(p["seed"])),callback_on_step_end=_image_callback,output_type="pil" if _NATIVE_BF16 else "latent")
            _denoise_seconds=time.perf_counter()-denoise_started
            _decode_seconds=0.0
            _decode_parked=not _NATIVE_BF16 and p["width"]*p["height"]>512*512
            if _NATIVE_BF16:image=result.images[0]
            else:
                _session_progress("解码完整尺寸图片",9)
                decode_started=time.perf_counter();image=_resident_decode(pipe,result.images,_decode_parked)
                _decode_seconds=time.perf_counter()-decode_started
            del result
            _generation_seconds=time.perf_counter()-started
            _EXECUTING=False
            if _JOB_CANCEL.is_set() or _SESSION_STOP.is_set():raise RuntimeError("当前图片任务已取消。")
            path=_output/(current["id"]+".png");image.save(path,format="PNG")
            _session_progress("校验完整PNG图片",9)
            with Image.open(path) as check:check.verify()
            with Image.open(path) as check:
                check.load();width,height=check.size
                if check.format!="PNG" or (width,height)!=(p["width"],p["height"]):raise RuntimeError("图片尺寸或解码校验失败。")
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            _session_progress("上传图片",9)
            for attempt in range(3):
                try:
                    with path.open("rb") as handle:
                        response=requests.put(_SESSION_API+"/artifact/"+current["id"],params={"claim":current["claimToken"]},headers={"Authorization":"Bearer "+_SESSION_TOKEN,"X-H3-Worker":_WORKER_ID,"Content-Type":"image/png","Content-Length":str(path.stat().st_size),"X-Artifact-SHA256":digest},data=handle,timeout=120)
                        response.raise_for_status()
                    break
                except Exception:
                    if attempt==2 or _JOB_CANCEL.is_set() or _SESSION_STOP.is_set():raise
                    time.sleep(2**attempt)
            metadata={"category":"image","model_id":"z-image-turbo","model_repo":"Tongyi-MAI/Z-Image-Turbo","model_revision":_IMAGE_REVISION,"runtime_profile":"standard","dtype":str(_DTYPE),"quantized":False,"device":torch.cuda.get_device_name(0),"vae_tiling":True,"resolved_config":{"width":width,"height":height,"steps":9,"seed":str(p["seed"])},"image_validation":{"format":"png","width":width,"height":height,"full_decode_passed":True},"artifact_sha256":digest,"server_reused":_image_index>0,"session_job_index":_image_index,"timings":{"generation_seconds":_generation_seconds,"model_load_seconds":_model_load_seconds if _image_index==0 else 0,"environment_seconds":float(_BOOTSTRAP.get("setupSeconds",0)) if _image_index==0 else 0,"job_seconds":time.perf_counter()-started}}
            metadata.update({"placement":getattr(pipe,"_resident_placement",{"strategy":"native_bf16_model_offload"}),"devices":[torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())],"peak_memory_bytes":[torch.cuda.max_memory_allocated(i) for i in range(torch.cuda.device_count())],"software":{"torch":torch.__version__},"prompt_stage_seconds":_prompt_seconds})
            metadata.update({"denoise_seconds":_denoise_seconds,"decode_seconds":_decode_seconds,"decode_parked":_decode_parked})
            delivered=_image_finish({"jobId":current["id"],"claimToken":current["claimToken"],"status":"completed","metadata":metadata})
            (path.with_suffix(".json")).write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
            print("MODEL_STUDIO_IMAGE_DELIVERED "+current["id"]+" "+delivered.get("status",""),flush=True)
        except Exception as exc:
            _EXECUTING=False;cancelled=_JOB_CANCEL.is_set() or _SESSION_STOP.is_set()
            _image_finish({"jobId":current["id"],"claimToken":current["claimToken"],"status":"cancelled" if cancelled else "failed","error":type(exc).__name__+": "+str(exc)[-900:]})
            if not cancelled and ("out of memory" in str(exc).lower() or "cuda error" in str(exc).lower()):_SESSION_STOP.set()
        finally:
            _EXECUTING=False
            if 'image' in locals():del image
            gc.collect();torch.cuda.empty_cache()
        _image_index+=1;_QUEUE_JOB=None;_JOB_CANCEL.clear();_INTERRUPT_AT=None
        _session_progress("等待下一条图像任务",0)
        if not _SESSION_STOP.is_set():_session_take()
finally:
    _NORMAL_EXIT.set()
    try:_session_call("heartbeat",{"exiting":True})
    except Exception:pass
    _SESSION_STOP.set()
    del pipe;gc.collect();torch.cuda.empty_cache()
print("MODEL_STUDIO_IMAGE_SESSION_EXITED",flush=True)
`;

export function buildImageNotebook(_params:ImageParams,base:string,token:string){
 const prelude=sessionWorkerPrelude(base,token).replace('try:requests.post("http://127.0.0.1:8188/interrupt",json={},timeout=3)','try: pass').replace('        if _SESSION_STOP.is_set() or _JOB_CANCEL.is_set():','        if _NORMAL_EXIT.is_set():return\n        if _SESSION_STOP.is_set() or _JOB_CANCEL.is_set():');
 const childPrelude=prelude.replace(`_SESSION_API = ${JSON.stringify(base)}`,`import sys, json\n_BOOTSTRAP=json.loads(sys.stdin.readline())\n_SESSION_API = _BOOTSTRAP["base"]`).replace(`_SESSION_TOKEN = ${JSON.stringify(token)}`,'_SESSION_TOKEN = _BOOTSTRAP["token"]').replace('_WORKER_ID=str(uuid.uuid4())','_WORKER_ID=_BOOTSTRAP["workerId"]');
 const child=childPrelude+`\n_IMAGE_REVISION=${JSON.stringify(ZIMAGE_REVISION)}\n`+guardedSessionSource(imageLoop);
 const bootstrap=`_IMAGE_DEPENDENCIES=${JSON.stringify(IMAGE_DEPENDENCIES)}\n_CHILD_SOURCE=${JSON.stringify(child)}\n`+String.raw`
import subprocess, sys, venv
from pathlib import Path
_proc=None

def _stop_child(signum,frame):
    if _proc and _proc.poll() is None:
        try:os.killpg(_proc.pid,signal.SIGTERM)
        except ProcessLookupError:pass
    raise RuntimeError("图像会话强制终止，未正常退出。")
signal.signal(signal.SIGTERM,_stop_child)
try:
    _session_progress("安装独立图像生成环境",0)
    _env=Path('/kaggle/working/model-studio-env')
    # Kaggle镜像已有pip；直接借用，避免其嵌套环境的ensurepip失败。
    # 安装位置仍由子环境sys.prefix决定，不修改宿主Notebook依赖。
    venv.EnvBuilder(with_pip=False,system_site_packages=True).create(_env)
    _python=str(_env/'bin/python')
    subprocess.run([_python,'-c','import sys,pip; assert sys.prefix != sys.base_prefix; print("MODEL_STUDIO_ENV_READY",sys.prefix,flush=True)'],check=True)
    _proc=subprocess.Popen([_python,'-m','pip','install','--quiet',*_IMAGE_DEPENDENCIES],start_new_session=True)
    if _proc.wait()!=0:raise RuntimeError("图像生成环境安装失败。")
    if _SESSION_STOP.is_set():raise SystemExit("图像会话已停止。")
    _worker=Path('/kaggle/working/model-studio-image-worker.py')
    _worker.write_text(_CHILD_SOURCE)
    # 子进程文件无会话凭证；凭证只通过stdin交接，原监听器停止后由子进程接管。
    _NORMAL_EXIT.set()
    _proc=subprocess.Popen([_python,str(_worker)],stdin=subprocess.PIPE,text=True,start_new_session=True)
    _proc.communicate(json.dumps({"base":_SESSION_API,"token":_SESSION_TOKEN,"workerId":_WORKER_ID,"setupSeconds":time.monotonic()-_SESSION_BORN}))
    if _proc.returncode!=0:raise RuntimeError("图像执行器已退出，请查看Kaggle日志。")
except Exception as exc:
    try:_session_call("finish",{"jobId":_QUEUE_JOB["id"],"claimToken":_QUEUE_JOB["claimToken"],"status":"cancelled" if _JOB_CANCEL.is_set() or _SESSION_STOP.is_set() else "failed","error":type(exc).__name__+": "+str(exc)[-700:]})
    except Exception:pass
    raise
finally:
    _NORMAL_EXIT.set()
    if _proc and _proc.poll() is None:
        try:os.killpg(_proc.pid,signal.SIGTERM)
        except ProcessLookupError:pass
    try:_session_call("heartbeat",{"exiting":True})
    except Exception:pass
`;
 const cell=(source:string)=>({cell_type:'code',metadata:{},source,outputs:[],execution_count:null});
 return JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{kernelspec:{display_name:'Python 3',language:'python',name:'python3'}},cells:[
  {cell_type:'markdown',metadata:{},source:'# 模型工作室 · Z-Image-Turbo\n独立图像生成器，共享会话队列与停止通道；默认推荐步数，原始浮点权重。'},
  cell(prelude),cell(bootstrap),
 ]});
}
