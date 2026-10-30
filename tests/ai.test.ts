import { describe, expect, it } from 'vitest';
import { buildAiPrompt, heuristicPlan, PERSONA_PROFILE, PERSONA_TEXT, type AiView, type AiPersona } from '../src/engine/ai';
import { PERSONAS } from '../src/engine/battle';

function view(persona: AiPersona): AiView {
  return {
    turn: 3,
    self: {
      hp: 20,
      maxHp: 54,
      block: 0,
      energy: 3,
      hand: [
        { slot: 0, cost: 2, type: 'attack', target: 'enemy', api: ['deal_damage'] },
        { slot: 1, cost: 1, type: 'skill', target: 'enemy', api: ['discard', 'draw'] },
        { slot: 2, cost: 1, type: 'skill', target: 'self', api: ['gain_block'] },
      ],
      drawCount: 1,
      discardCount: 2,
    },
    opponent: { hp: 10, maxHp: 72, block: 0, handCount: 4, drawCount: 2, discardCount: 1 },
    persona,
    legalOps: ['play', 'discard', 'end'],
  };
}

describe('opponent contract', () => {
  it('ships exactly the five fixed personas', () => {
    expect(PERSONAS).toHaveLength(5);
    for (const p of PERSONAS) {
      expect(PERSONA_PROFILE[p].name).toContain('SENTINEL-07');
      expect(PERSONA_TEXT[p].length).toBeGreaterThan(4);
    }
  });

  it('produces a feasible plan for every persona', () => {
    for (const persona of PERSONAS) {
      const plan = heuristicPlan(view(persona));
      expect(plan[plan.length - 1].op).toBe('end');
      expect(plan.length).toBeLessThanOrEqual(8);
      expect(plan.every((o) => ['play', 'discard', 'end'].includes(o.op))).toBe(true);
    }
  });

  it('never receives card names, descriptions, player code or hidden state', () => {
    const prompt = buildAiPrompt(view('aggressor'));
    expect(prompt).not.toContain('处决斩');
    expect(prompt).not.toContain('ctx.');
    expect(prompt).not.toContain('script');
    expect(prompt).toContain('卡牌名称与描述不会提供给你');
    expect(prompt).toContain('opponent_public');
  });

  it('cannot afford a card whose cost exceeds its energy', () => {
    const v = view('combo');
    v.self.energy = 1;
    v.self.hand = [{ slot: 0, cost: 3, type: 'attack', target: 'enemy', api: ['deal_damage'] }];
    const plan = heuristicPlan(v);
    expect(plan.some((o) => o.op === 'play')).toBe(false);
    expect(plan[plan.length - 1].op).toBe('end');
  });
});
