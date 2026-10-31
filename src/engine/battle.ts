import {
  API_BY_NAME,
  CREDIT_BUDGET,
  ENERGY_PER_TURN,
  HAND_DRAW,
  LIMITS,
  MAX_TURNS,
  PLAYER_MAX_HP,
  ENEMY_MAX_HP,
  SANDBOX,
  creditCost,
  effectCapForCost,
} from './config';
import type { CompiledCard, CompiledScript, RegisterDecl } from './analyze';
import { Interpreter, SandboxHalt, SbList, TurnBudget, type Prim, type RV, type SandboxHost, type SbObj, type SourceRef } from './sandbox';
import { buildAiViewHistory, proposeAiPlan, heuristicPlan, type AiConfig, type AiDeckMeta, type AiMeta, type AiOp, type AiPersona, type AiPlan, type AiView } from './ai';
import { Rng } from './rng';

export type Side = 'player' | 'enemy';
export type BattleResult = 'victory' | 'defeat' | null;
export type Phase = 'player' | 'resolving' | 'enemy' | 'over';

export interface CardInstance {
  uid: string;
  name: string;
  description: string;
  cost: number;
  type: string;
  target: string;
  art?: CompiledCard['art'];
  compiled: CompiledCard | null;
  state: Record<string, number | boolean | string>;
  stateTypes: Map<string, 'int' | 'bool' | 'str'>;
}

export interface SidePiles {
  draw: CardInstance[];
  hand: CardInstance[];
  discard: CardInstance[];
}

interface TurnCounters {
  drawCalls: number;
  discardCalls: number;
  swapCalls: number;
  moveCalls: number;
  shuffleCalls: number;
  reshuffleCalls: number;
  randomCalls: number;
  energyGained: number;
  credits: number;
  healed: number;
  discarded: number;
  played: number;
}

interface UnitState {
  side: Side;
  hp: number;
  maxHp: number;
  block: number;
  energy: number;
  counters: TurnCounters;
  piles: SidePiles;
}

export interface LogEvent {
  seq: number;
  turn: number;
  actor: 'player' | 'enemy' | 'engine';
  type: string;
  message: string;
  source?: { kind: string; label: string; line: number; irId?: number };
  data?: Record<string, unknown>;
}

export interface PublicCard {
  uid: string;
  name: string;
  description: string;
  cost: number;
  type: string;
  target: string;
  art?: CompiledCard['art'];
  playable: boolean;
}

export interface PublicUnit {
  hp: number;
  maxHp: number;
  block: number;
  energy: number;
  creditsUsed: number;
  creditBudget: number;
  drawCount: number;
  discardCount: number;
  handCount: number;
  handLimit: number;
  drawLimit: number;
}

export interface PublicRegister {
  name: string;
  type: 'int' | 'bool' | 'enum';
  value: number | boolean | string;
  min: number;
  max: number;
  enumValues?: string[];
}

export interface TurnRecord {
  turn: number;
  actor: 'player' | 'enemy';
  sourceLabel: string;
  astNodes: number;
  p: number;
  apiCalls: number;
  pileOps: number;
  halted?: { reason: string; label: string; line: number; message: string };
  registerCommitted: boolean;
  cardsPlayed: string[];
  scriptSource?: string;
}

export interface PublicBattleState {
  turn: number;
  maxTurns: number;
  phase: Phase;
  result: BattleResult;
  seed: number;
  aiMode: 'heuristic' | 'llm' | 'recorded';
  persona: AiPersona;
  player: PublicUnit & { hand: PublicCard[]; draw: PublicCard[]; discard: PublicCard[]; maxEnergy: number };
  enemy: PublicUnit;
  registers: PublicRegister[];
  playerDeckBudget: number;
  aiDeckBudget: number;
  playerDeck: PublicCard[];
  aiDeck: PublicCard[];
  aiDeckMeta: AiDeckMeta;
  enemyDiscard: PublicCard[];
  lastHalt: TurnRecord['halted'] | null;
  turnRecords: TurnRecord[];
  aiMeta: AiMeta[];
  logCount: number;
}

export interface BattleOptions {
  seed: number;
  playerDeck: CompiledCard[];
  registers: RegisterDecl[];
  aiDeck: CompiledCard[];
  aiDeckMeta?: AiDeckMeta;
  aiMode: 'heuristic' | 'llm' | 'recorded';
  aiConfig?: AiConfig;
  recordedAiPlans?: AiOp[][];
  autoStart?: boolean;
}

export interface RoundResult {
  events: LogEvent[];
  state: PublicBattleState;
  ended: boolean;
  result: BattleResult;
}

interface PlayerScriptRuntime {
  script: CompiledScript;
  budget: TurnBudget;
  halted?: TurnRecord['halted'];
  apiCalls: number;
  pileOps: number;
  cardsPlayed: string[];
}

function freshCounters(): TurnCounters {
  return {
    drawCalls: 0,
    discardCalls: 0,
    swapCalls: 0,
    moveCalls: 0,
    shuffleCalls: 0,
    reshuffleCalls: 0,
    randomCalls: 0,
    energyGained: 0,
    credits: 0,
    healed: 0,
    discarded: 0,
    played: 0,
  };
}

export class Battle {
  readonly seed: number;
  readonly aiMode: 'heuristic' | 'llm' | 'recorded';
  readonly registers: RegisterDecl[];
  readonly playerDeck: CompiledCard[];
  readonly aiDeck: CompiledCard[];
  readonly aiDeckMeta: AiDeckMeta;
  readonly aiConfig?: AiConfig;
  readonly recordedAiPlans?: AiOp[][];

  turn = 0;
  phase: Phase = 'player';
  result: BattleResult = null;

  player: UnitState;
  enemy: UnitState;

  log: LogEvent[] = [];
  turnRecords: TurnRecord[] = [];
  aiMeta: AiMeta[] = [];

  private rng: Rng;
  private budget = new TurnBudget();
  private playerBudget = new TurnBudget();
  private registerValues = new Map<string, Prim>();
  private aiPlanIndex = 0;
  private executedAiPlans: AiOp[][] = [];
  private lastHalt: TurnRecord['halted'] | null = null;
  private persona: AiPersona;
  private scriptRuntime: PlayerScriptRuntime | null = null;

