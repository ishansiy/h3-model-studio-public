import {HYPERFLOW_RESOLUTIONS,validateHyperFlow,type HyperFlowParams} from './hyperflow-config';
import {MAX_SEED,samplingSteps,type VideoParams} from './parameters';
import {validateSiteParams,RESOLUTION_OPTIONS} from './site-options';

export type GenerationCategory='video'|'image';
export type ImageParams={category:'image';modelId:'z-image-turbo';prompt:string;width:number;height:number;steps:9;seed:number|string;runtimeProfile:'standard'};
export type StudioVideoParams=VideoParams&{category:'video';modelId:'h3'};
export type GenerationParams=StudioVideoParams|HyperFlowParams|ImageParams;
export const IMAGE_RESOLUTIONS=[{value:'1024x1024',label:'1:1 · 1024 × 1024'},{value:'1024x768',label:'4:3 · 1024 × 768'},{value:'768x1024',label:'3:4 · 768 × 1024'},{value:'512x512',label:'1:1 · 512 × 512'}] as const;
export const CATEGORIES=[{id:'video',label:'视频生成',defaultModelId:'h3'},{id:'image',label:'图像生成',defaultModelId:'z-image-turbo'}] as const;
export const MODEL_CATALOG=[
 {id:'h3',category:'video',name:'H3',subtitle:'视频默认模型',description:'原版音视频生成，保留原版与Turbo模式，支持连续GPU会话。',sourceUrl:'https://docs.comfy.org/tutorials/video/minimax/minimax-h3',license:'沿用原模型许可',provider:'kaggle',runner:'comfyui-h3',loadPolicy:'按需加载到GPU会话',precision:'原版配置',resolutions:RESOLUTION_OPTIONS,defaults:{mode:'quality',width:608,height:352,duration:5,steps:20,runtimeProfile:'standard'}},
 {id:'hyperflow-h3-flash',category:'video',name:'HyperFlow H3 Flash',subtitle:'少步音视频模型',description:'独立剪枝模型，默认6步，支持4/6/8步与连续会话。首版接入文生音视频；GGUF Q4_K_M量化，输出与H3原版不同。',sourceUrl:'https://huggingface.co/VideoRebirthAI/hyperflow-h3-flash',license:'MiniMax H3 社区许可；节点GPL-3.0',provider:'kaggle',runner:'comfyui-hyperflow',loadPolicy:'独立模型GPU会话，按需加载',precision:'GGUF Q4_K_M',resolutions:HYPERFLOW_RESOLUTIONS,defaults:{mode:'quality',width:608,height:352,duration:5,steps:6,runtimeProfile:'standard'}},
 {id:'z-image-turbo',category:'image',name:'Z-Image-Turbo',subtitle:'图像默认模型',description:'支持中英文提示词的开源图像模型，生成PNG图片。',sourceUrl:'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',license:'Apache 2.0',provider:'kaggle',runner:'diffusers-zimage',loadPolicy:'按需加载到GPU会话',precision:'浮点权重，不量化',resolutions:IMAGE_RESOLUTIONS,defaults:{width:1024,height:1024,steps:9,runtimeProfile:'standard'}},
] as const;
export function modelById(id:string){return MODEL_CATALOG.find(m=>m.id===id);}
export function modelForCategory(category:GenerationCategory){return MODEL_CATALOG.find(m=>m.category===category)!;}
export function jobCategory(row:{category?:string;params?:any}):GenerationCategory{const p=typeof row.params==='string'?JSON.parse(row.params):row.params;return (row.category||p?.category)==='image'?'image':'video';}
export function jobModel(row:{model_id?:string;modelId?:string;category?:string;params?:any}){return row.model_id||row.modelId||(jobCategory(row)==='image'?'z-image-turbo':'h3');}
export function generationSteps(params:GenerationParams|VideoParams){return 'category' in params&&params.category==='image'?params.steps:samplingSteps(params as VideoParams);}
export function validateGenerationParams(input:unknown):GenerationParams{
 const v=input as Record<string,unknown>;if(!v||typeof v!=='object')throw Error('生成参数无效。');
 const category=v.category??(typeof v.modelId==='string'?modelById(v.modelId)?.category:'video');
 if(category!=='video'&&category!=='image')throw Error('请选择图像或视频生成类别。');
 const id=v.modelId??modelForCategory(category).id,model=typeof id==='string'?modelById(id):undefined;
 if(!model||model.category!==category)throw Error('模型与生成类别不兼容。');
 if(id==='hyperflow-h3-flash')return validateHyperFlow(v);
 if(id==='h3')return {...validateSiteParams(v),category:'video',modelId:'h3'};
 if(id!=='z-image-turbo')throw Error('该模型的参数适配器尚未接入。');
 if(typeof v.prompt!=='string'||!v.prompt.trim()||v.prompt.length>3000)throw Error('图像描述需要1–3000个字符。');
 if(!IMAGE_RESOLUTIONS.some(r=>r.value===`${v.width}x${v.height}`))throw Error('请选择支持的图像尺寸。');
 if(v.steps!==undefined&&v.steps!==9)throw Error('Z-Image-Turbo当前采用推荐的9个调度步（8次模型评估）。');
 if(v.runtimeProfile!==undefined&&v.runtimeProfile!=='standard')throw Error('图像模型使用独立标准执行器，不能使用H3计算方案。');
 if(v.duration!==undefined||v.mode!==undefined)throw Error('图像生成不接受视频时长或H3采样模式。');
 if(!((typeof v.seed==='number'&&Number.isSafeInteger(v.seed)&&v.seed>=0)||(typeof v.seed==='string'&&/^\d{1,20}$/.test(v.seed))))throw Error('请填写有效的随机种子。');
 if(BigInt(v.seed)>BigInt(MAX_SEED))throw Error('随机种子超出范围。');
 return {category:'image',modelId:'z-image-turbo',prompt:v.prompt.trim(),width:Number(v.width),height:Number(v.height),steps:9,seed:v.seed as number|string,runtimeProfile:'standard'};
}
