/** 最后一步包裹运行单元：停止发生在准备单元之间时，跳过后续模型加载。 */
export function guardedSessionSource(source:string){
 return '_STUDIO_CELL_SOURCE='+JSON.stringify(source)+'\nif not _SESSION_STOP.is_set():\n    try:\n        exec(_STUDIO_CELL_SOURCE,globals())\n    except SystemExit:\n        if not _SESSION_STOP.is_set():raise\n        _session_cooperative_exit()\nelse:\n    _session_cooperative_exit()\n';
}
export function finalizeSessionStop(notebook:string){
 const n=JSON.parse(notebook);let claimed=false;
 for(const cell of n.cells){
  if(cell.cell_type!=='code')continue;
  if(claimed)cell.source=guardedSessionSource(cell.source);
  if(cell.source.includes('_QUEUE_JOB=_session_take()'))claimed=true;
 }
 if(!claimed)throw Error('会话停止保护缺少初始化入口。');
 return JSON.stringify(n);
}