  constructor(opts: BattleOptions) {
    this.seed = opts.seed >>> 0;
    this.rng = new Rng(this.seed);
    this.registers = opts.registers;
    this.playerDeck = opts.playerDeck;
    this.aiDeck = opts.aiDeck;
    this.aiDeckMeta = opts.aiDeckMeta ?? { source: 'fixed' };
    this.aiMode = opts.aiMode;
    this.aiConfig = opts.aiConfig;
    this.recordedAiPlans = opts.recordedAiPlans;
    this.persona = personaForSeed(this.seed);
    for (const r of opts.registers) this.registerValues.set(r.name, r.initial);
    this.player = this.makeUnit('player', PLAYER_MAX_HP, opts.playerDeck, 'p');
    this.enemy = this.makeUnit('enemy', ENEMY_MAX_HP, opts.aiDeck, 'e');
    this.shuffleIntoDraw(this.player);
    this.shuffleIntoDraw(this.enemy);
    this.logEvent('battle_start', `战场接入 · 种子 ${this.seed}`, 'engine', undefined, {
      seed: this.seed,
      persona: this.persona,
      aiMode: this.aiMode,
      playerDeck: opts.playerDeck.map((c) => c.name),
      aiDeckSize: opts.aiDeck.length,
      playerBudget: deckWeight(opts.playerDeck),
      aiBudget: deckWeight(opts.aiDeck),
    });
    if (opts.autoStart !== false) this.startPlayerTurn();
  }

  private makeUnit(side: Side, maxHp: number, deck: CompiledCard[], prefix: string): UnitState {
    const piles: SidePiles = { draw: [], hand: [], discard: [] };
    deck.forEach((card, i) => {
      piles.draw.push({
        uid: `${prefix}${i}`,
        name: card.name,
        description: card.description,
        cost: card.cost,
        type: card.type,
        target: card.target,
        art: card.art,
        compiled: card,
        state: {},
        stateTypes: new Map(),
      });
    });
    return {
      side,
      hp: maxHp,
      maxHp,
      block: 0,
      energy: 0,
      counters: freshCounters(),
      piles,
    };
  }

  private shuffleIntoDraw(unit: UnitState): void {
    const all = [...unit.piles.draw, ...unit.piles.discard, ...unit.piles.hand];
    unit.piles.draw = this.rng.shuffle(all).slice(0, LIMITS.deck.drawCap);
    const overflow = this.rng.shuffle(all).slice(LIMITS.deck.drawCap);
    unit.piles.hand = [];
    unit.piles.discard = overflow;
    this.logEvent('shuffle', `${unit.side === 'player' ? '你' : 'SENTINEL'} 洗牌（种子 ${this.seed}）`, 'engine', undefined, unit.side === 'player'
      ? { side: unit.side, order: unit.piles.draw.map((c) => c.name) }
      : { side: unit.side, count: unit.piles.draw.length });
  }

  startPlayerTurn(): void {
    if (this.result) return;
    if (this.turn >= MAX_TURNS) {
      this.finishByTimeout();
      return;
    }
    this.turn += 1;
    this.phase = 'player';
    this.playerBudget = new TurnBudget();
    this.budget = this.playerBudget;
    this.lastHalt = null;
    this.logEvent('turn_start', `第 ${this.turn} 回合 · 轮到你`, 'engine');
    this.beginUnitTurn(this.player);
    this.refillHand(this.player);
    this.logEvent('phase', `手牌 ${this.player.piles.hand.length} · 能量 ${this.player.energy} · 格挡 ${this.player.block}`, 'engine', undefined, {
      hand: this.player.piles.hand.length,
      energy: this.player.energy,
      block: this.player.block,
    });
  }

  private beginUnitTurn(unit: UnitState): void {
    if (unit.block > 0) {
      this.logEvent('block_expire', `${unit.side === 'player' ? '你的' : 'SENTINEL 的'}格挡 ${unit.block} 在回合开始时消失`, 'engine', undefined, { side: unit.side, block: unit.block });
    }
    unit.block = 0;
    unit.energy = ENERGY_PER_TURN;
    unit.counters = freshCounters();
    this.logEvent('turn_start', `${unit.side === 'player' ? '你' : 'SENTINEL'} 回合开始 · 能量 ${unit.energy} · 格挡清零`, unit.side, undefined, {
      side: unit.side,
      energy: unit.energy,
    });
  }

  private refillHand(unit: UnitState): number {
    const before = unit.piles.hand.length;
    if (before >= HAND_DRAW) return 0;
    this.drawCards(unit, HAND_DRAW - before, false);
    return unit.piles.hand.length - before;
  }

  private drawCards(unit: UnitState, count: number, silent = false): number {
    const drawn: string[] = [];
    for (let i = 0; i < count; i++) {
      if (unit.piles.hand.length >= LIMITS.deck.handCap) break;
      if (unit.piles.draw.length === 0) {
        if (unit.piles.discard.length === 0) break;
        this.reshuffleInto(unit, true);
      }
      const card = unit.piles.draw.shift();
      if (!card) break;
      unit.piles.hand.push(card);
      drawn.push(card.name);
    }
    if (!silent && drawn.length > 0) {
      this.logEvent('draw', `${unit.side === 'player' ? '你' : 'SENTINEL'} 抽了 ${drawn.length} 张牌`, unit.side, undefined, unit.side === 'player'
        ? {
          side: unit.side,
          drawn: drawn.length,
          cards: drawn,
          order: unit.piles.draw.map((c) => c.name),
          discard: unit.piles.discard.map((c) => c.name),
        }
        : { side: unit.side, drawn: drawn.length });
    }
    return drawn.length;
  }

  /** Move the discard pile back under the draw pile. Extra cards stay in the discard pile. */
  private reshuffleInto(unit: UnitState, automatic: boolean): number {
    const room = Math.max(0, LIMITS.deck.drawCap - unit.piles.draw.length);
    const moved = Math.min(room, unit.piles.discard.length);
    if (moved === 0) return 0;
    const candidates = unit.piles.discard.splice(0, moved);
    const shuffled = this.rng.shuffle(candidates);
    unit.piles.draw.push(...shuffled);
    this.logEvent('shuffle', `${unit.side === 'player' ? '你' : 'SENTINEL'} 的弃牌堆回洗 ${moved} 张${automatic ? '（抽牌堆耗尽自动触发）' : ''}`, 'engine', undefined, unit.side === 'player'
      ? {
        side: unit.side,
        count: moved,
        automatic,
        order: unit.piles.draw.map((c) => c.name),
        discard: unit.piles.discard.map((c) => c.name),
      }
      : { side: unit.side, count: moved, automatic });
    return moved;
  }

