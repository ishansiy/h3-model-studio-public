import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash,pbkdf2Sync} from 'node:crypto';
import {Pool,types,type PoolClient} from 'pg';
import {eq,sql} from 'drizzle-orm';
import {migratePostgres,postgresOrm} from './db/postgres';
import {objects} from './db/schema';
types.setTypeParser(20,Number);
const renderDatabaseError = 'Render 必须配置持久Postgres DATABASE_URL。';
const schemaPath = resolve('lib/schema.sql');
export function postgresSql(sql:string){let ignore=/^\s*INSERT OR IGNORE /i.test(sql);sql=sql.replace("json_extract(settings.value,'$.expires')", "(settings.value::jsonb->>'expires')::bigint").replace("json_set(settings.value,'$.attempts',json_extract(settings.value,'$.attempts')+1)","jsonb_set(settings.value::jsonb,'{attempts}',to_jsonb((settings.value::jsonb->>'attempts')::bigint+1))::text").replace("json_set(COALESCE(metadata,'{}'),'$.termination',json(?))", "jsonb_set(COALESCE(metadata,'{}')::jsonb,'{termination}',?::jsonb)::text");sql=sql.replace(/INSERT OR IGNORE /i,'INSERT ').replace(/\bMIN\(/g,'LEAST(').replace(/\bMAX\(/g,'GREATEST(');let n=0;sql=sql.replace(/'(?:''|[^'])*'|\?/g,x=>x==='?'?'$'+(++n):x);if(ignore&&!/ON CONFLICT/i.test(sql))sql+=' ON CONFLICT DO NOTHING';return sql;}
type Result={results:any[];success:boolean;meta:{changes:number}};
export class NodeDatabase{
 readonly sqlite?: DatabaseSync;
 readonly pool?: Pool;
 readonly orm?: ReturnType<typeof postgresOrm>;
 readonly ready: Promise<void>;
 private tail = Promise.resolve();

 constructor(url=process.env.DATABASE_URL, file=process.env.SQLITE_PATH||'data/h3.db', injectedPool?: Pool) {
  if (url || injectedPool) {
   this.pool = injectedPool || new Pool({connectionString:url,max:5,connectionTimeoutMillis:5000});
   this.orm = postgresOrm(this.pool);
   this.ready = migratePostgres(this.pool);
   return;
  }
  if (process.env.RENDER) throw Error(renderDatabaseError);
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)),{recursive:true});
  const sqlite = new DatabaseSync(file);
  this.sqlite = sqlite;
  try {
   sqlite.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;');
   sqlite.exec(readFileSync(schemaPath,'utf8') + '\nCREATE TABLE IF NOT EXISTS h3_objects (key TEXT PRIMARY KEY,body BLOB NOT NULL,http_metadata TEXT NOT NULL,sha TEXT NOT NULL,updated_at BIGINT NOT NULL);');
   const upgrades = {
    integration_keys: {scopes:"TEXT NOT NULL DEFAULT 'accounts:read accounts:write'"},
    gpu_sessions: {category:"TEXT NOT NULL DEFAULT 'video'",model_id:"TEXT NOT NULL DEFAULT 'h3'"},
    jobs: {category:"TEXT NOT NULL DEFAULT 'video'",model_id:"TEXT NOT NULL DEFAULT 'h3'",artifact_mime:'TEXT'},
   };
   for (const [table, columns] of Object.entries(upgrades)) {
    const existing = new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
    for (const [column, definition] of Object.entries(columns)) {
     if (!existing.has(column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
   }
   sqlite.exec('COMMIT');
  } catch (error) {
   sqlite.close();
   throw error;
  }
  this.ready = Promise.resolve();
 }
 prepare(sql:string){return new NodeStatement(this,sql);}
 async atomic<T>(fn:(db:Pick<D1Database,'prepare'>)=>Promise<T>){
  return this.transaction(client=>fn({
   prepare:sql=>new NodeStatement(this,sql,(text,values)=>this.execute(text,values,client)) as unknown as D1PreparedStatement,
  }));
 }
 async transaction<T>(fn:(client?:PoolClient)=>Promise<T>){const prior=this.tail;let release!:()=>void;this.tail=new Promise(r=>release=r);await prior;let client:PoolClient|undefined;let began=false;try{await this.ready;if(this.pool){client=await this.pool.connect();await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(731042024)");}else this.sqlite!.exec('BEGIN IMMEDIATE');began=true;const value=await fn(client);if(client)await client.query('COMMIT');else this.sqlite!.exec('COMMIT');return value;}catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});else if(began)this.sqlite!.exec('ROLLBACK');throw e;}finally{client?.release();release();}}
 async execute(sql:string,values:any[],client?:PoolClient):Promise<Result>{await this.ready;if(this.pool){const r=await (client||this.pool).query(postgresSql(sql),values);return {results:r.rows||[],success:true,meta:{changes:r.rowCount||0}};}const statement=this.sqlite!.prepare(sql);if(/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)||/\bRETURNING\b/i.test(sql)){const rows=statement.all(...values);return{results:rows,success:true,meta:{changes:/^\s*SELECT/i.test(sql)?0:rows.length}};}const r=statement.run(...values);return{results:[],success:true,meta:{changes:Number(r.changes)}};}
 async query(sql:string,values:any[]=[]){return /^\s*(SELECT|PRAGMA)\b/i.test(sql)?this.execute(sql,values):this.transaction(c=>this.execute(sql,values,c));}
 async batch(statements:NodeStatement[]){return this.transaction(async c=>{const results=[];for(const s of statements)results.push(await this.execute(s.sql,s.values,c));return results;});}
 async close() {
  await this.ready.catch(()=>{});
  if (this.pool) await this.pool.end();
  else this.sqlite!.close();
 }
}
class NodeStatement{
 values:any[]=[];
 constructor(public db:NodeDatabase,public sql:string,private execute?: (sql:string,values:any[])=>Promise<Result>){}
 bind(...v:any[]){const s=new NodeStatement(this.db,this.sql,this.execute);s.values=v.map(x=>x===undefined?null:x);return s;}
 async run(){return this.execute?this.execute(this.sql,this.values):this.db.query(this.sql,this.values);}
 async all<T=any>(){return this.run() as Promise<Result&{results:T[]}>;}
 async first<T=any>(column?:string):Promise<T|null>{const r=await this.run();const row=r.results[0];return row?(column?row[column]:row):null;}
}
const MAX_OBJECT_SIZE = 100*1024*1024;
type ObjectHead = {size:number; http_metadata:string; sha:string};

export class NodeBucket {
 constructor(public db:NodeDatabase) {}

 async put(key:string,value:any,options:any={}) {
  let data: Buffer;
  if (typeof value==='string') data=Buffer.from(value);
  else if (ArrayBuffer.isView(value)) data=Buffer.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
  else if (value instanceof ArrayBuffer) data=Buffer.from(value);
  else {
   const reader=value.getReader();
   const chunks: Buffer[]=[];
   let size=0;
   try {
    for (;;) {
     const part=await reader.read();
     if (part.done) break;
     size+=part.value.byteLength;
     if (size>MAX_OBJECT_SIZE) {
      await reader.cancel();
      throw Error('视频超过100MB。');
     }
     chunks.push(Buffer.from(part.value));
    }
   } finally {
    reader.releaseLock();
   }
   data=Buffer.concat(chunks);
  }
  if (data.length>MAX_OBJECT_SIZE) throw Error('视频超过100MB。');
  const digest=createHash('sha256').update(data).digest('hex');
  if (options.sha256 && options.sha256!==digest) throw Error('视频校验和不匹配。');
  const row={key,body:data,http_metadata:JSON.stringify(options.httpMetadata||{}),sha:digest,updated_at:Date.now()};
  if (this.db.orm) {
   await this.db.ready;
   const {key, ...fields}=row;
   try {
    await this.db.orm.insert(objects).values(row).onConflictDoUpdate({target:objects.key,set:fields});
   } catch {
    throw Error('作品写入数据库失败。');
   }
  } else {
   await this.db.query(
    'INSERT INTO h3_objects(key,body,http_metadata,sha,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,http_metadata=excluded.http_metadata,sha=excluded.sha,updated_at=excluded.updated_at',
    [row.key,row.body,row.http_metadata,row.sha,row.updated_at],
   );
  }
  return {key,size:data.length};
 }

 async head(key:string) {
  let row: ObjectHead | null;
  if (this.db.orm) {
   await this.db.ready;
   const [found]=await this.db.orm.select({
    size:sql<number>`octet_length(${objects.body})`,
    http_metadata:objects.http_metadata,
    sha:objects.sha,
   }).from(objects).where(eq(objects.key,key));
   row=found??null;
  } else {
   row=await this.db.prepare('SELECT length(body) AS size,http_metadata,sha FROM h3_objects WHERE key=?')
    .bind(key).first<ObjectHead>();
  }
  return row?{key,size:Number(row.size),httpMetadata:JSON.parse(row.http_metadata),etag:row.sha}:null;
 }

 async get(key:string,options:any={}) {
  const head=await this.head(key);
  if (!head) return null;
  const offset=options.range?.offset??0;
  const length=options.range?.length??head.size-offset;
  let row: {body: Uint8Array} | null;
  if (this.db.orm) {
   const [found]=await this.db.orm.select({
    body:sql<Buffer>`substring(${objects.body} from ${offset+1}::integer for ${length}::integer)`,
   }).from(objects).where(eq(objects.key,key));
   row=found??null;
  } else {
   row=await this.db.prepare('SELECT substr(body,?,?) AS body FROM h3_objects WHERE key=?')
    .bind(offset+1,length,key).first<{body: Uint8Array}>();
  }
  if (!row) return null;
  const bytes=new Uint8Array(row.body);
  return {...head,body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),
   text:async()=>new TextDecoder().decode(bytes)};
 }

 async delete(key:string) {
  if (this.db.orm) {
   await this.db.ready;
   await this.db.orm.delete(objects).where(eq(objects.key,key));
  } else {
   await this.db.prepare('DELETE FROM h3_objects WHERE key=?').bind(key).run();
  }
 }
}
export class FixedLengthStream extends TransformStream<Uint8Array,Uint8Array>{constructor(size:number){let seen=0;super({transform(chunk,c){seen+=chunk.byteLength;if(seen>size)throw Error('上传长度不匹配。');c.enqueue(chunk);},flush(){if(seen!==size)throw Error('上传长度不匹配。');}});}}
const globalState=globalThis as typeof globalThis&{__h3NodeDb?:NodeDatabase};
export function storage(){return globalState.__h3NodeDb??=(new NodeDatabase());}
const derive=(name:string)=>createHash('sha256').update((process.env.H3_MASTER_KEY||'')+':'+name).digest('hex');
function verifier(){if(process.env.SITE_ACCESS_VERIFIER)return process.env.SITE_ACCESS_VERIFIER;if(!process.env.SITE_PASSWORD||!process.env.H3_MASTER_KEY)return undefined;const salt=derive('password-salt');return 'v1:'+salt+':'+pbkdf2Sync(process.env.SITE_PASSWORD,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex');}
export function validateEnvironment(){if(!process.env.H3_MASTER_KEY||process.env.H3_MASTER_KEY.length<32)throw Error('请配置至少32字符的H3_MASTER_KEY，并永久保留。');if(!verifier())throw Error('请配置SITE_PASSWORD或SITE_ACCESS_VERIFIER。');if(process.env.RENDER&&!process.env.DATABASE_URL?.trim())throw Error(renderDatabaseError);}
export const env=new Proxy({} as Cloudflare.Env,{get(_target,name){if(name==='DB')return storage() as unknown as D1Database;if(name==='BUCKET')return new NodeBucket(storage()) as unknown as R2Bucket;if(name==='KAGGLE_CIPHER_KEY')return process.env.KAGGLE_CIPHER_KEY||derive('cipher');if(name==='SITE_SESSION_SECRET')return process.env.SITE_SESSION_SECRET||derive('session');if(name==='SITE_ACCESS_VERIFIER')return verifier();if(name==='BOOTSTRAP_OWNER_ID')return process.env.BOOTSTRAP_OWNER_ID||'owner';return process.env[String(name)];}});
export async function initializeStorage(){await storage().ready;}
export async function checkStorage() {
 const database=storage();
 await database.ready;
 if(database.orm) await database.orm.execute(sql`select 1`);
 else await database.query('SELECT 1');
}

export async function closeStorage(){const d=globalState.__h3NodeDb;delete globalState.__h3NodeDb;if(d)await d.close();}
