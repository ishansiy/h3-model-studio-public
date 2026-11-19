"use client";
import AccountProxyPanel from "./account-proxy-panel";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowUpRight, Check, CircleCheck, Cpu, LoaderCircle, Plus, RefreshCw, UserRound } from "lucide-react";
import type { AccountResources, ResourceQuota } from "../lib/resources";

type Account={id:string;name:string;username:string;hint:string;busy:number};
type Props={accounts:Account[];selectedId:string;onSelect:(id:string)=>void;onAdd:()=>void;revision:number;onProxySaved?:()=>void};
const hours=(value:number)=>value.toFixed(2);
const dateLabel=(date:number|string)=>new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(date));

function Quota({quota}:{quota:ResourceQuota}) {
  const percent=quota.totalHours>0?Math.min(100,quota.remainingHours/quota.totalHours*100):0;
  return <div className={`resource-quota ${quota.remainingHours<=0?"depleted":""}`}>
    <div className="resource-caption"><span><Cpu size={13}/>{quota.resource} 周额度</span>{quota.extended&&<small>含扩展额度</small>}</div>
    <div className="resource-remaining"><strong>{hours(quota.remainingHours)}</strong><span>小时剩余</span></div>
    <div className="resource-track" role="progressbar" aria-label={`${quota.resource} 剩余额度`} aria-valuenow={Number(quota.remainingHours.toFixed(2))} aria-valuemin={0} aria-valuemax={quota.totalHours}><span style={{width:`${percent}%`}}/></div>
    <div className="resource-details"><span>已用 {hours(quota.usedHours)}h</span><span>总额 {hours(quota.totalHours)}h</span></div>
    {quota.reservedHours!==null&&quota.reservedHours>0&&<p className="resource-reserved">当前会话预留 {hours(quota.reservedHours)}h</p>}
  </div>;
}