  /**
   * Executes one script chunk without ending the turn. The player can run several
   * chunks before pressing skip; all chunks share the same credit budget and piles.
   */
  async executePlayerScript(script: CompiledScript): Promise<RoundResult> {
    const startSeq = this.log.length;
    if (this.phase !== 'player' || this.result) {
      return { events: this.log.slice(startSeq), state: this.getState(), ended: !!this.result, result: this.result };
    }
    this.phase = 'resolving';
    const record: TurnRecord = {
      turn: this.turn,
      actor: 'player',
      sourceLabel: '指令块',
      astNodes: script.astNodes,
      p: script.CU,
      apiCalls: 0,
      pileOps: 0,
      registerCommitted: true,
      cardsPlayed: [],
      scriptSource: script.source,
    };
    this.turnRecords.push(record);
    this.logEvent('script_submit', `执行指令块 · ${script.lines} 行 · 预算 ${script.CU.toFixed(1)} · 算力 ${this.playerBudget.credits.toFixed(1)}/${CREDIT_BUDGET}`, 'player', { kind: 'script', label: '指令块', line: 1 }, {
      source: script.source,
      complexity: script.astNodes,
      budget: script.CU,
    });
    const runtime: PlayerScriptRuntime = {
      script,
      budget: this.playerBudget,
      apiCalls: 0,
      pileOps: 0,
      cardsPlayed: [],
    };
    this.playerBudget.beginChunk();
    this.budget = runtime.budget;
    this.scriptRuntime = runtime;
    try {
      const host = this.createHost('player', runtime.budget, null, true);
      const interp = new Interpreter(host, runtime.budget, { kind: 'script', label: '指令块', line: 1 }, script.functions, {});
      interp.run(script.body);
    } catch (err) {
      this.handleHalt(err, record, 'player');
    }
    record.apiCalls = runtime.budget.apiCalls;
    record.pileOps = runtime.budget.pileOps;
    record.cardsPlayed = runtime.cardsPlayed;
    this.lastHalt = record.halted ?? null;
    this.scriptRuntime = null;
    this.checkDeaths();
    this.phase = this.result ? 'over' : 'player';
    if (this.result) this.finishBattle(this.result);
    return {
      events: this.log.slice(startSeq),
      state: this.getState(),
      ended: !!this.result,
      result: this.result,
    };
  }

  /** Explicitly skip the rest of the player turn, then let the opponent act. */
  async endPlayerTurn(): Promise<RoundResult> {
    const startSeq = this.log.length;
    if (this.phase !== 'player' || this.result) {
      return { events: this.log.slice(startSeq), state: this.getState(), ended: !!this.result, result: this.result };
    }
    this.phase = 'resolving';
    this.settleEndOfTurn(this.player);
    this.checkDeaths();
    if (!this.result) {
      await this.aiTurn();
    }
    this.checkDeaths();
    if (this.result) {
      this.finishBattle(this.result);
    } else {
      this.startPlayerTurn();
    }
    return {
      events: this.log.slice(startSeq),
      state: this.getState(),
      ended: !!this.result,
      result: this.result,
    };
  }

  /** Convenience for tests/replay: execute a full chunk, then skip the turn. */
  async submitPlayerTurn(script: CompiledScript): Promise<RoundResult> {
    const startSeq = this.log.length;
    const first = await this.executePlayerScript(script);
    if (first.ended) {
      return { events: this.log.slice(startSeq), state: this.getState(), ended: true, result: this.result };
    }
    await this.endPlayerTurn();
    return { events: this.log.slice(startSeq), state: this.getState(), ended: !!this.result, result: this.result };
  }

