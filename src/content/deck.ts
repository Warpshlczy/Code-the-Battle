import { compileCard, type CardArt, type CompiledCard, type Diagnostic, type RegisterDecl } from '../engine/analyze';
import { deckWeight } from '../engine/battle';
import { LIMITS } from '../engine/config';
import type { Lang } from '../i18n';

export const DEFAULT_REGISTERS: RegisterDecl[] = [
  { name: 'combo', type: 'int', initial: 0, min: 0, max: 20 },
  { name: 'guard', type: 'bool', initial: false, min: 0, max: 1 },
  { name: 'mode', type: 'enum', initial: '默认', min: 0, max: 2, enumValues: ['默认', '强攻', '蛰伏'] },
];

/** English defaults used by the default (English) UI. */
export const DEFAULT_REGISTERS_EN: RegisterDecl[] = [
  { name: 'combo', type: 'int', initial: 0, min: 0, max: 20 },
  { name: 'guard', type: 'bool', initial: false, min: 0, max: 1 },
  { name: 'mode', type: 'enum', initial: 'idle', min: 0, max: 2, enumValues: ['idle', 'assault', 'hold'] },
];

export function defaultRegisters(lang: Lang): RegisterDecl[] {
  return (lang === 'en' ? DEFAULT_REGISTERS_EN : DEFAULT_REGISTERS).map((r) => ({
    ...r,
    enumValues: r.enumValues ? [...r.enumValues] : undefined,
  }));
}

export interface DeckSlot {
  id: string;
  source: string;
  /** Player-designed card face. Presentation only. */
  art?: CardArt;
}

export const DEFAULT_ART: CardArt = { frame: '#58d7ff', sigil: 'slash', ink: '#08222b' };

export const STARTER_CARDS: DeckSlot[] = [
  {
    id: 'direct',
    art: { frame: '#58d7ff', sigil: 'slash', ink: '#08222b' },
    source: `class DirectStrike(Card):
    name = "直击协议"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 7)  // 造成 7 点伤害
`,
  },
  {
    id: 'direct2',
    art: { frame: '#58d7ff', sigil: 'slash', ink: '#08222b' },
    source: `class DirectStrikeB(Card):
    name = "直击协议"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 7)  // 造成 7 点伤害
`,
  },
  {
    id: 'barrier',
    art: { frame: '#7ef0c0', sigil: 'shield', ink: '#072620' },
    source: `class BarrierProtocol(Card):
    name = "屏障协议"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(8)  // 获得 8 点格挡，下个自己回合开始清零
`,
  },
  {
    id: 'twin',
    art: { frame: '#ffb45c', sigil: 'arc', ink: '#2a1707' },
    source: `class TwinPulse(Card):
    name = "二连脉冲"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 3)  // 两段各 3 点伤害
        ctx.deal_damage("enemy", 3)
`,
  },
  {
    id: 'twin2',
    art: { frame: '#ffb45c', sigil: 'arc', ink: '#2a1707' },
    source: `class TwinPulseB(Card):
    name = "二连脉冲"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 3)  // 两段各 3 点伤害
        ctx.deal_damage("enemy", 3)
`,
  },
  {
    id: 'patch',
    art: { frame: '#a7ff8f', sigil: 'cross', ink: '#0d2408' },
    source: `class Patch(Card):
    name = "应急修复"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.heal(5)  // 恢复 5 点生命
`,
  },
  {
    id: 'siphon',
    art: { frame: '#9db4ff', sigil: 'node', ink: '#0b1230' },
    source: `class DataSiphon(Card):
    name = "数据抽取"
    cost = 1
    type = "skill"
    target = "none"

    def effect(self, ctx):
        ctx.draw(2)  // 抽 2 张牌
`,
  },
  {
    id: 'overload',
    art: { frame: '#ff7a8a', sigil: 'slash', ink: '#2b0710' },
    source: `class OverloadSlash(Card):
    name = "过载斩"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 8)  // 造成 8 点伤害
        ctx.deal_damage("self", 2)   // 自伤 2 点，抵扣部分效果
`,
  },
  {
    id: 'shift',
    art: { frame: '#c9a4ff', sigil: 'wave', ink: '#1b0b2c' },
    source: `class Shift(Card):
    name = "调度"
    cost = 1
    type = "skill"
    target = "none"

    def effect(self, ctx):
        ctx.swap("hand", 0, 1)  // 交换手牌第 1、2 张
`,
  },
  {
    id: 'spark',
    art: { frame: '#ffe27a', sigil: 'arc', ink: '#2a2307' },
    source: `class Spark(Card):
    name = "微光脉冲"
    cost = 0
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 2)  // 0 费：效果上限 1.5
`,
  },
];

