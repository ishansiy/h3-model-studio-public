import {finalizeSessionStop} from './session-stop';
import {buildHyperFlowNotebook} from './hyperflow';
import {buildSessionNotebook} from './session-notebook';
import {buildImageNotebook} from './image-notebook';
import {validateGenerationParams,type ImageParams} from './model-catalog';

/** 模型执行器只构建自己的运行环境，任务队列与账户凭证由调度层管理。 */
export function buildModelNotebook(input:unknown,base:string,token:string){
 const params=validateGenerationParams(input);
 if(params.modelId==='hyperflow-h3-flash')return finalizeSessionStop(buildHyperFlowNotebook(params,base,token,{safeMixed:true,resident:true,headParallel:true}));
 if(params.modelId==='h3'&&params.category==='video')return finalizeSessionStop(buildSessionNotebook(params,base,token));
 if(params.modelId==='z-image-turbo'&&params.category==='image')return finalizeSessionStop(buildImageNotebook(params as ImageParams,base,token));
 throw Error('模型执行器尚未接入。');
}
