// 单人工作室沿用原主人 ID；保留历史账户、任务及 API 密钥，不迁移或合并其他人的数据。
export function workspaceOwner(config:{BOOTSTRAP_OWNER_ID?:string}){
  const owner=config.BOOTSTRAP_OWNER_ID;
  if(!owner||owner.length>256||/\s/.test(owner))throw new Error("单人工作室尚未配置，请联系站点主人。");
  return owner;
}