/** Same deck, English card faces. Used by the default English UI. */
export const STARTER_CARDS_EN: DeckSlot[] = [
  {
    id: 'direct',
    art: { frame: '#58d7ff', sigil: 'slash', ink: '#08222b' },
    source: `class DirectStrike(Card):
    name = "Direct Strike"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 7)  // Deal 7 damage
`,
  },
  {
    id: 'direct2',
    art: { frame: '#58d7ff', sigil: 'slash', ink: '#08222b' },
    source: `class DirectStrikeB(Card):
    name = "Direct Strike"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 7)  // Deal 7 damage
`,
  },
  {
    id: 'barrier',
    art: { frame: '#7ef0c0', sigil: 'shield', ink: '#072620' },
    source: `class BarrierProtocol(Card):
    name = "Barrier Protocol"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(8)  // Gain 8 Block; it expires at the start of your next turn
`,
  },
  {
    id: 'twin',
    art: { frame: '#ffb45c', sigil: 'arc', ink: '#2a1707' },
    source: `class TwinPulse(Card):
    name = "Twin Pulse"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 3)  // Two hits of 3 damage
        ctx.deal_damage("enemy", 3)
`,
  },
  {
    id: 'twin2',
    art: { frame: '#ffb45c', sigil: 'arc', ink: '#2a1707' },
    source: `class TwinPulseB(Card):
    name = "Twin Pulse"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 3)  // Two hits of 3 damage
        ctx.deal_damage("enemy", 3)
`,
  },
  {
    id: 'patch',
    art: { frame: '#a7ff8f', sigil: 'cross', ink: '#0d2408' },
    source: `class Patch(Card):
    name = "Emergency Patch"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.heal(5)  // Restore 5 HP
`,
  },
  {
    id: 'siphon',
    art: { frame: '#9db4ff', sigil: 'node', ink: '#0b1230' },
    source: `class DataSiphon(Card):
    name = "Data Siphon"
    cost = 1
    type = "skill"
    target = "none"

    def effect(self, ctx):
        ctx.draw(2)  // Draw 2 cards
`,
  },
  {
    id: 'overload',
    art: { frame: '#ff7a8a', sigil: 'slash', ink: '#2b0710' },
    source: `class OverloadSlash(Card):
    name = "Overload Slash"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 8)  // Deal 8 damage
        ctx.deal_damage("self", 2)   // Take 2 self-damage; it discounts the effect
`,
  },
  {
    id: 'shift',
    art: { frame: '#c9a4ff', sigil: 'wave', ink: '#1b0b2c' },
    source: `class Shift(Card):
    name = "Reorder"
    cost = 1
    type = "skill"
    target = "none"

    def effect(self, ctx):
        ctx.swap("hand", 0, 1)  // Swap hand slots 1 and 2
`,
  },
  {
    id: 'spark',
    art: { frame: '#ffe27a', sigil: 'arc', ink: '#2a2307' },
    source: `class Spark(Card):
    name = "Glimmer Pulse"
    cost = 0
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 2)  // 0 cost: effect cap is 1.5
`,
  },
];

export function starterCards(lang: Lang): DeckSlot[] {
  return (lang === 'en' ? STARTER_CARDS_EN : STARTER_CARDS).map((s) => ({ ...s, art: s.art ? { ...s.art } : undefined }));
}

function normalizedSource(source: string): string {
  return source.replace(/\r\n/g, '\n').trim();
}

/**
 * Swaps untouched starter cards to the other language. Custom cards, and cards
 * the player edited, are left exactly as they are.
 */
export function localizeStarterSlots(slots: DeckSlot[], lang: Lang): DeckSlot[] {
  const targetDeck = lang === 'en' ? STARTER_CARDS_EN : STARTER_CARDS;
  const sourceDeck = lang === 'en' ? STARTER_CARDS : STARTER_CARDS_EN;
  const bySource = new Map(sourceDeck.map((s) => [normalizedSource(s.source), s]));
  const targetById = new Map(targetDeck.map((s) => [s.id, s]));
  return slots.map((slot) => {
    const match = bySource.get(normalizedSource(slot.source));
    if (!match) return slot;
    const replacement = targetById.get(match.id);
    if (!replacement) return slot;
    return { ...replacement, id: slot.id, art: slot.art ?? replacement.art };
  });
}

/** Nine lines, no loop: play the leftmost cards and commit one register. */
export const STARTER_SCRIPT = `ctx.playcard()
ctx.playcard()
ctx.playcard()
ctx.playcard()
ctx.set_global("combo", min(ctx.get_global("combo") + 1, 20))
`;

