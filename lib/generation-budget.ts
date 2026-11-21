import {defaultGenerationType} from './generation-inputs';
import {HYPERFLOW_10S_GENERATION_SECONDS,HYPERFLOW_10S_PRESET,hyperFlowDualT4Preset} from './hyperflow-config';
import { generationSteps, type GenerationParams } from './model-catalog';
import { frameCount, generationMode } from './parameters';

export type TimingRow = { params: string; metadata: string | null };
type Workload = { profile: string; mode: string; generationType: string; width: number; height: number; frames: number; steps: number };

function workload(p: GenerationParams): Workload {
  return {
    profile: p.runtimeProfile || 'standard',
    generationType: p.generationType || defaultGenerationType(p.category || 'video'),
    mode: p.category === 'image' ? 'image' : generationMode(p.mode),
    width: p.width,
    height: p.height,
    frames: p.category === 'image' ? 1 : frameCount(p.duration),
    steps: generationSteps(p),
  };
}

function seconds(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function createGenerationBudget(history: TimingRow[]) {
  const samples = history.flatMap(row => {
    try {
      const p = JSON.parse(row.params) as GenerationParams;
      const metadata = JSON.parse(row.metadata || '{}');
      const timing = metadata.timings || {};
      const work = workload(p);
      const generation = seconds(timing.generation_seconds);
      if (!generation || ![work.width,work.height,work.frames,work.steps].every(v => Number.isFinite(v) && v > 0)) return [];
      const setup = seconds(timing.setup_seconds) + seconds(timing.download_seconds) + seconds(timing.server_seconds) +
        seconds(timing.model_load_seconds) + seconds(timing.environment_seconds);
      const total = seconds(timing.total_seconds);
      const cold = metadata.server_reused === false || metadata.session_job_index === 0 || setup > 0;
      return [{
        work, cold,
        run: Math.max(generation, seconds(timing.job_seconds), cold ? 0 : total),
        setup: cold ? Math.max(setup, total - generation) : 0,
      }];
    } catch {
      return [];
    }
  });

  return (p: GenerationParams, cold: boolean) => {
    const target = workload(p);
    const comparable = samples.filter(({ work }) => work.mode === target.mode && work.profile === target.profile);
    const exact = comparable.filter(({ work }) =>
      work.generationType === target.generationType && work.width === target.width && work.height === target.height && work.frames === target.frames && work.steps === target.steps);
    const reference = exact.length ? exact : comparable;
    // 未实测的组合使用同模式历史的保守估算。完全没有参考记录时使用调度保留值。
    const fallback = p.category === 'video' ? 1_800 : 600;
    const run = reference.length ? Math.max(...reference.map(({ work, run }) =>
      run * Math.max(1, (target.width * target.height) / (work.width * work.height)) *
      Math.max(1, target.frames / work.frames) * Math.max(1, target.steps / work.steps))) : fallback;
    const setup = cold ? Math.max(300, ...samples.map(s => s.setup)) : 0;
    const long=hyperFlowDualT4Preset(p)===HYPERFLOW_10S_PRESET;
    const measured=long?(cold?HYPERFLOW_10S_PRESET.measuredTotalSeconds:HYPERFLOW_10S_GENERATION_SECONDS):0;
    return Math.ceil(Math.max(run+setup,measured)*1.25+120);
  };
}
