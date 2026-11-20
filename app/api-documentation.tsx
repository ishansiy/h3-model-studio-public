'use client';

import { useEffect, useState } from 'react';
import { ArrowDownToLine, BookOpen, Check, ChevronDown, Copy, KeyRound } from 'lucide-react';
import { API_SPEC } from '../lib/api-spec';
import styles from './api-documentation.module.css';

type JsonContent = Record<string, {
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, { summary: string; value: unknown }>;
}>;
type Parameter = { name: string; in: string; required?: boolean; description?: string; schema: unknown };
type Operation = {
  summary: string;
  description: string;
  'x-required-scope': string;
  parameters?: Parameter[];
  requestBody?: { content: JsonContent };
  responses: Record<string, { description: string; content?: JsonContent; headers?: Record<string, { description: string }> }>;
};

const routes = Object.entries(API_SPEC.paths).flatMap(([path, methods]) =>
  Object.entries<Operation>(methods).map(([method, operation]) => ({
    id: `${method}-${path.slice(8).replaceAll(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`,
    method, path, operation,
  })),
);

const sections = [
  { id: 'models', label: '模型', routes: routes.filter(route => route.path.endsWith('/models')) },
  { id: 'accounts', label: '计算账户', routes: routes.filter(route => route.path.endsWith('/accounts')) },
  { id: 'inputs', label: '输入图片', routes: routes.filter(route => route.path.endsWith('/inputs')) },
  { id: 'jobs', label: '生成任务', routes: routes.filter(route => route.path.includes('/jobs') && !route.path.endsWith('/artifact')) },
  { id: 'artifacts', label: '作品下载', routes: routes.filter(route => route.path.endsWith('/artifact')) },
];

function describeSchema(schema: unknown) {
  if (schema && typeof schema === 'object' && '$ref' in schema && typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').at(-1);
    if (name && Object.hasOwn(API_SPEC.components.schemas, name)) {
      return API_SPEC.components.schemas[name as keyof typeof API_SPEC.components.schemas];
    }
  }
  return schema;
}

function formatted(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function Code({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('已复制');
    } catch {
      setStatus('请手动复制');
    }
  }
  return <div className={styles.code}>
    <div className={styles.codeBar}>
      <span>{label}</span>
      <button type="button" onClick={copy} aria-label={`复制 ${label}`}>
        {status === '已复制' ? <Check size={14} /> : <Copy size={14} />}{status || '复制'}
      </button>
    </div>
    <pre tabIndex={0}><code>{value}</code></pre>
  </div>;
}

function curlExample(route: typeof routes[number], origin: string, example?: unknown) {
  const isDownload = route.path.endsWith('/artifact');
  const url = `${origin || '$STUDIO_URL'}${route.path.replace('{id}', '$JOB_ID')}${isDownload ? '?download=1' : ''}`;
  return [
    `curl ${route.method === 'post' ? '-X POST ' : ''}"${url}"`,
    '  -H "Authorization: Bearer $STUDIO_API_KEY"',
    ...(example ? ["  -H 'Content-Type: application/json'", `  --data '${formatted(example).replaceAll("'", "'\\''")}'`] : []),
    ...(route.path.endsWith('/inputs') ? ["  -H 'Content-Type: image/png'", "  --data-binary @input.png"] : []),
    ...(isDownload ? ['  -OJ'] : []),
  ].join(' \\\n');
}

function Endpoint({ route, origin }: { route: typeof routes[number]; origin: string }) {
  const { id, method, path, operation } = route;
  const request = operation.requestBody?.content['application/json'];
  const examples = Object.values(request?.examples ?? {});
  const [primary, ...additional] = examples;
  return <details className={styles.endpoint} id={id}>
    <summary>
      <span className={`${styles.method} ${method === 'post' ? styles.post : styles.get}`}>{method.toUpperCase()}</span>
      <code>{path}</code>
      <span className={styles.operationLabel}>{operation.summary}</span>
      <ChevronDown className={styles.chevron} size={17} aria-hidden="true" />
    </summary>
    <div className={styles.endpointBody}>
      <p>所需权限 <code>{operation['x-required-scope']}</code></p>
      <p>{operation.description}</p>
      {operation.parameters?.length ? <div>
        <h3>请求参数</h3>
        <dl className={styles.params}>
          {operation.parameters.map(parameter => <div key={`${parameter.in}-${parameter.name}`}>
            <dt><code>{parameter.name}</code><span>{parameter.in === 'path' ? '路径' : parameter.in === 'header' ? '请求头' : '查询'}{parameter.required ? ' · 必填' : ''}</span></dt>
            <dd>{parameter.description || formatted(parameter.schema)}</dd>
          </div>)}
        </dl>
      </div> : null}
      <Code label={primary ? `cURL · ${primary.summary}` : 'cURL 请求示例'} value={curlExample(route, origin, primary?.value ?? request?.example)} />
      {additional.map(example => <details key={example.summary} className={styles.schema}>
        <summary>{example.summary}<ChevronDown size={15} aria-hidden="true" /></summary>
        <Code label={`cURL · ${example.summary}`} value={curlExample(route, origin, example.value)} />
      </details>)}
      {request?.schema ? <details className={styles.schema}>
        <summary>请求体结构<ChevronDown size={15} aria-hidden="true" /></summary>
        <Code label="请求 JSON Schema" value={formatted(describeSchema(request.schema))} />
      </details> : null}
      <div>
        <h3>响应</h3>
        <div className={styles.responses}>
          {Object.entries(operation.responses).map(([status, response]) => {
            const contents = Object.entries(response.content ?? {});
            const headers = Object.entries(response.headers ?? {});
            return contents.length || headers.length ? <details className={styles.schema} key={status}>
              <summary><code>{status}</code><span>{response.description}</span><ChevronDown size={15} aria-hidden="true" /></summary>
              {headers.length ? <dl className={styles.responseHeaders}>
                {headers.map(([name, header]) => <div key={name}><dt><code>{name}</code></dt><dd>{header.description}</dd></div>)}
              </dl> : null}
              {contents.map(([mime, content]) => <div key={mime} className={styles.responseContent}>
                {content.example !== undefined && <Code label="响应示例" value={formatted(content.example)} />}
                {content.schema !== undefined && <Code label={`${mime} · 响应结构`} value={formatted(describeSchema(content.schema))} />}
              </div>)}
            </details> : <div className={styles.response} key={status}><code>{status}</code><span>{response.description}</span></div>;
          })}
        </div>
      </div>
    </div>
  </details>;
}

