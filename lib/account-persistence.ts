export async function persistVerifiedAccount(database:D1Database,owner:string,username:string,name:string,cipher:string,hint:string,now=Date.now(),proxyCipher?:string){
  const existing=await database.prepare("SELECT id FROM accounts WHERE owner=? AND username=?").bind(owner,username).first<{id:string}>();
  const id=existing?.id||crypto.randomUUID();
  const busy="NOT EXISTS(SELECT 1 FROM jobs WHERE account_id=? AND status IN ('submitting','queued','running','submission_unknown')) AND NOT EXISTS(SELECT 1 FROM gpu_sessions WHERE account_id=? AND status NOT IN ('completed','failed'))";
  if(proxyCipher){
    const results=await database.batch([
      database.prepare("INSERT INTO accounts(id,owner,name,username,cipher,hint,created_at) SELECT ?,?,?,?,?,?,? WHERE ((SELECT COUNT(*) FROM accounts WHERE owner=? AND deleted_at IS NULL)<20 OR EXISTS(SELECT 1 FROM accounts WHERE owner=? AND username=? AND deleted_at IS NULL)) AND "+busy+" ON CONFLICT(owner,username) DO UPDATE SET name=excluded.name,cipher=excluded.cipher,hint=excluded.hint,deleted_at=NULL WHERE accounts.id=excluded.id").bind(id,owner,name.trim().slice(0,40)||username,username,cipher,hint,now,owner,owner,username,id,id),
      database.prepare("INSERT INTO settings(id,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND owner=? AND deleted_at IS NULL) AND "+busy+" ON CONFLICT(id) DO UPDATE SET value=excluded.value").bind(`account-proxy:${owner}:${id}`,proxyCipher,id,owner,id,id)
    ]);
    if(!results[0].meta.changes||!results[1].meta.changes)throw new Error("账户有活动任务或已达到账户上限，代理未更改。");
    return id;
  }
  const saved=await database.prepare("INSERT INTO accounts(id,owner,name,username,cipher,hint,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM accounts WHERE owner=? AND deleted_at IS NULL)<20 OR EXISTS(SELECT 1 FROM accounts WHERE owner=? AND username=? AND deleted_at IS NULL) ON CONFLICT(owner,username) DO UPDATE SET name=excluded.name,cipher=excluded.cipher,hint=excluded.hint,deleted_at=NULL")
    .bind(id,owner,name.trim().slice(0,40)||username,username,cipher,hint,now,owner,owner,username).run();
  if(!saved.meta.changes)throw new Error("最多可连接 20 个账户。");
  const stored=await database.prepare("SELECT id FROM accounts WHERE owner=? AND username=? AND deleted_at IS NULL").bind(owner,username).first<{id:string}>();
  if(!stored)throw new Error("账户保存未完成。");
  return stored.id;
}