  private handleHalt(err: unknown, record: TurnRecord, actor: Side): void {
    if (err instanceof SandboxHalt) {
      record.halted = { reason: err.reason, label: err.label, line: err.ref.line, message: err.message };
      this.lastHalt = record.halted;
      this.logEvent('halt', `${err.label}：${err.message}`, actor, err.ref, { reason: err.reason, detail: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    record.halted = { reason: 'PROTOCOL_HALT', label: '协议中断', line: 0, message };
    this.lastHalt = record.halted;
    this.logEvent('halt', `协议中断：${message}`, actor, undefined, { reason: 'PROTOCOL_HALT', detail: message });
  }

  private async aiTurn(): Promise<void> {
    if (this.result) return;
    this.phase = 'enemy';
    this.logEvent('turn_start', 'SENTINEL 行动', 'enemy', undefined, { persona: this.persona });
    this.beginUnitTurn(this.enemy);
    this.refillHand(this.enemy);
    const record: TurnRecord = {
      turn: this.turn,
      actor: 'enemy',
      sourceLabel: `对手:${this.aiMode}`,
      astNodes: 0,
      p: 0,
      apiCalls: 0,
      pileOps: 0,
      registerCommitted: false,
      cardsPlayed: [],
    };
    this.turnRecords.push(record);
    const view = this.buildAiView();
    let plan: AiPlan;
    if (this.recordedAiPlans && this.aiPlanIndex < this.recordedAiPlans.length) {
      plan = { ops: this.recordedAiPlans[this.aiPlanIndex], source: 'recorded' };
      this.aiPlanIndex++;
      this.aiMeta.push({
        turn: this.turn,
        source: 'recorded',
        persona: this.persona,
        validation: 'replay',
        finalPlan: plan.ops,
      });
    } else if (this.aiMode === 'llm') {
      const proposed = await proposeAiPlan(view, this.aiMode, this.aiConfig, this.persona);
      const feasibility = this.validateAiPlan(proposed.plan.ops);
      if (proposed.meta.fallbackReason || !feasibility.ok) {
        const fallback = heuristicPlan(view);
        plan = { ops: fallback, source: 'heuristic' };
        const reason = feasibility.ok ? proposed.meta.fallbackReason : `计划不可执行：${feasibility.reason}`;
        this.aiMeta.push({
          ...proposed.meta,
          validation: feasibility.ok ? proposed.meta.validation : `失败：${feasibility.reason}`,
          fallbackReason: reason,
          finalPlan: fallback,
        });
        this.logEvent('ai_fallback', `SENTINEL 的提议被退回，改用本地策略：${reason}`, 'engine', undefined, {
          promptHash: proposed.meta.promptHash,
          reason,
        });
      } else {
        plan = proposed.plan;
        this.aiMeta.push({ ...proposed.meta, finalPlan: plan.ops });
      }
    } else {
      const ops = heuristicPlan(view);
      plan = { ops, source: 'heuristic' };
      this.aiMeta.push({
        turn: this.turn,
        source: 'heuristic',
        persona: this.persona,
        validation: 'ok',
        finalPlan: ops,
      });
    }
    const feasibility = this.validateAiPlan(plan.ops);
    if (!feasibility.ok) {
      plan = { ops: heuristicPlan(view), source: 'heuristic' };
      this.logEvent('ai_fallback', `SENTINEL 的计划不可执行，改用本地策略：${feasibility.reason}`, 'engine');
    }
    this.executedAiPlans.push(plan.ops);
    this.logEvent('ai_act', 'SENTINEL 开始行动', 'enemy', undefined, {
      ops: plan.ops,
      source: plan.source,
      persona: this.persona,
    });
    const budget = new TurnBudget();
    this.budget = budget;
    for (const op of plan.ops) {
      if (this.result) break;
      try {
        budget.checkTime({ kind: 'ai', label: 'SENTINEL 计划', line: 0 });
        if (op.op === 'play') {
          const ok = this.playLeftmost(this.enemy, budget, 'ai');
          if (!ok) {
            this.logEvent('ai_invalid', 'SENTINEL 无法出牌（能量或手牌不足）', 'enemy');
            break;
          }
          record.cardsPlayed.push(this.enemy.piles.discard[this.enemy.piles.discard.length - 1]?.name ?? '?');
          record.astNodes += 1;
        } else if (op.op === 'discard') {
          const card = this.enemy.piles.hand.shift();
          if (!card) break;
          this.enemy.piles.discard.push(card);
          this.enemy.counters.discarded += 1;
          budget.pileOps++;
          record.pileOps++;
          this.logEvent('pile', `SENTINEL 弃置 ${card.name}（调整队列）`, 'enemy', { kind: 'ai', label: 'SENTINEL 计划', line: 0 }, { card: card.name });
        } else if (op.op === 'end') {
          break;
        }
      } catch (err) {
        this.handleHalt(err, record, 'enemy');
        break;
      }
    }
    record.apiCalls = budget.apiCalls;
    this.settleEndOfTurn(this.enemy);
    this.checkDeaths();
    if (!this.result) {
      this.phase = 'player';
      this.logEvent('phase', 'SENTINEL 结束行动，轮到你了', 'engine');
    }
  }

  /**
   * Structural pre-flight only. Energy and hand depth are judged while the plan
   * runs, because a played card can add energy or draw more cards; rejecting the
   * whole plan up front would discard legal early moves that the effect-driven
   * budget could afford.
   */
  private validateAiPlan(ops: AiOp[]): { ok: true } | { ok: false; reason: string } {
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > 20) {
      return { ok: false, reason: '计划长度必须为 1-20' };
    }
    let sawEnd = false;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || !['play', 'discard', 'end'].includes(op.op)) return { ok: false, reason: `第 ${i + 1} 个操作非法` };
      if (sawEnd) return { ok: false, reason: 'end 之后不允许有操作' };
      if (op.op === 'end') sawEnd = true;
    }
    if (!sawEnd) return { ok: false, reason: '计划缺少 end' };
    return { ok: true };
  }

  private buildAiView(): AiView {
    const own = this.enemy;
    const foe = this.player;
    // Battle-time instances carry only the face name and energy cost. Effects
    // are public through the deck designs, which both sides know from turn 1.
    const cardView = (c: CardInstance, slot: number) => ({
      slot,
      name: c.name,
      cost: c.cost,
      // Internal tag set for the deterministic fallback policy. The prompt
      // serializes instances with name/cost only; effects live in the deck.
      api: [...new Set(c.compiled?.apiUses.map((u) => u.name) ?? [])],
    });
    const deckView = (deck: CompiledCard[]) => deck.map((c, slot) => ({
      slot,
      name: c.name,
      cost: c.cost,
      type: c.type,
      target: c.target,
      description: c.description,
      api: [...new Set(c.apiUses.map((u) => u.name))],
      source: c.source,
    }));
    return {
      turn: this.turn,
      self: {
        hp: own.hp,
        maxHp: own.maxHp,
        block: own.block,
        energy: own.energy,
        energyMax: ENERGY_PER_TURN,
        hand: own.piles.hand.map(cardView),
        drawPile: own.piles.draw.map(cardView),
        discardPile: own.piles.discard.map(cardView),
        drawCount: own.piles.draw.length,
        discardCount: own.piles.discard.length,
        handLimit: LIMITS.deck.handCap,
        drawLimit: LIMITS.deck.drawCap,
        deck: deckView(this.aiDeck),
      },
      opponent: {
        hp: foe.hp,
        maxHp: foe.maxHp,
        block: foe.block,
        energy: foe.energy,
        energyMax: ENERGY_PER_TURN,
        handCount: foe.piles.hand.length,
        drawCount: foe.piles.draw.length,
        discardCount: foe.piles.discard.length,
        handLimit: LIMITS.deck.handCap,
        drawLimit: LIMITS.deck.drawCap,
        deck: deckView(this.playerDeck),
      },
      registers: this.registers.map((r) => ({
        name: r.name,
        type: r.type,
        value: this.registerValues.get(r.name) ?? r.initial,
        min: r.min,
        max: r.max,
        enumValues: r.enumValues,
        owner: 'player' as const,
      })),
      persona: this.persona,
      legalOps: ['play（打出最左牌）', 'discard（弃置最左牌）', 'end'],
      history: buildAiViewHistory(this.log, this.turn, MAX_TURNS, this.executedAiPlans),
    };
  }

