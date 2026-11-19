import assert from 'node:assert/strict';
import {NodeDatabase} from '../lib/node-runtime';
import {accountProxyRoute} from '../lib/account-proxy';
import {encrypt,decrypt,accountCredential} from '../lib/store';
import {persistVerifiedAccount} from '../lib/account-persistence';
process.env.H3_MASTER_KEY='test-master-key-'.repeat(4);
const d=new NodeDatabase('',':memory:');(globalThis as any).__h3NodeDb=d;
const id=await persistVerifiedAccount(d as any,'owner','testuser','测试',await encrypt('KGAT_dummy_test_token_never_real'),'test');
const request=(method='GET',value?:unknown)=>new Request('http://localhost/api/accounts/'+id+'/proxy',{method,headers:{'Content-Type':'application/json'},body:value?JSON.stringify(value):undefined});
const network={verify:async(c:any,u?:string)=>{assert.equal(c.proxyUrl,'http://user:secret@127.0.0.1:8080/');assert.equal(u,'testuser');return 'testuser';},fetch:async(c:any,_u:any)=>Response.json({ip:'203.0.113.2'})};
try{
 assert.equal((await accountProxyRoute(request(),'another-owner',id)).status,404);
 let r=await accountProxyRoute(request('POST',{enabled:true,action:'save',proxyUrl:'http://user:secret@127.0.0.1:8080'}),'owner',id,network);assert.equal(r.status,200);assert.ok(!(await r.text()).includes('secret'));
 const stored=await d.prepare('SELECT value FROM settings WHERE id=?').bind('account-proxy:owner:'+id).first<any>();assert.ok(!stored.value.includes('secret'));assert.equal(JSON.parse(await decrypt(stored.value)).url,'http://user:secret@127.0.0.1:8080/');
 const a=await d.prepare('SELECT * FROM accounts WHERE id=?').bind(id).first<any>();assert.equal((await accountCredential(a) as any).proxyUrl,'http://user:secret@127.0.0.1:8080/');
 r=await accountProxyRoute(request('POST',{enabled:true,action:'save',proxyUrl:'http://broken:80'}),'owner',id,{verify:async()=>{throw Error('secret');},fetch:network.fetch});assert.equal(r.status,400);assert.ok(!(await r.text()).includes('secret'));assert.equal((await d.prepare('SELECT value FROM settings WHERE id=?').bind('account-proxy:owner:'+id).first<any>()).value,stored.value);
 await d.query("INSERT INTO gpu_sessions(id,owner,account_id,username,status,profile,token_hash,kernel_ref,created_at,expires_at) VALUES(?,?,?,?,'active','standard','x','test/k',?,?)",['s','owner',id,'testuser',Date.now(),Date.now()+1000]);
 assert.equal((await accountProxyRoute(request('POST',{enabled:false,action:'save'}),'owner',id)).status,409);
 await assert.rejects(persistVerifiedAccount(d as any,'owner','testuser','测试','changed','test',Date.now(),'changed-proxy'),/活动任务/);assert.equal((await d.prepare('SELECT cipher FROM accounts WHERE id=?').bind(id).first<any>()).cipher,a.cipher);
 await d.query("UPDATE gpu_sessions SET status='completed' WHERE id='s'");assert.equal((await accountProxyRoute(request('POST',{enabled:false,action:'save'}),'owner',id)).status,200);assert.equal(typeof await accountCredential(a),'string');
 console.log('通过：代理配置加密、API不回显认证、账户隔离、连接失败保留原配置、活动任务禁止改代理、显式停用后直连。');
}finally{await d.close();delete (globalThis as any).__h3NodeDb;}
