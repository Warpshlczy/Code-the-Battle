import { describe, expect, it } from 'vitest';
import { compileScript } from '../src/engine/analyze';
import { CREDIT_BUDGET, creditCost } from '../src/engine/config';
import { DEFAULT_REGISTERS, STARTER_CARDS, STARTER_SCRIPT, compileAiDeck, compileSources } from '../src/content/deck';
import { Battle } from '../src/engine/battle';

async function winRate(source: string, seeds = 150): Promise<number> {
  const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
  const script = compileScript(source, DEFAULT_REGISTERS);
  expect(script.ok).toBe(true);
  let wins = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const battle = new Battle({ seed, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
    for (let turn = 0; turn < 30 && !battle.result; turn++) await battle.submitPlayerTurn(script.value!);
    if (battle.result === 'victory') wins++;
  }
  return wins / seeds;
}

describe('credit economy', () => {
  it('prices combat and resources above card flow, and scheduling cheapest', () => {
    expect(creditCost('deal_damage', 5)).toBeGreaterThan(creditCost('draw', 2));
    expect(creditCost('gain_block', 5)).toBeGreaterThan(creditCost('discard', 2));
    expect(creditCost('draw', 2)).toBeGreaterThan(creditCost('playcard') * 3);
    expect(creditCost('swap') * 10).toBeLessThan(creditCost('deal_damage', 5));
    expect(creditCost('deal_damage', 10)).toBeGreaterThan(creditCost('deal_damage', 5) * 2);
    expect(CREDIT_BUDGET).toBeLessThanOrEqual(20);
  });

  it('rejects scripted energy gain and big direct damage before submit', () => {
    const energy = compileScript('ctx.gain_energy(1)\nctx.playcard()', DEFAULT_REGISTERS);
    expect(energy.ok).toBe(false);
    expect(energy.diagnostics.some((d) => d.code === 'E_CREDITS')).toBe(true);
    const big = compileScript('ctx.deal_damage("enemy", 8)', DEFAULT_REGISTERS);
    expect(big.ok).toBe(false);
  });

  it('keeps a naive three-card script competitive and pure API strategies losing', async () => {
    const starter = await winRate(STARTER_SCRIPT);
    const pureDamage = await winRate('ctx.deal_damage("enemy", 3)');
    const pureBlock = await winRate('ctx.gain_block(2)');
    const pureHeal = await winRate('ctx.heal(2)');
    expect(starter).toBeGreaterThanOrEqual(0.3);
    expect(starter).toBeLessThanOrEqual(0.65);
    expect(pureDamage).toBeLessThanOrEqual(0.1);
    expect(pureBlock).toBeLessThanOrEqual(0.1);
    expect(pureHeal).toBeLessThanOrEqual(0.1);
  }, 120000);
});
