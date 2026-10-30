import { describe, expect, it } from 'vitest';
import type { VisualCue } from '../src/ui/visual';
import {
  CARD_H,
  CARD_W,
  cameraPreset,
  handSlot,
  idleMotion,
  pileSlot,
  spreadSlot,
  stageSlot,
} from '../src/table/layout';
import { CUE_MS, cueDuration, nextSpeed, speedLabel } from '../src/table/timeline';

const cue = (kind: VisualCue['kind'], extra: Partial<VisualCue> = {}): VisualCue => ({
  id: 1,
  kind,
  label: kind,
  ...extra,
});

describe('tabletop presentation math', () => {
  it('keeps the default slow pacing and speeds up on demand', () => {
    const cast = cue('cast');
    expect(cueDuration(cast, 1)).toBe(CUE_MS.cast);
    expect(cueDuration(cast, 2)).toBe(CUE_MS.cast / 2);
    expect(cueDuration(cast, 3)).toBeLessThan(cueDuration(cast, 1));
    expect(cueDuration(cast, 0)).toBe(CUE_MS.cast);
    expect(CUE_MS.cast).toBeGreaterThanOrEqual(1200);
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(3);
    expect(nextSpeed(3)).toBe(1);
    expect(speedLabel(1)).toContain('慢');
  });

  it('lays out a fan of cards with a clear leftmost card', () => {
    const left = handSlot(0, 5);
    const middle = handSlot(2, 5);
    const right = handSlot(4, 5);
    expect(left.x).toBeLessThan(middle.x);
    expect(middle.x).toBeLessThan(right.x);
    expect(left.z).toBeGreaterThan(middle.z);
    expect(left.y).toBeGreaterThan(0);
    for (const slot of [left, middle, right]) {
      expect(Number.isFinite(slot.rx)).toBe(true);
      expect(slot.rx).toBeLessThan(0);
      expect(Math.abs(slot.x)).toBeLessThanOrEqual(2.5);
    }
  });

  it('caps visible pile meshes and keeps both sides visible', () => {
    const a = pileSlot('player-draw', 0, 20);
    const b = pileSlot('player-draw', 7, 20);
    const capped = pileSlot('player-draw', 12, 20);
    expect(b.y).toBeGreaterThan(a.y);
    expect(capped.y).toBe(b.y);
    expect(a.x).toBeLessThan(0);
    expect(pileSlot('player-discard', 1, 3).x).toBeGreaterThan(0);
  });

  it('spreads piles into a readable row', () => {
    const first = spreadSlot('player-discard', 0, 4);
    const last = spreadSlot('player-discard', 3, 4);
    expect(first.z).toBeGreaterThan(-1);
    expect(first.y).toBeLessThan(1);
    expect(last.x).toBeGreaterThan(first.x);
    expect(CARD_W).toBeLessThan(1);
    expect(CARD_H).toBeGreaterThan(CARD_W);
  });

  it('pulls the camera back on portrait viewports', () => {
    const wide = cameraPreset('overview', 1.7);
    const portrait = cameraPreset('overview', 0.5);
    expect(portrait.position[2]).toBeGreaterThan(wide.position[2]);
    expect(portrait.fov).toBeGreaterThan(wide.fov);
    expect(cameraPreset('hand', 1.7).target[2]).toBeGreaterThan(cameraPreset('overview', 1.7).target[2]);
  });

  it('produces idle motion and separate stage slots for both sides', () => {
    const t0 = idleMotion(0, 'player');
    const t1 = idleMotion(1.2, 'player');
    expect(t0.y).not.toBe(t1.y);
    expect(t0.flicker).toBeGreaterThan(0.5);
    expect(t0.flicker).toBeLessThanOrEqual(1);
    const player = stageSlot('player');
    const enemy = stageSlot('enemy');
    expect(player.x).toBeLessThan(0);
    expect(enemy.x).toBeGreaterThan(0);
    expect(player.y).toBeGreaterThan(1);
  });
});
