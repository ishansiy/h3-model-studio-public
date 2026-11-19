import {closeStorage,initializeStorage} from '../lib/node-runtime';

try {
  if (!process.env.DATABASE_URL?.trim()) throw Error('请先配置 PostgreSQL DATABASE_URL。');
  try {
    await initializeStorage();
  } catch {
    throw Error('PostgreSQL 迁移失败，请检查连接和数据库账户的建表权限。');
  }
  console.log('PostgreSQL 结构迁移完成。');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode=1;
} finally {
  await closeStorage();
}
