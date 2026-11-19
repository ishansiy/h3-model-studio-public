// Python运行时：只改变权重放置位置，保留FP32和原始采样算法。
export const DUAL_T4_RUNTIME=String.raw`
def _resident_split(block_bytes, other_bytes, limits, capacity=None):
    capacity=capacity or limits
    candidates=[]
    for split in range(1,len(block_bytes)):
        sizes=(other_bytes+sum(block_bytes[:split]),sum(block_bytes[split:]))
        if all(size<=limit for size,limit in zip(sizes,limits)):
            candidates.append((max(size/limit for size,limit in zip(sizes,capacity)),split,sizes))
    if not candidates:raise RuntimeError("两张GPU没有足够显存容纳FP32模型及推理余量。")
    _,split,sizes=min(candidates)
    return split,sizes

class _ResidentZImagePipeline(ZImagePipeline):
    @property
    def _execution_device(self):return torch.device("cuda:0")

def _load_resident_pipeline():
    from accelerate import init_empty_weights, cpu_offload
    from diffusers import ZImageTransformer2DModel
    if torch.cuda.device_count()<2:raise RuntimeError("FP32加速方案需要两张GPU，未回退到慢速卸载或降低画质。")
    config=ZImageTransformer2DModel.load_config("Tongyi-MAI/Z-Image-Turbo",subfolder="transformer",revision=_IMAGE_REVISION)
    with init_empty_weights():skeleton=ZImageTransformer2DModel.from_config(config)
    nbytes=lambda module:sum(p.numel()*4 for p in module.parameters())
    blocks=[nbytes(layer) for layer in skeleton.layers]
    other=nbytes(skeleton)-sum(blocks)
    gib=1024**3
    limits=[torch.cuda.get_device_properties(0).total_memory-int(3*gib),torch.cuda.get_device_properties(1).total_memory-int(2*gib)]
    print("MODEL_STUDIO_MEMORY_PREFLIGHT "+json.dumps({"gpu_bytes":[torch.cuda.get_device_properties(i).total_memory for i in range(2)],"weight_bytes":sum(blocks)+other,"block_bytes":blocks,"other_bytes":other,"limits":limits}),flush=True)
    split,sizes=_resident_split(blocks,other,limits,[torch.cuda.get_device_properties(0).total_memory-int(.2*gib),torch.cuda.get_device_properties(1).total_memory])
    # 不使用根模块映射，避免Accelerate先把整个模型放到第一张卡导致峰值OOM。
    placement={name:0 for name,_ in skeleton.named_children() if name!="layers"}
    placement.update({name:0 for name,_ in skeleton.named_parameters(recurse=False)})
    placement.update({"layers."+str(i):0 if i<split else 1 for i in range(len(blocks))})
    del skeleton;gc.collect()
    transformer=ZImageTransformer2DModel.from_pretrained("Tongyi-MAI/Z-Image-Turbo",subfolder="transformer",revision=_IMAGE_REVISION,torch_dtype=torch.float32,low_cpu_mem_usage=True,use_safetensors=True,device_map=placement)
    for name,param in transformer.named_parameters():
        prefix=max((key for key in placement if name==key or name.startswith(key+".")),key=len)
        if param.dtype!=torch.float32 or param.device!=torch.device("cuda",placement[prefix]):raise RuntimeError("模型权重精度或双GPU放置校验失败。")
    result=_ResidentZImagePipeline.from_pretrained("Tongyi-MAI/Z-Image-Turbo",revision=_IMAGE_REVISION,transformer=transformer,torch_dtype=torch.float32,low_cpu_mem_usage=True,use_safetensors=True)
    result.vae.to("cuda:0")
    encoder_bytes=nbytes(result.text_encoder)
    # 编码器的FP32权重超过单张T4容量；仅编码时逐层加载，每图只执行一遍。
    cpu_offload(result.text_encoder,execution_device=torch.device("cuda:0"),offload_buffers=len(result.text_encoder._parameters)>0)
    result._resident_split_index=split
    result._resident_placement={"strategy":"dual_t4_resident_fp32","split_layer":split,"weight_bytes":list(sizes),"reserved_bytes":[int(3*gib),int(2*gib)],"transformer_device_map":placement,"encoder_weight_bytes":encoder_bytes,"encoder_strategy":"sequential_once_per_image"}
    print("MODEL_STUDIO_RESIDENT_PLAN "+json.dumps(result._resident_placement),flush=True)
    return result

@torch.no_grad()
def _resident_prompt(pipe,prompt):
    # 编码器与第一张卡上的部分去噪权重按任务交换，采样循环内不再搬运权重。
    # 编码仍在CUDA/FP32运行，避免CPU编码引入额外的数值差异。
    parked=list(pipe.transformer.layers[:pipe._resident_split_index])
    for layer in parked:layer.to("cpu")
    torch.cuda.empty_cache()
    try:
        embeds,_=pipe.encode_prompt(prompt=prompt,device=torch.device("cuda:0"),do_classifier_free_guidance=False)
        if any(not torch.isfinite(e).all().item() for e in embeds):raise RuntimeError("提示词编码出现非有限数值。")
    finally:
        torch.cuda.empty_cache()
        for layer in parked:layer.to("cuda:0")
    torch.cuda.synchronize(0);torch.cuda.synchronize(1)
    return embeds

@torch.no_grad()
def _resident_decode(pipe,latents,park):
    if park:
        for layer in pipe.transformer.layers[:pipe._resident_split_index]:layer.to("cpu")
        torch.cuda.empty_cache()
    # 与原Pipeline相同的缩放、FP32 VAE解码和后处理，不缩小输出。
    latents=latents.to(pipe.vae.dtype)
    latents=(latents/pipe.vae.config.scaling_factor)+pipe.vae.config.shift_factor
    decoded=pipe.vae.decode(latents,return_dict=False)[0]
    return pipe.image_processor.postprocess(decoded,output_type="pil")[0]
`;
