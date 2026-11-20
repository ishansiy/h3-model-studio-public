export function sessionWorkerPrelude(base:string,token:string){return `
_SESSION_API = ${JSON.stringify(base)}
_SESSION_TOKEN = ${JSON.stringify(token)}
`+String.raw`
import requests, threading, uuid, time, os, signal, json
_WORKER_ID=str(uuid.uuid4())
_SESSION_STOP=threading.Event()
_JOB_CANCEL=threading.Event()
_QUEUE_JOB=None
_QUEUE_PROGRESS={"stage":"准备环境与模型","step":0}
_SESSION_BORN=time.monotonic()
_LAST_CONTACT=time.monotonic()
_EXECUTING=False
_READY=False
_NORMAL_EXIT=threading.Event()
_INTERRUPT_AT=None
_STOP_GRACE_AT=None

def _session_call(action,payload=None):
    global _LAST_CONTACT
    response=requests.post(_SESSION_API+"/"+action,headers={"Authorization":"Bearer "+_SESSION_TOKEN,"X-H3-Worker":_WORKER_ID},json=payload or {},timeout=20)
    response.raise_for_status()
    data=response.json()
    _LAST_CONTACT=time.monotonic()
    return data

def _session_image(current, role):
    import hashlib
    expected=current["params"].get(role)
    if not expected:raise RuntimeError("任务缺少输入图片："+role)
    response=requests.get(_SESSION_API+"/inputs/"+current["id"]+"/"+role,params={"claim":current["claimToken"]},headers={"Authorization":"Bearer "+_SESSION_TOKEN,"X-H3-Worker":_WORKER_ID},timeout=60)
    response.raise_for_status()
    data=response.content
    if len(data)>20*1024*1024 or hashlib.sha256(data).hexdigest()!=expected:
        raise RuntimeError("输入图片完整性校验失败："+role)
    return data

def _session_progress(stage,step=0):
    _QUEUE_PROGRESS.update(stage=str(stage),step=int(step))

def _session_cooperative_exit():
    global _COOPERATIVE_EXIT_DONE
    if globals().get("_COOPERATIVE_EXIT_DONE",False):return
    _COOPERATIVE_EXIT_DONE=True
    _NORMAL_EXIT.set();_SESSION_STOP.set()
    current=_QUEUE_JOB
    if current:
        try:_session_call("finish",{"jobId":current["id"],"claimToken":current["claimToken"],"status":"cancelled","error":"会话在准备阶段正常停止。"})
        except Exception:pass
    child=globals().get("_proc")
    if child is not None and child.poll() is None:
        try:
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=10)
            except Exception:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
        except Exception:pass
    pid_path=globals().get("PID_PATH")
    if pid_path is not None:
        try:
            ps=__import__("psutil")
            process=ps.Process(int(pid_path.read_text()));process.terminate()
            try:process.wait(timeout=15)
            except ps.TimeoutExpired:process.kill()
        except Exception:pass
    try:_session_call("heartbeat",{"exiting":True})
    except Exception:pass
    print("H3_SESSION_EXITED cooperative",flush=True)

def _session_heartbeat():
    global _INTERRUPT_AT,_STOP_GRACE_AT
    while not _NORMAL_EXIT.wait(5):
        try:
            current=_QUEUE_JOB
            value={**_QUEUE_PROGRESS}
            if current:value.update(jobId=current["id"],claimToken=current["claimToken"])
            state=_session_call("heartbeat",value)
            if state.get("stopSession") or time.monotonic()-_SESSION_BORN>42600:
                _SESSION_STOP.set()
            if current and _QUEUE_JOB is current and state.get("jobId")==current["id"] and state.get("stopJob"):
                _JOB_CANCEL.set()
                if not _EXECUTING and not _READY and not state.get("hasPending"):_SESSION_STOP.set()
        except Exception:
            if time.monotonic()-_LAST_CONTACT>90:_SESSION_STOP.set()
        if _NORMAL_EXIT.is_set():return
        if _SESSION_STOP.is_set() or _JOB_CANCEL.is_set():
            if _EXECUTING:
                try:requests.post("http://127.0.0.1:8188/interrupt",json={},timeout=3)
                except Exception:pass
                if _INTERRUPT_AT is None:_INTERRUPT_AT=time.monotonic()
                if time.monotonic()-_INTERRUPT_AT<30:continue
            else:
                # A queued cancellation during setup must stop before downloading more weights.
                if _JOB_CANCEL.is_set() and not _SESSION_STOP.is_set():continue
            if _SESSION_STOP.is_set() and not _EXECUTING:
                # Let the main poll loop return and run its finally block first.
                # SIGTERM is a bounded fallback, never the ordinary idle exit.
                if _STOP_GRACE_AT is None:
                    _STOP_GRACE_AT=time.monotonic()
                    print("H3_SESSION_STOP_REQUESTED graceful",flush=True)
                if time.monotonic()-_STOP_GRACE_AT<30:continue
            if _SESSION_STOP.is_set() or (_INTERRUPT_AT is not None and time.monotonic()-_INTERRUPT_AT>=30):
                try:_session_call("heartbeat",{"exiting":True})
                except Exception:pass
                if _NORMAL_EXIT.is_set():return
                print("H3_SESSION_FORCED_EXIT timeout",flush=True)
                os.kill(os.getpid(),signal.SIGTERM)

def _session_take():
    global _QUEUE_JOB,_INTERRUPT_AT
    while not _SESSION_STOP.is_set():
        try:data=_session_call("poll")
        except Exception:
            if time.monotonic()-_LAST_CONTACT>90:_SESSION_STOP.set();return None
            time.sleep(3);continue
        if data.get("stopSession"):_SESSION_STOP.set();return None
        if data.get("job"):
            _JOB_CANCEL.clear();_INTERRUPT_AT=None;_QUEUE_JOB=data["job"]
            if _QUEUE_JOB.get("stopRequested"):_JOB_CANCEL.set()
            return _QUEUE_JOB
        time.sleep(3)
    return None

# Authenticate and claim before expensive setup; the credential can only control this session.
_QUEUE_JOB=_session_take()
if _QUEUE_JOB is None:
    _SESSION_STOP.set();_NORMAL_EXIT.set()
    print("H3_SESSION_EXITED before_setup",flush=True)
if _QUEUE_JOB is not None:
    threading.Thread(target=_session_heartbeat,daemon=True).start()
    _probe=b"H3_QUEUE_PROBE"
    _probe_response=requests.put(_SESSION_API+"/probe",headers={"Authorization":"Bearer "+_SESSION_TOKEN,"X-H3-Worker":_WORKER_ID,"Content-Type":"application/octet-stream"},data=_probe,timeout=20)
    _probe_response.raise_for_status()
    print("H3_SESSION_CHANNEL_READY",flush=True)
`}
export const freshNoiseNode=String.raw`
import os as _session_os
from pathlib import Path as _SessionPath
class H3SessionFreshNoise:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required":{"noise":("NOISE",),"nonce":("STRING",{"default":""})}}
    RETURN_TYPES=("NOISE",)
    FUNCTION="forward"
    CATEGORY="H3/Session"
    def forward(self,noise,nonce):
        global _ck_audited
        if _session_os.environ.get("H3_CK_AUDIT_PATH"):
            _ck_audited=False
            _SessionPath(_session_os.environ["H3_CK_AUDIT_PATH"]).unlink(missing_ok=True)
        print("H3_SESSION_FRESH_NOISE "+nonce,flush=True)
        return (noise,)
NODE_CLASS_MAPPINGS["H3SessionFreshNoise"]=H3SessionFreshNoise
`;
export const sessionWorkerLoop=String.raw`
import hashlib, av

def _session_media_check(path,config):
    with av.open(str(path)) as container:
        stream=container.streams.video[0]
        width,height=stream.codec_context.width,stream.codec_context.height
        fps=float(stream.average_rate)
        frames=sum(1 for _ in container.decode(video=0))
    with av.open(str(path)) as container:
        stream=container.streams.audio[0]
        channels=len(stream.codec_context.layout.channels)
        audio_samples=sum(frame.samples for frame in container.decode(audio=0))
    if (width,height,frames,fps,channels)!=(config["width"],config["height"],config["frames"],24.0,2) or audio_samples<=0:
        raise RuntimeError("最终媒体参数或完整解码校验失败。")
    return {"width":width,"height":height,"frames":frames,"fps":fps,"audio_channels":channels,"audio_samples":audio_samples,"full_decode_passed":True}

def _session_finish(payload):
    for attempt in range(4):
        try:return _session_call("finish",payload)
        except Exception:
            if attempt==3:raise
            time.sleep(2**attempt)

def _session_upload(current,path,digest):
    _session_progress("上传成片",STEPS)
    for attempt in range(3):
        try:
            with path.open("rb") as handle:
                response=requests.put(_SESSION_API+"/video/"+current["id"],params={"claim":current["claimToken"]},headers={"Authorization":"Bearer "+_SESSION_TOKEN,"X-H3-Worker":_WORKER_ID,"Content-Type":"video/mp4","Content-Length":str(path.stat().st_size),"X-Video-SHA256":digest},data=handle,timeout=120)
                response.raise_for_status()
            return
        except Exception:
            if _JOB_CANCEL.is_set() or _SESSION_STOP.is_set() or attempt==2:raise
            time.sleep(2**attempt)

_requested_dual=bool(USE_SECOND_T4_FOR_TEXT_ENCODER and torch.cuda.device_count()>1 and MULTIGPU_NODE_AVAILABLE)
_session_index=0
_READY=True
try:
    while _QUEUE_JOB and not _SESSION_STOP.is_set():
        current=_QUEUE_JOB;p=current["params"]
        PROMPT=p["prompt"];WIDTH=p["width"];HEIGHT=p["height"];DURATION_SECONDS=p["duration"];SEED=int(p["seed"]);STEPS=p["steps"]
        USE_TURBO=p["mode"]=="turbo";SAMPLER_NAME="euler" if USE_TURBO else "res_multistep";GENERATION_MODE=("Turbo" if USE_TURBO else "原版")+" · "+str(STEPS)+"步"
        started=time.perf_counter()
        files={}
        try:
            if _JOB_CANCEL.is_set():raise RuntimeError("当前任务已取消。")
            if USE_TURBO:
                item=("loras/"+TURBO_LORA_NAME,1956193000)
                _session_progress("检查Turbo模型",0);download_model(item);MODEL_FILES[item[0]]=item[1]
            if RUNTIME_PROFILE=="ck":
                proof_path=FINAL_OUTPUT_DIR/"minimax_h3_attention_proof.json"
                # A reused server writes the proof once; retain this actual kernel evidence.
                if _session_index==0 and proof_path.exists():proof_path.unlink()
            for role in ("firstFrame","lastFrame"):
                if p.get(role):
                    _session_progress("读取关键帧",0)
                    name="studio-"+current["id"]+"-"+role+".png"
                    folder=COMFY_DIR/"input";folder.mkdir(parents=True,exist_ok=True)
                    files[role]=name
                    import io
                    from PIL import Image, ImageOps
                    frame=Image.open(io.BytesIO(_session_image(current,role))).convert("RGB")
                    ImageOps.fit(frame,(WIDTH,HEIGHT),method=Image.Resampling.LANCZOS).save(folder/name,format="PNG")
            _session_progress("准备生成",0)
            _EXECUTING=True
            path,resolved,prompt_id,history=execute_attempt({"label":current["id"],"width":WIDTH,"height":HEIGHT,"duration":DURATION_SECONDS,"steps":STEPS,"gpu1_clip":_requested_dual,"images":files})
            _EXECUTING=False
            if _JOB_CANCEL.is_set() or _SESSION_STOP.is_set():raise RuntimeError("当前任务已取消。")
            _session_progress("校验完整视频",STEPS)
            validation=_session_media_check(path,resolved)
            resolved["seed"]=str(SEED)
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            proof=None
            if RUNTIME_PROFILE=="ck":
                proof=json.loads((FINAL_OUTPUT_DIR/"minimax_h3_attention_proof.json").read_text())
                if proof.get("executed") is not True:raise RuntimeError("缺少实际注意力执行证明。")
            metadata={"prompt":PROMPT,"resolved_config":resolved,"prompt_id":prompt_id,"comfyui_commit":COMFY_COMMIT,"model_repo":MODEL_REPO,"model_revision":MODEL_REVISION,"model_files":list(MODEL_FILES),"runtime_profile":RUNTIME_PROFILE,"runtime_command":command,"attention_proof":proof,"server_reused":_session_index>0,"server_pid":int(PID_PATH.read_text()),"session_job_index":_session_index,"media_validation":validation,"video_sha256":digest,"timings":{"setup_seconds":STAGE_TIMINGS.get("setup_seconds",0) if _session_index==0 else 0,"download_seconds":STAGE_TIMINGS.get("download_seconds",0) if _session_index==0 else 0,"server_seconds":STAGE_TIMINGS.get("server_seconds",0) if _session_index==0 else 0,"generation_seconds":resolved["generation_seconds"],"total_seconds":time.perf_counter()-(RUN_STARTED_AT if _session_index==0 else started)}}
            if files:metadata.update({"generation_type":p["generationType"],"generation_inputs":{role:p[role] for role in files}})
            _session_upload(current,path,digest)
            delivered=_session_finish({"jobId":current["id"],"claimToken":current["claimToken"],"status":"completed","metadata":metadata})
            (FINAL_OUTPUT_DIR/("h3_session_"+current["id"]+".json")).write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
            print(("H3_SESSION_DELIVERED " if delivered.get("status")=="completed" else "H3_SESSION_CANCELLED ")+current["id"],flush=True)
        except Exception as exc:
            _EXECUTING=False
            cancelled=_JOB_CANCEL.is_set() or _SESSION_STOP.is_set()
            _session_finish({"jobId":current["id"],"claimToken":current["claimToken"],"status":"cancelled" if cancelled else "failed","error":type(exc).__name__+": "+str(exc)[-1000:]})
            try:requests.post(SERVER_URL+"/free",json={"free_memory":True,"unload_models":False},timeout=10)
            except Exception:pass
            if not cancelled and ("out of memory" in str(exc).lower() or "cuda error" in str(exc).lower()):_SESSION_STOP.set()
        finally:
            for name in files.values():(COMFY_DIR/"input"/name).unlink(missing_ok=True)
        _session_index+=1;_QUEUE_JOB=None;_JOB_CANCEL.clear();_INTERRUPT_AT=None
        _session_progress("等待下一条任务",0)
        if not _SESSION_STOP.is_set():_session_take()
finally:
    _NORMAL_EXIT.set()
    try:_session_call("heartbeat",{"exiting":True})
    except Exception:pass
    _SESSION_STOP.set()
    try:
        process=psutil.Process(int(PID_PATH.read_text()));process.terminate()
        try:process.wait(timeout=15)
        except psutil.TimeoutExpired:process.kill()
    except Exception:pass
print("H3_SESSION_EXITED",flush=True)
`;
