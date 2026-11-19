import {enableH3SafeMixedBase,enableH3SafeMixedStandalone} from './h3-mixed';
import {modelCacheCell} from "./model-cache";
import {ckPreflight,ckAuditNode,ckWorkflow} from "./ck-experiment";
import {controlCell} from "./job-control";
import template from "./h3-template.json";
import { MODES, generationMode, samplingSteps, validateParams, type VideoParams } from "./parameters";

const sourceText = (source:string|string[]) => Array.isArray(source) ? source.join("") : source;
export function buildNotebook(params: VideoParams, control?: {url:string;token:string}) {
  params = validateParams(params);
  const nb = structuredClone(template);
  const config = { ...MODES[generationMode(params.mode)], steps: samplingSteps(params), label: `${MODES[generationMode(params.mode)].label.split(" · ")[0]} · ${samplingSteps(params)}步` };
  const input = JSON.stringify({ ...params, ...config });
  // 两层 JSON 编码，让用户提示词只作为数据读取，不能变成 Python 代码。
  nb.cells[2].source = [`import json, time\n_WEB_PARAMS = json.loads(${JSON.stringify(input)})\n`,
    `PROMPT = _WEB_PARAMS["prompt"]\nWIDTH = _WEB_PARAMS["width"]\nHEIGHT = _WEB_PARAMS["height"]\n`,
    `DURATION_SECONDS = _WEB_PARAMS["duration"]\nSEED = int(_WEB_PARAMS["seed"])\n`,
    `GENERATION_MODE = _WEB_PARAMS["label"]\nSTEPS = _WEB_PARAMS["steps"]\nUSE_TURBO = _WEB_PARAMS["turbo"]\nSAMPLER_NAME = _WEB_PARAMS["sampler"]\n`,
    `TURBO_LORA_NAME = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"\nTURBO_SHIFT_VIDEO, TURBO_SHIFT_AUDIO = 12.0, 3.0\nRUN_STARTED_AT = time.perf_counter()\nSTAGE_TIMINGS = {}\n`];
  // Runtime experiments preserve weights, precision and requested quality parameters.
  nb.cells[2].source.push('RUNTIME_PROFILE = _WEB_PARAMS.get("runtimeProfile", "standard")\n');
  nb.cells[9].source=[sourceText(nb.cells[9].source)+ckPreflight];
  nb.cells[11].source=[sourceText(nb.cells[11].source).replace('(custom_node_dir / "__init__.py").write_text',`custom_node_code += ${JSON.stringify(ckAuditNode)}\n\n(custom_node_dir / "__init__.py").write_text`)];
  nb.cells[7].source=[sourceText(nb.cells[7].source).replace("MIN_RECOMMENDED_FREE_GIB = 44.0",'MIN_RECOMMENDED_FREE_GIB = 24.0 if RUNTIME_PROFILE == "cached" else 44.0')];
  const downloadSource=sourceText(nb.cells[13].source);
  nb.cells[13].source=['if RUNTIME_PROFILE == "cached":\n'+modelCacheCell().split('\n').map(line=>'    '+line).join('\n')+'\nelse:\n'+downloadSource.split('\n').map(line=>'    '+line).join('\n')];
  nb.cells[15].source = [sourceText(nb.cells[15].source).replace("fingerprint = hashlib.sha256", 'if RUNTIME_PROFILE == "eager":\n    command.append("--disable-comfy-compiler")\nfingerprint = hashlib.sha256')];
  nb.cells[15].source=[sourceText(nb.cells[15].source).replace('env["HF_HOME"] = str(SESSION_ROOT / "hf_home")','env["HF_HOME"] = str(SESSION_ROOT / "hf_home")\nif "ck" == RUNTIME_PROFILE:\n    env["H3_CK_AUDIT_PATH"] = str(FINAL_OUTPUT_DIR / "minimax_h3_attention_proof.json")')];
  nb.cells[15].source=[sourceText(nb.cells[15].source).replace('"command": command, "commit": COMFY_COMMIT','"command": command, "runtime_profile": RUNTIME_PROFILE, "commit": COMFY_COMMIT')];
  nb.cells[19].source=[sourceText(nb.cells[19].source).replace('    return workflow, {',ckWorkflow+'\n    return workflow, {\n        "attention_backend": "comfy_kitchen_int8" if RUNTIME_PROFILE == "ck" else "default",')];
  nb.cells[21].source = [sourceText(nb.cells[21].source).replace('run_metadata = {', 'run_metadata = {\n    "runtime_profile": RUNTIME_PROFILE,\n    "runtime_command": command,\n    "model_cache_used": globals().get("MODEL_CACHE_USED", False),')];
  nb.cells[21].source=[sourceText(nb.cells[21].source).replace('run_metadata = {','CK_ATTENTION_PROOF = None\nif RUNTIME_PROFILE == "ck":\n    CK_ATTENTION_PROOF = json.loads((FINAL_OUTPUT_DIR / "minimax_h3_attention_proof.json").read_text())\n    if CK_ATTENTION_PROOF.get("backend") != "comfy_kitchen_int8" or CK_ATTENTION_PROOF.get("executed") is not True:\n        raise RuntimeError("没有实际注意力加速执行证据。")\nrun_metadata = {\n    "attention_proof": CK_ATTENTION_PROOF,')];
  const ready={ ...nb, cells: nb.cells.map(c => ({ ...c, source: Array.isArray(c.source) ? c.source.join("") : c.source, ...(c.cell_type === "code" ? { execution_count: null, outputs: [] } : {}) })) };
  if(params.runtimeProfile==='fp16'){enableH3SafeMixedBase(ready);enableH3SafeMixedStandalone(ready);}
  if(control)ready.cells.splice(6,0,{cell_type:"code",metadata:{},source:controlCell(control.url,control.token),execution_count:null,outputs:[]} as any);
  return JSON.stringify(ready);
}