  private settleEndOfTurn(unit: UnitState): void {
    this.logEvent('turn_end', `${unit.side === 'player' ? '你的' : 'SENTINEL 的'}回合结束，开始结算`, unit.side);
    if (unit.piles.hand.length > 0) {
      const names = unit.piles.hand.map((c) => c.name);
      unit.piles.discard.push(...unit.piles.hand);
      unit.piles.hand = [];
      this.logEvent('pile', `${unit.side === 'player' ? '你' : 'SENTINEL'} 把剩余手牌 ${names.length} 张置入弃牌堆`, 'engine', undefined, {
        side: unit.side,
        cards: names,
        handToDiscard: true,
      });
    }
  }

  private checkDeaths(): void {
    if (this.player.hp <= 0) {
      if (this.result !== 'defeat') {
        this.result = 'defeat';
        this.logEvent('death', '你的外接战斗设备离线。', 'enemy', undefined, { side: 'player' });
      }
      return;
    }
    if (this.enemy.hp <= 0 && this.result !== 'victory') {
      this.result = 'victory';
      this.logEvent('death', 'SENTINEL-07 核心协议崩溃。', 'player', undefined, { side: 'enemy' });
    }
  }

  private finishByTimeout(): void {
    const playerRatio = this.player.hp / this.player.maxHp;
    const enemyRatio = this.enemy.hp / this.enemy.maxHp;
    const result: BattleResult = playerRatio > enemyRatio ? 'victory' : 'defeat';
    this.logEvent('timeout', `达到 ${MAX_TURNS} 回合上限，按剩余生命比例判定`, 'engine', undefined, { playerRatio, enemyRatio });
    this.finishBattle(result);
  }

  private finishBattle(result: BattleResult): void {
    this.phase = 'over';
    this.result = result;
    this.logEvent('battle_end', result === 'victory' ? '胜利：进入复盘审讯。' : '战败：协议日志仍可复盘。', 'engine', undefined, {
      result,
      turn: this.turn,
      playerHp: this.player.hp,
      enemyHp: this.enemy.hp,
    });
    this.registerValues.clear();
  }

  private logEvent(
    type: string,
    message: string,
    actor: 'player' | 'enemy' | 'engine',
    source?: SourceRef,
    data?: Record<string, unknown>,
  ): void {
    this.log.push({
      seq: this.log.length + 1,
      turn: this.turn,
      actor,
      type,
      message,
      source: source ? { kind: source.kind, label: source.label, line: source.line, irId: source.irId } : undefined,
      data,
    });
  }

