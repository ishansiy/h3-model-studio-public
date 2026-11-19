'use client';

import { useEffect, useState } from 'react';
import { ArrowDownToLine, BookOpen, Check, ChevronDown, Copy, KeyRound } from 'lucide-react';
import { API_SPEC } from '../lib/api-spec';
import styles from './api-documentation.module.css';

type JsonContent = Record<string, { schema?: unknown; example?: unknown }>;
type Parameter = { name: string; in: string; required?: boolean; description?: string; schema: unknown };
type Operation = {
  summary: string;
  description: string;
  parameters?: Parameter[];
  requestBody?: { content: JsonContent };
  responses: Record<string, { description: string; content?: JsonContent }>;
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

function curlExample(route: typeof routes[number], origin: string) {
  const example = route.operation.requestBody?.content['application/json']?.example;
  const isDownload = route.path.endsWith('/artifact');
  const url = `${origin || '$STUDIO_URL'}${route.path.replace('{id}', '$JOB_ID')}${isDownload ? '?download=1' : ''}`;
  return [
    `curl ${route.method === 'post' ? '-X POST ' : ''}"${url}"`,
    '  -H "Authorization: Bearer $STUDIO_API_KEY"',
    ...(example ? ["  -H 'Content-Type: application/json'", `  --data '${formatted(example).replaceAll("'", "'\\''")}'`] : []),
    ...(isDownload ? ['  -OJ'] : []),
  ].join(' \\\n');
}

function Endpoint({ route, origin }: { route: typeof routes[number]; origin: string }) {
  const { id, method, path, operation } = route;
  const requestSchema = operation.requestBody?.content['application/json']?.schema;
  return <details className={styles.endpoint} id={id}>
    <summary>
      <span className={`${styles.method} ${method === 'post' ? styles.post : styles.get}`}>{method.toUpperCase()}</span>
      <code>{path}</code>
      <span className={styles.operationLabel}>{operation.summary}</span>
      <ChevronDown className={styles.chevron} size={17} aria-hidden="true" />
    </summary>
    <div className={styles.endpointBody}>
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
      <Code label="cURL 请求示例" value={curlExample(route, origin)} />
      {requestSchema ? <details className={styles.schema}>
        <summary>请求体结构<ChevronDown size={15} aria-hidden="true" /></summary>
        <Code label="请求 JSON Schema" value={formatted(describeSchema(requestSchema))} />
      </details> : null}
      <div>
        <h3>响应</h3>
        <div className={styles.responses}>
          {Object.entries(operation.responses).map(([status, response]) => {
            const contents = Object.entries(response.content ?? {});
            return contents.length ? <details className={styles.schema} key={status}>
              <summary><code>{status}</code><span>{response.description}</span><ChevronDown size={15} aria-hidden="true" /></summary>
              {contents.map(([mime, content]) => <Code key={mime} label={mime} value={formatted(describeSchema(content.schema))} />)}
            </details> : <div className={styles.response} key={status}><code>{status}</code><span>{response.description}</span></div>;
          })}
        </div>
      </div>
    </div>
  </details>;
}

export default function ApiDocumentation() {
  const [origin, setOrigin] = useState('');
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
      </div>
      <section id="quickstart" className={styles.intro}>
        <h2>身份验证</h2>
        <p>在请求头中传入 <code>Authorization: Bearer 你的工作室 API 密钥</code>。按所调用的接口为密钥勾选权限。运行示例前，请换成自己的密钥和账户或任务 ID。</p>
        <Code label="cURL 快速开始" value={curlExample(routes[0], origin)} />
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
