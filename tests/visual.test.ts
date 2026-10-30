import { describe, expect, it } from 'vitest';
import { compileCard, compileScript } from '../src/engine/analyze';
import { DEFAULT_ART, DEFAULT_REGISTERS, STARTER_CARDS, STARTER_SCRIPT, compileAiDeck, compileSources } from '../src/content/deck';
import { Battle } from '../src/engine/battle';
import { VisualSession } from '../src/ui/visual';

const BLOCK_CARD = `class Wall(Card):
    name = "墙体"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(9)  // 获得 9 点格挡
`;

describe('visual session', () => {
  it('replays battle events into the same public pile and resource state', async () => {
    const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
    const script = compileScript(STARTER_SCRIPT, DEFAULT_REGISTERS).value!;
    const battle = new Battle({ seed: 9, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
    const before = battle.getState();
    const result = await battle.submitPlayerTurn(script);
    const visual = new VisualSession(before, result.state);
    const cues = result.events.map((e) => visual.apply(e)).filter(Boolean);
    const view = visual.snapshot();
    expect(cues.length).toBeGreaterThan(0);
    expect(view.player.hp).toBe(result.state.player.hp);
    expect(view.enemy.hp).toBe(result.state.enemy.hp);
    expect(view.player.energy).toBe(result.state.player.energy);
    expect(view.player.hand.map((c) => c.name)).toEqual(result.state.player.hand.map((c) => c.name));
    expect(view.player.draw.map((c) => c.name)).toEqual(result.state.player.draw.map((c) => c.name));
    expect(view.player.discard.map((c) => c.name)).toEqual(result.state.player.discard.map((c) => c.name));
    expect(view.enemy.handCount).toBe(result.state.enemy.handCount);
    expect(view.player.discardCount).toBe(result.state.player.discardCount);
    expect(view.player.block).toBe(result.state.player.block);
  });

  it('emits a shield cue on block, a hit cue that consumes block, and an expire cue at turn start', async () => {
    const card = compileCard(BLOCK_CARD, DEFAULT_REGISTERS).value!;
    const battle = new Battle({
      seed: 11,
      playerDeck: [card, card, card],
      registers: DEFAULT_REGISTERS,
      aiDeck: compileAiDeck(),
      aiMode: 'heuristic',
    });
    const before = battle.getState();
    const first = await battle.executePlayerScript(compileScript('ctx.playcard()\nctx.playcard()', DEFAULT_REGISTERS).value!);
    const visual = new VisualSession(before, first.state);
    const cues = first.events.map((e) => visual.apply(e)).filter((c): c is NonNullable<typeof c> => !!c);
    expect(cues.some((c) => c.kind === 'block' && (c.amount ?? 0) > 0)).toBe(true);
    const result = await battle.endPlayerTurn();
    const later = new VisualSession(visual.snapshot(), result.state);
    const nextCues = result.events.map((e) => later.apply(e)).filter((c): c is NonNullable<typeof c> => !!c);
    expect(nextCues.some((c) => c.kind === 'expire')).toBe(true);
    const view = later.snapshot();
    expect(view.player.block).toBe(result.state.player.block);
  });

  it('emits phase cues for the enemy turn and the next player turn', async () => {
    const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
    const battle = new Battle({ seed: 21, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
    const before = battle.getState();
    const result = await battle.submitPlayerTurn(compileScript(STARTER_SCRIPT, DEFAULT_REGISTERS).value!);
    const visual = new VisualSession(before, result.state);
    const phases = result.events
      .map((e) => visual.apply(e))
      .filter((c): c is NonNullable<typeof c> => !!c && c.kind === 'phase');
    expect(phases.some((c) => c.phaseSide === 'enemy')).toBe(true);
    expect(phases.some((c) => c.phaseSide === 'player')).toBe(true);
    expect(phases.every((c) => typeof c.turn === 'number' && typeof c.energy === 'number')).toBe(true);
  });

  it('keeps the exact played copy face when card names repeat', async () => {
    const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
    deck.forEach((card, i) => {
      card.art = { ...DEFAULT_ART, frame: i === 0 ? '#ff2f7d' : '#58d7ff', sigil: i === 0 ? 'cross' : 'slash' };
    });
    const battle = new Battle({ seed: 1, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
    const before = battle.getState();
    const result = await battle.executePlayerScript(compileScript('ctx.playcard()', DEFAULT_REGISTERS).value!);
    const playEvent = result.events.find((e) => e.type === 'card_play');
    const uid = (playEvent?.data as { uid?: string } | undefined)?.uid;
    const expected = before.player.hand.find((c) => c.uid === uid)?.art?.frame;
    const visual = new VisualSession(before, result.state);
    const cast = result.events.map((e) => visual.apply(e)).find((c) => c?.kind === 'cast');
    expect(cast?.card?.art?.frame).toBe(expected);
  });

  it('keeps the exact face of a drawn copy when names repeat', async () => {
    const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
    deck.forEach((card, i) => {
      card.art = { ...DEFAULT_ART, frame: i === 0 ? '#ff2f7d' : '#58d7ff', sigil: i === 0 ? 'cross' : 'slash' };
    });
    const battle = new Battle({ seed: 6, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
    const before = battle.getState();
    const result = await battle.executePlayerScript(compileScript('ctx.draw(1)', DEFAULT_REGISTERS).value!);
    const expected = before.player.draw[0]?.art?.frame;
    const visual = new VisualSession(before, result.state);
    const draw = result.events.map((e) => visual.apply(e)).find((c) => c?.kind === 'draw' && c.side === 'player');
    expect(draw?.cards?.[0]?.art?.frame).toBe(expected);
  });

  it('moves the whole hand into the discard pile with a discard cue', async () => {
    const deck = compileSources(STARTER_CARDS, DEFAULT_REGISTERS).cards;
    const battle = new Battle({ seed: 3, playerDeck: deck, registers: DEFAULT_REGISTERS, aiDeck: compileAiDeck(), aiMode: 'heuristic' });
    const before = battle.getState();
    const result = await battle.submitPlayerTurn(compileScript('ctx.log("hold")', DEFAULT_REGISTERS).value!);
    const visual = new VisualSession(before, result.state);
    const cues = result.events.map((e) => visual.apply(e)).filter((c): c is NonNullable<typeof c> => !!c);
    const mass = cues.find((c) => c.kind === 'discard' && c.message?.includes('剩余手牌'));
    expect(mass).toBeTruthy();
    expect((mass?.cards?.length ?? 0) > 0).toBe(true);
    const view = visual.snapshot();
    expect(view.player.hand.map((c) => c.name)).toEqual(result.state.player.hand.map((c) => c.name));
    expect(view.player.discard.map((c) => c.name)).toEqual(result.state.player.discard.map((c) => c.name));
  });
});
