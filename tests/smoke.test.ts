import { describe, expect, it } from 'vitest';
import { compileScript } from '../src/engine/analyze';
import {
  AI_CARD_SOURCES,
  DEFAULT_REGISTERS,
  MANUAL_SORT_SCRIPT,
  STARTER_CARDS,
  STARTER_SCRIPT,
  compileAiDeck,
  compileSources,
} from '../src/content/deck';
import { Battle } from '../src/engine/battle';
import { buildReport, verifyReplay } from '../src/engine/report';

describe('content', () => {
  it('starter deck and AI deck compile within the spec limits', () => {
    const starter = compileSources(STARTER_CARDS, DEFAULT_REGISTERS);
    const errors = starter.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(starter.cards).toHaveLength(10);
    expect(starter.cards.every((c) => c.art)).toBe(true);
    expect(starter.cards.every((c) => c.description.length > 0)).toBe(true);

    const ai = compileAiDeck();
    expect(ai).toHaveLength(AI_CARD_SOURCES.length);
    expect(ai.every((c) => c.type === 'attack' || c.type === 'skill')).toBe(true);
    expect(ai.every((c) => c.target === 'enemy' || c.target === 'self' || c.target === 'none')).toBe(true);
  });

  it('starter and manual scripts compile', () => {
    for (const source of [STARTER_SCRIPT, MANUAL_SORT_SCRIPT]) {
      const res = compileScript(source, DEFAULT_REGISTERS);
      expect(res.ok).toBe(true);
      expect(res.value!.lines).toBeLessThanOrEqual(20);
      expect(res.value!.astNodes).toBeLessThanOrEqual(60);
    }
  });

  it('runs a full battle, builds a report and replays deterministically', async () => {
    const starter = compileSources(STARTER_CARDS, DEFAULT_REGISTERS);
    const script = compileScript(STARTER_SCRIPT, DEFAULT_REGISTERS);
    expect(starter.ok && script.ok).toBe(true);
    const battle = new Battle({
      seed: 12345,
      playerDeck: starter.cards,
      registers: DEFAULT_REGISTERS,
      aiDeck: compileAiDeck(),
      aiMode: 'heuristic',
    });
    while (!battle.result) {
      await battle.submitPlayerTurn(script.value!);
    }
    const report = buildReport(battle);
    expect(battle.log.length).toBeGreaterThan(10);
    expect(report.attribution.length).toBeGreaterThan(0);
    // set_global now commits immediately.
    expect(battle.log.some((e) => e.type === 'register_commit')).toBe(true);
    expect(battle.log.some((e) => e.type === 'pile' && (e.data as { handToDiscard?: boolean })?.handToDiscard)).toBe(true);
    expect(battle.log.some((e) => e.type.startsWith('status_'))).toBe(false);
    expect(battle.log.some((e) => e.type === 'block' || e.type === 'block_expire')).toBe(true);
    const replay = await verifyReplay(battle);
    expect(replay.ok).toBe(true);
  });

  it('carries the selected card face into battle', () => {
    const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
    deck[0].art = { frame: '#ff2f7d', sigil: 'cross', ink: '#2b0710' };
    const battle = new Battle({ seed: 5, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
    const all = [...battle.player.piles.hand, ...battle.player.piles.draw, ...battle.player.piles.discard];
    const painted = all.find((c) => c.uid === 'p0');
    expect(painted?.art?.frame).toBe('#ff2f7d');
    expect(painted?.art?.sigil).toBe('cross');
  });

  it('halts a command when a played card needs more energy and reports it', async () => {
    const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
    const battle = new Battle({ seed: 8, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
    battle.player.energy = 0;
    if (battle.player.piles.hand[0]) battle.player.piles.hand[0].cost = 2;
    const result = await battle.executePlayerScript(compileScript('ctx.playcard()', DEFAULT_REGISTERS).value!);
    expect(result.state.lastHalt?.label).toContain('能量不足');
  });

});