  private createHost(actor: Side, budget: TurnBudget, card: CardInstance | null, scriptHost: boolean): SandboxHost {
    const owner = this;
    const int = (args: Prim[], i: number, r: SourceRef, name: string): number => {
      const v = args[i];
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `${name}() 的参数 ${i + 1} 必须是整数`);
      }
      if (v < -SANDBOX.maxNumber || v > SANDBOX.maxNumber) {
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `${name}() 数值超出范围`);
      }
      return v;
    };
    const str = (args: Prim[], i: number, r: SourceRef, name: string): string => {
      const v = args[i];
      if (typeof v !== 'string') {
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `${name}() 的参数 ${i + 1} 必须是字符串`);
      }
      if (v.length > SANDBOX.maxStringLength) {
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `${name}() 字符串超长`);
      }
      return v;
    };
    const self = actor === 'player' ? this.player : this.enemy;
    const foe = actor === 'player' ? this.enemy : this.player;
    const who = (side: Side) => (side === 'player' ? '你' : 'SENTINEL');
    const pileOf = (u: UnitState, name: string, r: SourceRef): CardInstance[] => {
      if (name === 'draw') return u.piles.draw;
      if (name === 'hand') return u.piles.hand;
      if (name === 'discard') return u.piles.discard;
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `非法牌堆 ${name}`);
    };
    // Battle-time card instances expose only their name and energy cost.
    // Full effects are public through the deck design, not through the instance.
    const cardSnapshot = (c: CardInstance): SbObj => ({
      shape: 'card',
      fields: Object.freeze({ name: c.name, cost: c.cost }),
    });
    const cardList = (cards: CardInstance[]): SbList => new SbList(cards.map(cardSnapshot));
    const chargeCredits = (name: string, args: Prim[], r: SourceRef): number => {
      if (!scriptHost) return 0;
      const spec = API_BY_NAME.get(name);
      const amountArg = spec?.amountArg;
      let magnitude = amountArg === undefined ? 0 : Number(args[amountArg] ?? 0);
      if (name === 'random_int') magnitude = Math.max(0, Number(args[1] ?? 0) - Number(args[0] ?? 0));
      if (spec?.cat === 'read') {
        switch (name) {
          case 'hand_size': magnitude = self.piles.hand.length; break;
          case 'draw_size': magnitude = self.piles.draw.length; break;
          case 'discard_size': magnitude = self.piles.discard.length; break;
          case 'getHand': magnitude = self.piles.hand.length; break;
          case 'getDraw': magnitude = self.piles.draw.length; break;
          case 'getDiscard': magnitude = self.piles.discard.length; break;
          case 'getPile': magnitude = pileOf(self, String(args[0] ?? 'hand'), r).length; break;
          case 'pile_costs': magnitude = pileOf(self, String(args[0] ?? 'hand'), r).length; break;
          case 'getTurn': magnitude = owner.turn; break;
          case 'getEnergy': magnitude = self.energy; break;
          case 'getBlock': magnitude = self.block; break;
          case 'getMaxEnergy': magnitude = ENERGY_PER_TURN; break;
          case 'getHandLimit': magnitude = LIMITS.deck.handCap; break;
          case 'getDrawLimit': magnitude = LIMITS.deck.drawCap; break;
          case 'get_global': {
            const reg = owner.registers.find((x) => x.name === String(args[0] ?? ''));
            magnitude = reg && reg.type === 'int' ? Math.max(Math.abs(reg.min), Math.abs(reg.max)) : 0;
            break;
          }
        }
      }
      const credits = creditCost(name, Number.isFinite(magnitude) ? magnitude : 0);
      self.counters.credits = Math.round((self.counters.credits + credits) * 10) / 10;
      budget.spendCredits(credits, r);
      return credits;
    };
    const freeSlots = (): number => {
      const used = self.piles.draw.length + self.piles.hand.length + self.piles.discard.length;
      return Math.max(0, LIMITS.deck.totalInstances - used);
    };
    return {
      callApi: (name, args, r0) => {
        const r = r0;
        const credits = chargeCredits(name, args, r);
        owner.logEvent('api', `${who(actor)} 调用 ${name}(${args.map((a) => JSON.stringify(a)).join(', ')})`, actor, r, {
          api: name,
          args,
          credits,
        });
        switch (name) {
          case 'deal_damage': {
            const target = str(args, 0, r, name);
            if (target !== 'self' && target !== 'enemy') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `非法目标 ${target}`);
            const raw = int(args, 1, r, name);
            if (raw < 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '伤害不能为负');
            return owner.dealDamage(actor, target, raw, r);
          }
          case 'gain_block': {
            const raw = int(args, 0, r, name);
            if (raw < 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '格挡不能为负');
            const amount = raw;
            self.block += amount;
            owner.logEvent('block', `${who(actor)} 获得 ${amount} 格挡（共 ${self.block}，下个自己回合开始清零）`, actor, r, { side: actor, amount, block: self.block });
            return null;
          }
          case 'heal': {
            const raw = int(args, 0, r, name);
            if (raw < 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '治疗不能为负');
            const amount = raw;
            const before = self.hp;
            self.hp = Math.min(self.maxHp, self.hp + amount);
            const healed = self.hp - before;
            self.counters.healed += healed;
            owner.logEvent('heal', healed > 0
              ? `${who(actor)} 恢复 ${healed} 点生命（共 ${self.hp}/${self.maxHp}）`
              : `${who(actor)} 的生命已满，治疗没有生效`, actor, r, { side: actor, amount, healed, hp: self.hp });
            return null;
          }
          case 'gain_energy': {
            const raw = int(args, 0, r, name);
            if (raw < 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '能量不能为负');
            const amount = raw;
            self.energy = Math.min(999, self.energy + amount);
            self.counters.energyGained += amount;
            owner.logEvent('energy', `${who(actor)} 获得 ${amount} 能量（共 ${self.energy}）`, actor, r, { side: actor, amount, energy: self.energy });
            return null;
          }
          case 'lose_energy': {
            const raw = int(args, 0, r, name);
            if (raw < 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '能量不能为负');
            const amount = raw;
            const lost = Math.min(self.energy, amount);
            self.energy -= lost;
            owner.logEvent('energy', `${who(actor)} 失去 ${lost} 能量（共 ${self.energy}）`, actor, r, { side: actor, amount: lost, energy: self.energy });
            return null;
          }
          case 'draw': {
            const count = int(args, 0, r, name);
            if (count < 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '抽牌数量不能为负');
            const drawn = owner.drawCards(self, count);
            if (drawn === 0) owner.logEvent('draw', `${who(actor)} 抽牌失败（抽牌堆与弃牌堆都空了，或手牌已满）`, actor, r, { side: actor, drawn: 0 });
            return drawn;
          }
          case 'discard': {
            const count = int(args, 0, r, name);
            if (count < 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '弃牌数量不能为负');
            const n = Math.min(count, self.piles.hand.length);
            const discarded = self.piles.hand.splice(0, n);
            self.piles.discard.push(...discarded);
            self.counters.discarded += n;
            owner.logEvent('discard', `${who(actor)} 弃置 ${n} 张手牌`, actor, r, { side: actor, count: n, cards: discarded.map((c) => c.name) });
            return n;
          }
          case 'playcard': {
            if (!scriptHost) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'playcard() 只能由回合脚本调用');
            return owner.playLeftmost(self, budget, 'script');
          }
          case 'swap': {
            const pileName = str(args, 0, r, name);
            const i = int(args, 1, r, name);
            const j = int(args, 2, r, name);
            const pile = pileOf(self, pileName, r);
            if (i < 0 || j < 0 || i >= pile.length || j >= pile.length) {
              throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'swap 索引越界');
            }
            [pile[i], pile[j]] = [pile[j], pile[i]];
            owner.logEvent('pile', `${who(actor)} 交换${pileName === 'hand' ? '手牌' : pileName === 'draw' ? '抽牌堆' : '弃牌堆'} ${i} 与 ${j}`, actor, r, actor === 'player'
              ? { side: actor, i, j, pile: pileName, order: pile.map((c) => c.name) }
              : { side: actor, i, j, pile: pileName, count: pile.length });
            return null;
          }
          case 'move_card': {
            const fromName = str(args, 0, r, name);
            const fromIndex = int(args, 1, r, name);
            const toName = str(args, 2, r, name);
            const toIndex = int(args, 3, r, name);
            const from = pileOf(self, fromName, r);
            const to = pileOf(self, toName, r);
            if (fromIndex < 0 || fromIndex >= from.length) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'move_card 来源下标越界');
            const [card] = from.splice(fromIndex, 1);
            const insertAt = Math.max(0, Math.min(toIndex, to.length));
            if (toName === toName) to.splice(insertAt, 0, card);
            owner.logEvent('pile', `${who(actor)} 移动 ${card.name}：${fromName}[${fromIndex}] → ${toName}[${insertAt}]`, actor, r, {
              side: actor,
              card: card.name,
              from: fromName,
              to: toName,
              index: fromIndex,
              targetIndex: insertAt,
            });
            return null;
          }
          case 'shuffle': {
            self.piles.draw = owner.rng.shuffle(self.piles.draw);
            owner.logEvent('shuffle', `${who(actor)} 重洗抽牌堆`, actor, r, actor === 'player'
              ? { side: actor, order: self.piles.draw.map((c) => c.name) }
              : { side: actor, count: self.piles.draw.length });
            return null;
          }
          case 'reshuffle': {
            const moved = owner.reshuffleInto(self, false);
            if (moved === 0) owner.logEvent('shuffle', `${who(actor)} 回洗没有发生（抽牌堆已满或弃牌堆为空）`, actor, r, { side: actor });
            return moved;
          }
          case 'set_global': {
            if (!scriptHost) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'set_global() 只能由回合脚本调用');
            if (actor !== 'player') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '只有玩家回合脚本可以写寄存器');
            const regName = str(args, 0, r, name);
            const value = args[1];
            const decl = owner.registers.find((d) => d.name === regName);
            if (!decl) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `未声明的寄存器 ${regName}`);
            if (decl.type === 'int') {
              if (typeof value !== 'number' || !Number.isInteger(value)) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `寄存器 ${regName} 需要 int`);
              if (value < decl.min || value > decl.max) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `寄存器 ${regName} 超出 [${decl.min}, ${decl.max}]`);
            } else if (decl.type === 'bool') {
              if (typeof value !== 'boolean') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `寄存器 ${regName} 需要 bool`);
            } else {
              if (typeof value !== 'string' || !decl.enumValues?.includes(value)) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `寄存器 ${regName} 枚举值非法`);
            }
            owner.registerValues.set(regName, value);
            owner.logEvent('register_commit', `寄存器 ${regName} ← ${JSON.stringify(value)}`, 'player', r, { name: regName, value });
            return null;
          }
          case 'get_global': {
            const regName = str(args, 0, r, name);
            return owner.registerValues.get(regName) ?? 0;
          }
          case 'getHand':
            return cardList(self.piles.hand);
          case 'getDraw':
            return cardList(self.piles.draw);
          case 'getDiscard':
            return cardList(self.piles.discard);
          case 'getPile':
            return cardList(pileOf(self, str(args, 0, r, name), r));
          case 'hand_size':
            return self.piles.hand.length;
          case 'draw_size':
            return self.piles.draw.length;
          case 'discard_size':
            return self.piles.discard.length;
          case 'pile_costs': {
            const pileName = str(args, 0, r, name);
            return new SbList(pileOf(self, pileName, r).map((c) => c.cost));
          }
          case 'getTurn':
            return owner.turn;
          case 'getEnergy':
            return self.energy;
          case 'getBlock':
            return self.block;
          case 'getMaxEnergy':
            return ENERGY_PER_TURN;
          case 'getHandLimit':
            return LIMITS.deck.handCap;
          case 'getDrawLimit':
            return LIMITS.deck.drawCap;
          case 'random_int': {
            const a = int(args, 0, r, name);
            const b = int(args, 1, r, name);
            if (a < 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'random_int 下限必须 >= 0');
            if (a > b) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'random_int 下限大于上限');
            const value = owner.rng.int(a, b);
            owner.logEvent('rng', `随机结果 ${value}（范围 ${a}-${b}，种子 ${owner.seed}）`, actor, r, { min: a, max: b, value, seed: owner.seed });
            return value;
          }
          case 'log': {
            const msg = str(args, 0, r, name);
            owner.logEvent('player_log', `[${who(actor)}] ${msg}`, actor, r, { message: msg });
            return null;
          }
          default:
            throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `未实现或禁止的 API ${name}`);
        }
      },
      ctxField: (name, r) => {
        if (name === 'turn') {
          if (scriptHost) {
            self.counters.credits = Math.round((self.counters.credits + 1) * 10) / 10;
            budget.spendCredits(1, r);
          }
          return {
            shape: 'turn',
            fields: Object.freeze({ discarded_count: self.counters.discarded, played_count: self.counters.played }),
          };
        }
        if (name === 'enemy') return { shape: 'unit', fields: Object.freeze({}) };
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `禁止访问 ctx.${name}`);
      },
      ctxMethod: (object, method, r) => {
        if (object === 'enemy' && (method === 'hp' || method === 'block')) {
          if (scriptHost) {
            const credits = creditCost(`enemy.${method}`);
            self.counters.credits = Math.round((self.counters.credits + credits) * 10) / 10;
            budget.spendCredits(credits, r);
          }
          return method === 'hp' ? foe.hp : foe.block;
        }
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `禁止调用 ctx.${object}.${method}()`);
      },
      selfField: (name, r) => {
        if (!card) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, '只能在卡牌 effect 中读取 self');
        if (name === 'name') return card.name;
        if (name === 'cost') return card.cost;
        if (name === 'type') return card.type;
        if (name === 'target') return card.target;
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `禁止访问 self.${name}`);
      },
      getState: (key) => {
        if (!card) return 0;
        return card.state[key] ?? 0;
      },
      setState: (key, value, r) => {
        if (!card) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'self.state 只能在卡牌 effect 中写入');
        const keyCount = Object.keys(card.state).length;
        if (!(key in card.state) && keyCount >= 4) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'self.state 最多 4 个键');
        const type = typeof value === 'number' ? 'int' : typeof value === 'boolean' ? 'bool' : 'str';
        const prior = card.stateTypes.get(key);
        if (prior && prior !== type) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, `self.state["${key}"] 类型不一致`);
        if (typeof value === 'number' && (value < -99 || value > 99)) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'self.state 整数超出 -99..99');
        if (typeof value === 'string' && value.length > 32) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', r, 'self.state 字符串超长');
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
          card.stateTypes.set(key, type);
          card.state[key] = value;
        }
      },
      stateType: (key) => (card ? card.stateTypes.get(key) : undefined),
      getGlobal: (name) => owner.registerValues.get(name) ?? 0,
    };
  }

  private dealDamage(actor: Side, target: string, amount: number, ref: SourceRef): number {
    const self = actor === 'player' ? this.player : this.enemy;
    const foe = actor === 'player' ? this.enemy : this.player;
    const unit = target === 'self' ? self : foe;
    const blocked = Math.min(unit.block, amount);
    unit.block -= blocked;
    const hpDamage = Math.max(0, amount - blocked);
    unit.hp = Math.max(0, unit.hp - hpDamage);
    this.logEvent(
      'damage',
      `${actor === 'player' ? '你' : 'SENTINEL'} 对 ${unit.side === 'player' ? '你' : 'SENTINEL'} 造成 ${amount} 伤害（格挡吸收 ${blocked}，生命 -${hpDamage}）`,
      actor,
      ref,
      { side: unit.side, amount, blocked, hpDamage, hpAfter: unit.hp, blockAfter: unit.block },
    );
    this.checkDeaths();
    return amount;
  }

  private playLeftmost(unit: UnitState, budget: TurnBudget, kind: 'script' | 'ai'): boolean {
    const actor = unit.side;
    const card = unit.piles.hand[0];
    if (!card) {
      this.logEvent('card_skip', `${actor === 'player' ? '你' : 'SENTINEL'} 没有手牌`, actor);
      return false;
    }
    if (unit.energy < card.cost) {
      this.logEvent('card_skip', `能量不足：${card.name} 需要 ${card.cost}，当前 ${unit.energy}`, actor, { kind: kind === 'ai' ? 'ai' : 'script', label: kind === 'ai' ? 'SENTINEL 计划' : '回合脚本', line: 0 }, { card: card.name, cost: card.cost, energy: unit.energy });
      if (kind === 'script') {
        throw new SandboxHalt('PROTOCOL_HALT', '能量不足', { kind: 'script', label: '回合脚本', line: 0 }, `【${card.name}】需要 ${card.cost} 能量，当前只有 ${unit.energy}`);
      }
      return false;
    }
    unit.energy -= card.cost;
    unit.counters.played += 1;
    unit.piles.hand.shift();
    this.logEvent('card_play', `${actor === 'player' ? '你' : 'SENTINEL'} 打出最左牌【${card.name}】· 费用 ${card.cost}`, actor, { kind: 'card', label: card.name, line: 1 }, {
      card: card.name,
      uid: card.uid,
      description: card.description,
      cost: card.cost,
      type: card.type,
      target: card.target,
      energyAfter: unit.energy,
      handLeft: actor === 'player' ? unit.piles.hand.map((c) => c.name) : undefined,
    });
    const sourceRef: SourceRef = { kind: 'card', label: card.name, line: 1 };
    try {
      if (card.compiled) {
        const host = this.createHost(actor, budget, card, false);
        const interp = new Interpreter(
          host,
          budget,
          { kind: 'card', label: card.name, line: 1 },
          card.compiled.program.functions,
          { name: card.name, cost: card.cost, type: card.type, target: card.target },
        );
        interp.run(card.compiled.effect);
      }
    } catch (err) {
      this.logEvent('card_halt', `【${card.name}】效果中断，已执行动作保留`, actor, sourceRef, { detail: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      unit.piles.discard.push(card);
    }
    this.logEvent('card_end', `【${card.name}】结算完毕 → 弃牌堆`, actor, sourceRef, { card: card.name });
    this.checkDeaths();
    return true;
  }

  signature(): { hash: string; playerHp: number; enemyHp: number; turn: number; result: BattleResult } {
    const canonical = this.log
      .filter((e) => e.type !== 'ai_fallback')
      .map((e) => {
        if ((e.type === 'ai_plan' || e.type === 'ai_act') && e.data) {
          return [e.seq, e.turn, e.actor, e.type, e.message, (e.data as { ops?: unknown }).ops, (e.data as { persona?: unknown }).persona];
        }
        return [e.seq, e.turn, e.actor, e.type, e.message, e.source, e.data];
      });
    const payload = JSON.stringify(canonical);
    return { hash: fnv1a(payload), playerHp: this.player.hp, enemyHp: this.enemy.hp, turn: this.turn, result: this.result };
  }

  getState(): PublicBattleState {
    const mapUnit = (u: UnitState): PublicUnit => ({
      hp: u.hp,
      maxHp: u.maxHp,
      block: u.block,
      energy: u.energy,
      creditsUsed: u.counters.credits,
      creditBudget: CREDIT_BUDGET,
      drawCount: u.piles.draw.length,
      discardCount: u.piles.discard.length,
      handCount: u.piles.hand.length,
      handLimit: LIMITS.deck.handCap,
      drawLimit: LIMITS.deck.drawCap,
    });
    const pubCard = (c: CardInstance): PublicCard => ({
      uid: c.uid,
      name: c.name,
      description: c.description,
      cost: c.cost,
      type: c.type,
      target: c.target,
      art: c.art,
      playable: c.cost <= this.player.energy,
    });
    return {
      turn: this.turn,
      maxTurns: MAX_TURNS,
      phase: this.phase,
      result: this.result,
      seed: this.seed,
      aiMode: this.aiMode,
      persona: this.persona,
      player: {
        ...mapUnit(this.player),
        maxEnergy: ENERGY_PER_TURN,
        hand: this.player.piles.hand.map(pubCard),
        draw: this.player.piles.draw.map(pubCard),
        discard: this.player.piles.discard.map(pubCard),
      },
      enemy: mapUnit(this.enemy),
      registers: this.registers.map((r) => ({
        name: r.name,
        type: r.type,
        value: this.registerValues.get(r.name) ?? r.initial,
        min: r.min,
        max: r.max,
        enumValues: r.enumValues,
      })),
      playerDeckBudget: deckWeight(this.playerDeck),
      aiDeckBudget: deckWeight(this.aiDeck),
      playerDeck: this.playerDeck.map((c, i) => ({
        uid: `pd${i}`, name: c.name, description: c.description, cost: c.cost,
        type: c.type, target: c.target, art: c.art, playable: false,
      })),
      aiDeck: this.aiDeck.map((c, i) => ({
        uid: `ad${i}`, name: c.name, description: c.description, cost: c.cost,
        type: c.type, target: c.target, art: c.art, playable: false,
      })),
      aiDeckMeta: this.aiDeckMeta,
      enemyDiscard: this.enemy.piles.discard.map((c) => ({
        uid: c.uid, name: c.name, description: c.description, cost: c.cost,
        type: c.type, target: c.target, art: c.art, playable: false,
      })),
      lastHalt: this.lastHalt,
      turnRecords: [...this.turnRecords],
      aiMeta: this.result ? [...this.aiMeta] : this.aiMeta.map(({ rawOutput, ...rest }) => rest),
      logCount: this.log.length,
    };
  }

  getEvents(from = 0): LogEvent[] {
    return this.log.slice(from);
  }

  replayData(): { seed: number; registers: RegisterDecl[]; playerDeckSources: string[]; aiDeck: CompiledCard[]; aiMode: string; plans: AiOp[][] } {
    return {
      seed: this.seed,
      registers: this.registers,
      playerDeckSources: this.playerDeck.map((c) => c.source),
      aiDeck: this.aiDeck,
      aiMode: this.aiMode,
      plans: this.executedAiPlans,
    };
  }
}

export function deckWeight(deck: CompiledCard[]): number {
  let total = 0;
  for (const c of deck) total += c.cost;
  return total;
}

export const PERSONAS: readonly AiPersona[] = ['aggressor', 'controller', 'discarder', 'combo', 'bait'];

export function personaForSeed(seed: number): AiPersona {
  return PERSONAS[(seed >>> 0) % PERSONAS.length];
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
