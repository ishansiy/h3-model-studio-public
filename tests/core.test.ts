import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildNotebook } from "../lib/notebook";
import { validateParams, frameCount, MODES, generationMode, MODEL_LIMITS, MAX_SEED, MAX_VIDEO_SECONDS, samplingSteps, randomVideoSeed } from "../lib/parameters";
import { parseProgress, trustedFile, cleanError } from "../lib/kaggle";
const base = {prompt:"海边的一阵风",mode:"quality",width:608,height:352,duration:5,seed:20260803};
assert.equal(frameCount(5),124);
for (const mode of Object.keys(MODES)) {
  const p = validateParams({...base,mode});
  const notebook = JSON.parse(buildNotebook(p));
  const python = `import json, ast, sys\nn=json.loads(sys.stdin.read())\nfor c in n['cells']:\n if c['cell_type']=='code': ast.parse(c['source'])\ng={}\nexec(n['cells'][2]['source'],g)\nassert g['PROMPT']==${JSON.stringify(p.prompt)}\nassert g['STEPS']==${MODES[generationMode(p.mode)].steps}\nassert g['USE_TURBO']==${MODES[generationMode(p.mode)].turbo ? "True" : "False"}\n`;
  execFileSync("python3",["-c",python],{input:JSON.stringify(notebook)});
}
for (const invalid of [{mode:"constructor"},{width:609},{width:16416},{height:0},{width:1376,height:768},{width:1024,height:1024},{width:1920,height:1088},{width:3840,height:2176},{width:7680,height:4320},{width:16384,height:16384},{width:256,height:4064},{width:224,height:352},{duration:150},{duration:15.001},{duration:NaN},{duration:0},{duration:3.99},{steps:51},{steps:10000},{steps:1.5},{mode:"turbo",steps:1},{mode:"turbo",steps:5},{mode:"turbo",steps:6},{mode:"turbo",steps:7},{mode:"turbo",steps:20},{seed:-1},{seed:"18446744073709551616"},{seed:Number.MAX_SAFE_INTEGER+1},{prompt:" "}]) {
  assert.throws(()=>validateParams({...base,...invalid}));
  // Notebook 构造入口同样拒绝，避免以后新增调用绕过 API 校验。
  assert.throws(()=>buildNotebook({...base,...invalid} as any));
}
// 原生范围边界和不同画幅经过实际 Python 工作流构造器，无 GPU 分配或张量创建。
// 自动种子经过与任务 params 列相同的 JSON 存取，完整传入实际 Python 工作流。
const autoSeeds = Array.from({length:20},()=>randomVideoSeed());
assert.equal(new Set(autoSeeds).size,autoSeeds.length);
for(const seed of autoSeeds){
  assert.match(seed,/^\d{1,20}$/);
  assert.ok(BigInt(seed)>=0 && BigInt(seed)<=BigInt(MAX_SEED));
  const saved=JSON.parse(JSON.stringify(validateParams({...base,seed})));
  assert.equal(BigInt(saved.seed),BigInt(seed));
}
const choices = [
  {...base,seed:autoSeeds[0],steps:20},
  {...base,width:1344,height:768,duration:15,steps:50,seed:MAX_SEED},
  {...base,width:768,height:1344,duration:15,steps:25,seed:MAX_SEED},
  {...base,width:768,height:768,duration:4,steps:1},
  {...base,width:1536,height:672,duration:10,steps:50},
  {...base,width:4032,height:256,duration:15,steps:20},
  {...base,mode:"turbo",duration:15,steps:8,seed:"9007199254740993"},
  {...base,mode:"turbo",duration:4,steps:4},
];
for(const choice of choices) {
  const p = validateParams(choice), notebook = JSON.parse(buildNotebook(p));
  assert.equal(samplingSteps(p),choice.steps);
  const python = `import ast,json,sys\nn=json.loads(sys.stdin.read());g={}\nexec(n['cells'][2]['source'],g)\nfor c in n['cells']:\n if c['cell_type']=='code' and 'def build_h3_workflow(' in c['source']:\n  tree=ast.parse(c['source']);selected=[x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name in ['snap_h3_frames','build_h3_workflow']]\n  exec(compile(ast.Module(body=selected,type_ignores=[]),'workflow','exec'),g)\ng.update(DIFFUSION_NAME='model',TEXT_ENCODER_NAME='clip',VIDEO_VAE_NAME='video_vae',AUDIO_VAE_NAME='audio_vae')\nw,m=g['build_h3_workflow'](prompt=g['PROMPT'],width=g['WIDTH'],height=g['HEIGHT'],duration_seconds=g['DURATION_SECONDS'],steps=g['STEPS'],seed=g['SEED'],use_gpu1_clip=False,filename_prefix='test')\nassert w['104']['inputs']['width']==${p.width}\nassert w['104']['inputs']['height']==${p.height}\nassert w['104']['inputs']['length']==${frameCount(p.duration)}\nassert w['9']['inputs']['steps']==${p.steps}\nassert w['15']['inputs']['noise_seed']==int(${JSON.stringify(String(p.seed))})\nassert isinstance(g['SEED'],int)\nassert ('119' in w)==${generationMode(p.mode)==='turbo'?'True':'False'}\nif '119' in w:\n assert w['119']['inputs']['lora_name']=='minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'\n assert w['120']['inputs']['shift_video']==12\n assert w['120']['inputs']['shift_audio']==3\n assert w['17']['inputs']['sampler_name']=='euler'\nelse:\n assert w['17']['inputs']['sampler_name']=='res_multistep'\nprint('参数无截断')\n`;
  execFileSync("python3",["-c",python],{input:JSON.stringify(notebook)});
}
assert.equal(frameCount(15),362);
assert.equal(MAX_VIDEO_SECONDS,362/24);
assert.equal(1344*768,MODEL_LIMITS.pixels);
assert.equal(samplingSteps({...base,mode:"quality"}),20); // 已保存的旧记录仍正常。
// 旧记录缺少 steps 时仍能正确恢复原先的 25/8/4 步，并规范化为两个模式。
for (const [mode,steps,newMode] of [["quality-plus",25,"quality"],["turbo8",8,"turbo"],["turbo4",4,"turbo"]] as const) {
  assert.equal(samplingSteps({mode}),steps);
  const p=validateParams({...base,mode});
  assert.equal(p.mode,newMode);assert.equal(p.steps,steps);
  assert.equal(generationMode(mode),newMode);
}
for(let steps=1;steps<=50;steps++) assert.equal(validateParams({...base,steps}).steps,steps);
assert.equal(validateParams({...base,mode:"quality-plus",steps:35}).steps,35);
assert.equal(validateParams({...base,mode:"turbo"}).steps,8);
const injection = `"""\n__import__('os').system('false')\n#中文\\n\"\n`;
const dangerous = JSON.parse(buildNotebook(validateParams({...base,prompt:injection})));
const result = execFileSync("python3",["-c",`import sys,json,ast\nn=json.loads(sys.stdin.read());s=n['cells'][2]['source'];ast.parse(s);g={};exec(s,g);print(json.dumps(g['PROMPT']))`],{input:JSON.stringify(dangerous),encoding:"utf8"});
assert.equal(JSON.parse(result),injection.trim());
const marker = '@@H3_PROGRESS@@'+JSON.stringify({stage:"采样视频",step:3,steps:20});
const event = 'data: '+JSON.stringify({data:marker+'\n',time:300});
assert.equal(parseProgress(event).step,3); assert.equal(parseProgress('nothing'),null);
assert.throws(()=>trustedFile("http://127.0.0.1/video")); assert.throws(()=>trustedFile("https://kaggleusercontent.com.evil.example/video"));
assert.ok(trustedFile("https://www.kaggleusercontent.com/video"));
assert.ok(!cleanError("KGAT_abcdefghijklmnopqrstuvwxyz").includes("abcdefghijklmnopqrstuvwxyz"));
console.log("通过：两种模式与旧记录兼容、H3原生画布与15秒边界、横竖屏和宽银幕、原版1–50步、Turbo4/8步及实际LoRA与采样器配置、超出范围前后端拒绝、完整64位种子、Python参数与帧数对齐、非法参数、提示词注入隔离、进度与文件安全。");

