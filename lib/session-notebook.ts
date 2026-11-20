import {enableH3SafeMixedWorker} from './h3-mixed';
import {buildNotebook} from './notebook';
import {sessionWorkerPrelude,sessionWorkerLoop,freshNoiseNode} from './session-worker';
import type {VideoParams} from './parameters';
export function buildSessionNotebook(params:VideoParams,base:string,token:string){
 const n=JSON.parse(buildNotebook(params));
 n.cells[11].source=n.cells[11].source.replace('(custom_node_dir / "__init__.py").write_text',`custom_node_code += ${JSON.stringify(freshNoiseNode)}\n(custom_node_dir / "__init__.py").write_text`);
 n.cells[19].source=n.cells[19].source.replace('    return workflow, {','    workflow["122"]={"class_type":"H3SessionFreshNoise","inputs":{"noise":["15",0],"nonce":filename_prefix}}\n    workflow["14"]["inputs"]["noise"]=["122",0]\n    return workflow, {');
 n.cells[19].source=n.cells[19].source
  .replace('    filename_prefix: str,','    filename_prefix: str,\n    images=None,')
  .replace('    return workflow, {',`    for role,slot,node_id in (("firstFrame","first_frame","123"),("lastFrame","last_frame","124")):
        if images and role in images:
            workflow[node_id]={"class_type":"LoadImage","inputs":{"image":images[role]}}
            workflow["104"]["inputs"][slot]=[node_id,0]
    return workflow, {`);
 n.cells[21].source=n.cells[21].source.replace('        filename_prefix=prefix,','        filename_prefix=prefix,\n        images=attempt.get("images"),');
 n.cells[21].source=n.cells[21].source.split('requested_dual = bool(')[0].replace('        last_stage = stage','        _session_progress(stage,int(progress_bar.n))\n        last_stage = stage')+sessionWorkerLoop;
 if(params.runtimeProfile==='fp16')enableH3SafeMixedWorker(n);
 n.cells=n.cells.slice(0,22);
 for(const [i,stage] of [[9,'安装生成环境'],[13,'下载模型到本地磁盘'],[15,'启动生成服务']] as const)n.cells[i].source=`_session_progress(${JSON.stringify(stage)},0)\n`+n.cells[i].source;
 n.cells.splice(6,0,{cell_type:'code',metadata:{},source:sessionWorkerPrelude(base,token),outputs:[],execution_count:null});
 return JSON.stringify(n);
}
