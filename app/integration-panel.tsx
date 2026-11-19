"use client";
import {useEffect,useState} from "react";
import {KeyRound,Plus,Copy,Trash2,LoaderCircle,ArrowDownToLine} from "lucide-react";
type Key={scope:string;id:string;name:string;hint:string;expiresAt:number;lastUsedAt:number|null};
async function api(path:string,init?:RequestInit){const r=await fetch(`/api/${path}`,{...init,headers:{"Content-Type":"application/json",...init?.headers}});const data=await r.json() as any;if(!r.ok)throw new Error(data.error||"请求失败。");return data;}
const date=(value:number)=>new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",dateStyle:"short",timeStyle:"short",hour12:false}).format(value);
export default function IntegrationPanel(){
  const[scopes,setScopes]=useState<string[]>(["accounts:read","models:read","jobs:read","jobs:write"]);
  const[keys,setKeys]=useState<Key[]>([]),[loaded,setLoaded]=useState(false),[name,setName]=useState("外部应用"),[secret,setSecret]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[copied,setCopied]=useState(false);
  async function refresh(){try{setKeys((await api("integration-keys")).keys);setLoaded(true);}catch(e){setError((e as Error).message);}}
  useEffect(()=>{void refresh();},[]);
  async function create(){setBusy(true);setError("");setSecret("");setCopied(false);try{const result=await api("integration-keys",{method:"POST",body:JSON.stringify({name,scopes})});setSecret(result.token);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function revoke(key:Key){if(!window.confirm(`撤销“${key.name}”的 API 密钥？使用它的脚本将立即失去接入权限。`))return;setBusy(true);setError("");try{await api(`integration-keys/${key.id}`,{method:"DELETE"});setSecret("");await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function copy(){try{await navigator.clipboard.writeText(secret);setCopied(true);}catch{setError("无法复制，请手动选中并复制密钥。");}}
  return <details open className="panel integration-panel" id="account-api" onToggle={e=>{if(e.currentTarget.open&&!loaded)void refresh();}}><summary><KeyRound size={17}/><strong>脚本接入 API</strong><span>连接外部程序与生成任务</span></summary><div className="integration-content">
    <p>外部程序可按授权读取模型、提交图像或视频、查询进度、取消任务及下载作品。账户接入权限单独选择，旧密钥保持原权限。</p>
    <div className="integration-create"><label htmlFor="integration-name">密钥名称</label><input id="integration-name" value={name} maxLength={40} onChange={e=>setName(e.target.value)}/><button className="button primary small" disabled={busy||keys.length>=5||!scopes.length} onClick={create}>{busy?<LoaderCircle className="spin" size={14}/>:<Plus size={14}/>}创建 API 密钥</button></div>
    <fieldset><legend>新密钥权限</legend>{[["models:read","查看模型"],["jobs:read","查看任务与下载作品"],["jobs:write","创建及取消任务"],["accounts:read","读取账户列表"],["accounts:write","接入或更新账户"]].map(([scope,label])=><label key={scope} style={{display:"inline-flex",gap:6,marginRight:16}}><input type="checkbox" checked={scopes.includes(scope)} onChange={e=>setScopes(e.target.checked?[...scopes,scope]:scopes.filter(s=>s!==scope))}/>{label}</label>)}</fieldset>
    {secret&&<div className="integration-secret"><strong>请现在保存密钥，它只会显示一次</strong><input aria-label="新创建的 API 密钥" value={secret} readOnly autoComplete="off" spellCheck={false}/><div><button className="button secondary small" onClick={copy}><Copy size={13}/>{copied?"已复制":"复制密钥"}</button><button className="text-button" onClick={()=>setSecret("")}>我已保存</button></div></div>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <div className="integration-keys">{keys.map(key=><div className="integration-key" key={key.id}><div><strong>{key.name}</strong><small>权限 {key.scope} · 尾号 {key.hint} · 到期 {date(key.expiresAt)} · {key.lastUsedAt?`最近使用 ${date(key.lastUsedAt)}`:"尚未使用"}</small></div><button className="text-button" disabled={busy} onClick={()=>revoke(key)} aria-label={`撤销${key.name}API密钥`}><Trash2 size={13}/>撤销</button></div>)}</div>
    <p className="subtle">密钥有效期 90 天，最多 5 个；权限以创建时勾选项为准，撤销立即生效。每个密钥每分钟最多 20 次请求。不会返回已保存的 Kaggle Token。</p>
    <div className="integration-doc"><strong>开发者文档</strong><p><a href="/generation-api-guide.txt" target="_blank" rel="noreferrer">生成 API 调用说明</a> · <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI 规范</a> · <a href="/studio-api-client.py" download>Python 示例</a></p><strong>账户接入地址</strong><code>POST /api/v1/accounts</code><p>请求头：Authorization: Bearer 你的工作室 API 密钥；Content-Type: application/json</p><pre>{'{"name":"创作账户","token":"KGAT_…"}'}</pre><p>返回账户 id、name、username、hint、created_at。GET 同一地址可读取你的账户列表。每个工作空间最多连接 20 个账户。</p><a className="button secondary small" href="/connect-kaggle-account.py" download><ArrowDownToLine size={14}/>下载 Python 接入脚本</a><a className="token-help" href="/account-api-guide.txt" target="_blank" rel="noreferrer">查看完整调用说明与错误码</a></div>
  </div></details>;
}