export default function AccountOverview({accounts,selectedId,onSelect,onAdd,revision,onProxySaved}:Props) {
  const [data,setData]=useState<Record<string,AccountResources>>({}),[loading,setLoading]=useState<Record<string,boolean>>({});
  const inFlight=useRef(new Set<string>()),currentAccounts=useRef(accounts); currentAccounts.current=accounts;
  const ids=accounts.map(a=>a.id+":"+a.hint).join("|");
  const loadOne=useCallback(async(a:Account,force=false)=>{
    if(inFlight.current.has(a.id))return;
    inFlight.current.add(a.id);setLoading(old=>({...old,[a.id]:true}));
    try {
      const r=await fetch(`/api/accounts/${a.id}/resources${force?"?refresh=1":""}`),result=await r.json() as {error?:string;resources:AccountResources};
      if(!r.ok)throw new Error(result.error||"账户状态查询失败。");
      setData(old=>({...old,[a.id]:result.resources}));
    } catch(e) {
      setData(old=>({...old,[a.id]:{status:"unavailable",checkedAt:Date.now(),quotas:[],error:(e as Error).message,quotaError:null}}));
    } finally {inFlight.current.delete(a.id);setLoading(old=>({...old,[a.id]:false}));}
  },[]);
  const refreshAll=useCallback(async(force=false)=>{
    const list=currentAccounts.current;let index=0;
    await Promise.all(Array.from({length:Math.min(3,list.length)},async()=>{
      while(index<list.length){const a=list[index++];await loadOne(a,force);}
    }));
  },[loadOne]);
  useEffect(()=>{void refreshAll();const timer=setInterval(()=>{if(document.visibilityState==="visible")void refreshAll();},120000);return()=>clearInterval(timer);},[ids,revision,refreshAll]);
  const busy=accounts.some(a=>loading[a.id]);
  const known=accounts.map(a=>data[a.id]?.quotas.find(q=>q.resource==="GPU")).filter((q):q is ResourceQuota=>!!q);
  const totalRemaining=known.reduce((sum,q)=>sum+q.remainingHours,0);
  return <section id="accounts-overview" className="accounts-overview" aria-labelledby="account-overview-title">
    <div className="history-heading"><div><h2 id="account-overview-title">账户列表 <span>{accounts.length}</span></h2><p>账户状态与本周计算额度，一处查看。</p></div><div className="overview-actions"><button className="button secondary small" disabled={!accounts.length||busy} onClick={()=>void refreshAll(true)}><RefreshCw size={14} className={busy?"spin":""}/>刷新全部额度</button><button className="button secondary small" onClick={onAdd}><Plus size={14}/>添加账户</button></div></div>
    {!accounts.length?<div className="empty-history"><div className="empty-icon"><UserRound size={25}/></div><div><strong>连接你的第一个 Kaggle 账户</strong><p>添加密钥后，会自动查询账户状态及可用计算额度。</p></div></div>:<>
      <div className="resource-summary"><div><Cpu size={16}/><span>GPU 剩余周额度合计</span><strong>{known.length?hours(totalRemaining):"—"}<small>小时</small></strong></div><span>已查询 {known.length} / {accounts.length} 个账户 · 占用中的账户 {accounts.filter(a=>a.busy).length}</span></div>
      <div className="resource-account-grid">{accounts.map(a=>{
        const info=data[a.id],gpu=info?.quotas.find(q=>q.resource==="GPU"),tpu=info?.quotas.find(q=>q.resource==="TPU");
        const invalid=info?.status==="invalid",unavailable=info?.status==="unavailable";
        const status=loading[a.id]?"检查中":!info?"待检查":invalid?"密钥失效":unavailable?"暂时无法检查":"已连接";
        const reset=info?.quotas.find(q=>q.refreshAt)?.refreshAt;
        return <article key={a.id} className={`resource-account-card ${selectedId===a.id?"selected":""}`}>
          <div className="resource-account-header"><span className="account-avatar">{a.name.slice(0,1)}</span><div><h3>{a.name}</h3><a href={`https://www.kaggle.com/${a.username}`} target="_blank" rel="noreferrer">{a.username}<ArrowUpRight size={11}/></a></div><span className={`resource-status ${invalid?"invalid":unavailable?"unknown":""}`}>{loading[a.id]?<LoaderCircle size={12} className="spin"/>:invalid||unavailable?<AlertCircle size={12}/>:info?<CircleCheck size={12}/>:null}{status}</span></div>
          <div className="account-task-state"><span className={`status-dot ${a.busy?"amber":""}`}/>{a.busy?"有活动GPU会话或任务":"本网站暂无进行中的任务"}<small>密钥尾号 {a.hint}</small></div>
          <div className="account-quota-grid">{gpu?<Quota quota={gpu}/>:<div className="resource-quota missing"><span>GPU 周额度</span><strong>—</strong><small>{loading[a.id]?"正在查询…":"暂未取得额度数据"}</small></div>}{tpu?<Quota quota={tpu}/>:<div className="resource-quota missing"><span>TPU 周额度</span><strong>—</strong><small>{loading[a.id]?"正在查询…":"暂未取得额度数据"}</small></div>}</div>
          {(info?.error||info?.quotaError)&&<p className="resource-error" role="status"><AlertCircle size={13}/>{info.error||info.quotaError}</p>}
          {reset&&<p className="quota-reset">额度重置：{dateLabel(reset)}（北京时间）</p>}
          <AccountProxyPanel id={a.id} busy={!!a.busy} onSaved={()=>onProxySaved?.()}/><div className="resource-account-footer"><small>{info?`检查于 ${dateLabel(info.checkedAt)}`:"尚未检查"}</small><div><button className="icon-button" onClick={()=>void loadOne(a,true)} disabled={!!loading[a.id]} aria-label={`刷新${a.name}额度`}><RefreshCw size={13} className={loading[a.id]?"spin":""}/></button><button className={`choose-account ${selectedId===a.id?"current":""}`} disabled={selectedId===a.id||invalid} onClick={()=>onSelect(a.id)}>{selectedId===a.id?<><Check size={12}/>当前账户</>:"用于生成"}</button></div></div>
        </article>;
      })}</div>
      <p className="quota-footnote">数据来自 Kaggle，每 2 分钟更新；“剩余”按总额度减已用时长计算，会话预留另行显示。TPU 额度仅供查看，当前图像与视频模型使用 GPU。</p>
    </>}
  </section>;
}
