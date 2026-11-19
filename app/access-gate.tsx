"use client";
import {useState} from "react";
import {Aperture,KeyRound,ShieldCheck,ArrowRight,LoaderCircle,AlertCircle} from "lucide-react";
export default function AccessGate({returnTo="/"}:{returnTo?:string}){
  const [password,setPassword]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function unlock(event:React.FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setError("");
    try{const response=await fetch("/api/access",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});const data=await response.json() as any;if(!response.ok)throw new Error(data.error || "验证失败，请重试。");setPassword("");window.location.replace(returnTo);}
    catch(e){setError((e as Error).message);setBusy(false);}
  }
  return <main className="access-page"><section className="panel access-panel"><div className="access-brand"><span className="brand-mark"><Aperture size={25}/></span><span>模型工作室</span></div><div className="access-symbol"><KeyRound size={28}/></div><h1>输入密码，进入工作室。</h1><p className="access-description">输入你的访问密码，直接开始创作。</p><form onSubmit={unlock}><div className="field"><label htmlFor="access-password">访问密码</label><input id="access-password" name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e=>setPassword(e.target.value)} placeholder="请输入访问密码" disabled={busy}/></div>{error&&<div className="inline-error" role="alert"><AlertCircle size={15}/>{error}</div>}<button className="button primary access-submit" type="submit" disabled={busy||!password}>{busy?<LoaderCircle size={16} className="spin"/>:<ArrowRight size={16}/>} {busy?"正在验证…":"进入工作室"}</button></form><div className="access-privacy"><ShieldCheck size={15}/><span>单人工作室 · 账户密钥加密保存</span></div></section></main>;
}
