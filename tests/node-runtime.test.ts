import {createIntegrationKey,authenticateIntegration} from '../lib/integration-api';
import {persistVerifiedAccount} from '../lib/account-persistence';
import {publicUrl,publicRequest} from '../lib/public-url';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool,QueryConfig} from 'pg';
import {importSqlite} from '../scripts/import-sqlite';
import {account,encrypt,job} from '../lib/store';
import {NodeDatabase,NodeBucket,postgresSql,validateEnvironment} from '../lib/node-runtime';
import {enqueue,workerPoll,cancelQueuedJob,getSession,workerHeartbeat,finishQueueJob} from '../lib/session-queue';
import {frameCount} from '../lib/parameters';
assert.equal(publicUrl(new Request('http://0.0.0.0:3000/api/access',{headers:{host:'localhost:8791'}})).origin,'http://localhost:8791');process.env.PUBLIC_BASE_URL='https://studio.example.com';assert.equal(publicRequest(new Request('http://0.0.0.0:3000/api/access')).url,'https://studio.example.com/api/access');delete process.env.PUBLIC_BASE_URL;
const dir=mkdtempSync(join(tmpdir(),'h3-storage-'));
function pglitePool(pg:PGlite) {
 const query=async(input:string|QueryConfig,values?:unknown[])=>{
  const text=typeof input==='string'?input:input.text;
  const rowMode=typeof input==='string'?'object':(input as QueryConfig&{rowMode?:'array'}).rowMode??'object';
  const result=await pg.query(text,values,{rowMode});
  return {rows:result.rows,rowCount:result.affectedRows};
 };
 return {query,connect:async()=>({query,release(){}}),end:()=>pg.close()} as unknown as Pool;
}
async function exercise(d:NodeDatabase){
 await d.ready;const db=d as unknown as D1Database;
 const apiKey=await createIntegrationKey(db,'owner','API回归',Date.now(),['jobs:read']);const auth=new Request('https://test/api/v1/jobs',{headers:{Authorization:'Bearer '+apiKey.token}});assert.equal(await authenticateIntegration(auth,db,Date.now(),'jobs:read'),'owner');await assert.rejects(authenticateIntegration(auth,db,Date.now(),'jobs:write'),(e:any)=>e.status===403);
const proxyAccount=await persistVerifiedAccount(db,'owner','proxyuser','测试','test-cipher','hint',Date.now(),'encrypted-proxy-test');assert.equal((await d.prepare('SELECT value FROM settings WHERE id=?').bind('account-proxy:owner:'+proxyAccount).first<any>()).value,'encrypted-proxy-test');
 await d.query('INSERT INTO settings(id,value) VALUES(?,?)',['example',JSON.stringify({expires:200,attempts:1})]);
 const rate="INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=CASE WHEN json_extract(settings.value,'$.expires')<=? THEN excluded.value ELSE json_set(settings.value,'$.attempts',json_extract(settings.value,'$.attempts')+1) END RETURNING value";
 const r=await d.prepare(rate).bind('example','{}',100).first<any>();assert.equal(JSON.parse(r.value).attempts,2);
 await assert.rejects(d.batch([d.prepare('INSERT INTO settings(id,value) VALUES(?,?)').bind('rollback','x'),d.prepare('INSERT INTO settings(id,value) VALUES(?,?)').bind('example','x')]));assert.equal(await d.prepare('SELECT id FROM settings WHERE id=?').bind('rollback').first(),null);
 const a={id:'a',username:'testuser',name:'测试账户'},params={prompt:'海边',mode:'quality',width:512,height:288,duration:4.46,steps:20,seed:123,runtimeProfile:'standard'};
 const first=await enqueue(db,'owner',a,'j1',params);assert.ok(first.launch);assert.ok(first.session);
 const second=await enqueue(db,'owner',a,'j2',params);assert.equal(second.launch,null);assert.equal(second.session!.id,first.session!.id);
 assert.equal((await enqueue(db,'owner',a,'j1',params)).launch,null);
 const polled=await workerPoll(db,first.session!);assert.equal(polled.job!.id,'j1');assert.equal((await workerPoll(db,first.session!)).job!.claimToken,polled.job!.claimToken);
 await workerHeartbeat(db,first.session!,{jobId:'j1',claimToken:polled.job!.claimToken,step:999});assert.equal((await d.prepare('SELECT step FROM jobs WHERE id=?').bind('j1').first<any>()).step,20);
 const bucket=new NodeBucket(d),bytes=Buffer.from('test-artifact'),sha=createHash('sha256').update(bytes).digest('hex');await bucket.put('video',bytes,{sha256:sha});assert.equal((await bucket.head('video'))!.size,bytes.length);assert.equal(await (await bucket.get('video',{range:{offset:5,length:3}}))!.text(),'art');
 await assert.rejects(bucket.put('bad',bytes,{sha256:'bad'}));assert.equal(await bucket.head('bad'),null);
 await d.query('UPDATE jobs SET artifact_key=?,artifact_sha=?,artifact_bytes=? WHERE id=?',['video',sha,bytes.length,'j1']);
 const m={runtime_profile:'standard',resolved_config:{...params,frames:frameCount(params.duration)},media_validation:{full_decode_passed:true,frames:frameCount(params.duration),width:512,height:288,fps:24,audio_channels:2},video_sha256:sha};
 await finishQueueJob(db,first.session!,{jobId:'j1',claimToken:polled.job!.claimToken,status:'completed',metadata:m},key=>bucket.head(key));
 assert.equal((await d.prepare('SELECT status FROM jobs WHERE id=?').bind('j1').first<any>()).status,'completed');
 await cancelQueuedJob(db,'owner','j2');assert.equal((await d.prepare('SELECT status FROM jobs WHERE id=?').bind('j2').first<any>()).status,'cancelled');
 await d.query("UPDATE jobs SET metadata=json_set(COALESCE(metadata,'{}'),'$.termination',json(?)) WHERE id=?",[JSON.stringify({source:'test'}),'j1']);assert.equal(JSON.parse((await d.prepare('SELECT metadata FROM jobs WHERE id=?').bind('j1').first<any>()).metadata).termination.source,'test');
 assert.equal((await getSession(db,first.session!.id))!.profile,'standard');
}
try {
 const file=join(dir,'test.db');
 let sqlite=new NodeDatabase('',file);
 await exercise(sqlite);
 // Persist an actual encrypted credential and terminal history for import.
 process.env.H3_MASTER_KEY='x'.repeat(32);
 process.env.SITE_PASSWORD='local-test-only';
 const cipher=await encrypt('test-persistence-credential');
 await sqlite.query('UPDATE accounts SET cipher=?',[cipher]);
 await sqlite.query("UPDATE settings SET value=? WHERE id LIKE 'account-proxy:%'",[await encrypt('test-proxy-settings')]);
 await sqlite.query("UPDATE gpu_sessions SET status='completed'");
 await sqlite.close();
 sqlite=new NodeDatabase('',file);
 assert.equal((await new NodeBucket(sqlite).head('video'))!.size,13);
 await sqlite.close();

 // The same node-postgres Drizzle driver runs against a PostgreSQL-compatible
 // fixture, including the path that baselines an existing PostgreSQL database.
 const legacy=new PGlite(join(dir,'postgres-legacy'));
 await legacy.exec(readFileSync('lib/schema.sql','utf8'));
 await legacy.query("INSERT INTO settings(id,value) VALUES('existing','retain')");
 let postgres=new NodeDatabase('','',pglitePool(legacy));
 await exercise(postgres);
 assert.equal(await postgres.prepare("SELECT value FROM settings WHERE id='existing'").first('value'),'retain');
 const namespaces=await postgres.prepare('SELECT COUNT(*) AS n FROM h3_studio_migrations.__drizzle_migrations').first('n');
 assert.equal(Number(namespaces),1);
 await postgres.close();
 postgres=new NodeDatabase('','',pglitePool(new PGlite(join(dir,'postgres-legacy'))));
 assert.equal(Number(await postgres.prepare('SELECT COUNT(*) AS n FROM h3_studio_migrations.__drizzle_migrations').first('n')),1);
 assert.equal(await postgres.prepare("SELECT value FROM settings WHERE id='existing'").first('value'),'retain');
 assert.equal(await (await new NodeBucket(postgres).get('video',{range:{offset:5,length:3}}))!.text(),'art');
 await postgres.close();

 const imported=()=>new NodeDatabase('','',pglitePool(new PGlite(join(dir,'postgres-import'))));
 postgres=imported();
 try {
  await assert.rejects(importSqlite(file,postgres,'wrong-owner'),/BOOTSTRAP_OWNER_ID/);
  const damagedFile=join(dir,'damaged.db');
  const {copyFileSync}=await import('node:fs');
  copyFileSync(file,damagedFile);
  const damaged=new NodeDatabase('',damagedFile);
  await damaged.query("UPDATE h3_objects SET body=? WHERE key='video'",[Buffer.from('broken-bytes!')]);
  await damaged.close();
  await assert.rejects(importSqlite(damagedFile,postgres,'owner'),/SHA-256/);
  assert.equal(await postgres.prepare('SELECT id FROM jobs').first(),null);
  assert.equal(await postgres.prepare('SELECT id FROM accounts').first(),null);
  const counts=await importSqlite(file,postgres,'owner');
  assert.equal(counts.accounts,1);
  assert.equal(counts.jobs,2);
  assert.equal(counts.gpu_sessions,1);
  assert.equal(counts.integration_keys,1);
  assert.equal(counts.h3_objects,1);
  await assert.rejects(importSqlite(file,postgres,'owner'),/目标数据库必须为空/);
 } finally {
  await postgres.close();
 }
 postgres=imported();
 try {
  const stored=await postgres.prepare('SELECT id FROM accounts').first<string>('id');
  assert.ok(stored);
  const runtime=globalThis as typeof globalThis&{__h3NodeDb?:NodeDatabase};
  runtime.__h3NodeDb=postgres;
  try {
   assert.equal((await account('owner',stored))?.cipher,cipher);
   assert.equal(await account('different',stored),null);
   assert.equal((await job('owner','j1'))?.status,'completed');
  } finally {
   delete runtime.__h3NodeDb;
  }
  assert.equal(await (await new NodeBucket(postgres).get('video'))!.text(),'test-artifact');
 } finally {
  await postgres.close();
 }

 process.env.RENDER='true';
 process.env.ALLOW_PERSISTENT_SQLITE='true';
 delete process.env.DATABASE_URL;
 assert.throws(validateEnvironment,/持久Postgres/);
 assert.throws(()=>new NodeDatabase('',join(dir,'render-local.db')),/持久Postgres/);
 assert.equal(postgresSql("SELECT '?' AS q,? AS a"),"SELECT '?' AS q,$1 AS a");
 console.log('通过：Drizzle 新库迁移与旧 PostgreSQL 原地升级、重启持久化、SQLite 整库迁入、错误回滚、队列与媒体 Range。');
} finally {
 rmSync(dir,{recursive:true,force:true});
}
