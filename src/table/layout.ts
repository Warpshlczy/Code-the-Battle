/**
 * Pure tabletop layout math. Kept free of Three.js so it can be unit tested in Node.
 * The board is arranged as two opposing sides: the player sits at +Z (bottom of the
 * screen), the opponent at -Z (top). Blue always means the player, red the opponent.
 */

export const TABLE_RADIUS = 5.2;
export const CARD_W = 0.86;
export const CARD_H = 1.24;
export const CARD_THICK = 0.012;

export interface Slot {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hand fans across the near edge, leftmost card slightly raised. */
export function handSlot(index: number, count: number): Slot {
  const n = Math.max(1, count);
  const t = n <= 1 ? 0.5 : index / (n - 1);
  const spread = Math.min(2.15, 0.35 + n * 0.28);
  const x = lerp(-spread, spread, t);
  // Keep the fan in front of the player standee (the camera sits at +Z), so cards stay readable.
  const z = 3.95 + 0.3 * Math.pow(2 * t - 1, 2);
  return {
    x,
    y: 0.46 + index * 0.002,
    z,
    rx: -Math.PI / 2 + 0.98,
    ry: (t - 0.5) * 0.34,
    rz: -(t - 0.5) * 0.3,
  };
}

export type Side = 'player' | 'enemy';
export type PileName = 'draw' | 'discard';
export type PileKey = `${Side}-${PileName}`;

/** Four always-visible trays: each side has a draw pile and a discard pile. */
export const PILE_ANCHOR: Record<PileKey, { x: number; z: number }> = {
  'player-draw': { x: -3.35, z: 1.95 },
  'player-discard': { x: 3.35, z: 1.95 },
  'enemy-draw': { x: -3.35, z: -1.95 },
  'enemy-discard': { x: 3.35, z: -1.95 },
};

export const PILE_KEYS: readonly PileKey[] = ['player-draw', 'player-discard', 'enemy-draw', 'enemy-discard'];

export function pileSide(key: PileKey): Side {
  return key.startsWith('player') ? 'player' : 'enemy';
}

export function pileType(key: PileKey): PileName {
  return key.endsWith('draw') ? 'draw' : 'discard';
}

export function pileKey(side: Side, pile: PileName): PileKey {
  return `${side}-${pile}`;
}

/** Stack offsets keep a visible thickness while capping the mesh count. */
export function pileSlot(pile: PileKey, index: number, total: number): Slot {
  const anchor = PILE_ANCHOR[pile];
  const visible = Math.min(total, 8);
  const capped = Math.min(index, Math.max(0, visible - 1));
  return {
    x: anchor.x + (capped - (visible - 1) / 2) * 0.24,
    y: CARD_THICK + capped * 0.012,
    z: anchor.z + capped * 0.008,
    rx: -Math.PI / 2,
    ry: (capped - (visible - 1) / 2) * 0.05,
    rz: 0,
  };
}

/** Laid-out row used when the player inspects their discard pile. */
export function spreadSlot(pile: PileKey, index: number, total: number): Slot {
  const n = Math.max(1, total);
  const t = n <= 1 ? 0.5 : index / (n - 1);
  const width = Math.min(5.2, n * 0.64);
  const zBase = pileSide(pile) === 'player' ? 2.15 : -2.15;
  return {
    x: lerp(-width / 2, width / 2, t),
    y: 0.62,
    z: zBase + (pileSide(pile) === 'player' ? 1 : -1) * Math.abs(2 * t - 1) * 0.18,
    rx: -Math.PI / 2 + 0.78,
    ry: (t - 0.5) * 0.12,
    rz: 0,
  };
}

/** Enemy hand is drawn as a small fan of card backs on the far edge. */
export function enemyHandSlot(index: number, count: number): Slot {
  const n = Math.max(1, count);
  const t = n <= 1 ? 0.5 : index / (n - 1);
  return {
    x: (t - 0.5) * 2.3,
    y: 0.46,
    z: -2.2 - 0.26 * Math.pow(2 * t - 1, 2),
    rx: -Math.PI / 2 + 0.98,
    ry: (t - 0.5) * 0.34,
    rz: (t - 0.5) * 0.3,
  };
}

/** Center stage where a played card is presented. */
export function stageSlot(side: Side): Slot {
  const dir = side === 'player' ? -1 : 1;
  return {
    x: dir * 0.55,
    y: 1.8,
    z: 0.95,
    rx: -0.28,
    ry: dir * 0.3,
    rz: dir * 0.05,
  };
}

export interface CameraPreset {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export type ViewName = 'overview' | 'player' | 'enemy' | 'hand' | 'draw' | 'discard' | 'enemy-discard';

/** Camera framing per view, adjusted for portrait viewports. */
export function cameraPreset(view: ViewName, aspect: number): CameraPreset {
  const portrait = aspect < 1;
  const base: Record<ViewName, CameraPreset> = {
    overview: { position: [0, 8.6, 10.4], target: [0, 0.35, 0.1], fov: 48 },
    player: { position: [-3.6, 3.4, 4.4], target: [-2.4, 1.2, 0.4], fov: 40 },
    enemy: { position: [3.6, 3.4, -4.4], target: [2.4, 1.2, -0.4], fov: 40 },
    hand: { position: [-0.2, 3.6, 8.8], target: [-0.3, 0.5, 2.8], fov: 42 },
    draw: { position: [0, 4.1, 7.8], target: [0, 0.65, 1.9], fov: 42 },
    discard: { position: [0, 4.1, 7.8], target: [0, 0.65, 1.9], fov: 42 },
    'enemy-discard': { position: [0, 5.2, 1.2], target: [0, 0.55, -1.9], fov: 46 },
  };
  const preset = base[view];
  if (!portrait) return preset;
  if (view === 'overview') {
    return {
      position: [0, 15.2, 19.6],
      target: [0, 0.15, 0.45],
      fov: 60,
    };
  }
  return {
    ...preset,
    position: [preset.position[0] * 0.7, preset.position[1] + 3.4, preset.position[2] + 6.2],
    fov: preset.fov + 14,
    target: [preset.target[0], Math.max(0.35, preset.target[1] - 0.2), preset.target[2] + 0.2],
  };
}

/** Idle breathing/sway offsets for a standee at a given time. */
export function idleMotion(time: number, side: Side): { y: number; sway: number; scale: number; flicker: number } {
  const phase = side === 'player' ? 0 : 1.7;
  const speed = side === 'player' ? 1 : 0.82;
  return {
    y: Math.sin(time * speed + phase) * 0.035,
    sway: Math.sin(time * speed * 0.6 + phase) * 0.022,
    scale: 1 + Math.sin(time * speed * 0.9 + phase) * 0.006,
    flicker: 0.86 + 0.14 * Math.abs(Math.sin(time * 3.1 + phase * 2)),
  };
}