/** One bubble pass: push the expensive cards to the left so the big hits land first. */
export const MANUAL_SORT_SCRIPT = `costs = ctx.pile_costs("hand")
for i in range(1, 4):
    if costs[i] > costs[i - 1]:
        ctx.swap("hand", i - 1, i)
ctx.playcard()
ctx.playcard()
ctx.playcard()
`;

/** One execution chunk. Ending the turn is a separate button. */
export const MINIMAL_SCRIPT = `ctx.playcard()
`;

export const AI_CARD_SOURCES: DeckSlot[] = [
  {
    id: 'exec',
    source: `class ExecutionSlash(Card):
    name = "处决斩"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6)  // 6 点伤害
`,
  },
  {
    id: 'exec2',
    source: `class ExecutionSlashB(Card):
    name = "处决斩"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6)  // 6 点伤害
`,
  },
  {
    id: 'wall',
    source: `class PhaseWall(Card):
    name = "相位壁垒"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(6)  // 6 点格挡
`,
  },
  {
    id: 'wall2',
    source: `class PhaseWallB(Card):
    name = "相位壁垒"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(6)  // 6 点格挡
`,
  },
  {
    id: 'pulse',
    source: `class OverloadPulse(Card):
    name = "过载脉冲"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 4)  // 两段 4 + 3 点伤害
        ctx.deal_damage("enemy", 3)
`,
  },
  {
    id: 'rebuild',
    source: `class Rebuild(Card):
    name = "重构协议"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.heal(3)  // 恢复 3 点生命
`,
  },
  {
    id: 'breakline',
    source: `class BreakLine(Card):
    name = "断链击"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6)  // 6 点伤害
`,
  },
];

export const AI_CARD_SOURCES_EN: DeckSlot[] = [
  {
    id: 'exec',
    source: `class ExecutionSlash(Card):
    name = "Execution Slash"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6)  // 6 damage
`,
  },
  {
    id: 'exec2',
    source: `class ExecutionSlashB(Card):
    name = "Execution Slash"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6)  // 6 damage
`,
  },
  {
    id: 'wall',
    source: `class PhaseWall(Card):
    name = "Phase Wall"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(6)  // 6 Block
`,
  },
  {
    id: 'wall2',
    source: `class PhaseWallB(Card):
    name = "Phase Wall"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(6)  // 6 Block
`,
  },
  {
    id: 'pulse',
    source: `class OverloadPulse(Card):
    name = "Overload Pulse"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 4)  // Two hits: 4 + 3 damage
        ctx.deal_damage("enemy", 3)
`,
  },
  {
    id: 'rebuild',
    source: `class Rebuild(Card):
    name = "Rebuild Protocol"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.heal(3)  // Restore 3 HP
`,
  },
  {
    id: 'breakline',
    source: `class BreakLine(Card):
    name = "Break Line"
    cost = 2
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6)  // 6 damage
`,
  },
];

export interface CompiledDeck {
  cards: CompiledCard[];
  diagnostics: Diagnostic[];
  ok: boolean;
  budget: number;
}

export function compileSources(sources: DeckSlot[], registers: RegisterDecl[]): CompiledDeck {
  const cards: CompiledCard[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const slot of sources) {
    const res = compileCard(slot.source, registers);
    diagnostics.push(...res.diagnostics);
    if (res.value) {
      res.value.art = slot.art ?? DEFAULT_ART;
      cards.push(res.value);
    }
  }
  const budget = cards.reduce((sum, c) => sum + c.cost, 0);
  return {
    cards,
    diagnostics,
    ok: diagnostics.every((d) => d.severity !== 'error') && cards.length > 0,
    budget: Math.round(budget * 10) / 10,
  };
}

const aiCache = new Map<Lang, CompiledCard[]>();
export function compileAiDeck(lang: Lang = 'zh'): CompiledCard[] {
  const cached = aiCache.get(lang);
  if (cached) return cached;
  const sources = lang === 'en' ? AI_CARD_SOURCES_EN : AI_CARD_SOURCES;
  const res = compileSources(sources, []);
  if (!res.ok) {
    const msgs = res.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.line}: ${d.message}`).join('\n');
    throw new Error(`AI deck compile failed:\n${msgs}`);
  }
  aiCache.set(lang, res.cards);
  return res.cards;
}

export function aiDeckBudget(lang: Lang = 'zh'): number {
  return deckWeight(compileAiDeck(lang));
}

export const DECK_LIMITS = LIMITS.deck;
