import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {ACCESS_SECONDS,accessConfigured,passwordVerifier,verifyPassword,issueAccessSession,hasAccessSession,handleAccessRequest,accessCookieFromRequest} from "../lib/access";
const password="test-only-password-2026", verifier=await passwordVerifier(password), config={verifier,sessionSecret:"12".repeat(32)};
assert.equal(accessConfigured(config),true);assert.equal(accessConfigured({}),false);
assert.equal(verifier.includes(password),false);assert.equal(await verifyPassword(password,config),true);assert.equal(await verifyPassword("wrong",config),false);assert.equal(await verifyPassword(password,{}),false);
const now=Date.now(),session=await issueAccessSession(config,now);
assert.equal(await hasAccessSession(session,config,now),true);
assert.equal(await hasAccessSession(session,config,now+ACCESS_SECONDS*1000),false);
assert.equal(await hasAccessSession(session.slice(0,-1)+(session.endsWith("0")?"1":"0"),config,now),false);
assert.equal(await hasAccessSession(session.replace(/v1\.\d+/,"v1.9999999999"),config,now),false);
assert.equal(await hasAccessSession(session,{...config,verifier:await passwordVerifier("changed-password")},now),false);
assert.equal(await hasAccessSession(session,{...config,sessionSecret:"34".repeat(32)},now),false);
assert.equal(await hasAccessSession("",config),false);assert.equal(await hasAccessSession(session,{}),false);
let attempts=0;
const limit=async()=>({attempts:++attempts,expires:Date.now()+15*60_000});
const request=(value:string,origin="https://studio.example",method="POST")=>new Request("https://studio.example/api/access",{method,headers:{Origin:origin,"Content-Type":"application/json","CF-Connecting-IP":"192.0.2.123"},...(method==="POST"?{body:JSON.stringify({password:value})}:{})});
const cross=await handleAccessRequest(request(password,"https://attacker.example"),config,limit);assert.equal(cross.status,403);assert.equal(attempts,0);
assert.equal((await handleAccessRequest(request(password),{},limit)).status,503);
assert.equal((await handleAccessRequest(request("wrong"),config,limit)).status,401);
const accepted=await handleAccessRequest(request(password),config,limit);assert.equal(accepted.status,200);
const cookie=accepted.headers.get("Set-Cookie")!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);assert.ok(!cookie.includes(password));
const cookieRequest=new Request("https://studio.example/api/jobs",{headers:{Cookie:cookie.split(";")[0]}});
assert.equal(await hasAccessSession(accessCookieFromRequest(cookieRequest),config),true);
for(let i=attempts;i<10;i++)await handleAccessRequest(request("wrong"),config,limit);
const denied=await handleAccessRequest(request(password),config,limit);assert.equal(denied.status,429);assert.ok(Number(denied.headers.get("Retry-After"))>0);
const logout=await handleAccessRequest(request("","https://studio.example","DELETE"),config,limit);assert.match(logout.headers.get("Set-Cookie")!,/Max-Age=0/);
// 使用生产路由的实际 SQL 检查跨请求持久计数与窗口过期重置。
const source=readFileSync(new URL("../app/api/access/route.ts",import.meta.url),"utf8");
const sql=source.match(/prepare\("([^"\n]+)"\)/)![1];
execFileSync("python3",["-c",`import sqlite3,json,sys
c=sqlite3.connect(':memory:');c.execute('CREATE TABLE settings(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
sql=sys.stdin.read()
for n in range(1,12):
 row=c.execute(sql,('access-rate:test',json.dumps(dict(attempts=1,expires=1000)),100)).fetchone()
 assert json.loads(row[0])['attempts']==n
row=c.execute(sql,('access-rate:test',json.dumps(dict(attempts=1,expires=3000)),1001)).fetchone()
assert json.loads(row[0])==dict(attempts=1,expires=3000)
`],{input:sql});
console.log("通过：密码哈希、正确/错误密码、会话签名与篡改/过期/轮换失效、配置缺失拒绝、跨站请求拒绝、HttpOnly/Secure Cookie、持久限流与过期重置、锁定退出。");
