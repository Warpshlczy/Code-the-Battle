/**
 * Immutable engine rules. Players cannot change any value in this file at runtime;
 * the analyzer and sandbox both read from it.
 *
 * Only the mechanics listed here exist. Nothing else is part of the game.
 */

export const ENGINE_VERSION = '3.0.0';

export type Scope = 'card' | 'script' | 'both';
export type ArgType = 'int' | 'str' | 'unit' | 'target' | 'pile' | 'bool' | 'cardlist' | 'intlist';

export interface ApiArg {
  name: string;
  type: ArgType;
  optional?: boolean;
  enum?: readonly string[];
}

export type ApiCategory =
  | 'damage'
  | 'block'
  | 'heal'
  | 'energy'
  | 'draw'
  | 'discard'
  | 'pile'
  | 'register'
  | 'random'
  | 'play'
  | 'read'
  | 'log';

export type NegativeKind = 'self_damage' | 'discard' | 'energy_loss';

export interface ApiSpec {
  name: string;
  scope: Scope;
  args: ApiArg[];
  ret: 'none' | 'int' | 'bool' | 'str' | 'cardlist' | 'intlist';
  cat: ApiCategory;
  /** Fixed complexity price plus per-unit price. */
  base: number;
  perUnit?: number;
  /** Argument index used as the magnitude for pricing. */
  amountArg?: number;
  /** Argument index holding an int list; its maximum length drives pricing. */
  listArg?: number;
  /** Fixed magnitude used when the price is driven by a pile capacity. */
  fixedMagnitude?: number;
  negative?: NegativeKind;
}

const PILES = ['draw', 'hand', 'discard'] as const;

/**
 * The complete API surface. Anything not on this list is rejected at compile time
 * and again at run time.
 */
export const API_SPECS: readonly ApiSpec[] = [
  { name: 'deal_damage', scope: 'both', args: [{ name: 'target', type: 'target' }, { name: 'amount', type: 'int' }], ret: 'int', cat: 'damage', base: 0.8, perUnit: 0.22, amountArg: 1 },
  { name: 'gain_block', scope: 'both', args: [{ name: 'amount', type: 'int' }], ret: 'none', cat: 'block', base: 0.6, perUnit: 0.2, amountArg: 0 },
  { name: 'heal', scope: 'both', args: [{ name: 'amount', type: 'int' }], ret: 'none', cat: 'heal', base: 0.7, perUnit: 0.3, amountArg: 0 },
  { name: 'gain_energy', scope: 'both', args: [{ name: 'amount', type: 'int' }], ret: 'none', cat: 'energy', base: 1.4, perUnit: 1.4, amountArg: 0 },
  { name: 'lose_energy', scope: 'both', args: [{ name: 'amount', type: 'int' }], ret: 'none', cat: 'energy', base: 0.5, perUnit: 1, amountArg: 0, negative: 'energy_loss' },
  { name: 'draw', scope: 'both', args: [{ name: 'count', type: 'int' }], ret: 'int', cat: 'draw', base: 0.6, perUnit: 0.5, amountArg: 0 },
  { name: 'discard', scope: 'both', args: [{ name: 'count', type: 'int' }], ret: 'int', cat: 'discard', base: 0.4, perUnit: 0.25, amountArg: 0, negative: 'discard' },
  { name: 'playcard', scope: 'script', args: [], ret: 'bool', cat: 'play', base: 0.9 },
  { name: 'swap', scope: 'both', args: [{ name: 'pile', type: 'pile' }, { name: 'i', type: 'int' }, { name: 'j', type: 'int' }], ret: 'none', cat: 'pile', base: 0.25 },
  { name: 'move_card', scope: 'both', args: [{ name: 'from', type: 'pile' }, { name: 'from_index', type: 'int' }, { name: 'to', type: 'pile' }, { name: 'to_index', type: 'int' }], ret: 'none', cat: 'pile', base: 0.35 },
  { name: 'shuffle', scope: 'both', args: [], ret: 'none', cat: 'pile', base: 0.5 },
  { name: 'reshuffle', scope: 'both', args: [], ret: 'int', cat: 'pile', base: 0.6 },
  { name: 'hand_size', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.03 },
  { name: 'draw_size', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.03 },
  { name: 'discard_size', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.03 },
  { name: 'getHand', scope: 'both', args: [], ret: 'cardlist', cat: 'read', base: 0.05 },
  { name: 'getDraw', scope: 'both', args: [], ret: 'cardlist', cat: 'read', base: 0.05 },
  { name: 'getDiscard', scope: 'both', args: [], ret: 'cardlist', cat: 'read', base: 0.05 },
  { name: 'getPile', scope: 'both', args: [{ name: 'pile', type: 'pile' }], ret: 'cardlist', cat: 'read', base: 0.05 },
  { name: 'pile_costs', scope: 'both', args: [{ name: 'pile', type: 'pile' }], ret: 'intlist', cat: 'read', base: 0.15, perUnit: 0.03, fixedMagnitude: 8 },
  { name: 'getTurn', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.05 },
  { name: 'getEnergy', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.05 },
  { name: 'getBlock', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.05 },
  { name: 'getMaxEnergy', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.05 },
  { name: 'getHandLimit', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.05 },
  { name: 'getDrawLimit', scope: 'both', args: [], ret: 'int', cat: 'read', base: 0.05 },
  { name: 'get_global', scope: 'both', args: [{ name: 'name', type: 'str' }], ret: 'str', cat: 'read', base: 0.1 },
  { name: 'set_global', scope: 'script', args: [{ name: 'name', type: 'str' }, { name: 'value', type: 'int' }], ret: 'none', cat: 'register', base: 0.5 },
  { name: 'random_int', scope: 'both', args: [{ name: 'min', type: 'int' }, { name: 'max', type: 'int' }], ret: 'int', cat: 'random', base: 0.5 },
  { name: 'log', scope: 'both', args: [{ name: 'message', type: 'str' }], ret: 'none', cat: 'log', base: 0.1 },
];

