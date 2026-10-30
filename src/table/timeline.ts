import type { VisualCue } from '../ui/visual';
import type { ViewName } from './layout';
import type { Lang } from '../i18n';

/**
 * Pure presentation timeline. Visual timing never affects the engine, the log or the RNG.
 * The default is deliberately slow; the player can speed it up.
 */

export const SPEEDS = [1, 2, 3] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 1;
/** Baseline durations already include the slow cinematic pacing. */
export const CUE_MS: Record<VisualCue['kind'], number> = {
  cast: 1500,
  hit: 1250,
  block: 1000,
  heal: 1150,
  energy: 950,
  expire: 900,
  phase: 950,
  draw: 1300,
  discard: 1100,
  shuffle: 1650,
  arrange: 700,
  halt: 1600,
  ai: 900,
  register: 500,
  end: 1800,
  skip: 800,
};

export function cueDuration(cue: VisualCue, speed: number): number {
  const base = CUE_MS[cue.kind] ?? 1000;
  return Math.max(120, base / Math.max(1, speed));
}

export interface CueDirection {
  camera: ViewName;
  shake: number;
  /** 0..1 strength used for flashes and particles. */
  intensity: number;
}

export function cueDirection(cue: VisualCue): CueDirection {
  switch (cue.kind) {
    case 'hit':
      return { camera: 'overview', shake: cue.amount && cue.amount >= 6 ? 0.06 : 0.035, intensity: 1 };
    case 'block':
      return { camera: 'overview', shake: 0, intensity: 0.7 };
    case 'heal':
      return { camera: 'overview', shake: 0, intensity: 0.8 };
    case 'energy':
      return { camera: 'overview', shake: 0, intensity: 0.65 };
    case 'expire':
      return { camera: 'overview', shake: 0, intensity: 0.4 };
    case 'phase':
      return { camera: 'overview', shake: 0, intensity: 0.5 };
    case 'draw':
      return { camera: cue.side === 'enemy' ? 'overview' : 'draw', shake: 0, intensity: 0.6 };
    case 'discard':
      return { camera: cue.side === 'enemy' ? 'overview' : 'discard', shake: 0, intensity: 0.6 };
    case 'shuffle':
      return { camera: 'overview', shake: 0.015, intensity: 0.7 };
    case 'arrange':
      return { camera: 'overview', shake: 0, intensity: 0.35 };
    case 'cast':
      return { camera: 'overview', shake: 0, intensity: 0.85 };
    case 'halt':
      return { camera: 'overview', shake: 0.08, intensity: 1 };
    case 'end':
      return { camera: cue.side === 'player' ? 'enemy' : 'player', shake: 0.03, intensity: 0.9 };
    default:
      return { camera: 'overview', shake: 0, intensity: 0.5 };
  }
}

export function nextSpeed(current: number): Speed {
  const index = SPEEDS.indexOf(current as Speed);
  return SPEEDS[(index + 1) % SPEEDS.length];
}

export function speedLabel(speed: number, lang: Lang = 'zh'): string {
  if (speed > 1) return `×${speed}`;
  return lang === 'zh' ? '慢速' : 'Slow';
}