// Compiler experiment preserves generation params, precision and workflow.
assert.throws(()=>validateParams({...base,runtimeProfile:"unknown"}));
for(const runtimeProfile of ["standard","eager"] as const){
 const nb=JSON.parse(buildNotebook(validateParams({...base,steps:20,runtimeProfile})));
 const python=`import ast,json,sys\nn=json.loads(sys.stdin.read());g={}\nexec(n['cells'][2]['source'],g)\nassert g['RUNTIME_PROFILE']==${JSON.stringify(runtimeProfile)}\nfor c in n['cells']:\n if c['cell_type']=='code': ast.parse(c['source'])\n# Execute just the candidate flag decision with an inert server command.\nserver=n['cells'][15]['source'];part=server[server.index('if RUNTIME_PROFILE =='):server.index('fingerprint =')]\ng['command']=['--lowvram','--reserve-vram','0.8'];exec(part,g)\nassert ('--disable-comfy-compiler' in g['command'])==${runtimeProfile==='eager'?'True':'False'}\nassert g['STEPS']==20 and g['WIDTH']==608 and g['HEIGHT']==352\n`;
 execFileSync("python3",["-c",python],{input:JSON.stringify(nb)});
}
console.log("通过：运行实验仅影响编译开关，默认方案不变，全部Python单元可解析。");
