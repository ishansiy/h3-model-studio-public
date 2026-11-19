/** 固定公开域名优先；本地通过请求Host还原端口，避免Next内部监听地址参与CSRF比较。 */
export function publicUrl(request:Request){const url=new URL(request.url);const configured=process.env.PUBLIC_BASE_URL||process.env.RENDER_EXTERNAL_URL;if(configured){const origin=new URL(configured);url.protocol=origin.protocol;url.host=origin.host;url.port=origin.port;}else{const host=request.headers.get('host');if(host){const proto=request.headers.get('x-forwarded-proto')==='https:'||request.headers.get('x-forwarded-proto')==='https'?'https:':'http:';const origin=new URL(proto+'//'+host);url.protocol=origin.protocol;url.host=origin.host;url.port=origin.port;}}return url;}
function accessUrl(request: Request): URL | null {
  const canonical = publicUrl(request);
  const configured = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!configured) return canonical;

  const authority = (request.headers.get('host') || new URL(request.url).host).toLowerCase();
  const origins = [canonical.origin, process.env.RENDER_EXTERNAL_URL, ...(process.env.PUBLIC_ACCESS_ORIGINS ?? '').split(',')];
  for (const value of origins) {
    let allowed: URL;
    try { allowed = new URL(value?.trim() ?? ''); } catch { continue; }
    if (!['http:', 'https:'].includes(allowed.protocol) || allowed.username || allowed.password ||
        allowed.pathname !== '/' || allowed.search || allowed.hash || allowed.host !== authority) continue;
    allowed.pathname = canonical.pathname;
    allowed.search = canonical.search;
    allowed.hash = canonical.hash;
    return allowed;
  }
  return null;
}

export function samePublicOrigin(request: Request) {
  return request.headers.get('origin') === accessUrl(request)?.origin;
}

export function publicRequest(request: Request) {
  const url = accessUrl(request);
  const headers = new Headers(request.headers);
  if (!url) headers.delete('origin');
  headers.set('CF-Connecting-IP', (process.env.RENDER || process.env.TRUST_PROXY_HEADERS === 'true')
    ? (headers.get('x-real-ip') || headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unavailable')
    : 'local');
  return new Request(url ?? publicUrl(request), {
    method: request.method, headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    duplex: 'half',
  } as RequestInit);
}
