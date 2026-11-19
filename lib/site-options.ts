import {validateParams,frameCount,MODEL_LIMITS,type VideoParams} from './parameters';
// 网站开放档位；模型原生范围仍由parameters保留，以兼容历史记录。
export const RESOLUTION_OPTIONS=[
 {value:'512x288',label:'草稿 · 512 × 288'},
 {value:'608x352',label:'标准 · 608 × 352'},
 {value:'736x416',label:'清晰 · 736 × 416（待完整实测）'},
 {value:'768x768',label:'方形 · 768 × 768（待完整实测）'},
 {value:'1024x768',label:'最高 · 1024 × 768'},
] as const;
export const isHighestResolution=(width:number,height:number)=>width===1024&&height===768;
export const siteMaxSeconds=(width:number,height:number)=>isHighestResolution(width,height)?4.46:MODEL_LIMITS.maxSeconds;
export function validateSiteParams(value:unknown):VideoParams{
 const p=validateParams(value);
 if(!RESOLUTION_OPTIONS.some(x=>x.value===`${p.width}x${p.height}`))throw new Error('请选择网站提供的分辨率档位，当前最高为1024 × 768。');
 if(isHighestResolution(p.width,p.height)&&(p.duration>4.46||frameCount(p.duration)>107))throw new Error('1024 × 768当前仅开放最多4.46秒（107帧）；更长时长尚未完整验证。');
 return p;
}
