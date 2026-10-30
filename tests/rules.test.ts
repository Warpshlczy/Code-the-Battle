import { describe, expect, it } from 'vitest';
import { compileCard, compileScript, validateDeck, type CompiledCard } from '../src/engine/analyze';
import { CREDIT_BUDGET, LIMITS, effectCapForCost } from '../src/engine/config';
import { DEFAULT_REGISTERS, STARTER_CARDS, compileAiDeck, compileSources } from '../src/content/deck';
import { Battle } from '../src/engine/battle';

const REGS = DEFAULT_REGISTERS;

function cardSource(opts: { name?: string; cost?: number; type?: string; target?: string; body: string; comments?: string }): string {
  const comments = opts.comments ? `  // ${opts.comments}` : '';
  return `class Probe(Card):
    name = "${opts.name ?? '探针'}"
    cost = ${opts.cost ?? 1}
    type = "${opts.type ?? 'skill'}"
    target = "${opts.target ?? 'none'}"

    def effect(self, ctx):
${opts.body}
${comments}
`;
}

function compileProbe(body: string, extra: { cost?: number; name?: string; type?: string; target?: string; comments?: string } = {}): CompiledCard | null {
  const res = compileCard(cardSource({ body, ...extra }), REGS);
  return res.value ?? null;
}

