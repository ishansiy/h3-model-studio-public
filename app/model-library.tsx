'use client';

import { useState } from 'react';
import { ArrowUpRight, ChevronDown, Clapperboard, Image as ImageIcon, Search, X } from 'lucide-react';
import { CATEGORIES, MODEL_CATALOG, type GenerationCategory } from '../lib/model-catalog';
import styles from './model-library.module.css';

type Model = (typeof MODEL_CATALOG)[number];
type Filter = 'all' | GenerationCategory;

function ModelRow({ model }: { model: Model }) {
  const [expanded, setExpanded] = useState(false);
  const category = CATEGORIES.find(item => item.id === model.category);
  const categoryLabel = category?.label ?? model.category;
  const Icon = model.category === 'video' ? Clapperboard : ImageIcon;
  const detailsId = `model-details-${model.id}`;

  return <li className={styles.item}>
    <div className={styles.row}>
      <div className={styles.name}>
        <span className={`${styles.icon} ${model.category === 'image' ? styles.imageIcon : ''}`}><Icon size={18} aria-hidden="true" /></span>
        <h2>{model.name}</h2>
        {category?.defaultModelId === model.id && <span className={styles.defaultTag}>默认</span>}
      </div>
      <span className={styles.category}>{categoryLabel}</span>
      <span className={styles.params}>{model.defaults.width} × {model.defaults.height} · {model.defaults.steps} 步</span>
      <div className={styles.actions}>
        <button type="button" className={styles.detailsButton} aria-controls={detailsId} aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)} aria-label={`${expanded ? '收起' : '展开'} ${model.name} 详情`}>
          <span>详情</span><ChevronDown size={15} aria-hidden="true" />
        </button>
        <a className={styles.use} href={`/?category=${model.category}&model=${encodeURIComponent(model.id)}`} aria-label={`使用 ${model.name}`}>
          使用<ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </div>
    </div>
    <div id={detailsId} className={styles.details} hidden={!expanded}>
      <p>{model.description}</p>
      <dl>
        <div><dt>模型 ID</dt><dd><code>{model.id}</code></dd></div>
        <div><dt>精度</dt><dd>{model.precision}</dd></div>
        <div><dt>加载方式</dt><dd>{model.loadPolicy}</dd></div>
        <div><dt>许可</dt><dd>{model.license}</dd></div>
      </dl>
      <a href={model.sourceUrl} target="_blank" rel="noreferrer">官方说明<ArrowUpRight size={13} aria-hidden="true" /></a>
    </div>
  </li>;
}

const filters = [{ id: 'all' as const, label: '全部' }, ...CATEGORIES];

export default function ModelLibrary() {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const models = MODEL_CATALOG.filter(model =>
    (filter === 'all' || model.category === filter) &&
    [model.name, model.id, model.subtitle, model.description].some(value => value.toLowerCase().includes(keyword)),
  );

  return <section className={styles.library} aria-label="模型目录">
    <div className={styles.toolbar}>
      <div className={styles.filters} role="group" aria-label="按模型类别筛选">
        {filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id}
          onClick={() => setFilter(item.id)}>{item.label}</button>)}
      </div>
      <div className={styles.search}>
        <Search size={16} aria-hidden="true" />
        <input type="search" aria-label="搜索模型" value={query} placeholder="搜索模型名称或 ID" onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={15} aria-hidden="true" /></button>}
      </div>
      <span className={styles.count} role="status">{models.length} 个模型</span>
    </div>
    {models.length > 0 ? <div className={styles.list}>
      <div className={`${styles.row} ${styles.heading}`} aria-hidden="true">
        <span>模型</span><span>类别</span><span>默认参数</span><span>操作</span>
      </div>
      <ul aria-label="模型列表">{models.map(model => <ModelRow key={model.id} model={model} />)}</ul>
    </div> : <div className={styles.empty}>
      <p>没有找到匹配的模型</p>
      <button type="button" onClick={() => { setFilter('all'); setQuery(''); }}>清除筛选</button>
    </div>}
  </section>;
}
