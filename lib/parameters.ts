export type GenerationMode = "quality" | "turbo";
type StoredMode = GenerationMode | "quality-plus" | "turbo8" | "turbo4";
export type VideoParams = { prompt: string; mode: StoredMode; width: number; height: number; duration: number; seed: number | string; steps?: number; runtimeProfile?: "standard" | "eager" | "cached" | "ck" | "fp16" };
// H3 原生画布与有效质量范围，来源是 ComfyUI H3 官方指南和已固定的 H3 节点。
// 不是通用 ComfyUI 输入上限，也不代表所有组合已在 Kaggle T4 上完成实测。
// https://docs.comfy.org/tutorials/video/minimax/minimax-h3
export const MODEL_LIMITS = { minDimension: 256, shortEdge: 768, pixels: 768 * 1344, minSeconds: 4, maxSeconds: 15, maxSteps: 50 } as const;
export const MAX_DIMENSION = Math.floor(MODEL_LIMITS.pixels / MODEL_LIMITS.minDimension / 32) * 32;
export const MAX_ALIGNED_FRAMES = 362;
export const MAX_VIDEO_SECONDS = MAX_ALIGNED_FRAMES / 24;
export const MAX_SEED = "18446744073709551615";
// 提交时生成，使用字符串完整保留 64 位精度；保存到任务后可用于复现。
export function randomVideoSeed(): string {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(words[0]) << BigInt(32)) | BigInt(words[1])).toString();
}
export const MODES = {
  quality: { label: "原版", steps: 20, turbo: false, sampler: "res_multistep" },
  turbo: { label: "Turbo", steps: 8, turbo: true, sampler: "euler" },
} as const;
// 已保存任务沿用旧模式名；读取与重用时保留原有步数，新任务统一保存两种模式。
const LEGACY_DEFAULT_STEPS = { "quality-plus": 25, turbo8: 8, turbo4: 4 } as const;
export function generationMode(mode: StoredMode): GenerationMode {
  return mode === "turbo" || mode === "turbo8" || mode === "turbo4" ? "turbo" : "quality";
}
export function samplingSteps(params: Pick<VideoParams, "mode" | "steps">): number {
  return params.steps ?? (Object.hasOwn(LEGACY_DEFAULT_STEPS, params.mode)
    ? LEGACY_DEFAULT_STEPS[params.mode as keyof typeof LEGACY_DEFAULT_STEPS]
    : MODES[generationMode(params.mode)].steps);
}
export const TURBO_STEPS = [4, 8] as const;
// FL2VA 8-step v1.0 官方列明支持 8 / 4 NFE，使用同一 LoRA、video/audio shift=12/3。
// https://github.com/ModelTC/Minimax-H3-Turbo#1-model-specs
export function validateParams(value: unknown): VideoParams {
  const v = value as Record<string, unknown>;
  if (!v || typeof v.prompt !== "string" || !v.prompt.trim() || v.prompt.length > 6000) throw new Error("提示词需要 1–6000 个字符。");
  if (typeof v.mode !== "string" || (!Object.hasOwn(MODES, v.mode) && !Object.hasOwn(LEGACY_DEFAULT_STEPS, v.mode))) throw new Error("请选择有效的生成模式。");
  if (![v.width, v.height].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= MODEL_LIMITS.minDimension && n <= MAX_DIMENSION && n % 32 === 0)) throw new Error(`当前脚本要求宽高至少 ${MODEL_LIMITS.minDimension} 像素，且为 32 的倍数。`);
  const width = Number(v.width), height = Number(v.height);
  if (Math.min(width, height) > MODEL_LIMITS.shortEdge || width * height > MODEL_LIMITS.pixels) throw new Error("H3 原生画布要求短边不超过 768、总像素不超过 1344 × 768；横屏、竖屏和自定义比例均适用。当前部署没有 2K 再生成模型。");
  if (typeof v.duration !== "number" || !Number.isFinite(v.duration) || v.duration < MODEL_LIMITS.minSeconds || v.duration > MODEL_LIMITS.maxSeconds || frameCount(v.duration) > MAX_ALIGNED_FRAMES) throw new Error("H3 单段请求时长支持 4–15 秒，按 24 FPS 对齐后最多 362 帧（约 15.08 秒）。");
  if(v.runtimeProfile!==undefined && v.runtimeProfile!=="standard" && v.runtimeProfile!=="eager" && v.runtimeProfile!=="cached" && v.runtimeProfile!=="ck" && v.runtimeProfile!=="fp16")throw new Error("请选择有效的运行方案。");
  const mode = generationMode(v.mode as StoredMode), config = MODES[mode];
  if(v.runtimeProfile==="fp16" && mode!=="quality")throw new Error("混合精度加速目前仅验证原版模式，Turbo请使用原精度计算。");
  if(v.runtimeProfile==="cached" && mode!=="quality")throw new Error("当前模型缓存仅支持原版，请使用标准运行。");
  const steps = v.steps === undefined ? samplingSteps({mode:v.mode as StoredMode}) : v.steps;
  if (typeof steps !== "number" || !Number.isSafeInteger(steps) || steps < 1 || steps > MODEL_LIMITS.maxSteps) throw new Error(`原版采样支持 1–${MODEL_LIMITS.maxSteps} 步；默认 20 步，细节复杂的画面可增加至 50 步。`);
  if (config.turbo && !TURBO_STEPS.some(n => n === steps)) throw new Error("当前 Turbo 模型支持 4 或 8 步，请选择其中一档；调整其他步数请切换原版。");
  if (!((typeof v.seed === "number" && Number.isSafeInteger(v.seed) && v.seed >= 0) || (typeof v.seed === "string" && /^\d{1,20}$/.test(v.seed)))) throw new Error(`随机种子须为 0–${MAX_SEED} 的整数。`);
  const seed = BigInt(v.seed);
  if (seed > BigInt(MAX_SEED)) throw new Error(`随机种子须为 0–${MAX_SEED} 的整数。`);
  return { prompt: v.prompt.trim(), mode, width: Number(v.width), height: Number(v.height), duration: v.duration, seed: seed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(seed) : seed.toString(), steps, ...(v.runtimeProfile ? {runtimeProfile:v.runtimeProfile as "standard"|"eager"|"cached"|"ck"|"fp16"} : {}) };
}
export function frameCount(seconds: number) { const n = Math.max(5, Math.round(seconds * 24)); return n + (5 - n % 17 + 17) % 17; }
