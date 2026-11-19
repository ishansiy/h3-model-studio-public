export function explicitSessionId(value: any): number | null {
  // Notebook version numbers and kernel IDs are different identifiers.
  const id = value?.kernelSessionId ?? value?.kernel_session_id;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
export async function controlHash(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,"0")).join("");
}
export function createControlToken(){ return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join(""); }
export async function readControl(request: Request, database: D1Database, id: string) {
  const token=request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if(!token)return Response.json({error:"无效的任务控制凭证。"},{status:401});
  const row=await database.prepare("SELECT stop_requested_at FROM jobs WHERE id=? AND control_hash=?").bind(id,await controlHash(token)).first<{stop_requested_at:number|null}>();
  if(!row)return Response.json({error:"无效的任务控制凭证。"},{status:401});
  return Response.json({stopRequested:!!row.stop_requested_at},{headers:{"Cache-Control":"no-store"}});
}
export function controlCell(url:string,token:string){
 return `# Job-scoped credential: can only read this task's stop signal.\nimport threading, requests, json, os, time, signal\ndef _h3_stop_signal():\n    with requests.get(${JSON.stringify(url)},headers={"Authorization":"Bearer "+${JSON.stringify(token)}},timeout=(5,8)) as response:\n        response.raise_for_status()\n        value=response.json().get("stopRequested")\n        if not isinstance(value,bool):raise RuntimeError("Invalid stop response")\n        return value\n# Fail before model downloads if the stop channel cannot be reached.\ntry:\n    _h3_stop_signal()\nexcept Exception as exc:\n    raise RuntimeError("停止控制通道不可用，拒绝开始模型下载："+type(exc).__name__) from None\nprint("H3: 停止控制通道已验证。",flush=True)\ndef _h3_stop_watcher():\n    last_warning=0\n    while True:\n        try:\n            if _h3_stop_signal():\n                print("H3: 收到用户停止请求，正在结束运行。",flush=True)\n                try:\n                    import psutil\n                    children=psutil.Process(os.getpid()).children(recursive=True)\n                    for child in reversed(children):\n                        try: child.terminate()\n                        except psutil.Error: pass\n                    _,alive=psutil.wait_procs(children,timeout=3)\n                    for child in alive:\n                        try: child.kill()\n                        except psutil.Error: pass\n                finally:\n                    os.kill(os.getpid(),signal.SIGTERM)\n                return\n        except Exception as exc:\n            if time.monotonic()-last_warning>60:\n                print("H3: 停止控制暂不可达："+type(exc).__name__,flush=True)\n                last_warning=time.monotonic()\n        time.sleep(5)\nthreading.Thread(target=_h3_stop_watcher,daemon=True).start()\n`;
}
