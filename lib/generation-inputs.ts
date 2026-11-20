export const GENERATION_TYPES = {
  'text-to-video': '文生视频',
  'image-to-video': '首帧图生视频',
  'frames-to-video': '首尾帧生视频',
  'text-to-image': '文生图像',
  'image-to-image': '图生图像',
  inpaint: '蒙版局部重绘',
} as const;

export type GenerationType = keyof typeof GENERATION_TYPES;
export const IMAGE_ROLES = ['firstFrame', 'lastFrame', 'sourceImage', 'maskImage'] as const;
export type ImageRole = typeof IMAGE_ROLES[number];
export type GenerationInputs = Partial<Record<ImageRole, string>> & { generationType?: GenerationType; strength?: number };
export const IMAGE_ID = /^[a-f0-9]{64}$/;
export const INPUT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_TASKS = {
  'text-to-video': [],
  'image-to-video': ['firstFrame'],
  'frames-to-video': ['firstFrame', 'lastFrame'],
  'text-to-image': [],
  'image-to-image': ['sourceImage'],
  inpaint: ['sourceImage', 'maskImage'],
} as const satisfies Record<GenerationType, readonly ImageRole[]>;

export function defaultGenerationType(category: 'image' | 'video') {
  return category === 'image' ? 'text-to-image' : 'text-to-video';
}

export function generationImages(input: GenerationInputs): [ImageRole, string][] {
  return IMAGE_ROLES.flatMap(role => input[role] ? [[role,input[role]]] : []);
}

export function validateGenerationInputs(input: Record<string, unknown>, category: 'image' | 'video'): GenerationInputs {
  const fallback = defaultGenerationType(category);
  const type = input.generationType === undefined ? fallback : input.generationType;
  const options = category === 'video'
    ? ['text-to-video', 'image-to-video', 'frames-to-video'] : ['text-to-image', 'image-to-image', 'inpaint'];
  if (typeof type !== 'string' || !options.includes(type)) throw Error('生成方式与模型不兼容。');
  const required: readonly ImageRole[] = IMAGE_TASKS[type as GenerationType];
  for (const role of IMAGE_ROLES) {
    const value = input[role];
    if (required.includes(role)) {
      if (typeof value !== 'string' || !IMAGE_ID.test(value)) throw Error('请上传当前生成方式所需的图片。');
    } else if (value !== undefined) {
      throw Error('当前生成方式不接受该图片输入。');
    }
  }
  const edit = type === 'image-to-image' || type === 'inpaint';
  if (!edit && input.strength !== undefined) throw Error('只有图生图像和局部重绘支持重绘幅度。');
  const strength = input.strength === undefined ? (type === 'inpaint' ? 1 : 0.6) : input.strength;
  if (edit && (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0.2 || strength > 1)) {
    throw Error('重绘幅度须在 0.2–1 之间。');
  }
  // 旧的纯文本任务保留原来的参数形状，已有 requestId 可以安全重试。
  if (type === fallback) return {};
  return {
    generationType: type as GenerationType,
    ...Object.fromEntries(required.map(role => [role, input[role]])),
    ...(edit ? { strength: strength as number } : {}),
  };
}

export const sessionImageInputsKey = (sessionId: string) => `session-image-inputs:${sessionId}`;
