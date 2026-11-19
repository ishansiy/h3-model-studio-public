import {accountFetch,credentialToken,type KaggleCredential} from './proxy';
const API = "https://www.kaggle.com/api/v1/kernels/";
export class KaggleError extends Error { constructor(message: string, public status: number) { super(message); } }
export function cleanError(value: unknown): string { return String(value instanceof Error ? value.message : value).replace(/(?:KGAT_|H3AK_)[\w-]+/g, "[密钥已隐藏]").slice(0, 1200); }
export async function kaggle(token: KaggleCredential, path: string, query: Record<string, string> = {}, body?: unknown) {
  const u = new URL(path, API); for (const [k,v] of Object.entries(query)) u.searchParams.set(k, v);
  let response: Response;
  try { response = await accountFetch(token,u, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${credentialToken(token)}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body ? 35_000 : 15_000) }); }
  catch { throw new KaggleError("Kaggle 连接暂时中断，请稍后刷新核对。", 0); }
  const raw = await response.text(); let data: any;
  try { data = JSON.parse(raw); } catch { throw new KaggleError("Kaggle 返回了无法读取的响应。", response.status); }
  if (!response.ok) throw new KaggleError(cleanError(data.message || `Kaggle 请求失败（${response.status}）。`), response.status);
  return data;
}
export async function verifyAccount(token: KaggleCredential, inputUsername = "") {
  if (!/^KGAT_[\w-]{16,512}$/.test(credentialToken(token))) throw new Error("请输入有效的 KGAT_ API Token。");
  let response: Response;
  try {
    response = await accountFetch(token,"https://www.kaggle.com/api/v1/oauth2/introspect", {
      method:"POST", headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({token:credentialToken(token)}), signal:AbortSignal.timeout(15000)
    });
  } catch { throw new KaggleError("Kaggle 连接暂时中断，请稍后重试。",0); }
  let data: any;
  try { data = await response.json(); } catch { throw new KaggleError("Kaggle 暂时无法返回账户资料，请稍后重试。",response.status); }
  if (!response.ok) throw new KaggleError("Kaggle 账户验证失败，请检查 API Token 或稍后重试。",response.status);
  if (data.active !== true) throw new KaggleError("API Token 无效、已过期或已撤销，请在 Kaggle 重新生成。",401);
  const username = data.username;
  if (typeof username !== "string" || !/^[a-zA-Z0-9_-]{2,64}$/.test(username)) throw new KaggleError("Kaggle 未返回有效用户名，请稍后重试。",0);
  if (inputUsername && username.toLowerCase() !== inputUsername.trim().toLowerCase()) throw new Error("填写的用户名与密钥所属账户不一致。");
  return username.toLowerCase();
}
export function queryFor(ref: string, version?: number | null) { const [owner,slug] = ref.split("/"); return { userName: owner, kernelSlug: slug, ...(version ? { versionLabel: `v${version}` } : {}) }; }
export async function output(token: KaggleCredential, ref: string, version?: number | null) { return kaggle(token, "output", queryFor(ref,version)); }
export function trustedFile(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !(u.hostname === "kaggleusercontent.com" || u.hostname.endsWith(".kaggleusercontent.com") || u.hostname === "storage.googleapis.com")) throw new Error("视频文件地址未通过来源检查。");
  return u.href;
}
export function findFile(data: any, name: string): string | undefined { const f = data.files?.find((f: any) => (f.fileName || f.fileNameNullable) === name); return f ? trustedFile(f.url || f.urlNullable) : undefined; }
export function parseProgress(raw: string) {
  let latest: any = null;
  for (const line of raw.split(/\r?\n/)) {
    let content = line;
    if (line.startsWith("data:")) { try { content = JSON.parse(line.slice(5).trim()).data || ""; } catch { continue; } }
    for (const piece of content.split(/\r?\n/)) {
      const pos = piece.indexOf("@@H3_PROGRESS@@");
      if (pos >= 0) { try { const p = JSON.parse(piece.slice(pos + 15)); if (typeof p.stage === "string" && Number.isFinite(p.step) && Number.isFinite(p.steps)) latest = p; } catch {} }
    }
  }
  return latest;
}
export async function liveProgress(token: KaggleCredential, ref: string, version: number | null) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000); let raw = "";
  try {
    const u = new URL(`logs/stream/${ref}`, API); if (version) u.searchParams.set("versionLabel", `v${version}`);
    const res = await accountFetch(token,u, { headers: { Authorization: `Bearer ${credentialToken(token)}`, Accept: "text/event-stream, */*" }, signal: controller.signal });
    if (!res.ok || !res.body) return null;
    if (!(res.headers.get("Content-Type") || "").includes("text/event-stream")) {
      const events = await res.json() as any[]; raw = (Array.isArray(events) ? events : []).map(e => e.data || "").join("\n");
    } else {
      const reader = res.body.getReader(), decoder = new TextDecoder();
      try { while (raw.length < 600_000) { const r = await reader.read(); if (r.done) break; raw += decoder.decode(r.value, { stream: true }); } } finally { await reader.cancel().catch(() => {}); }
    }
  } catch {} finally { clearTimeout(timer); }
  return parseProgress(raw);
}
