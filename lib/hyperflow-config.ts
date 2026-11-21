import {validateGenerationInputs,type GenerationInputs} from './generation-inputs';
import {frameCount,validateParams,type VideoParams} from './parameters';
import {RESOLUTION_OPTIONS} from './site-options';
export const HYPERFLOW={id:'hyperflow-h3-flash',repo:'VideoRebirthAI/hyperflow-h3-flash',revision:'6834923e1a9ca4d15a2349a622b6677bea1404cb',comfyCommit:'e6515b16ed360b01bd6548bffaca193f88f181fb',nodesCommit:'356649c32dca9a1dd46608d530ccb5e025fb338d',ggufCommit:'6ea2651e7df66d7585f6ffee804b20e92fb38b8a',checkpoint:'minimax_h3_fl2va_hyperflow_flash_14b-Q4_K_M.gguf',bytes:9053456480,quantization:'Q4_K_M',steps:[4,6,8]} as const;
export type HyperFlowParams=VideoParams&{category:'video';modelId:'hyperflow-h3-flash';mode:'quality';steps:4|6|8;runtimeProfile:'standard'} & GenerationInputs;
export const HYPERFLOW_FAST_PRESET={width:1024,height:768,duration:5,frames:124,steps:4,accelerator:'dual-t4'} as const;
export const hyperFlowFastSessionKey=(id:string)=>'session-hyperflow-fast:'+id;
export const HYPERFLOW_DUAL_T4_STEPS=[HYPERFLOW_FAST_PRESET.steps,6] as const;
export function usesHyperFlowFastPreset(params:{modelId:string;width:number;height:number;steps?:number;duration?:number}){
 const fast=HYPERFLOW_FAST_PRESET;
 return params.modelId===HYPERFLOW.id&&params.width===fast.width&&params.height===fast.height&&params.steps===fast.steps
  &&typeof params.duration==='number'&&params.duration>=fast.duration&&frameCount(params.duration)===fast.frames;
}
export const HYPERFLOW_RESOLUTIONS=RESOLUTION_OPTIONS.map(r=>({value:r.value,label:r.value==='608x352'?'标准 · 608 × 352':r.value==='512x288'?'草稿 · 512 × 288':r.value==='1024x768'?'高画质 · 1024 × 768':`${r.value.replace('x',' × ')}（待T4完整实测）`}));
export function validateHyperFlow(input:Record<string,unknown>):HyperFlowParams{
 if(['image','images','references','referenceImages'].some(k=>input[k]!==undefined))throw Error('图片请先上传为工作室素材，并使用 firstFrame 或 lastFrame 参数。');
 if(input.mode!==undefined&&input.mode!=='quality')throw Error('HyperFlow Flash使用独立少步模型，不支持H3 Turbo模式。');
 if(input.runtimeProfile!==undefined&&input.runtimeProfile!=='standard')throw Error('HyperFlow Flash使用独立GGUF执行器，不能叠加H3计算方案。');
 const steps=input.steps??6;if(!HYPERFLOW.steps.includes(steps as 4|6|8))throw Error('HyperFlow Flash支持4、6、8步，默认6步。');
 const p=validateParams({...input,mode:'quality',runtimeProfile:'standard',steps});
 if(!HYPERFLOW_RESOLUTIONS.some(r=>r.value===`${p.width}x${p.height}`))throw Error('请选择HyperFlow Flash提供的画面尺寸。');
 if(p.duration<5||frameCount(p.duration)<124)throw Error('HyperFlow Flash请求时长支持5–15秒，至少124帧（约5.17秒）。');
 return {...p,category:'video',modelId:'hyperflow-h3-flash',mode:'quality',steps:steps as 4|6|8,runtimeProfile:'standard',...validateGenerationInputs(input,'video')};
}
