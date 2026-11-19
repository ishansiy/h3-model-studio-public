import cache from "./model-cache.json";
export function modelCacheSources(username: string) {
    const owner = process.env.H3_MODEL_CACHE_USERNAME;
    if (!owner || username !== owner) return [];
    const sources = (process.env.H3_MODEL_CACHE_SOURCES ?? '').split(',').map(source => source.trim());
    const validSources = sources.every(source => /^[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(source));
    return sources.length === 4 && new Set(sources).size === 4 && validSources ? sources : [];
}
export function modelCacheCell(spec=cache){return `import hashlib, json, time, os
from pathlib import Path
_CACHE_SPEC = json.loads(${JSON.stringify(JSON.stringify(spec))})
_cache_started = time.perf_counter()
print("@@H3_PROGRESS@@"+json.dumps({"stage":"校验与复用模型缓存","step":0,"steps":STEPS}),flush=True)
if USE_TURBO:
    raise RuntimeError("当前模型缓存仅支持原版，Turbo请使用标准运行。")
input_root=Path(globals().get("MODEL_CACHE_INPUT_ROOT","/kaggle/input")).resolve()
models_root=COMFY_DIR/"models"
models_root.mkdir(parents=True,exist_ok=True)
expected={item['path']:item for item in _CACHE_SPEC['files']}
parts={name:[] for name in expected}
seen=set()
for manifest_path in sorted(input_root.rglob('h3_model_cache_part[0-3].json')):
    manifest=json.loads(manifest_path.read_text())
    if manifest.get('repo')!=MODEL_REPO or manifest.get('revision')!=MODEL_REVISION or not manifest.get('complete'):
        raise RuntimeError("模型缓存版本或完成标记不匹配，停止加载。")
    part=manifest.get('part')
    if part in seen or part not in [0,1,2,3]:
        raise RuntimeError("模型缓存分片标识重复或无效。")
    seen.add(part)
    for item in manifest.get('files',[]):
        spec=expected.get(item.get('path'))
        if not spec or item.get('sha256')!=spec['sha256'] or item.get('bytes')!=spec['bytes']:
            raise RuntimeError("模型缓存清单与固定权重不匹配。")
        name=item.get('file','')
        if not name or Path(name).name!=name:raise RuntimeError("模型缓存文件路径无效。")
        source=(manifest_path.parent/name).resolve()
        if not source.is_relative_to(input_root) or not source.is_file():raise RuntimeError("模型缓存文件不可用。")
        if not isinstance(item.get('start'),int) or not isinstance(item.get('end'),int) or item['start']<0 or item['end']<item['start'] or source.stat().st_size!=item['end']-item['start']+1:
            raise RuntimeError("模型缓存分片大小不符。")
        parts[item['path']].append((item,source))
if seen!={0,1,2,3}:raise RuntimeError("模型缓存未完整挂载，拒绝启动重复下载。")
# Check coverage before reading any large weight files.
for relative,spec in expected.items():
    items=sorted(parts[relative],key=lambda x:x[0]['start']);offset=0
    for item,source in items:
        if item['start']!=offset:raise RuntimeError("模型缓存分片存在缺口或重叠。")
        offset=item['end']+1
    if offset!=spec['bytes']:raise RuntimeError("模型缓存未覆盖完整权重。")
    parts[relative]=items
cache_manifest={}
for relative,spec in expected.items():
    target=models_root/relative
    target.parent.mkdir(parents=True,exist_ok=True)
    items=parts[relative];digest=hashlib.sha256()
    single=len(items)==1
    temporary=target.with_name(target.name+'.cache-partial')
    writer=None if single else temporary.open('wb')
    try:
        for item,source in items:
            with source.open('rb') as handle:
                while True:
                    block=handle.read(16*1024*1024)
                    if not block:break
                    digest.update(block)
                    if writer:writer.write(block)
    finally:
        if writer:writer.close()
    if digest.hexdigest()!=spec['sha256']:
        temporary.unlink(missing_ok=True)
        raise RuntimeError("模型缓存SHA256校验失败："+relative)
    if single:
        if target.exists() or target.is_symlink():target.unlink()
        target.symlink_to(items[0][1])
    else:
        temporary.replace(target)
    cache_manifest[relative]={"path":str(target),"bytes":spec['bytes'],"repo":MODEL_REPO,"revision":MODEL_REVISION,"sha256":spec['sha256'],"cache_verified":True}
    print("缓存模型就绪："+relative,flush=True)
MODEL_FILES={name:item['bytes'] for name,item in expected.items()}
(FINAL_OUTPUT_DIR/'minimax_h3_model_manifest.json').write_text(json.dumps(cache_manifest,indent=2))
STAGE_TIMINGS['download_seconds']=0.0
STAGE_TIMINGS['cache_seconds']=time.perf_counter()-_cache_started
MODEL_CACHE_USED=True
print("模型缓存校验/组装用时 %.1f 秒。"%STAGE_TIMINGS['cache_seconds'],flush=True)
`;}