export default function ApiDocumentation({ publicOpenApiUrl }: { publicOpenApiUrl?: string }) {
  const [origin, setOrigin] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const shareUrl = publicOpenApiUrl || (origin ? `${origin}/api/v1/openapi.json` : '');
  async function copyPublicUrl() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }
  useEffect(() => {
    setOrigin(window.location.origin);
    const expandLinkedEndpoint = () => {
      const element = document.getElementById(window.location.hash.slice(1));
      if (element instanceof HTMLDetailsElement) element.open = true;
    };
    expandLinkedEndpoint();
    window.addEventListener('hashchange', expandLinkedEndpoint);
    return () => window.removeEventListener('hashchange', expandLinkedEndpoint);
  }, []);
  return <div className={styles.layout}>
    <nav className={styles.contents} aria-label="接口目录">
      <strong><BookOpen size={16} />接口目录</strong>
      <a href="#quickstart">身份验证</a>
      {sections.map(section => <a href={`#${section.id}`} key={section.id}>{section.label}</a>)}
    </nav>
    <div className={styles.main}>
      <div className={styles.toolbar}>
        <a className="ms-button primary" href="/integrations/keys"><KeyRound size={16} />管理 API 密钥</a>
        <a className="ms-button subtle" href="/api/v1/openapi.json" download="studio-openapi.json"><ArrowDownToLine size={16} />OpenAPI {API_SPEC.openapi}</a>
        <button type="button" className="ms-button subtle" onClick={copyPublicUrl} disabled={!shareUrl} title={shareUrl}>
          {copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}
          <span aria-live="polite">{copyState === 'copied' ? '已复制公开 JSON 地址' : '复制公开 JSON 地址'}</span>
        </button>
        {copyState === 'failed' && <a className="ms-button subtle" href={shareUrl} target="_blank" rel="noreferrer">打开公开链接并手动复制</a>}
      </div>
      <section id="quickstart" className={styles.intro}>
        <h2>身份验证</h2>
        <p>在请求头中传入 <code>Authorization: Bearer 你的工作室 API 密钥</code>。按所调用的接口为密钥勾选权限。运行示例前，请换成自己的密钥和任务 ID。</p>
        <Code label="cURL 快速开始" value={curlExample(routes[0], origin)} />
        <ol className={styles.workflow}>
          <li>从<a href="#get-models">模型目录</a>选择模型与尺寸。计算账户默认自动分配，也可以<a href="#get-accounts">查询账户</a>后手动指定。</li>
          <li>图生任务先<a href="#post-inputs">上传图片</a>，使用返回的素材 ID。</li>
          <li><a href="#post-jobs">提交生成任务</a>，保存自己的 <code>requestId</code>。超时后沿用该 ID 和原参数，避免重复生成。</li>
          <li>每 5–10 秒<a href="#get-jobs-id">查询一次进度</a>。收到 <code>429</code> 时按 <code>Retry-After</code> 等待。</li>
          <li>状态到 <code>completed</code> 后<a href="#get-jobs-id-artifact">下载作品</a>，根据响应类型保存为 PNG 或 MP4。</li>
        </ol>
        <div className={styles.resources}>
          <a href="/studio-api-client.py" download>下载 Python 生成示例 <ArrowDownToLine size={14} /></a>
          <a href="/connect-kaggle-account.py" download>下载账户接入脚本 <ArrowDownToLine size={14} /></a>
        </div>
      </section>
      {sections.map(section => <section className={styles.group} id={section.id} key={section.id}>
        <h2>{section.label}</h2>
        <div className={styles.endpoints}>
          {section.routes.map(route => <Endpoint key={route.id} route={route} origin={origin} />)}
        </div>
      </section>)}
    </div>
  </div>;
}