export const API_BY_NAME: ReadonlyMap<string, ApiSpec> = new Map(API_SPECS.map((a) => [a.name, a]));

/** Per-turn script budget. Card effects are paid with energy, not credits. */
export const CREDIT_BUDGET = 14;

/** Declared energy cost directly caps how much effect a card may contain. */
export const EFFECT_CAPS = [1.5, 2.4, 3.2, 4.2, 5.5, 6.4] as const;
export const EFFECT_CAP_MAX = 6.4;
export function effectCapForCost(cost: number): number {
  return EFFECT_CAPS[Math.max(0, Math.min(EFFECT_CAPS.length - 1, Math.floor(cost)))];
}

export interface CreditCost {
  base: number;
  perUnit?: number;
  /** Quadratic term: bigger effects get disproportionately more expensive. */
  quad?: number;
}

/**
 * Script API pricing, deliberately tiered:
 * combat/resources > draw/discard > scheduling > reads.
 */
export const CREDIT_COSTS: Record<string, CreditCost> = {
  deal_damage: { base: 4, perUnit: 1.2, quad: 0.12 },
  gain_block: { base: 5, perUnit: 1.5, quad: 0.25 },
  heal: { base: 4, perUnit: 2, quad: 0.2 },
  gain_energy: { base: 14, perUnit: 8 },
  lose_energy: { base: 1, perUnit: 0.8 },
  draw: { base: 1.5, perUnit: 0.9, quad: 0.04 },
  discard: { base: 1.2, perUnit: 0.7 },
  shuffle: { base: 1.2 },
  reshuffle: { base: 1.5 },
  random_int: { base: 2, perUnit: 0.4 },
  playcard: { base: 0.8 },
  swap: { base: 0.1 },
  move_card: { base: 0.25 },
  getHand: { base: 0.2, perUnit: 0.06 },
  getDraw: { base: 0.2, perUnit: 0.06 },
  getDiscard: { base: 0.2, perUnit: 0.06 },
  getPile: { base: 0.2, perUnit: 0.06 },
  hand_size: { base: 0.05, perUnit: 0.03 },
  draw_size: { base: 0.05, perUnit: 0.03 },
  discard_size: { base: 0.05, perUnit: 0.03 },
  pile_costs: { base: 0.15, perUnit: 0.04 },
  getTurn: { base: 0.1, perUnit: 0.03 },
  getEnergy: { base: 0.1, perUnit: 0.04 },
  getBlock: { base: 0.1, perUnit: 0.02 },
  getMaxEnergy: { base: 0.1, perUnit: 0.04 },
  getHandLimit: { base: 0.1, perUnit: 0.06 },
  getDrawLimit: { base: 0.1, perUnit: 0.06 },
  'enemy.hp': { base: 0.1, perUnit: 0.015 },
  'enemy.block': { base: 0.1, perUnit: 0.02 },
  get_global: { base: 0.15, perUnit: 0.05 },
  set_global: { base: 0.6 },
  log: { base: 0.2 },
};

