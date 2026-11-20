import { queryAccountResources, resourcesCacheKey, type AccountResources } from './resources';
import { accountCredential, db, type Account } from './store';

const inFlight = new Map<string, Promise<AccountResources>>();

export function cachedAccountResources(raw: string | null, now: number, force = false) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AccountResources;
    const age = now - value.checkedAt;
    const gpu = value.quotas?.find(quota => quota.resource === 'GPU');
    if (gpu?.refreshAt && Date.parse(gpu.refreshAt) <= now) return null;
    const ttl = force ? 5_000 : value.error || value.quotaError || !gpu ? 15_000 : 120_000;
    return age >= 0 && age < ttl ? value : null;
  } catch {
    return null;
  }
}

export async function getAccountResources(a: Account, force = false) {
  const key = resourcesCacheKey(a.owner, a.id);
  const cached = await db().prepare('SELECT value FROM settings WHERE id=?').bind(key).first<string>('value');
  const fresh = cachedAccountResources(cached, Date.now(), force);
  if (fresh) return fresh;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = (async () => {
    const value = await queryAccountResources(await accountCredential(a), a.username);
    await db().prepare('INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .bind(key, JSON.stringify(value)).run();
    return value;
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}
