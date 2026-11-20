import { ChevronDown, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { GENERATION_TYPES, IMAGE_TASKS, type GenerationInputs, type GenerationType, type ImageRole } from '../lib/generation-inputs';

const labels: Record<ImageRole,string> = {
  firstFrame:'首帧', lastFrame:'尾帧', sourceImage:'原图', maskImage:'黑白蒙版',
};

export function GenerationInputFields({type,options,draft,uploading,onChange,onUpload}:{
  type: GenerationType;
  options: readonly GenerationType[];
  draft: GenerationInputs;
  uploading: ImageRole | null;
  onChange: (value: GenerationInputs) => void;
  onUpload: (role: ImageRole, file: File) => void;
}) {
  const roles: readonly ImageRole[] = IMAGE_TASKS[type];
  return <div className="ms-generation-inputs">
    <div className="ms-setting-row">
      <label htmlFor="studio-generation-type">生成方式</label>
      <div className="ms-select">
        <select id="studio-generation-type" value={type} disabled={!!uploading}
          onChange={event=>onChange({generationType:event.target.value as GenerationType,strength:undefined})}>
          {options.map(mode=><option value={mode} key={mode}>{GENERATION_TYPES[mode]}</option>)}
        </select>
        <ChevronDown size={14}/>
      </div>
    </div>
    {!!roles.length&&<>
      <div className="ms-input-grid">
        {roles.map(role=><div className="ms-input-card" key={role}>
          <label className="ms-input-tile">
            {draft[role]?<img src={'/api/inputs/'+draft[role]} alt={labels[role]+'预览'}/>:uploading===role?<LoaderCircle className="spin" size={19}/>:<ImagePlus size={20}/>}
            <span>{uploading===role?'正在上传…':labels[role]}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!uploading}
              aria-label={`上传${labels[role]}`} onChange={event=>{
                const file=event.target.files?.[0];
                event.target.value='';
                if(file)onUpload(role,file);
              }}/>
          </label>
          {draft[role]&&<button type="button" aria-label={`移除${labels[role]}`} disabled={!!uploading}
            onClick={()=>onChange({[role]:undefined})}><X size={14}/></button>}
        </div>)}
      </div>
      <small>{type==='inpaint'?'蒙版与原图同尺寸，白色区域重绘。':'PNG、JPEG 或 WebP，单张最多 8 MB。按输出比例居中裁切。'}</small>
    </>}
    {(type==='image-to-image'||type==='inpaint')&&<div className="ms-setting-row ms-strength">
      <label htmlFor="studio-strength">重绘幅度</label>
      <input id="studio-strength" type="range" min="0.2" max="1" step="0.05"
        value={draft.strength??(type==='inpaint'?1:0.6)} onChange={event=>onChange({strength:Number(event.target.value)})}/>
      <output htmlFor="studio-strength">{draft.strength??(type==='inpaint'?1:0.6)}</output>
    </div>}
  </div>;
}
