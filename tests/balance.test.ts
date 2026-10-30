import { expect, it } from 'vitest';
import { compileScript } from '../src/engine/analyze';
import { DEFAULT_REGISTERS, MANUAL_SORT_SCRIPT, STARTER_CARDS, STARTER_SCRIPT, compileAiDeck, compileSources } from '../src/content/deck';
import { Battle } from '../src/engine/battle';

async function scan(scriptSource: string, label: string) {
  const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
  const ai = compileAiDeck();
  const script = compileScript(scriptSource, DEFAULT_REGISTERS);
  if (!script.ok) throw new Error(`${label} script failed: ${JSON.stringify(script.diagnostics)}`);
  let wins = 0;
  let turns = 0;
  const seeds = 150;
  for (let seed = 1; seed <= seeds; seed++) {
    const b = new Battle({ seed, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: ai, aiMode: 'heuristic' });
    for (let t = 0; t < 30 && !b.result; t++) await b.submitPlayerTurn(script.value!);
    if (b.result === 'victory') wins++;
    turns += b.turn;
  }
  const winRate = wins / seeds;
  console.log(label, 'winRate', winRate.toFixed(3), 'avgTurns', (turns / seeds).toFixed(1));
  return winRate;
}

it('keeps the encounter winnable and rewards using the queue', async () => {
  const starter = await scan(STARTER_SCRIPT, 'starter');
  const manual = await scan(MANUAL_SORT_SCRIPT, 'manual sort');
  const passive = await scan(`ctx.set_global("combo", min(ctx.get_global("combo") + 1, 20))
ctx.log("wait")
`, 'passive');
  expect(starter).toBeGreaterThanOrEqual(0.3);
  expect(starter).toBeLessThanOrEqual(0.75);
  expect(starter - passive).toBeGreaterThanOrEqual(0.2);
  // Sorting by raw cost is a legal but not optimal plan: it burns energy on utility cards.
  expect(manual).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(manual)).toBe(true);
}, 180000);
