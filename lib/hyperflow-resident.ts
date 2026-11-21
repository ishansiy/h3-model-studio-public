import {HYPERFLOW_10S_ACTIVATION_GIB,HYPERFLOW_10S_PRESET,HYPERFLOW_DUAL_T4_STEPS,HYPERFLOW_FAST_PRESET} from './hyperflow-config';

const {width,height,frames}=HYPERFLOW_FAST_PRESET;
const shortJob='config.get("frames")=='+frames+' and config.get("steps") in ('+HYPERFLOW_DUAL_T4_STEPS.join(',')+')';
const longJob='config.get("frames")=='+HYPERFLOW_10S_PRESET.frames+' and config.get("steps")=='+HYPERFLOW_10S_PRESET.steps;
export const HYPERFLOW_DUAL_T4_JOB_CONDITION=
  'config.get("width")=='+width+' and config.get("height")=='+height+
  ' and (('+shortJob+') or ('+longJob+')) and bool(config.get("jobId")) and config["jobId"] in nonce';

/** 高尺寸逐任务显存调度，沿用原权重和采样设置。 */
export const HYPERFLOW_RESIDENT_NODE=String.raw`
def _hf_resident_budget(nonce):
    try:
        config=_hf_json.loads(_HFPath("/kaggle/working/hyperflow_active_job.json").read_text())
        if ${HYPERFLOW_DUAL_T4_JOB_CONDITION}:
            return (${HYPERFLOW_10S_ACTIVATION_GIB} if config["frames"]==${HYPERFLOW_10S_PRESET.frames} else 6)*1024**3
    except (OSError,ValueError,TypeError,AttributeError):pass
    return 0
_hf_resident_audit_original=StudioHyperFlowAudit.audit
def _hf_resident_audit(self,model,nonce):
    patcher=model
    result=_hf_resident_audit_original(self,patcher,nonce)
    m=patcher.model.diffusion_model
    budget=_hf_resident_budget(nonce)
    if getattr(patcher.model,"_hf_resident_installed",False):
        m._studio_hf_mixed_stats["resident_policy"].update(enabled=bool(budget),activation_budget_bytes=budget)
        return result
    original_memory=patcher.model.memory_required
    stats=m._studio_hf_mixed_stats
    stats["resident_policy"]={"name":"hyperflow_1024_fp16_budget_v1","activation_budget_bytes":budget,"original_estimate_bytes":[],"selected_estimate_bytes":[],"memory_samples":[],"math_unchanged":True,"enabled":bool(budget)}
    policy=stats["resident_policy"]
    def memory_required(self,input_shape,cond_shapes={}):
        original=original_memory(input_shape,cond_shapes)
        selected=min(original,policy["activation_budget_bytes"]) if policy["enabled"] else original
        policy["original_estimate_bytes"].append(int(original));policy["selected_estimate_bytes"].append(int(selected))
        return selected
    patcher.model.memory_required=_hf_types.MethodType(memory_required,patcher.model)
    original_forward=m.forward
    def measured_forward(*args,**kwargs):
        if not policy["enabled"]:return original_forward(*args,**kwargs)
        torch.cuda.synchronize(0);torch.cuda.reset_peak_memory_stats(0)
        before=torch.cuda.memory_allocated(0)
        loaded=patcher.loaded_size()
        output=original_forward(*args,**kwargs)
        torch.cuda.synchronize(0)
        policy["memory_samples"].append({"loaded_weight_bytes":int(loaded),"before_allocated_bytes":before,"peak_allocated_bytes":torch.cuda.max_memory_allocated(0),"peak_reserved_bytes":torch.cuda.max_memory_reserved(0),"free_bytes":torch.cuda.mem_get_info(0)[0]})
        _HFPath("/kaggle/working/hyperflow_precision_proof.json").write_text(_hf_json.dumps(stats))
        return output
    m.forward=measured_forward;patcher.model._hf_resident_installed=True
    return result
StudioHyperFlowAudit.audit=_hf_resident_audit
`;
export function attachHyperFlowJobConfig(n:any){
 let count=0;for(const c of n.cells){if(c.cell_type==='code'&&c.source.includes('        PROMPT=p["prompt"]')){
  if(!c.source.includes('hyperflow_active_job.json'))c.source=c.source.replace('        PROMPT=p["prompt"]','        Path("/kaggle/working/hyperflow_active_job.json").write_text(json.dumps({"jobId":current["id"],"width":p["width"],"height":p["height"],"frames":snap_h3_frames(float(p["duration"])),"steps":int(p["steps"])}))\n        PROMPT=p["prompt"]');count++;
 }}if(count!==1)throw Error('HyperFlow逐任务配置锚点不匹配');return n;
}
export function enableHyperFlowResident(n:any){
 attachHyperFlowJobConfig(n);
 let count=0;for(const c of n.cells){if(c.cell_type==='code'&&c.source.includes('(custom_node_dir / "__init__.py").write_text')){
  c.source=c.source.replace('(custom_node_dir / "__init__.py").write_text',`custom_node_code += ${JSON.stringify(HYPERFLOW_RESIDENT_NODE)}\n(custom_node_dir / "__init__.py").write_text`);count++;
 }}if(count!==1)throw Error('HyperFlow显存调度模板锚点不匹配');return n;
}
