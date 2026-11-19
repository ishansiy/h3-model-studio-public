import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {buildSessionNotebook} from '../lib/session-notebook';
for(const profile of ['standard','ck','fp16'] as const){
 const n=JSON.parse(buildSessionNotebook({prompt:'海边女孩',mode:'quality',width:512,height:288,duration:4,seed:'18446744073709551615',steps:20,runtimeProfile:profile},'https://studio.test/api/worker/fixture','c'.repeat(64)));
 const text=n.cells.map((x:any)=>x.source).join('\n');assert.ok(!text.includes('KGAT_'));assert.ok(text.includes('H3_SESSION_CHANNEL_READY'));assert.ok(text.includes('_session_upload'));assert.ok(text.includes('42600'));assert.ok(text.includes('resolved["seed"]=str(SEED)'));
 execFileSync('python3',['-c',`import json,ast,types,tempfile,pathlib,shutil
n=json.load(__import__('sys').stdin)
for c in n['cells']:
 if c['cell_type']=='code':ast.parse(c['source'])
g={};exec(n['cells'][2]['source'],g);assert g['SEED']==18446744073709551615
custom=next(c['source'] for c in n['cells'] if c['cell_type']=='code' and 'custom_node_code =' in c['source'])
with tempfile.TemporaryDirectory() as d:
 g['COMFY_DIR']=pathlib.Path(d);exec(custom,g);ast.parse(g['custom_node_code'])
g['torch']=types.SimpleNamespace(cuda=types.SimpleNamespace(device_count=lambda:2));g['MULTIGPU_NODE_AVAILABLE']=True;g['FINAL_OUTPUT_DIR']=pathlib.Path(tempfile.mkdtemp());g['OBJECT_INFO']={'ModelAttentionBackend':{'input':{'required':{'attention':[['pytorch attention','comfy kitchen attention']]}}}}
workflow=next(c['source'] for c in n['cells'] if c['cell_type']=='code' and 'def build_h3_workflow' in c['source']);exec(workflow.split('preview_workflow, preview_config')[0],g)
for prefix in ['first','second']:
 w,c=g['build_h3_workflow'](prompt='测试',width=512,height=288,duration_seconds=4,steps=20,seed=g['SEED'],use_gpu1_clip=True,filename_prefix=prefix)
 assert w['14']['class_type']=='SamplerCustomAdvanced' and w['14']['inputs']['noise']==['122',0]
 assert w['122']['inputs']['nonce']==prefix and c['seed']==18446744073709551615
shutil.rmtree(g['FINAL_OUTPUT_DIR'])`],{input:JSON.stringify(n),stdio:['pipe','pipe','pipe']});
}
console.log('通过：会话Notebook完整Python/自定义节点可解析、凭证不含账户Token、标准/CK保留模型与原采样器、64位种子、强制重新采样及逐条交付代码。');
