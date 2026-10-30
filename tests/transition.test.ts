import { describe, expect, it } from 'vitest';
import { cardKeys, diffHand, handTargets, pileTargets } from '../src/table/transition';

describe('hand transition math', () => {
  it('keys duplicate names by occurrence so cue uids do not matter', () => {
    expect(cardKeys([{ name: '直击协议' }, { name: '屏障协议' }, { name: '直击协议' }])).toEqual([
      '直击协议#0',
      '屏障协议#0',
      '直击协议#1',
    ]);
  });

  it('uses uids when available so duplicate names can keep different faces', () => {
    expect(cardKeys([{ name: '直击协议', uid: 'p0' }, { name: '直击协议', uid: 'p2' }])).toEqual(['uid:p0', 'uid:p2']);
  });

  it('slides the remaining cards left after the leftmost is played', () => {
    const diff = diffHand(['A#0', 'B#0', 'C#0'], ['B#0', 'C#0']);
    expect(diff.removed).toEqual([{ key: 'A#0', index: 0 }]);
    expect(diff.added).toEqual([]);
    expect(diff.kept).toEqual([
      { key: 'B#0', from: 1, to: 0 },
      { key: 'C#0', from: 2, to: 1 },
    ]);
  });

  it('appends drawn cards to the right without disturbing the kept cards', () => {
    const diff = diffHand(['A#0', 'B#0'], ['A#0', 'B#0', 'C#0']);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([{ key: 'C#0', index: 2 }]);
    expect(diff.kept).toEqual([
      { key: 'A#0', from: 0, to: 0 },
      { key: 'B#0', from: 1, to: 1 },
    ]);
  });

  it('computes a fan whose leftmost slot is left of the rightmost', () => {
    const slots = handTargets(5);
    expect(slots).toHaveLength(5);
    expect(slots[0].x).toBeLessThan(slots[4].x);
    expect(slots[0].y).toBeGreaterThan(0);
    expect(pileTargets('player-draw', 12)).toHaveLength(8);
    expect(pileTargets('player-discard', 12)[0].x).toBeGreaterThan(0);
    expect(pileTargets('enemy-draw', 3)[0].z).toBeLessThan(0);
  });
});