export function creditCost(name: string, magnitude = 0): number {
  const spec = CREDIT_COSTS[name] ?? { base: 0.2 };
  const n = Math.max(0, magnitude);
  const value = spec.base + (spec.perUnit ?? 0) * n + (spec.quad ?? 0) * n * n;
  return Math.round(value * 10) / 10;
}

/** Code limits. Reaching one of them hard-stops the editor. */
export const CODE_LIMITS = {
  card: { label: '单卡 effect', maxLines: 20, maxComplexity: 80, maxHelpers: 3, helperLines: 30, helperComplexity: 120 },
  script: { label: '回合脚本', maxLines: 20, maxComplexity: 60, maxHelpers: 3, helperLines: 30, helperComplexity: 120 },
  maxLineChars: 200,
  maxList: 8,
  maxVars: 10,
  maxNesting: 4,
  maxLoopDepth: 2,
  maxLoopBound: 10,
  maxListWrites: 64,
  maxCallDepth: 3,
} as const;

export const LIMITS = {
  card: {
    minLines: 4,
    maxLines: CODE_LIMITS.card.maxLines,
    maxAst: CODE_LIMITS.card.maxComplexity,
    maxVars: CODE_LIMITS.maxVars,
    maxList: CODE_LIMITS.maxList,
    maxNesting: CODE_LIMITS.maxNesting,
    maxLoopDepth: CODE_LIMITS.maxLoopDepth,
    maxLoopBound: CODE_LIMITS.maxLoopBound,
    maxTotalIterations: 96,
    maxListWrites: CODE_LIMITS.maxListWrites,
    maxApi: 20,
    maxPileOps: 200,
    maxHelpers: CODE_LIMITS.card.maxHelpers,
    maxCallDepth: CODE_LIMITS.maxCallDepth,
    maxP: EFFECT_CAP_MAX,
    maxCost: 5,
    maxString: 64,
  },
  script: {
    minLines: 1,
    maxLines: CODE_LIMITS.script.maxLines,
    maxAst: CODE_LIMITS.script.maxComplexity,
    maxVars: CODE_LIMITS.maxVars,
    maxList: CODE_LIMITS.maxList,
    maxNesting: CODE_LIMITS.maxNesting,
    maxLoopDepth: CODE_LIMITS.maxLoopDepth,
    maxLoopBound: CODE_LIMITS.maxLoopBound,
    maxTotalIterations: 120,
    maxListWrites: CODE_LIMITS.maxListWrites,
    maxApi: 200,
    maxPileOps: 200,
    maxHelpers: CODE_LIMITS.script.maxHelpers,
    maxCallDepth: CODE_LIMITS.maxCallDepth,
    maxCU: 9999,
    execMs: 140,
  },
  deck: {
    minSize: 5,
    size: 10,
    maxSize: 10,
    hardMax: 10,
    drawCap: 10,
    handCap: 10,
    totalInstances: 10,
  },
} as const;

export const BUDGET = {
  listRead: 0.05,
  listWrite: 0.1,
  listItem: 0.03,
  // Repeated actions written as a compact loop are cheaper than spelling out
  // every statement; the bound still multiplies the body cost.
  loopFactor: 0.9,
  conditionFactor: 1.15,
  nestingFactor: 1.1,
  nestingCap: 2.0,
  rCap: 0.7,
  /** Expression tax: operators and variables make a value harder to reason about. */
  exprOp: 0.08,
  exprVar: 0.05,
  exprMul: 0.06,
  exprChain: 0.1,
  /** Maximum CU the abstract interpreter will expand before declaring the program unbounded. */
  analysisCeiling: 240,
  maxSafe: 9999,
} as const;

export const NEGATIVE_BASE = {
  self_damage: (amount: number) => 0.6 + 0.3 * amount,
  discard: (count: number) => 0.6 * count,
  energy_loss: (count: number) => 1.0 * count,
} as const;

export const PLAYER_MAX_HP = 100;
export const ENEMY_MAX_HP = 100;
export const ENERGY_PER_TURN = 5;
export const HAND_DRAW = 5;
export const MAX_TURNS = 30;

export const SANDBOX = {
  maxIterationsPerTurn: 220,
  maxLoopIterations: 32,
  maxListWritesPerTurn: CODE_LIMITS.maxListWrites,
  maxArrayList: CODE_LIMITS.maxList,
  maxStringLength: 64,
  maxNumber: 9999,
  execMs: 140,
} as const;

export const CARD_TYPES = ['attack', 'skill'] as const;
export const CARD_TARGETS = ['enemy', 'self', 'none'] as const;
export const PILE_NAMES = PILES;