function battleWith(cards: CompiledCard[]): Battle {
  return new Battle({ seed: 4242, playerDeck: cards, registers: REGS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
}

describe('compiler rules', () => {
  it('uses the declared cost to cap the effect instead of deriving a cost', () => {
    const small = compileProbe('        ctx.deal_damage("enemy", 3)');
    const heavy = compileProbe('        ctx.deal_damage("enemy", 12)', { cost: 2 });
    expect(small?.cost).toBe(1);
    expect(heavy?.cost).toBe(2);
    expect(effectCapForCost(0)).toBe(1.5);
    expect(effectCapForCost(1)).toBe(2.4);
    expect(effectCapForCost(4)).toBe(5.5);
    expect(effectCapForCost(9)).toBe(6.4);
    expect(small!.N).toBeLessThanOrEqual(effectCapForCost(1));
  });

  it('rejects an effect above the cost ceiling and points at the cap', () => {
    const res = compileCard(cardSource({ body: '        ctx.deal_damage("enemy", 20)' }), REGS);
    expect(res.ok).toBe(false);
    expect(res.diagnostics.some((d) => d.code === 'E_EFFECT_CAP')).toBe(true);
    const big = compileCard(cardSource({ cost: 5, body: '        ctx.gain_block(30)' }), REGS);
    expect(big.ok).toBe(false);
  });

  it('no longer enforces per-call numeric caps', () => {
    const huge = compileProbe('        ctx.gain_block(60)', { cost: 5 });
    expect(huge).toBeTruthy();
    const heal = compileProbe('        ctx.heal(40)', { cost: 5 });
    expect(heal).toBeTruthy();
  });

  it('only accepts attack/skill card types and the three targets', () => {
    const badType = compileCard(cardSource({ type: 'power', body: '        ctx.gain_block(3)' }), REGS);
    expect(badType.ok).toBe(false);
    const badTarget = compileCard(cardSource({ target: 'all_enemy', body: '        ctx.gain_block(3)' }), REGS);
    expect(badTarget.ok).toBe(false);
  });

  it('removed the status API and engine sorting helpers', () => {
    for (const body of [
      '        ctx.apply_status("enemy", "poison", 2)',
      '        ctx.sort_pile("hand", "cost", "asc")',
      '        ctx.apply_order("hand", [0])',
      '        ctx.add_card("hand", "fragment")',
    ]) {
      const res = compileCard(cardSource({ body }), REGS);
      expect(res.ok).toBe(false);
    }
  });

  it('turns // comments into the card description', () => {
    const card = compileProbe('        ctx.deal_damage("enemy", 4)', { comments: '造成 4 点伤害' });
    expect(card?.description).toBe('造成 4 点伤害');
  });

  it('hard-stops cards beyond 20 lines or 80 complexity', () => {
    const body = Array.from({ length: 18 }, () => '        ctx.log("x")').join('\n');
    const long = compileCard(cardSource({ body }), REGS);
    expect(long.ok).toBe(false);
    expect(long.diagnostics.some((d) => d.code === 'E_LINES')).toBe(true);

    const busy = Array.from({ length: 16 }, (_, i) => `        v${i} = ${i} * 3 + 1`).join('\n');
    const complex = compileCard(cardSource({ body: busy }), REGS);
    expect(complex.ok).toBe(false);
    expect(complex.diagnostics.some((d) => d.code === 'E_AST')).toBe(true);
  });

  it('rejects a 200+ character line', () => {
    const longComment = '// ' + 'x'.repeat(220);
    const res = compileCard(cardSource({ body: `        ctx.log("ok")  ${longComment}` }), REGS);
    expect(res.ok).toBe(false);
  });

  it('gives 0-cost cards a 1.5 ceiling and forbids energy gain', () => {
    const tooStrong = compileCard(cardSource({ cost: 0, body: '        ctx.deal_damage("enemy", 6)' }), REGS);
    expect(tooStrong.ok).toBe(false);
    expect(tooStrong.diagnostics.some((d) => d.code === 'E_EFFECT_CAP' || d.code === 'E_ZERO_COST')).toBe(true);
    const fine = compileCard(cardSource({ cost: 0, body: '        ctx.deal_damage("enemy", 2)' }), REGS);
    expect(fine.ok).toBe(true);
    expect(fine.value?.cost).toBe(0);
    const energy = compileCard(cardSource({ cost: 0, body: '        ctx.gain_energy(1)' }), REGS);
    expect(energy.ok).toBe(false);
  });

  it('weights expressions by their variables so chained arithmetic cannot hide power', () => {
    const simple = compileProbe('        ctx.deal_damage("enemy", 3 * 2)', { cost: 2 });
    const chained = compileProbe('        x = 2\n        y = 3\n        ctx.deal_damage("enemy", (x + y) * (x * y))', { cost: 3 });
    expect(simple).toBeTruthy();
    expect(chained).toBeTruthy();
    expect(chained!.P).toBeGreaterThan(simple!.P);
  });

  it('prices global runtime reads highest and custom registers next', () => {
    const globalRead = compileProbe('        x = ctx.getBlock()\n        ctx.log(str(x))', { cost: 4 });
    const registerRead = compileProbe('        x = ctx.get_global("combo")\n        ctx.log(str(x))', { cost: 3 });
    expect(globalRead).toBeTruthy();
    expect(registerRead).toBeTruthy();
    expect(globalRead!.P).toBeGreaterThan(registerRead!.P);
    expect(globalRead!.P).toBeGreaterThanOrEqual(2.4);
    expect(registerRead!.P).toBeGreaterThanOrEqual(1.4);
    const turnField = compileProbe('        ctx.log(str(ctx.turn.played_count))', { cost: 3 });
    expect(turnField).toBeTruthy();
    expect(turnField!.P).toBeGreaterThanOrEqual(1.0);
    const turn = compileProbe('        x = ctx.getTurn()\n        ctx.log(str(x))', { cost: 4 });
    expect(turn).toBeTruthy();
    expect(turn!.P).toBeGreaterThanOrEqual(2.4);
  });

  it('counts self-target damage as a negative and lowers the net effect', () => {
    const trade = compileProbe('        ctx.deal_damage("enemy", 6)\n        ctx.deal_damage("self", 2)', { cost: 2 });
    const clean = compileProbe('        ctx.deal_damage("enemy", 6)', { cost: 2 });
    expect(trade).toBeTruthy();
    expect(clean).toBeTruthy();
    expect(trade!.R).toBeGreaterThan(0);
    expect(trade!.N).toBeLessThan(trade!.P);
    expect(trade!.negatives.some((n) => n.kind === 'self_damage')).toBe(true);
  });

  it('accepts pile_costs + array writes + swap, and rejects oversized loops', () => {
    const ok = compileCard(
      cardSource({
        type: 'skill',
        cost: 5,
        body: `        costs = ctx.pile_costs("hand")
        for i in range(1, 5):
            if costs[i] < costs[i - 1]:
                ctx.swap("hand", i - 1, i)`,
      }),
      REGS,
    );
    expect(ok.ok).toBe(true);
    const tooLong = compileCard(
      cardSource({
        type: 'skill',
        body: `        for i in range(0, 30):
            ctx.log("x")`,
      }),
      REGS,
    );
    expect(tooLong.ok).toBe(false);
  });

  it('caps the deck at ten cards and drops the old budget and same-name rules', () => {
    const deck = compileSources(STARTER_CARDS, REGS);
    expect(validateDeck(deck.cards)).toHaveLength(0);
    expect(LIMITS.deck.maxSize).toBe(10);
    expect(LIMITS.deck.hardMax).toBe(10);
    const tooBig = [...deck.cards, deck.cards[0], deck.cards[1]];
    expect(validateDeck(tooBig).some((d) => d.code === 'E_DECK_SIZE')).toBe(true);
    const sameName = Array.from({ length: 4 }, () => deck.cards[0]);
    expect(validateDeck(sameName).some((d) => d.code === 'E_DECK_SAME')).toBe(false);
  });
});

describe('battle rules', () => {
  it('keeps block uncapped for the turn, then clears it at the next own turn', async () => {
    const card = compileProbe('        ctx.gain_block(10)', { type: 'skill' });
    expect(card).toBeTruthy();
    const battle = battleWith([card!]);
    const script = compileScript('ctx.playcard()', REGS);
    expect(script.ok).toBe(true);
    battle.player.block = 30;
    await battle.executePlayerScript(script.value!);
    const blockEvent = battle.log.find((e) => e.type === 'block' && (e.data as { block?: number })?.block === 40);
    expect(blockEvent).toBeTruthy();
    expect(battle.player.block).toBe(40);
    await battle.endPlayerTurn();
    expect(battle.player.block).toBe(0);
    expect(battle.log.some((e) => e.type === 'block_expire')).toBe(true);
  });

  it('heals without an extra per-turn or per-battle cap', async () => {
    const card = compileProbe('        ctx.heal(10)', { type: 'skill', cost: 2 });
    const battle = battleWith([card!, card!, card!]);
    battle.player.hp = 10;
    battle.player.energy = 20;
    const script = compileScript('ctx.playcard()\nctx.playcard()\nctx.playcard()', REGS);
    await battle.executePlayerScript(script.value!);
    const healed = battle.log
      .filter((e) => e.type === 'heal' && (e.data as { side?: string })?.side === 'player')
      .reduce((sum, e) => sum + Number((e.data as { healed?: number })?.healed ?? 0), 0);
    expect(healed).toBe(30);
  });

  it('allows multiple energy gains without a per-call cap', async () => {
    const card = compileProbe('        ctx.gain_energy(2)', { type: 'skill', cost: 2 });
    const battle = battleWith([card!, card!]);
    const script = compileScript('ctx.playcard()\nctx.playcard()', REGS);
    await battle.executePlayerScript(script.value!);
    const gained = battle.log.filter((e) => e.type === 'energy' && (e.data as { side?: string })?.side === 'player').reduce((sum, e) => sum + Number((e.data as { amount?: number })?.amount ?? 0), 0);
    expect(gained).toBe(4);
  });

  it('runs several script chunks inside one turn before an explicit skip', async () => {
    const deck = compileSources(STARTER_CARDS, REGS).cards;
    const battle = battleWith(deck);
    const chunk = compileScript('ctx.playcard()', REGS).value!;
    const first = await battle.executePlayerScript(chunk);
    expect(first.ended).toBe(false);
    expect(battle.phase).toBe('player');
    const energyAfterFirst = battle.player.energy;
    await battle.executePlayerScript(compileScript('ctx.playcard()', REGS).value!);
    expect(battle.player.energy).toBeLessThan(energyAfterFirst);
    const before = battle.turn;
    await battle.endPlayerTurn();
    expect(battle.turn).toBe(before + 1);
  });

  it('discards the whole hand at the end of the turn', async () => {
    const deck = compileSources(STARTER_CARDS, REGS).cards;
    const battle = battleWith(deck);
    const handBefore = battle.player.piles.hand.length;
    expect(handBefore).toBe(5);
    await battle.endPlayerTurn();
    expect(battle.log.some((e) => e.type === 'pile' && (e.data as { handToDiscard?: boolean })?.handToDiscard)).toBe(true);
    const playerTurnEnd = battle.log.find((e) => e.type === 'pile' && (e.data as { handToDiscard?: boolean })?.handToDiscard);
    expect(Number((playerTurnEnd?.data as { cards?: string[] })?.cards?.length ?? 0)).toBeGreaterThan(0);
  });

  it('locks a script before submit when its worst-case credits exceed the budget', () => {
    const over = compileScript('ctx.deal_damage("enemy", 10)\nctx.playcard()', REGS);
    expect(over.ok).toBe(false);
    expect(over.diagnostics.some((d) => d.code === 'E_CREDITS')).toBe(true);
    const fine = compileScript('ctx.deal_damage("enemy", 2)\nctx.playcard()', REGS);
    expect(fine.ok).toBe(true);
    expect(fine.value?.credits).toBeGreaterThan(4);
    expect(fine.value?.credits).toBeLessThan(CREDIT_BUDGET);
  });

  it('allows reading the opponent HP in a card and fixes its build cost at 6', () => {
    const res = compileCard(
      cardSource({
        cost: 5,
        type: 'skill',
        target: 'self',
        body: '        x = ctx.enemy.hp()\n        ctx.discard(0)',
      }),
      REGS,
    );
    expect(res.ok).toBe(true);
    expect(res.value?.P).toBeCloseTo(6.4, 5);
    expect(res.diagnostics.some((d) => d.code === 'E_SCOPE' || d.code === 'E_EMPTY')).toBe(false);
    const tooMuch = compileCard(
      cardSource({
        cost: 5,
        type: 'attack',
        target: 'enemy',
        body: '        if ctx.enemy.hp() < 90:\n            ctx.deal_damage("enemy", 2)',
      }),
      REGS,
    );
    expect(tooMuch.diagnostics.some((d) => d.code === 'E_EFFECT_CAP')).toBe(true);
  });

  it('prices a compact two-step loop below two repeated statements', () => {
    const direct = compileProbe('        ctx.deal_damage("enemy", 2)\n        ctx.deal_damage("enemy", 2)', { cost: 3 });
    const loop = compileProbe('        for i in range(2):\n            ctx.deal_damage("enemy", 2)', { cost: 3 });
    expect(direct).toBeTruthy();
    expect(loop).toBeTruthy();
    expect(loop!.P).toBeLessThan(direct!.P);
    const directScript = compileScript('ctx.deal_damage("enemy", 2)\nctx.deal_damage("enemy", 2)', REGS);
    const loopScript = compileScript('for i in range(2):\n    ctx.deal_damage("enemy", 2)', REGS);
    expect(directScript.ok).toBe(true);
    expect(loopScript.ok).toBe(true);
    expect(loopScript.value!.credits).toBeLessThan(directScript.value!.credits);
  });

  it('ends the battle by HP ratio at the turn cap', () => {
    const deck = compileSources(STARTER_CARDS, REGS).cards;
    const battle = battleWith(deck);
    battle.turn = 30;
    battle.player.hp = 40;
    battle.enemy.hp = 4;
    battle.startPlayerTurn();
    expect(battle.result).toBe('victory');
    expect(battle.log.some((e) => e.type === 'timeout')).toBe(true);
  });
});
