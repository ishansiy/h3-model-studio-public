import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {getTableColumns,getTableName,sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/node-postgres';
import type {PgTable} from 'drizzle-orm/pg-core';
import {accounts,gpuSessions,integrationKeys,jobs,objects,settings} from '../lib/db/schema';
import {NodeDatabase,validateEnvironment} from '../lib/node-runtime';
import {decrypt} from '../lib/store';

const tables: PgTable[]=[accounts,gpuSessions,integrationKeys,jobs,objects,settings];

function snapshotColumns(source: DatabaseSync, table: PgTable) {
  const tableName=getTableName(table);
  const columns=getTableColumns(table);
  const actual=source.prepare('SELECT name FROM pragma_table_info(?)').all(tableName).map(row=>String(row.name));
  const known=new Set(Object.values(columns).map(column=>column.name));
  const required=Object.values(columns).filter(column=>column.notNull&&!column.hasDefault);
  if (!actual.length || required.some(column=>!actual.includes(column.name)) || actual.some(name=>!known.has(name))) {
    throw Error(`SQLite 的 ${tableName} 表结构与此版本不兼容。`);
  }
  return actual;
}

async function verifySnapshot(source: DatabaseSync, owner: string) {
  const statuses=source.prepare(`
    SELECT 1 FROM jobs WHERE status NOT IN ('completed','failed','cancelled')
    UNION ALL SELECT 1 FROM gpu_sessions WHERE status NOT IN ('completed','failed')
    LIMIT 1`).get();
  if (statuses) throw Error('来源仍有活动任务或会话。请结束后重新制作快照。');

  const owners=source.prepare(`
    SELECT owner FROM accounts UNION SELECT owner FROM jobs
    UNION SELECT owner FROM gpu_sessions UNION SELECT owner FROM integration_keys`).all();
  if (owners.length && !owners.some(row=>row.owner===owner)) {
    throw Error('BOOTSTRAP_OWNER_ID 与来源工作室不匹配。');
  }

  const secrets=source.prepare(`
    SELECT cipher AS value FROM accounts WHERE deleted_at IS NULL AND cipher!=''
    UNION ALL SELECT value FROM settings WHERE id LIKE 'account-proxy:%'`);
  try {
    for (const row of secrets.iterate()) await decrypt(String(row.value));
  } catch {
    throw Error('来源凭证无法解密，请核对来源的 H3_MASTER_KEY 或 KAGGLE_CIPHER_KEY。');
  }
  const wrongArtifact=source.prepare(`
    SELECT 1 FROM jobs AS j LEFT JOIN h3_objects AS o ON j.artifact_key=o.key
    WHERE j.status='completed' AND j.artifact_key IS NOT NULL
      AND (o.key IS NULL OR (j.artifact_sha IS NOT NULL AND j.artifact_sha!=o.sha)
        OR (j.artifact_bytes IS NOT NULL AND j.artifact_bytes!=length(o.body)))
    LIMIT 1`).get();
  if (wrongArtifact) throw Error('来源作品缺失或校验信息不一致。');
}

export async function importSqlite(file:string,target:NodeDatabase,owner:string) {
  if (!target.pool) throw Error('目标必须是 PostgreSQL。');
  const source=new DatabaseSync(file,{readOnly:true});
  try {
    source.exec('BEGIN');
    const layouts=tables.map(table=>({table,columns:snapshotColumns(source,table)}));
    await verifySnapshot(source,owner);
    return await target.transaction(async client=>{
      if (!client) throw Error('目标必须是 PostgreSQL。');
      const targetOrm=drizzle(client);
      const names=sql.join(tables.map(table=>sql.identifier(getTableName(table))),sql`, `);
      await targetOrm.execute(sql`LOCK TABLE ${names} IN SHARE ROW EXCLUSIVE MODE`);
      for (const table of tables) {
        const [row]=await targetOrm.select({present:sql<number>`1`}).from(table).limit(1);
        if (row) throw Error('目标数据库必须为空。');
      }

      const counts: Record<string,number>={};
      for (const {table,columns} of layouts) {
        const name=getTableName(table);
        // Identifiers are matched to the ORM schema before being interpolated.
        const select=source.prepare(`SELECT ${columns.map(column=>`"${column}"`).join(', ')} FROM "${name}"`);
        counts[name]=0;
        for (const row of select.iterate()) {
          if (table===objects) {
            if (!(row.body instanceof Uint8Array)) throw Error('来源作品的二进制数据无效。');
            const body=Buffer.from(row.body);
            if (createHash('sha256').update(body).digest('hex')!==row.sha) throw Error('来源作品的 SHA-256 校验失败。');
            row.body=body;
          }
          await targetOrm.insert(table).values(row);
          counts[name]++;
        }
      }
      return counts;
    });
  } finally {
    source.close();
  }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  let target:NodeDatabase|undefined;
  try {
    if (process.argv.length!==3) throw Error('用法为 npm run db:import-sqlite -- /备份路径/h3.db');
    validateEnvironment();
    if (!process.env.DATABASE_URL?.trim()) throw Error('请先配置目标 PostgreSQL DATABASE_URL。');
    target=new NodeDatabase();
    const counts=await importSqlite(process.argv[2],target,process.env.BOOTSTRAP_OWNER_ID||'owner');
    console.log('SQLite 快照迁移完成。',counts);
  } catch (error) {
    // Drizzle errors can contain bound parameters. Never print the raw exception.
    const safe=error instanceof Error && /^(用法|Render|请配置|请先配置|目标|SQLite|来源|BOOTSTRAP_OWNER_ID)/.test(error.message);
    console.error(safe ? (error as Error).message : '迁移未完成。请检查数据库连接、权限和 SQLite 快照。');
    process.exitCode=1;
  } finally {
    await target?.close();
  }
}
