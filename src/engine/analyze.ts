import {
  API_BY_NAME,
  BUDGET,
  CARD_TARGETS,
  CARD_TYPES,
  CODE_LIMITS,
  CREDIT_BUDGET,
  LIMITS,
  NEGATIVE_BASE,
  effectCapForCost,
  creditCost,
  type ApiSpec,
} from './config';
import type { IRExpr, IRFunction, IRProgram, IRStmt } from './ir';
import { lowerCard, lowerScript, walkExprs } from './ir';
import { ParseError, collectComments, parseModule, parseScript } from './python';

export type Severity = 'error' | 'warning';
export interface Diagnostic {
  line: number;
  message: string;
  severity: Severity;
  code?: string;
}

export interface RegisterDecl {
  name: string;
  type: 'int' | 'bool' | 'enum';
  initial: number | boolean | string;
  min: number;
  max: number;
  enumValues?: string[];
}

export interface ApiUse {
  name: string;
  line: number;
  cost: number;
  credits: number;
}

export interface NegativeUse {
  kind: 'self_damage' | 'discard' | 'energy_loss';
  line: number;
  base: number;
  credit: number;
  frequency: number;
}

export interface CardArt {
  /** Frame accent colour of the card face. */
  frame: string;
  /** Sigil drawn in the card art window when no painted image exists. */
  sigil: 'slash' | 'shield' | 'arc' | 'wave' | 'node' | 'cross';
  /** Background ink of the art window. */
  ink: string;
  /** Player-painted art window as a data URL. Presentation only. */
  image?: string;
  /** Bumped on every paint commit so texture caches know to rebuild. */
  imageRev?: number;
}

export interface CompiledCard {
  className: string;
  name: string;
  /** Text taken from `//` comments in the source and shown on the card face. */
  description: string;
  declaredCost: number;
  cost: number;
  type: 'attack' | 'skill';
  target: 'enemy' | 'self' | 'none';
  /** Player-designed card face; presentation only. */
  art?: CardArt;
  effect: IRStmt[];
  program: IRProgram;
  P: number;
  R: number;
  N: number;
  credits: number;
  apiCalls: number;
  pileOps: number;
  astNodes: number;
  lines: number;
  vars: number;
  apiUses: ApiUse[];
  negatives: NegativeUse[];
  warnings: Diagnostic[];
  source: string;
  registers: RegisterDecl[];
}

export interface CompiledScript {
  body: IRStmt[];
  functions: IRFunction[];
  program: IRProgram;
  P: number;
  CU: number;
  credits: number;
  apiCalls: number;
  pileOps: number;
  astNodes: number;
  lines: number;
  vars: number;
  maxIterations: number;
  regWrites: number;
  apiUses: ApiUse[];
  warnings: Diagnostic[];
  source: string;
  registers: RegisterDecl[];
}

export interface CompileResult<T> {
  ok: boolean;
  value?: T;
  diagnostics: Diagnostic[];
}

type AV =
  | { t: 'int'; min: number; max: number }
  | { t: 'bool'; v?: boolean }
  | { t: 'str'; vals: Set<string> | null }
  | { t: 'list'; minLen: number; maxLen: number; elem: AV; cards?: boolean }
  | { t: 'obj'; shape: 'ctx' | 'turn' | 'intent' | 'unit' | 'card' }
  | { t: 'none' };

const OBJ = (shape: 'ctx' | 'turn' | 'intent' | 'unit' | 'card'): AV => ({ t: 'obj', shape });
const IV = (min: number, max: number): AV => ({ t: 'int', min: Math.max(-BUDGET.maxSafe, min), max: Math.min(BUDGET.maxSafe, max) });
const NONE: AV = { t: 'none' };

function clampInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-BUDGET.maxSafe, Math.min(BUDGET.maxSafe, Math.trunc(n)));
}

function intVal(n: number): AV {
  return IV(n, n);
}

function mergeVal(a: AV, b: AV): AV {
  if (a.t === 'int' && b.t === 'int') return IV(Math.min(a.min, b.min), Math.max(a.max, b.max));
  if (a.t === 'bool' && b.t === 'bool') return a.v === b.v ? a : { t: 'bool' };
  if (a.t === 'str' && b.t === 'str') {
    if (!a.vals || !b.vals) return { t: 'str', vals: null };
    return { t: 'str', vals: new Set([...a.vals, ...b.vals]) };
  }
  if (a.t === 'list' && b.t === 'list') {
    return { t: 'list', minLen: Math.min(a.minLen, b.minLen), maxLen: Math.max(a.maxLen, b.maxLen), elem: mergeVal(a.elem, b.elem), cards: a.cards || b.cards };
  }
  if (a.t === 'obj' && b.t === 'obj' && a.shape === b.shape) return a;
  if (a.t === 'none' && b.t === 'none') return a;
  return IV(-BUDGET.maxSafe, BUDGET.maxSafe);
}

function cloneEnv(env: Map<string, AV>): Map<string, AV> {
  return new Map(env);
}

function mergeEnv(intersection: Map<string, AV>[]): Map<string, AV> {
  const out = new Map<string, AV>();
  if (intersection.length === 0) return out;
  const keys = [...intersection[0].keys()];
  for (const key of keys) {
    if (intersection.every((e) => e.has(key))) {
      let v = intersection[0].get(key)!;
      for (let i = 1; i < intersection.length; i++) v = mergeVal(v, intersection[i].get(key)!);
      out.set(key, v);
    }
  }
  return out;
}

class Meter {
  cost = 0;
  credits = 0;
  apiCalls = 0;
  pileOps = 0;
  listWrites = 0;
  apiUses: ApiUse[] = [];
  negatives: { kind: NegativeUse['kind']; base: number; line: number; frequency: number; conditional: boolean }[] = [];
  warnings: Diagnostic[] = [];
  totalIterations = 0;
  /** Worst-case number of calls per turn, shared by script and card effects. */
  calls: Record<string, number> = {};
  energyGain = 0;

  add(other: Meter): void {
    this.cost += other.cost;
    this.credits += other.credits;
    this.apiCalls += other.apiCalls;
    this.pileOps += other.pileOps;
    this.listWrites += other.listWrites;
    this.apiUses.push(...other.apiUses);
    this.negatives.push(...other.negatives);
    this.warnings.push(...other.warnings);
    this.totalIterations += other.totalIterations;
    this.energyGain += other.energyGain;
    for (const [k, v] of Object.entries(other.calls)) this.calls[k] = (this.calls[k] ?? 0) + v;
  }

  static max(a: Meter, b: Meter): Meter {
    const m = new Meter();
    m.cost = Math.max(a.cost, b.cost);
    m.credits = Math.max(a.credits, b.credits);
    m.apiCalls = Math.max(a.apiCalls, b.apiCalls);
    m.pileOps = Math.max(a.pileOps, b.pileOps);
    m.listWrites = Math.max(a.listWrites, b.listWrites);
    m.apiUses = [...a.apiUses, ...b.apiUses];
    m.negatives = [...a.negatives, ...b.negatives];
    m.warnings = [...a.warnings, ...b.warnings];
    m.totalIterations = Math.max(a.totalIterations, b.totalIterations);
    m.energyGain = Math.max(a.energyGain, b.energyGain);
    for (const key of new Set([...Object.keys(a.calls), ...Object.keys(b.calls)])) {
      m.calls[key] = Math.max(a.calls[key] ?? 0, b.calls[key] ?? 0);
    }
    return m;
  }
}

interface Ctx {
  depth: number;
  loopDepth: number;
  frequency: number;
  conditional: boolean;
  fnVars: Set<string>;
  fnName: string;
}

interface LoopSpec {
  bound: number;
  varMin: number;
  varMax: number;
}

class AnalysisAbort extends Error {}

const BANNED_NAMES = new Set([
  'eval', 'exec', 'open', 'compile', '__import__', 'import', 'getattr', 'setattr', 'delattr',
  'globals', 'locals', 'vars', 'input', 'breakpoint', 'memoryview', 'object', 'super', 'type',
  'isinstance', 'hasattr', 'os', 'sys', 'subprocess', 'socket', 'requests', 'threading',
  'asyncio', 'marshal', 'pickle', 'ctypes', 'inspect', 'importlib', '__class__', '__dict__',
  '__globals__', '__builtins__', '__loader__', '__code__', 'constructor', 'prototype',
]);
const BUILTINS = new Set(['range', 'len', 'min', 'max', 'abs', 'int', 'bool', 'str']);

function exprVariables(e: IRExpr): number {
  switch (e.k) {
    case 'var': return e.name === 'ctx' || e.name === 'self' ? 0 : 1;
    case 'num': case 'str': case 'bool': case 'none': case 'selffield': case 'state': return 0;
    case 'attr': return exprVariables(e.obj);
    case 'sub': return exprVariables(e.obj) + exprVariables(e.index);
    case 'un': return exprVariables(e.e);
    case 'bin': return exprVariables(e.l) + exprVariables(e.r);
    case 'cmp': return exprVariables(e.l) + exprVariables(e.r);
    case 'boolop': return e.items.reduce((n, x) => n + exprVariables(x), 0);
    case 'ifexp': return exprVariables(e.test) + exprVariables(e.body) + exprVariables(e.orelse);
    case 'list': return e.items.reduce((n, x) => n + exprVariables(x), 0);
    case 'listcomp': return exprVariables(e.iter) + exprVariables(e.elt) + (e.cond ? exprVariables(e.cond) : 0);
    case 'call': return e.args.reduce((n, x) => n + exprVariables(x), 0) + (e.fn.k === 'attr' ? exprVariables(e.fn.obj) : 0);
    default: return 0;
  }
}

/** Card-design effect weight. Dynamic global reads are unknowable at build time, so they cost the most. */
const CARD_READ_EFFECT_COST: Record<string, number> = {
  getTurn: 2.6,
  getEnergy: 2.6,
  getBlock: 2.6,
  getMaxEnergy: 2.2,
  getHandLimit: 2.0,
  getDrawLimit: 2.0,
  hand_size: 0.7,
  draw_size: 0.7,
  discard_size: 0.7,
  getHand: 0.8,
  getDraw: 0.8,
  getDiscard: 0.8,
  getPile: 0.8,
  get_global: 1.6,
  pile_costs: 0.25,
  'enemy.hp': 6.0,
  'enemy.block': 2.4,
};

/** Fixed build-time price for read APIs whose runtime value cannot be known statically. */
export function cardEffectPrice(name: string): number | undefined {
  return CARD_READ_EFFECT_COST[name];
}

class Analyzer {
  program: IRProgram;
  registers: RegisterDecl[];
  diagnostics: Diagnostic[] = [];
  meter = new Meter();
  cardWide = { healMax: 0, drawMax: 0, selfDamageMax: 0, discardMax: 0 };
  helperCallStack: string[] = [];
  helperCalls = 0;
  helperVars = new Map<string, Set<string>>();
  helperDepths = 0;
  stateKeys = new Map<string, 'int' | 'bool' | 'str'>();
  limits: {
    maxLines: number; maxAst: number; maxVars: number; maxList: number; maxNesting: number;
    maxLoopDepth: number; maxLoopBound: number; maxTotalIterations: number; maxApi: number;
    maxPileOps: number; maxHelpers: number; maxCallDepth: number; maxP: number; maxCU: number;
    execMs: number; maxListWrites: number;
  };
  private compiledHelpers = new Map<string, IRFunction>();
  private kind: 'card' | 'script';

  constructor(program: IRProgram, registers: RegisterDecl[], kind: 'card' | 'script') {
    this.program = program;
    this.registers = registers;
    this.limits = kind === 'card'
      ? { ...LIMITS.card, maxCU: LIMITS.script.maxCU, execMs: LIMITS.script.execMs }
      : { ...LIMITS.script, maxP: 9999 };
    this.kind = kind;
    for (const f of program.functions) this.compiledHelpers.set(f.name, f);
  }

  error(line: number, message: string, code = 'E_STATIC'): void {
    this.diagnostics.push({ line, message, severity: 'error', code });
  }

  warn(line: number, message: string, code = 'W_STATIC'): void {
    this.diagnostics.push({ line, message, severity: 'warning', code });
  }

  private abort(line: number, message: string, code = 'E_BUDGET'): never {
    this.error(line, message, code);
    throw new AnalysisAbort();
  }

  private addCost(line: number, amount: number): void {
    this.meter.cost += amount;
    if (this.meter.cost > BUDGET.analysisCeiling) {
      this.abort(line, `静态预算展开超过上限（${BUDGET.analysisCeiling} CU），代码复杂度不可接受`, 'E_BUDGET_CEILING');
    }
  }

  private checkName(name: string, line: number): boolean {
    if (BANNED_NAMES.has(name) || name.startsWith('__')) {
      this.error(line, `禁止的标识符或能力: ${name}`, 'E_SANDBOX_NAME');
      return false;
    }
    return true;
  }

  private varLimitCheck(fnVars: Set<string>, line: number): void {
    if (fnVars.size > this.limits.maxVars) {
      this.error(line, `局部变量超过上限 ${this.limits.maxVars} 个（当前 ${fnVars.size}）`, 'E_VARS');
    }
  }

  checkCallGraph(): void {
    const graph = new Map<string, Set<string>>();
    for (const f of this.program.functions) {
      const set = new Set<string>();
      walkExprs(f.body, (e) => {
        if (e.k === 'call' && e.fn.k === 'var' && this.compiledHelpers.has(e.fn.name)) set.add(e.fn.name);
      });
      graph.set(f.name, set);
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string): void => {
      if (state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') {
        const fn = this.compiledHelpers.get(name)!;
        this.error(fn.line, `递归调用图存在环: ${name}（递归被拒绝）`, 'E_RECURSION');
        return;
      }
      state.set(name, 'visiting');
      for (const next of graph.get(name) ?? []) visit(next);
      state.set(name, 'done');
    };
    for (const f of this.program.functions) visit(f.name);
  }

  analyzeBlock(stmts: IRStmt[], env: Map<string, AV>, ctx: Ctx): AV {
    let ret: AV = NONE;
    for (const s of stmts) {
      const r = this.analyzeStmt(s, env, ctx);
      if (r.t !== 'none') ret = ret.t === 'none' ? r : mergeVal(ret, r);
    }
    return ret;
  }

  analyzeStmt(s: IRStmt, env: Map<string, AV>, ctx: Ctx): AV {
    switch (s.k) {
      case 'assign': {
        const v = this.evalExpr(s.value, env, ctx);
        if (s.target.k === 'var') {
          if (s.target.name === 'ctx' || s.target.name === 'self') {
            this.error(s.line, `禁止重新绑定保留名 ${s.target.name}`, 'E_RESERVED');
            return NONE;
          }
          if (!this.checkName(s.target.name, s.line)) return NONE;
          ctx.fnVars.add(s.target.name);
          this.varLimitCheck(ctx.fnVars, s.line);
          env.set(s.target.name, v);
        } else if (s.target.k === 'index') {
          const list = env.get(s.target.name);
          if (!list || list.t !== 'list') {
            this.error(s.line, `数组下标赋值的目标必须是局部数组: ${s.target.name}`, 'E_LIST_TARGET');
            return NONE;
          }
          if (list.cards) {
            this.error(s.line, '只读卡牌快照不能写入', 'E_LIST_READONLY');
            return NONE;
          }
          const idx = this.evalExpr(s.target.index, env, ctx);
          if (idx.t !== 'int') {
            this.error(s.line, '数组下标必须是 int', 'E_TYPE');
            return NONE;
          }
          if (list.maxLen === 0 || idx.min < 0 || idx.max >= Math.max(1, list.maxLen)) {
            this.error(s.line, `数组下标可能越界（${idx.min}..${idx.max}，长度上限 ${list.maxLen}）`, 'E_LIST_INDEX');
            return NONE;
          }
          if (v.t !== 'int') {
            this.error(s.line, '本项目数组只保存 int', 'E_TYPE');
            return NONE;
          }
          this.addCost(s.line, BUDGET.listWrite);
          this.meter.listWrites += 1;
          if (this.meter.listWrites > LIMITS.script.maxListWrites) {
            this.error(s.line, `数组写入次数超过上限 ${LIMITS.script.maxListWrites}`, 'E_LIST_WRITES');
          }
          env.set(s.target.name, { ...list, elem: mergeVal(list.elem, v) });
        } else {
          s.target.key;
          if (v.t === 'list' || v.t === 'obj') {
            this.error(s.line, 'self.state 只能存 int/bool/短字符串，禁止容器与引擎对象', 'E_STATE_TYPE');
          } else {
            const key = s.target.key;
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(key)) {
              this.error(s.line, 'self.state 键必须是 1-16 位标识符', 'E_STATE_KEY');
            }
            const type = v.t === 'int' ? 'int' : v.t === 'bool' ? 'bool' : 'str';
            if (v.t === 'int' && (v.min < -99 || v.max > 99)) {
              this.error(s.line, 'self.state 整数必须在 -99..99（静态声明上限）', 'E_STATE_RANGE');
            }
            const prior = this.stateKeys.get(key);
            if (prior && prior !== type) {
              this.error(s.line, `self.state["${key}"] 类型不一致（${prior} → ${type}）`, 'E_STATE_TYPE');
            }
            this.stateKeys.set(key, type);
            if (this.stateKeys.size > 4) {
              this.error(s.line, 'self.state 最多 4 个键', 'E_STATE_KEYS');
            }
          }
        }
        return NONE;
      }
      case 'aug': {
        if (s.target === 'ctx' || s.target === 'self') {
          this.error(s.line, `禁止重新绑定保留名 ${s.target}`, 'E_RESERVED');
          return NONE;
        }
        if (!this.checkName(s.target, s.line)) return NONE;
        const cur = env.get(s.target);
        if (!cur) {
          this.error(s.line, `未定义的变量: ${s.target}`, 'E_VAR');
          return NONE;
        }
        if (cur.t !== 'int') {
          this.error(s.line, `增强赋值只支持 int 变量: ${s.target}`, 'E_VAR');
          return NONE;
        }
        const v = this.evalExpr(s.value, env, ctx);
        if (v.t !== 'int') {
          this.error(s.line, '增强赋值的右值必须是 int', 'E_TYPE');
          return NONE;
        }
        if (s.op === '+') env.set(s.target, IV(cur.min + v.min, cur.max + v.max));
        else if (s.op === '-') env.set(s.target, IV(cur.min - v.max, cur.max - v.min));
        else if (s.op === '*') {
          const cands = [cur.min * v.min, cur.min * v.max, cur.max * v.min, cur.max * v.max];
          env.set(s.target, IV(Math.min(...cands), Math.max(...cands)));
        } else if (s.op === '%') {
          if (v.min <= 0) this.error(s.line, '取模除数可能为 0，拒绝编译', 'E_DIV_ZERO');
          env.set(s.target, IV(0, Math.max(0, Math.abs(v.max) - 1)));
        }
        return NONE;
      }
      case 'expr': {
        this.evalExpr(s.value, env, ctx);
        return NONE;
      }
      case 'if': {
        const test = this.evalExpr(s.test, env, ctx);
        if (test.t !== 'bool') {
          this.error(s.line, 'if 条件必须是 bool 表达式', 'E_TYPE');
          return NONE;
        }
        if (ctx.depth + 1 > this.limits.maxNesting) {
          this.error(s.line, `嵌套深度超过 ${this.limits.maxNesting} 层`, 'E_NESTING');
          return NONE;
        }
        const before = cloneEnv(env);
        const nest = Math.min(BUDGET.nestingCap, Math.pow(BUDGET.nestingFactor, ctx.depth));
        const baseCost = this.meter.cost;
        const baseCredits = this.meter.credits;
        const baseMeter = this.meter;
        if (test.v === true) {
          this.analyzeBlock(s.body, env, { ...ctx, depth: ctx.depth + 1, conditional: ctx.conditional });
          this.meter.cost = baseCost + (this.meter.cost - baseCost) * nest;
          this.meter.credits = baseCredits + (this.meter.credits - baseCredits) * nest;
          return NONE;
        }
        if (test.v === false) {
          this.analyzeBlock(s.orelse, env, { ...ctx, depth: ctx.depth + 1, conditional: ctx.conditional });
          this.meter.cost = baseCost + (this.meter.cost - baseCost) * nest;
          this.meter.credits = baseCredits + (this.meter.credits - baseCredits) * nest;
          return NONE;
        }
        const mb = new Meter();
        const me = new Meter();
        const envB = cloneEnv(before);
        const envE = cloneEnv(before);
        const saved = this.meter;
        this.meter = mb;
        this.analyzeBlock(s.body, envB, { ...ctx, depth: ctx.depth + 1, conditional: true });
        this.meter = me;
        this.analyzeBlock(s.orelse, envE, { ...ctx, depth: ctx.depth + 1, conditional: true });
        this.meter = saved;
        const worst = Meter.max(mb, me);
        worst.negatives = worst.negatives.map((n) => ({ ...n, conditional: true }));
        worst.cost = worst.cost * BUDGET.conditionFactor * nest;
        worst.credits = worst.credits * BUDGET.conditionFactor * nest;
        baseMeter.add(worst);
        const merged = mergeEnv([before, envB, envE]);
        env.clear();
        for (const [k, v] of merged) env.set(k, v);
        return NONE;
      }
      case 'for': {
        if (s.var === 'ctx' || s.var === 'self') {
          this.error(s.line, `禁止用 ${s.var} 作为循环变量`, 'E_RESERVED');
          return NONE;
        }
        const spec = this.loopSpec(s.iter, env, s.line);
        if (!spec) return NONE;
        this.meter.totalIterations += spec.bound;
        if (ctx.loopDepth + 1 > this.limits.maxLoopDepth) {
          this.error(s.line, `循环嵌套超过 ${this.limits.maxLoopDepth} 层`, 'E_LOOP_DEPTH');
          return NONE;
        }
        if (ctx.depth + 1 > this.limits.maxNesting) {
          this.error(s.line, `嵌套深度超过 ${this.limits.maxNesting} 层`, 'E_NESTING');
          return NONE;
        }
        const nest = Math.min(BUDGET.nestingCap, Math.pow(BUDGET.nestingFactor, ctx.depth));
        const before = cloneEnv(env);
        const loopEnv = cloneEnv(env);
        ctx.fnVars.add(s.var);
        this.varLimitCheck(ctx.fnVars, s.line);
        loopEnv.set(s.var, IV(spec.varMin, spec.varMax));
        const saved = this.meter;
        const bodyMeter = new Meter();
        this.meter = bodyMeter;
        this.analyzeBlock(s.body, loopEnv, {
          ...ctx,
          depth: ctx.depth + 1,
          loopDepth: ctx.loopDepth + 1,
          frequency: ctx.frequency * spec.bound,
        });
        this.meter = saved;
        bodyMeter.cost = bodyMeter.cost * spec.bound * BUDGET.loopFactor * nest;
        bodyMeter.credits = bodyMeter.credits * spec.bound * BUDGET.loopFactor * nest;
        bodyMeter.apiCalls *= spec.bound;
        bodyMeter.pileOps *= spec.bound;
        bodyMeter.totalIterations = bodyMeter.totalIterations * spec.bound;
        this.meter.add(bodyMeter);
        this.checkIterations(s.line);
        // loop assignments may not execute? bound is >= 1 for static analysis
        const merged = mergeEnv([before, loopEnv]);
        env.clear();
        for (const [k, v] of merged) env.set(k, v);
        env.delete(s.var);
        return NONE;
      }
      case 'while': {
        const spec = this.whileSpec(s, env);
        if (!spec) return NONE;
        this.meter.totalIterations += spec.bound;
        if (ctx.loopDepth + 1 > this.limits.maxLoopDepth) {
          this.error(s.line, `循环嵌套超过 ${this.limits.maxLoopDepth} 层`, 'E_LOOP_DEPTH');
          return NONE;
        }
        const nest = Math.min(BUDGET.nestingCap, Math.pow(BUDGET.nestingFactor, ctx.depth));
        const before = cloneEnv(env);
        const loopEnv = cloneEnv(env);
        const varName = this.whileVar(s.test);
        if (varName) loopEnv.set(varName, IV(spec.varMin, spec.varMax));
        const saved = this.meter;
        const bodyMeter = new Meter();
        this.meter = bodyMeter;
        this.analyzeBlock(s.body, loopEnv, {
          ...ctx,
          depth: ctx.depth + 1,
          loopDepth: ctx.loopDepth + 1,
          frequency: ctx.frequency * spec.bound,
        });
        this.meter = saved;
        bodyMeter.cost = bodyMeter.cost * spec.bound * BUDGET.loopFactor * nest;
        bodyMeter.credits = bodyMeter.credits * spec.bound * BUDGET.loopFactor * nest;
        bodyMeter.apiCalls *= spec.bound;
        bodyMeter.pileOps *= spec.bound;
        bodyMeter.totalIterations = bodyMeter.totalIterations * spec.bound;
        this.meter.add(bodyMeter);
        this.checkIterations(s.line);
        env.clear();
        for (const [k, v] of mergeEnv([before, loopEnv])) env.set(k, v);
        if (varName) env.delete(varName);
        return NONE;
      }
      case 'return': {
        if (!s.value) return NONE;
        return this.evalExpr(s.value, env, ctx);
      }
      case 'break':
      case 'continue':
        return NONE;
      case 'pass':
        return NONE;
    }
  }

  private checkIterations(line: number): void {
    if (this.meter.totalIterations > this.limits.maxTotalIterations) {
      this.abort(line, `总迭代次数超过上限 ${this.limits.maxTotalIterations}`, 'E_ITERATIONS');
    }
  }

  whileVar(test: IRExpr): string | null {
    if (test.k !== 'cmp') return null;
    if (test.l.k === 'var') return test.l.name;
    if (test.r.k === 'var') return test.r.name;
    return null;
  }

  whileSpec(s: Extract<IRStmt, { k: 'while' }>, env: Map<string, AV>): LoopSpec | null {
    const test = s.test;
    if (test.k !== 'cmp') {
      this.error(s.line, 'while 的上界无法静态分析：只允许 while var < 常量 的形式，禁止 while True', 'E_WHILE_BOUND');
      return null;
    }
    const varSide = test.l.k === 'var' ? test.l : test.r.k === 'var' ? test.r : null;
    const otherSide = test.l === varSide ? test.r : test.l;
    const constSide = otherSide.k === 'num' || otherSide.k === 'var' ? otherSide : null;
    if (!varSide || !constSide) {
      this.error(s.line, 'while 的上界无法静态分析：必须与整数字面量或已声明的 int 变量比较', 'E_WHILE_BOUND');
      return null;
    }
    const counter = varSide.name;
    const cur = env.get(counter);
    if (!cur || cur.t !== 'int') {
      this.error(s.line, `while 计数器 ${counter} 必须是已声明的 int 变量`, 'E_WHILE_BOUND');
      return null;
    }
    const op = test.l.k === 'var' ? test.op : flipCmp(test.op);
    let limit: number;
    let boundVar: string | null = null;
    if (constSide.k === 'num') {
      limit = constSide.v;
    } else if (constSide.k === 'var') {
      const bound = env.get(constSide.name);
      if (!bound || bound.t !== 'int') {
        this.error(s.line, `while 的边界 ${constSide.name} 必须是已声明的 int 变量`, 'E_WHILE_BOUND');
        return null;
      }
      boundVar = constSide.name;
      limit = op === '<' || op === '<=' ? bound.max : bound.min;
    } else {
      this.error(s.line, 'while 的上界无法静态分析', 'E_WHILE_BOUND');
      return null;
    }
    let dir: 1 | -1;
    if (op === '<' || op === '<=') dir = 1;
    else if (op === '>' || op === '>=') dir = -1;
    else {
      this.error(s.line, 'while 条件必须是 < <= > >= 的边界比较', 'E_WHILE_BOUND');
      return null;
    }

    // Soundness: every iteration must execute exactly the same net counter change.
    // Counter writes inside if/for/while, direct assignments, shadowing, or continue can
    // let the real loop outrun the static bound, so they are rejected outright.
    let netStep = 0;
    let writes = 0;
    let bad = false;
    const literalDelta = (st: Extract<IRStmt, { k: 'aug' }>): number | null => {
      if (st.value.k === 'num') return st.op === '+' ? st.value.v : -st.value.v;
      if (st.value.k === 'un' && st.value.op === '-' && st.value.e.k === 'num') {
        return st.op === '+' ? -st.value.e.v : st.value.e.v;
      }
      return null;
    };
    const scan = (stmts: IRStmt[], depth: number): void => {
      for (const st of stmts) {
        if (bad) return;
        if (st.k === 'continue') {
          this.error(s.line, 'while 循环中禁止 continue：可能跳过计数器更新，上界不可静态分析', 'E_WHILE_BOUND');
          bad = true;
          return;
        }
        if (boundVar && st.k === 'assign' && st.target.k === 'var' && st.target.name === boundVar) {
          this.error(st.line, `while 的边界变量 ${boundVar} 不能在循环体内被修改`, 'E_WHILE_BOUND');
          bad = true;
          return;
        }
        if (boundVar && st.k === 'aug' && st.target === boundVar) {
          this.error(st.line, `while 的边界变量 ${boundVar} 不能在循环体内被修改`, 'E_WHILE_BOUND');
          bad = true;
          return;
        }
        if (st.k === 'assign' && st.target.k === 'var' && st.target.name === counter) {
          this.error(st.line, 'while 循环体不得直接赋值计数器（只允许固定步长的 -= / +=）', 'E_WHILE_BOUND');
          bad = true;
          return;
        }
        if (st.k === 'for' && st.var === counter) {
          this.error(st.line, 'while 循环体不得用 for 覆盖计数器', 'E_WHILE_BOUND');
          bad = true;
          return;
        }
        if (st.k === 'aug' && st.target === counter) {
          if (depth > 0) {
            this.error(st.line, '计数器更新必须无条件位于 while 体顶层，不能藏在 if/循环内', 'E_WHILE_BOUND');
            bad = true;
            return;
          }
          const d = literalDelta(st);
          if (d === null) {
            this.error(st.line, 'while 计数器步长必须是整数字面量', 'E_WHILE_BOUND');
            bad = true;
            return;
          }
          netStep += d;
          writes++;
        }
        if (st.k === 'if') {
          scan(st.body, depth + 1);
          scan(st.orelse, depth + 1);
        } else if (st.k === 'for' || st.k === 'while') {
          scan(st.body, depth + 1);
        }
      }
    };
    scan(s.body, 0);
    if (bad) return null;
    if (writes === 0 || netStep === 0 || Math.sign(netStep) !== dir) {
      this.error(s.line, `while 循环体必须使 ${counter} 朝边界方向固定步长递增/递减（净步长非 0）`, 'E_WHILE_BOUND');
      return null;
    }
    const step = netStep;
    let bound = 0;
    if (dir === 1) {
      const last = op === '<' ? limit - 1 : limit;
      const start = cur.min;
      bound = last < start ? 0 : Math.floor((last - start) / step) + 1;
    } else {
      const last = op === '>' ? limit + 1 : limit;
      const start = cur.max;
      bound = last > start ? 0 : Math.floor((start - last) / -step) + 1;
    }
    if (!Number.isFinite(bound) || bound < 0) {
      this.error(s.line, 'while 上界无法静态分析', 'E_WHILE_BOUND');
      return null;
    }
    if (bound > this.limits.maxLoopBound) {
      this.error(s.line, `循环上界 ${bound} 超过上限 ${this.limits.maxLoopBound}`, 'E_LOOP_BOUND');
      return null;
    }
    // Counter range actually reachable inside the loop body, so index math can be bounds-checked.
    let varMin: number;
    let varMax: number;
    if (dir === 1) {
      const lastAllowed = op === '<' ? limit - 1 : limit;
      varMin = Math.min(cur.min, lastAllowed);
      const reached = bound === 0 ? cur.max : Math.min(lastAllowed, cur.min + (bound - 1) * step);
      varMax = Math.min(lastAllowed, Math.max(cur.max, reached));
    } else {
      const lastAllowed = op === '>' ? limit + 1 : limit;
      varMax = Math.max(cur.max, lastAllowed);
      const reached = bound === 0 ? cur.min : Math.max(lastAllowed, cur.max + (bound - 1) * step);
      varMin = Math.max(lastAllowed, Math.min(cur.min, reached));
    }
    return { bound, varMin, varMax };
  }

  loopSpec(iter: IRExpr, env: Map<string, AV>, line: number): LoopSpec | null {
    if (iter.k !== 'call' || iter.fn.k !== 'var' || iter.fn.name !== 'range') {
      this.error(line, 'for 循环只能迭代 range(常量或寄存器) 且上界必须可静态分析', 'E_LOOP_BOUND');
      return null;
    }
    const args = iter.args;
    if (args.length < 1 || args.length > 3) {
      this.error(line, 'range 需要 1-3 个参数', 'E_LOOP_BOUND');
      return null;
    }
    const vals = args.map((a) => this.evalExpr(a, env, this.mockCtx()));
    if (vals.some((v) => v.t !== 'int')) {
      this.error(line, 'range 参数必须是 int', 'E_TYPE');
      return null;
    }
    const ints = vals as { t: 'int'; min: number; max: number }[];
    let start = 0;
    let end = ints[0].max;
    let step = 1;
    if (args.length >= 2) {
      start = ints[0].min;
      end = ints[1].max;
    }
    if (args.length === 3) {
      if (ints[2].min !== ints[2].max || ints[2].max <= 0) {
        this.error(line, 'range 步长必须是正的整数字面量', 'E_LOOP_BOUND');
        return null;
      }
      step = ints[2].max;
    }
    const bound = Math.max(0, Math.ceil((end - start) / step));
    if (bound > this.limits.maxLoopBound) {
      this.error(line, `循环上界 ${bound} 超过上限 ${this.limits.maxLoopBound}`, 'E_LOOP_BOUND');
      return null;
    }
    const varMax = bound === 0 ? start : start + (bound - 1) * step;
    return { bound, varMin: start, varMax };
  }

  private mockCtx(): Ctx {
    return { depth: 0, loopDepth: 0, frequency: 1, conditional: false, fnVars: new Set(), fnName: '' };
  }

  evalExpr(e: IRExpr, env: Map<string, AV>, ctx: Ctx): AV {
    switch (e.k) {
      case 'num':
        if (!Number.isInteger(e.v)) {
          this.error(e.line, '只支持整数常量', 'E_TYPE');
          return IV(0, 0);
        }
        return intVal(e.v);
      case 'str':
        return { t: 'str', vals: new Set([e.v]) };
      case 'bool':
        return { t: 'bool', v: e.v };
      case 'none':
        return NONE;
      case 'var': {
        if (e.name === 'ctx') return OBJ('ctx');
        if (e.name === 'self') return OBJ('unit');
        if (!this.checkName(e.name, e.line)) return IV(0, 0);
        const v = env.get(e.name);
        if (!v) {
          this.error(e.line, `未定义的变量: ${e.name}`, 'E_VAR');
          return IV(0, 0);
        }
        return v;
      }
      case 'selffield': {
        const field = this.constFields.get(e.name);
        if (!field) {
          this.error(e.line, `禁止访问 self.${e.name}（卡牌字段由引擎固定）`, 'E_SELF_FIELD');
          return IV(0, 0);
        }
        return field;
      }
      case 'state': {
        const type = this.stateKeys.get(e.key) ?? 'int';
        if (type === 'bool') return { t: 'bool' };
        if (type === 'str') return { t: 'str', vals: null };
        // Conservative: state ints may hold anything written in earlier turns.
        return IV(-99, 99);
      }
      case 'attr': {
        const base = this.evalExpr(e.obj, env, ctx);
        if (base.t !== 'obj') {
          this.error(e.line, `只能访问快照对象的字段，不能访问 ${e.name}`, 'E_ATTR');
          return IV(0, 0);
        }
        if (e.name.startsWith('__')) {
          this.error(e.line, '禁止访问双下划线属性', 'E_SANDBOX_NAME');
          return IV(0, 0);
        }
        return this.attrValue(base.shape, e.name, e.line);
      }
      case 'sub': {
        const base = this.evalExpr(e.obj, env, ctx);
        if (base.t !== 'list') {
          this.error(e.line, '只能索引列表快照', 'E_TYPE');
          return IV(0, 0);
        }
        const idx = this.evalExpr(e.index, env, ctx);
        if (idx.t !== 'int') {
          this.error(e.line, '列表索引必须是 int', 'E_TYPE');
          return IV(0, 0);
        }
        this.addCost(e.line, BUDGET.listRead);
        return base.elem;
      }
      case 'list': {
        if (e.items.length > this.limits.maxList) {
          this.error(e.line, `列表长度超过上限 ${this.limits.maxList}`, 'E_CONTAINER');
        }
        let elem: AV | null = null;
        for (const it of e.items) {
          const v = this.evalExpr(it, env, ctx);
          if (v.t === 'list' || v.t === 'obj') {
            this.error(e.line, '禁止在临时容器中嵌套容器或引擎对象', 'E_CONTAINER');
          }
          elem = elem ? mergeVal(elem, v) : v;
        }
        this.addCost(e.line, 0.1 + BUDGET.listItem * e.items.length);
        return { t: 'list', minLen: e.items.length, maxLen: e.items.length, elem: elem ?? NONE };
      }
      case 'listcomp': {
        const spec = this.loopSpec(e.iter, env, e.line);
        if (!spec) return { t: 'list', minLen: 0, maxLen: 0, elem: NONE };
        if (spec.bound > this.limits.maxList) {
          this.error(e.line, `推导式长度 ${spec.bound} 超过上限 ${this.limits.maxList}`, 'E_CONTAINER');
          return { t: 'list', minLen: 0, maxLen: 0, elem: NONE };
        }
        const inner = cloneEnv(env);
        inner.set(e.var, IV(spec.varMin, spec.varMax));
        const saved = this.meter;
        const m = new Meter();
        this.meter = m;
        const elt = this.evalExpr(e.elt, inner, { ...ctx, depth: ctx.depth + 1, loopDepth: ctx.loopDepth + 1 });
        if (e.cond) {
          const c = this.evalExpr(e.cond, inner, ctx);
          if (c.t !== 'bool') this.error(e.line, '推导式条件必须是 bool', 'E_TYPE');
        }
        this.meter = saved;
        const nest = Math.min(BUDGET.nestingCap, Math.pow(BUDGET.nestingFactor, ctx.depth));
        this.addCost(e.line, m.cost * spec.bound * BUDGET.loopFactor * nest);
        this.meter.credits += m.credits * spec.bound * BUDGET.loopFactor * nest;
        this.meter.apiCalls += m.apiCalls * spec.bound;
        this.meter.pileOps += m.pileOps * spec.bound;
        this.meter.apiUses.push(...m.apiUses);
        this.meter.negatives.push(...m.negatives);
        this.meter.totalIterations += spec.bound;
        this.checkIterations(e.line);
        this.addCost(e.line, 0.1 + BUDGET.listItem * spec.bound);
        return { t: 'list', minLen: 0, maxLen: spec.bound, elem: elt };
      }
      case 'un': {
        const v = this.evalExpr(e.e, env, ctx);
        if (e.op === 'not') {
          if (v.t !== 'bool') this.error(e.line, 'not 需要 bool 操作数', 'E_TYPE');
          return { t: 'bool', v: v.t === 'bool' ? v.v === undefined ? undefined : !v.v : undefined };
        }
        if (v.t !== 'int') {
          this.error(e.line, '一元 - 需要 int 操作数', 'E_TYPE');
          return IV(0, 0);
        }
        return IV(-v.max, -v.min);
      }
      case 'bin': {
        const vars = exprVariables(e.l) + exprVariables(e.r);
        const operatorTax = BUDGET.exprOp + BUDGET.exprVar * vars + (e.op === '*' ? BUDGET.exprMul + (vars > 1 ? BUDGET.exprChain : 0) : 0);
        this.addCost(e.line, operatorTax);
        const l = this.evalExpr(e.l, env, ctx);
        const r = this.evalExpr(e.r, env, ctx);
        if (l.t !== 'int' || r.t !== 'int') {
          this.error(e.line, `算术运算只支持 int（运算符 ${e.op}）`, 'E_TYPE');
          return IV(0, 0);
        }
        if (e.op === '/') {
          this.error(e.line, '不支持浮点除法 /，请使用 //', 'E_TYPE');
          return IV(0, 0);
        }
        if (e.op === '+') return IV(l.min + r.min, l.max + r.max);
        if (e.op === '-') return IV(l.min - r.max, l.max - r.min);
        if (e.op === '*') {
          const cands = [l.min * r.min, l.min * r.max, l.max * r.min, l.max * r.max];
          return IV(Math.min(...cands), Math.max(...cands));
        }
        if (r.min <= 0 && r.max >= 0) {
          this.error(e.line, '除数可能为 0，拒绝编译', 'E_DIV_ZERO');
          return IV(0, 0);
        }
        if (e.op === '//') {
          const vals = [Math.floor(l.min / r.min), Math.floor(l.min / r.max), Math.floor(l.max / r.min), Math.floor(l.max / r.max)];
          return IV(Math.min(...vals), Math.max(...vals));
        }
        if (e.op === '%') {
          return IV(0, Math.max(0, Math.abs(r.max) - 1));
        }
        this.error(e.line, `不支持的运算符 ${e.op}`, 'E_TYPE');
        return IV(0, 0);
      }
      case 'cmp': {
        const l = this.evalExpr(e.l, env, ctx);
        const r = this.evalExpr(e.r, env, ctx);
        if (l.t === 'int' && r.t === 'int') {
          const definitely = maybeCompare(l, r, e.op);
          return { t: 'bool', v: definitely };
        }
        if (l.t === 'str' && r.t === 'str' && e.op === '==') {
          if (l.vals && r.vals && l.vals.size === 1 && r.vals.size === 1) {
            return { t: 'bool', v: [...l.vals][0] === [...r.vals][0] };
          }
          return { t: 'bool' };
        }
        if (l.t === 'bool' && r.t === 'bool' && (e.op === '==' || e.op === '!=')) {
          if (l.v !== undefined && r.v !== undefined) return { t: 'bool', v: e.op === '==' ? l.v === r.v : l.v !== r.v };
          return { t: 'bool' };
        }
        this.error(e.line, '比较运算的类型不匹配（MVP 不支持混合类型比较）', 'E_TYPE');
        return { t: 'bool' };
      }
      case 'boolop': {
        let result: AV = { t: 'bool' };
        let cost = 0;
        for (const item of e.items) {
          const before = this.meter.cost;
          const v = this.evalExpr(item, env, ctx);
          const c = this.meter.cost - before;
          cost = Math.max(cost, c);
          if (v.t !== 'bool') this.error(e.line, `${e.op} 需要 bool 操作数`, 'E_TYPE');
          result = v;
        }
        if (e.op === 'and' && result.t === 'bool' && result.v === false) return result;
        if (e.op === 'or' && result.t === 'bool' && result.v === true) return result;
        return { t: 'bool' };
      }
      case 'ifexp': {
        const test = this.evalExpr(e.test, env, ctx);
        if (test.t !== 'bool') {
          this.error(e.line, '三元表达式条件必须是 bool', 'E_TYPE');
          return IV(0, 0);
        }
        if (test.v === true) return this.evalExpr(e.body, env, ctx);
        if (test.v === false) return this.evalExpr(e.orelse, env, ctx);
        const saved = this.meter;
        const mb = new Meter();
        const me = new Meter();
        this.meter = mb;
        const vb = this.evalExpr(e.body, env, ctx);
        this.meter = me;
        const ve = this.evalExpr(e.orelse, env, ctx);
        this.meter = saved;
        const worst = Meter.max(mb, me);
        worst.cost *= BUDGET.conditionFactor;
        worst.credits *= BUDGET.conditionFactor;
        this.meter.add(worst);
        return mergeVal(vb, ve);
      }
      case 'call':
        return this.evalCall(e, env, ctx);
    }
  }

  private attrValue(shape: 'ctx' | 'turn' | 'intent' | 'unit' | 'card', name: string, line: number): AV {
    if (shape === 'ctx') {
      if (name === 'turn') return OBJ('turn');
      if (name === 'enemy') return OBJ('unit');
      if (name === 'hand' || name === 'draw_pile' || name === 'discard_pile') {
        this.error(line, '请使用 ctx.getHand()/ctx.getDraw()/ctx.getDiscard() 只读快照，禁止直接访问牌堆存储', 'E_PILE_RAW');
        return NONE;
      }
      this.error(line, `ctx 没有可读字段 ${name}，请使用 ctx.getTurn() 等查询接口`, 'E_CTX_FIELD');
      return NONE;
    }
    if (shape === 'turn') {
      if (name === 'discarded_count' || name === 'played_count') {
        if (this.kind === 'card') this.addCost(line, 1.2);
        this.meter.credits += 1.0;
        return IV(0, 99);
      }
      this.error(line, `turn 快照没有字段 ${name}`, 'E_ATTR');
      return NONE;
    }
    if (shape === 'intent') {
      this.error(line, '对局不提供对手意图预读', 'E_ATTR');
      return NONE;
    }
    if (shape === 'unit') {
      this.error(line, `单位快照请使用 ctx.enemy.hp() / ctx.enemy.block()`, 'E_ATTR');
      return NONE;
    }
    if (shape === 'card') {
      // Battle-time card instances expose only their name and energy cost.
      // Full type/target/description/source belong to the known deck design.
      if (name === 'name') return { t: 'str', vals: null };
      if (name === 'cost') return IV(0, 5);
      this.error(line, `卡牌实例只开放 name 与 cost，没有字段 ${name}`, 'E_ATTR');
      return NONE;
    }
    this.error(line, `未知快照字段 ${name}`, 'E_ATTR');
    return NONE;
  }

  private evalCall(e: Extract<IRExpr, { k: 'call' }>, env: Map<string, AV>, ctx: Ctx): AV {
    if (e.fn.k === 'attr') {
      if (e.fn.obj.k === 'var' && e.fn.obj.name === 'ctx') {
        return this.callApi(e.fn.name, e.args, e.line, env, ctx);
      }
      if (
        e.fn.obj.k === 'attr' &&
        e.fn.obj.obj.k === 'var' &&
        e.fn.obj.obj.name === 'ctx' &&
        e.fn.obj.name === 'enemy' &&
        (e.fn.name === 'hp' || e.fn.name === 'block')
      ) {
        if (e.args.length > 0) {
          this.error(e.line, `ctx.enemy.${e.fn.name}() 不接受参数`, 'E_ARGS');
          return NONE;
        }
        this.addCost(e.line, this.kind === 'card' ? CARD_READ_EFFECT_COST[`enemy.${e.fn.name}`] : 0.05);
        this.meter.credits += creditCost(`enemy.${e.fn.name}`, e.fn.name === 'hp' ? 100 : 120);
        return IV(0, e.fn.name === 'hp' ? 100 : 999);
      }
      this.error(e.line, '只能调用 ctx.* 游戏 API，禁止调用对象方法', 'E_CALL');
      return NONE;
    }
    if (e.fn.k !== 'var') {
      this.error(e.line, '调用目标必须是 ctx API 或白名单函数', 'E_CALL');
      return NONE;
    }
    const name = e.fn.name;
    if (!this.checkName(name, e.line)) return NONE;
    if (this.compiledHelpers.has(name)) {
      return this.callHelper(name, e.args, e.line, env, ctx);
    }
    if (BUILTINS.has(name)) {
      return this.callBuiltin(name, e.args, e.line, env, ctx);
    }
    this.error(e.line, `未知或不安全的函数调用: ${name}`, 'E_UNKNOWN_CALL');
    return NONE;
  }

  private callBuiltin(name: string, args: IRExpr[], line: number, env: Map<string, AV>, ctx: Ctx): AV {
    if (name === 'range') {
      this.error(line, 'range() 只能直接用于 for 循环', 'E_FOR_ONLY');
      return NONE;
    }
    const vals = args.map((a) => this.evalExpr(a, env, ctx));
    if (name === 'len') {
      if (vals.length !== 1) {
        this.error(line, 'len() 需要 1 个参数', 'E_ARGS');
        return IV(0, 0);
      }
      const v = vals[0];
      if (v.t === 'list') {
        this.addCost(line, BUDGET.listRead);
        return IV(v.minLen, v.maxLen);
      }
      if (v.t === 'str') return IV(0, 64);
      this.error(line, 'len() 只接受列表或字符串快照', 'E_TYPE');
      return IV(0, 0);
    }
    if (name === 'int') {
      if (vals.length !== 1) {
        this.error(line, 'int() 需要 1 个参数', 'E_ARGS');
        return IV(0, 0);
      }
      const v = vals[0];
      if (v.t === 'int') return v;
      if (v.t === 'bool') return IV(0, 1);
      this.error(line, 'int() 只接受 int/bool', 'E_TYPE');
      return IV(0, 0);
    }
    if (name === 'bool') {
      if (vals.length !== 1) {
        this.error(line, 'bool() 需要 1 个参数', 'E_ARGS');
        return { t: 'bool' };
      }
      if (vals[0].t === 'bool') return vals[0];
      if (vals[0].t === 'int') return { t: 'bool', v: vals[0].min > 0 ? true : vals[0].max === 0 ? false : undefined };
      this.error(line, 'bool() 只接受 int/bool', 'E_TYPE');
      return { t: 'bool' };
    }
    if (name === 'str') {
      if (vals.length !== 1) {
        this.error(line, 'str() 需要 1 个参数', 'E_ARGS');
        return { t: 'str', vals: null };
      }
      if (vals[0].t === 'str') return vals[0];
      return { t: 'str', vals: null };
    }
    if (name === 'abs' || name === 'min' || name === 'max') {
      const need = name === 'abs' ? 1 : 2;
      if (vals.length !== need) {
        this.error(line, `${name}() 需要 ${need} 个参数`, 'E_ARGS');
        return IV(0, 0);
      }
      if (vals.some((v) => v.t !== 'int')) {
        this.error(line, `${name}() 只接受 int`, 'E_TYPE');
        return IV(0, 0);
      }
      const ints = vals as { t: 'int'; min: number; max: number }[];
      if (name === 'abs') return IV(Math.min(Math.abs(ints[0].min), Math.abs(ints[0].max)), Math.max(Math.abs(ints[0].min), Math.abs(ints[0].max)));
      if (name === 'min') return IV(Math.min(ints[0].min, ints[1].min), Math.min(ints[0].max, ints[1].max));
      return IV(Math.max(ints[0].min, ints[1].min), Math.max(ints[0].max, ints[1].max));
    }
    this.error(line, `未知白名单函数: ${name}`, 'E_CALL');
    return NONE;
  }

  private callHelper(name: string, args: IRExpr[], line: number, env: Map<string, AV>, ctx: Ctx): AV {
    const fn = this.compiledHelpers.get(name)!;
    if (this.helperCallStack.includes(name)) {
      this.error(line, `递归调用被拒绝: ${name}`, 'E_RECURSION');
      return IV(0, 0);
    }
    if (this.helperCallStack.length >= this.limits.maxCallDepth) {
      this.error(line, `调用深度超过上限 ${this.limits.maxCallDepth}`, 'E_CALL_DEPTH');
      return IV(0, 0);
    }
    if (fn.params.length !== args.length) {
      this.error(line, `${name}() 需要 ${fn.params.length} 个参数，实际 ${args.length}`, 'E_ARGS');
      return IV(0, 0);
    }
    const vals = args.map((a) => this.evalExpr(a, env, ctx));
    const local = new Map<string, AV>();
    fn.params.forEach((p, i) => {
      if (!this.checkName(p, fn.line)) return;
      local.set(p, vals[i]);
    });
    const vars = new Set(fn.params);
    this.helperCallStack.push(name);
    const saved = this.meter;
    const m = new Meter();
    this.meter = m;
    const ret = this.analyzeBlock(fn.body, local, {
      depth: ctx.depth,
      loopDepth: ctx.loopDepth,
      frequency: ctx.frequency,
      conditional: ctx.conditional,
      fnVars: vars,
      fnName: name,
    });
    this.meter = saved;
    this.helperCallStack.pop();
    saved.add(m);
    if (vars.size > this.limits.maxVars) {
      this.error(fn.line, `辅助函数 ${name} 的局部变量超过上限`, 'E_VARS');
    }
    return ret;
  }

  private needArgs(api: ApiSpec, args: IRExpr[], line: number): boolean {
    const required = api.args.filter((a) => !a.optional).length;
    const max = api.args.length;
    if (args.length < required || args.length > max) {
      this.error(line, `${api.name}() 需要 ${required}${required === max ? '' : `-${max}`} 个参数，实际 ${args.length}`, 'E_ARGS');
      return false;
    }
    return true;
  }

  private validateArg(type: string, v: AV, line: number, apiName: string): boolean {
    if (type === 'int') {
      if (v.t !== 'int') {
        this.error(line, `${apiName}() 的数值参数必须是 int`, 'E_TYPE');
        return false;
      }
      if (v.max > BUDGET.maxSafe || v.min < -BUDGET.maxSafe) {
        this.error(line, `${apiName}() 数值超出安全范围`, 'E_RANGE');
        return false;
      }
      return true;
    }
    if (type === 'str') {
      if (v.t !== 'str') {
        this.error(line, `${apiName}() 的文本参数必须是字符串`, 'E_TYPE');
        return false;
      }
      return true;
    }
    if (type === 'intlist') {
      if (v.t !== 'list' || v.elem.t !== 'int') {
        this.error(line, `${apiName}() 需要 int 数组`, 'E_TYPE');
        return false;
      }
      if (v.maxLen > LIMITS.script.maxList) {
        this.error(line, `${apiName}() 的数组长度 ${v.maxLen} 超过上限 ${LIMITS.script.maxList}`, 'E_CONTAINER');
        return false;
      }
      return true;
    }
    if (type === 'key') {
      if (v.t !== 'str' || !v.vals || [...v.vals].some((x) => x !== 'cost')) {
        this.error(line, `${apiName}() 的排序键只能是 "cost"`, 'E_ENUM');
        return false;
      }
      return true;
    }
    if (type === 'direction') {
      if (v.t !== 'str' || !v.vals || [...v.vals].some((x) => x !== 'asc' && x !== 'desc')) {
        this.error(line, `${apiName}() 的排序方向只能是 "asc" 或 "desc"`, 'E_ENUM');
        return false;
      }
      return true;
    }
    return true;
  }

  private checkOrderLiteral(expr: IRExpr, line: number): boolean {
    if (expr.k !== 'list') return true;
    const values: number[] = [];
    for (const item of expr.items) {
      if (item.k !== 'num') {
        this.error(line, 'apply_order() 的数组字面量只能包含整数', 'E_LITERAL');
        return false;
      }
      values.push(item.v);
    }
    for (const v of values) {
      if (v < 0 || v >= LIMITS.script.maxList) {
        this.error(line, `apply_order() 的下标 ${v} 超出 0..${LIMITS.script.maxList - 1}`, 'E_RANGE');
        return false;
      }
    }
    if (new Set(values).size !== values.length) {
      this.error(line, 'apply_order() 的数组字面量不能有重复下标', 'E_ORDER');
      return false;
    }
    return true;
  }

  private literal(v: AV, allowed: readonly string[], line: number, label: string): string | null {
    if (v.t !== 'str' || !v.vals || v.vals.size !== 1) {
      this.error(line, `${label} 必须是字符串字面量（禁止动态拼接）`, 'E_LITERAL');
      return null;
    }
    const s = [...v.vals][0];
    if (!allowed.includes(s)) {
      this.error(line, `${label} 必须是 ${allowed.join('/')} 之一，实际为 ${JSON.stringify(s)}`, 'E_ENUM');
      return null;
    }
    return s;
  }

  private register(name: string): RegisterDecl | undefined {
    return this.registers.find((r) => r.name === name);
  }

  private callApi(name: string, args: IRExpr[], line: number, env: Map<string, AV>, ctx: Ctx): AV {
    const api = API_BY_NAME.get(name);
    if (!api) {
      this.error(line, `未知 API: ${name}`, 'E_API');
      return NONE;
    }
    if (api.scope !== 'both' && api.scope !== this.program.kind) {
      this.error(line, `${name}() 在${this.program.kind === 'card' ? '卡牌' : '回合脚本'}中不可用`, 'E_SCOPE');
      return NONE;
    }
    if (!this.needArgs(api, args, line)) return NONE;
    const vals = args.map((a) => this.evalExpr(a, env, ctx));
    for (let i = 0; i < vals.length && i < api.args.length; i++) {
      if (!this.validateArg(api.args[i].type, vals[i], line, name)) return NONE;
    }
    let magnitude = 0;
    let earlyReturn: AV | null = null;
    if (api.listArg !== undefined) {
      const listVal = vals[api.listArg];
      if (listVal.t === 'list') magnitude = Math.max(magnitude, listVal.maxLen);
    }
    if (api.fixedMagnitude !== undefined) magnitude = Math.max(magnitude, api.fixedMagnitude);
    if (api.amountArg !== undefined) {
      const v = vals[api.amountArg];
      if (!this.validateArg('int', v, line, name)) return NONE;
      const iv = v as { t: 'int'; min: number; max: number };
      if (iv.max < 0) {
        this.error(line, `${name}() 的数值必须 >= 0`, 'E_RANGE');
        return NONE;
      }
      magnitude = iv.max;
    }
    if (name === 'pile_costs' || name === 'getPile' || name === 'swap' || name === 'move_card') {
      if (!this.literal(vals[0], ['draw', 'hand', 'discard'], line, '牌堆')) return NONE;
    }
    if (name === 'move_card' && !this.literal(vals[2], ['draw', 'hand', 'discard'], line, '牌堆')) return NONE;
    if (name === 'deal_damage') {
      if (!this.literal(vals[0], ['self', 'enemy'], line, '目标')) return NONE;
    }
    if (name === 'swap' || name === 'move_card') {
      const idxArgs = name === 'swap' ? [1, 2] : [1, 3];
      for (const i of idxArgs) {
        const v = vals[i];
        if (v.t === 'int' && v.min < 0) {
          this.error(line, `${name}() 的下标不能为负`, 'E_RANGE');
          return NONE;
        }
      }
    }
    if (name === 'set_global') {
      if (vals[0].t !== 'str' || !vals[0].vals || vals[0].vals.size !== 1) {
        this.error(line, 'set_global() 的寄存器名必须是字符串字面量', 'E_LITERAL');
        return NONE;
      }
      const regName = [...vals[0].vals][0];
      const reg = this.register(regName);
      if (!reg) {
        this.error(line, `未声明的寄存器: ${regName}`, 'E_REGISTER');
        return NONE;
      }
      const val = vals[1];
      if (reg.type === 'int') {
        if (val.t !== 'int') {
          this.error(line, `寄存器 ${regName} 需要 int`, 'E_REGISTER_TYPE');
        } else if (val.max > reg.max || val.min < reg.min) {
          this.error(line, `寄存器 ${regName} 范围 [${reg.min}, ${reg.max}]，写入可能越界 [${val.min}, ${val.max}]`, 'E_REGISTER_RANGE');
        }
      } else if (reg.type === 'bool') {
        if (val.t !== 'bool') this.error(line, `寄存器 ${regName} 需要 bool`, 'E_REGISTER_TYPE');
      } else {
        if (val.t !== 'str' || !val.vals) {
          this.error(line, `寄存器 ${regName} 需要 enum 字符串`, 'E_REGISTER_TYPE');
        } else if (reg.enumValues) {
          for (const v of val.vals) {
            if (!reg.enumValues.includes(v)) {
              this.error(line, `寄存器 ${regName} 不接受枚举值 ${JSON.stringify(v)}`, 'E_REGISTER_RANGE');
            }
          }
        }
      }
    }
    if (name === 'get_global') {
      const regName = this.literal(vals[0], this.registers.map((r) => r.name), line, '寄存器');
      if (!regName) return NONE;
      const reg = this.register(regName)!;
      earlyReturn = reg.type === 'int' ? IV(reg.min, reg.max) : reg.type === 'bool' ? { t: 'bool' } : { t: 'str', vals: new Set(reg.enumValues ?? []) };
    }
    if (name === 'random_int') {
      const a = vals[0] as { t: 'int'; min: number; max: number };
      const b = vals[1] as { t: 'int'; min: number; max: number };
      if (a.min < 0) {
        this.error(line, 'random_int 下限必须 >= 0', 'E_RANGE');
        return NONE;
      }
      if (a.max > b.min) {
        this.error(line, 'random_int 的最小值可能大于最大值，拒绝编译', 'E_RANGE');
        return NONE;
      }
    }

    if (name === 'random_int') {
      const a = vals[0] as { t: 'int'; min: number; max: number };
      const b = vals[1] as { t: 'int'; min: number; max: number };
      magnitude = Math.max(0, b.max - a.min);
    }
    let creditMagnitude = magnitude;
    if (api.cat === 'read') {
      const maxRead: Record<string, number> = {
        hand_size: 10, draw_size: 10, discard_size: 10,
        getHand: 10, getDraw: 10, getDiscard: 10, getPile: 10, pile_costs: 10,
        getTurn: 30, getEnergy: 5, getBlock: 120,
        getMaxEnergy: 5, getHandLimit: 10, getDrawLimit: 10,
      };
      creditMagnitude = maxRead[name] ?? magnitude;
      if (name === 'get_global') {
        const regName = [...(((vals[0] as { vals?: Set<string> }).vals) ?? [])][0];
        const reg = regName ? this.register(regName) : undefined;
        creditMagnitude = reg && reg.type === 'int' ? Math.max(Math.abs(reg.min), Math.abs(reg.max)) : 0;
      }
    }
    const baseCost = api.base + (api.perUnit ?? 0) * magnitude;
    const cost = this.kind === 'card' && CARD_READ_EFFECT_COST[name] !== undefined
      ? CARD_READ_EFFECT_COST[name]
      : baseCost;
    const credits = creditCost(name, creditMagnitude);
    this.meter.credits += credits;
    this.addCost(line, cost);
    if (api.cat !== 'read' && api.cat !== 'log') this.meter.apiCalls += 1;
    if (['pile', 'draw', 'discard', 'play'].includes(api.cat)) this.meter.pileOps += 1;
    this.meter.apiUses.push({ name, line, cost, credits });
    const repeats = Math.max(1, ctx.frequency);
    this.meter.calls[name] = (this.meter.calls[name] ?? 0) + repeats;
    if (name === 'gain_energy') this.meter.energyGain += magnitude * repeats;

    if (name === 'deal_damage' && [...(vals[0].t === 'str' ? vals[0].vals ?? [] : [])].includes('self')) {
      this.meter.negatives.push({
        kind: 'self_damage',
        base: NEGATIVE_BASE.self_damage(magnitude),
        line,
        frequency: ctx.frequency,
        conditional: ctx.conditional,
      });
      this.cardWide.selfDamageMax += magnitude * Math.max(1, ctx.frequency);
    }
    if (api.negative === 'discard') {
      this.meter.negatives.push({
        kind: 'discard',
        base: NEGATIVE_BASE.discard(magnitude),
        line,
        frequency: ctx.frequency,
        conditional: ctx.conditional,
      });
      this.cardWide.discardMax += magnitude * Math.max(1, ctx.frequency);
    }
    if (api.negative === 'energy_loss') {
      this.meter.negatives.push({
        kind: 'energy_loss',
        base: NEGATIVE_BASE.energy_loss(magnitude),
        line,
        frequency: ctx.frequency,
        conditional: ctx.conditional,
      });
    }
    if (name === 'heal') this.cardWide.healMax = Math.max(this.cardWide.healMax, magnitude * Math.max(1, ctx.frequency));
    if (name === 'draw') this.cardWide.drawMax = Math.max(this.cardWide.drawMax, magnitude * Math.max(1, ctx.frequency));

    if (name === 'getHand' || name === 'getDraw' || name === 'getDiscard' || name === 'getPile') {
      const maxLen = name === 'getHand' ? LIMITS.deck.handCap : LIMITS.deck.hardMax;
      return { t: 'list', minLen: 0, maxLen, elem: OBJ('card'), cards: true };
    }
    if (name === 'hand_size') return IV(0, LIMITS.deck.handCap);
    if (name === 'draw_size') return IV(0, LIMITS.deck.hardMax);
    if (name === 'discard_size') return IV(0, LIMITS.deck.totalInstances);
    if (name === 'pile_costs') return { t: 'list', minLen: 0, maxLen: LIMITS.deck.handCap, elem: IV(0, 4) };
    if (name === 'playcard') return { t: 'bool' };
    if (name === 'getTurn') return IV(1, 30);
    if (name === 'getEnergy') return IV(0, 99);
    if (name === 'getBlock') return IV(0, 33);
    if (name === 'getMaxEnergy') return IV(5, 5);
    if (name === 'getHandLimit') return IV(LIMITS.deck.handCap, LIMITS.deck.handCap);
    if (name === 'getDrawLimit') return IV(LIMITS.deck.hardMax, LIMITS.deck.hardMax);
    if (name === 'random_int') {
      const a = vals[0] as { t: 'int'; min: number; max: number };
      const b = vals[1] as { t: 'int'; min: number; max: number };
      return IV(a.min, b.max);
    }
    if (earlyReturn) return earlyReturn;
    return NONE;
  }

  private readonly constFields = new Map<string, AV>();
  setCardField(name: string, v: AV): void {
    this.constFields.set(name, v);
  }

  finalize(extraMeter: Meter, kind: 'card' | 'script'): Meter {
    const m = this.meter;
    m.add(extraMeter);
    m.totalIterations = Math.max(m.totalIterations, extraMeter.totalIterations);
    if (this.program.nodeCount > this.limits.maxAst) {
      this.error(1, `AST 节点数 ${this.program.nodeCount} 超过上限 ${this.limits.maxAst}`, 'E_AST');
    }
    if (this.program.lines < (kind === 'card' ? LIMITS.card.minLines : LIMITS.script.minLines)) {
      this.error(1, `有效代码行数 ${this.program.lines} 低于下限`, 'E_LINES');
    }
    if (this.program.lines > this.limits.maxLines) {
      this.error(1, `有效代码行数 ${this.program.lines} 超过上限 ${this.limits.maxLines}`, 'E_LINES');
    }
    if (m.listWrites > this.limits.maxListWrites) {
      this.error(1, `数组写入次数 ${m.listWrites} 超过上限 ${this.limits.maxListWrites}`, 'E_LIST_WRITES');
    }
    if (kind === 'script' && m.credits > CREDIT_BUDGET + 1e-9) {
      const top = [...m.apiUses]
        .sort((a, b) => b.credits - a.credits)
        .slice(0, 3)
        .map((u) => `${u.name} ${u.credits.toFixed(1)}`)
        .join('、');
      this.error(
        1,
        `本回合算力 ${m.credits.toFixed(1)} / ${CREDIT_BUDGET}，超出 ${(m.credits - CREDIT_BUDGET).toFixed(1)}。大头：${top || '无'}。调度（playcard/swap/move_card）最便宜，攻防与资源最贵`,
        'E_CREDITS',
      );
    }
    return m;
  }

  computeR(m: Meter, P: number): { R: number; negatives: NegativeUse[] } {
    const sameKindIndex = new Map<string, number>();
    const out: NegativeUse[] = [];
    let raw = 0;
    for (const neg of m.negatives) {
      const idx = sameKindIndex.get(neg.kind) ?? 0;
      sameKindIndex.set(neg.kind, idx + 1);
      if (idx >= 3) continue;
      const decay = [1, 0.5, 0.25][Math.min(idx, 2)];
      const freqMult = Math.min(3, 1 + 0.4 * Math.max(0, neg.frequency - 1));
      const condMult = neg.conditional ? 0.7 : 1;
      let fakeMult = 1;
      if (neg.kind === 'self_damage') {
        if (this.cardWide.healMax > 0) {
          fakeMult *= this.cardWide.healMax >= this.cardWide.selfDamageMax ? 0.3 : 0.6;
        }
      }
      if (neg.kind === 'discard' && this.cardWide.drawMax >= this.cardWide.discardMax) {
        fakeMult *= 0.5;
      }
      const credit = neg.base * decay * freqMult * condMult * fakeMult;
      raw += credit;
      out.push({ kind: neg.kind, line: neg.line, base: neg.base, credit, frequency: neg.frequency });
    }
    const cap = P * BUDGET.rCap;
    if (raw > cap) {
      const scale = cap / raw;
      for (const n of out) n.credit *= scale;
      raw = cap;
    }
    return { R: raw, negatives: out };
  }

  validateStructure(kind: 'card' | 'script'): void {
    if (kind === 'card') {
      if (this.program.functions.length > LIMITS.card.maxHelpers) {
        this.error(1, `辅助函数超过上限 ${LIMITS.card.maxHelpers}`, 'E_HELPERS');
      }
      for (const f of this.program.functions) {
        if (BANNED_NAMES.has(f.name)) this.error(f.line, `禁止的函数名: ${f.name}`, 'E_SANDBOX_NAME');
        for (const p of f.params) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) this.error(f.line, '非法参数名', 'E_NAMES');
      }
    } else {
      if (this.program.functions.length > LIMITS.script.maxHelpers) {
        this.error(1, `辅助函数超过上限 ${LIMITS.script.maxHelpers}`, 'E_HELPERS');
      }
    }
    this.checkCallGraph();
  }
}

function flipCmp(op: string): string {
  return ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' } as Record<string, string>)[op] ?? op;
}

function maybeCompare(l: { min: number; max: number }, r: { min: number; max: number }, op: string): boolean | undefined {
  if (op === '<') {
    if (l.max < r.min) return true;
    if (l.min >= r.max) return false;
    return undefined;
  }
  if (op === '<=') {
    if (l.max <= r.min) return true;
    if (l.min > r.max) return false;
    return undefined;
  }
  if (op === '>') {
    if (l.min > r.max) return true;
    if (l.max <= r.min) return false;
    return undefined;
  }
  if (op === '>=') {
    if (l.min >= r.max) return true;
    if (l.max < r.min) return false;
    return undefined;
  }
  if (op === '==') {
    if (l.min === l.max && r.min === r.max) return l.min === r.min;
    if (l.max < r.min || l.min > r.max) return false;
    return undefined;
  }
  if (op === '!=') {
    if (l.min === l.max && r.min === r.max) return l.min !== r.min;
    if (l.max < r.min || l.min > r.max) return true;
    return undefined;
  }
  return undefined;
}

export function validateRegisters(registers: RegisterDecl[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (registers.length > 3) diagnostics.push({ line: 0, message: '全局寄存器最多 3 个', severity: 'error', code: 'E_REG_COUNT' });
  const names = new Set<string>();
  for (const r of registers) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(r.name)) {
      diagnostics.push({ line: 0, message: `寄存器名非法: ${r.name}`, severity: 'error', code: 'E_REG_NAME' });
    }
    if (names.has(r.name)) diagnostics.push({ line: 0, message: `寄存器重名: ${r.name}`, severity: 'error', code: 'E_REG_NAME' });
    names.add(r.name);
    if (r.type === 'int') {
      if (!Number.isInteger(r.initial) || (r.initial as number) < r.min || (r.initial as number) > r.max) {
        diagnostics.push({ line: 0, message: `寄存器 ${r.name} 初始值超出范围`, severity: 'error', code: 'E_REG_INIT' });
      }
      if (r.min > r.max || r.max - r.min > 1000) {
        diagnostics.push({ line: 0, message: `寄存器 ${r.name} 范围非法`, severity: 'error', code: 'E_REG_RANGE' });
      }
    } else if (r.type === 'bool') {
      if (typeof r.initial !== 'boolean') {
        diagnostics.push({ line: 0, message: `寄存器 ${r.name} 需要 bool 初始值`, severity: 'error', code: 'E_REG_INIT' });
      }
    } else {
      if (!r.enumValues || r.enumValues.length < 1 || r.enumValues.length > 8) {
        diagnostics.push({ line: 0, message: `枚举寄存器 ${r.name} 需要 1-8 个值`, severity: 'error', code: 'E_REG_ENUM' });
      } else if (typeof r.initial !== 'string' || !r.enumValues.includes(r.initial)) {
        diagnostics.push({ line: 0, message: `枚举寄存器 ${r.name} 初始值非法`, severity: 'error', code: 'E_REG_INIT' });
      }
    }
  }
  return diagnostics;
}

function fieldValue(expr: IRExpr): { kind: 'int' | 'str' | 'bad'; value?: number | string; line: number } {
  if (expr.k === 'num') return { kind: 'int', value: expr.v, line: expr.line };
  if (expr.k === 'un' && expr.op === '-' && expr.e.k === 'num') return { kind: 'int', value: -expr.e.v, line: expr.line };
  if (expr.k === 'str') return { kind: 'str', value: expr.v, line: expr.line };
  return { kind: 'bad', line: expr.line };
}

interface CardPrelude {
  name: string;
  declaredCost: number;
  type: 'attack' | 'skill';
  target: 'enemy' | 'self' | 'none';
  className: string;
}

function readCardPrelude(program: IRProgram, diagnostics: Diagnostic[]): CardPrelude | null {
  const card = program.card;
  if (!card) {
    diagnostics.push({ line: 1, message: '未找到 Card 类定义', severity: 'error', code: 'E_CARD' });
    return null;
  }
  if (card.base !== 'Card') {
    diagnostics.push({ line: card.line, message: '类必须继承 Card', severity: 'error', code: 'E_CARD' });
  }
  if (card.effectParams.length !== 2 || card.effectParams[0] !== 'self' || card.effectParams[1] !== 'ctx') {
    diagnostics.push({ line: card.line, message: 'effect 签名必须是 effect(self, ctx)', severity: 'error', code: 'E_CARD' });
  }
  const allowed = new Set(['name', 'cost', 'type', 'target']);
  const map = new Map<string, IRExpr>();
  for (const f of card.fields) {
    if (!allowed.has(f.name)) {
      diagnostics.push({ line: f.line, message: `卡牌字段由引擎固定，禁止声明 ${f.name}`, severity: 'error', code: 'E_CARD_FIELD' });
    } else if (map.has(f.name)) {
      diagnostics.push({ line: f.line, message: `重复字段 ${f.name}`, severity: 'error', code: 'E_CARD_FIELD' });
    } else {
      map.set(f.name, f.value);
    }
  }
  for (const key of allowed) {
    if (!map.has(key)) diagnostics.push({ line: card.line, message: `缺少字段 ${key}`, severity: 'error', code: 'E_CARD_FIELD' });
  }
  if (diagnostics.some((d) => d.severity === 'error')) return null;
  const name = fieldValue(map.get('name')!);
  const cost = fieldValue(map.get('cost')!);
  const type = fieldValue(map.get('type')!);
  const target = fieldValue(map.get('target')!);
  if (name.kind !== 'str' || typeof name.value !== 'string' || name.value.length < 1 || name.value.length > 16) {
    diagnostics.push({ line: name.line, message: 'name 必须是 1-16 字符字符串', severity: 'error', code: 'E_CARD_FIELD' });
  }
  if (cost.kind !== 'int' || (cost.value as number) < 0 || (cost.value as number) > 5) {
    diagnostics.push({ line: cost.line, message: 'cost 必须是 0-5 的整数字面量', severity: 'error', code: 'E_CARD_FIELD' });
  }
  if (type.kind !== 'str' || !CARD_TYPES.includes(type.value as never)) {
    diagnostics.push({ line: type.line, message: `type 必须是 ${CARD_TYPES.join('/')}`, severity: 'error', code: 'E_CARD_FIELD' });
  }
  if (target.kind !== 'str' || !CARD_TARGETS.includes(target.value as never)) {
    diagnostics.push({ line: target.line, message: `target 必须是 ${CARD_TARGETS.join('/')}`, severity: 'error', code: 'E_CARD_FIELD' });
  }
  if (diagnostics.some((d) => d.severity === 'error')) return null;
  return {
    className: card.className,
    name: name.value as string,
    declaredCost: cost.value as number,
    type: type.value as CardPrelude['type'],
    target: target.value as CardPrelude['target'],
  };
}

export function compileCard(source: string, registers: RegisterDecl[]): CompileResult<CompiledCard> {
  const diagnostics: Diagnostic[] = [];
  let program: IRProgram;
  try {
    const mod = parseModule(source);
    const lowered = lowerCard(mod);
    program = lowered.program;
    diagnostics.push(...lowered.errors.map((e) => ({ ...e, severity: 'error' as const, code: 'E_LOWER' })));
  } catch (err) {
    const pe = err as ParseError;
    return { ok: false, diagnostics: [{ line: pe.line ?? 1, message: pe.message, severity: 'error', code: 'E_PARSE' }] };
  }
  const prelude = readCardPrelude(program, diagnostics);
  if (!prelude) return { ok: false, diagnostics };
  const analyzer = new Analyzer(program, registers, 'card');
  analyzer.validateStructure('card');
  const fieldValues: Record<string, AV> = {
    name: { t: 'str', vals: new Set([prelude.name]) },
    cost: intVal(prelude.declaredCost),
    type: { t: 'str', vals: new Set([prelude.type]) },
    target: { t: 'str', vals: new Set([prelude.target]) },
    state: OBJ('ctx'),
  };
  for (const [k, v] of Object.entries(fieldValues)) analyzer.setCardField(k, v);
  const env = new Map<string, AV>();
  env.set('ctx', OBJ('ctx'));
  env.set('self', OBJ('unit'));
  const ctx: Ctx = { depth: 0, loopDepth: 0, frequency: 1, conditional: false, fnVars: new Set(), fnName: 'effect' };
  try {
    analyzer.analyzeBlock(program.card!.effect, env, ctx);
  } catch (err) {
    if (!(err instanceof AnalysisAbort)) throw err;
  }
  let meter: Meter;
  try {
    meter = analyzer.finalize(new Meter(), 'card');
  } catch {
    meter = analyzer.meter;
  }
  diagnostics.push(...analyzer.diagnostics);
  const P = meter.cost;
  const { R, negatives } = analyzer.computeR(meter, P);
  const N = Math.max(0, P - R);
  const cost = prelude.declaredCost;
  const effectCap = effectCapForCost(cost);
  if (N > effectCap + 1e-9) {
    diagnostics.push({
      line: 1,
      message: `${cost} 费卡效果上限 ${effectCap.toFixed(1)}，当前最坏情况 ${N.toFixed(2)}，请降低效果或提高费用`,
      severity: 'error',
      code: 'E_EFFECT_CAP',
    });
  }
  if (cost === 0 && meter.apiUses.some((u) => u.name === 'gain_energy')) {
    diagnostics.push({ line: 1, message: '0 费卡禁止 gain_energy()', severity: 'error', code: 'E_ZERO_COST' });
  }
  if (meter.apiCalls === 0) {
    diagnostics.push({ line: 1, message: '卡牌 effect 必须至少调用一个命令 API', severity: 'error', code: 'E_EMPTY' });
  }
  const ok = !diagnostics.some((d) => d.severity === 'error');
  const description = collectComments(source).map((c) => c.text).join(' · ');
  const value: CompiledCard = {
    className: prelude.className,
    name: prelude.name,
    description,
    declaredCost: prelude.declaredCost,
    cost,
    type: prelude.type,
    target: prelude.target,
    effect: program.card!.effect,
    program,
    P,
    R,
    N,
    credits: meter.credits,
    apiCalls: meter.apiCalls,
    pileOps: meter.pileOps,
    astNodes: program.nodeCount,
    lines: program.lines,
    vars: ctx.fnVars.size,
    apiUses: meter.apiUses,
    negatives,
    warnings: diagnostics.filter((d) => d.severity === 'warning'),
    source,
    registers,
  };
  return { ok, value, diagnostics };
}

export function compileScript(source: string, registers: RegisterDecl[]): CompileResult<CompiledScript> {
  const diagnostics: Diagnostic[] = [];
  let program: IRProgram;
  try {
    const mod = parseScript(source);
    const lowered = lowerScript(mod);
    program = lowered.program;
    diagnostics.push(...lowered.errors.map((e) => ({ ...e, severity: 'error' as const, code: 'E_LOWER' })));
  } catch (err) {
    const pe = err as ParseError;
    return { ok: false, diagnostics: [{ line: pe.line ?? 1, message: pe.message, severity: 'error', code: 'E_PARSE' }] };
  }
  const analyzer = new Analyzer(program, registers, 'script');
  analyzer.validateStructure('script');
  const env = new Map<string, AV>();
  env.set('ctx', OBJ('ctx'));
  const ctx: Ctx = { depth: 0, loopDepth: 0, frequency: 1, conditional: false, fnVars: new Set(), fnName: 'script' };
  try {
    analyzer.analyzeBlock(program.body, env, ctx);
  } catch (err) {
    if (!(err instanceof AnalysisAbort)) throw err;
  }
  let meter: Meter;
  try {
    meter = analyzer.finalize(new Meter(), 'script');
  } catch {
    meter = analyzer.meter;
  }
  diagnostics.push(...analyzer.diagnostics);
  const ok = !diagnostics.some((d) => d.severity === 'error');
  const value: CompiledScript = {
    body: program.body,
    functions: program.functions,
    program,
    P: meter.cost,
    CU: meter.cost,
    credits: meter.credits,
    apiCalls: meter.apiCalls,
    pileOps: meter.pileOps,
    astNodes: program.nodeCount,
    lines: program.lines,
    vars: ctx.fnVars.size,
    maxIterations: meter.totalIterations,
    regWrites: 0,
    apiUses: meter.apiUses,
    warnings: diagnostics.filter((d) => d.severity === 'warning'),
    source,
    registers,
  };
  return { ok, value, diagnostics };
}

export function validateDeck(cards: CompiledCard[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const size = cards.length;
  if (size < LIMITS.deck.minSize || size > LIMITS.deck.maxSize) {
    diagnostics.push({ line: 0, message: `牌组必须包含 ${LIMITS.deck.minSize}-${LIMITS.deck.maxSize} 张牌`, severity: 'error', code: 'E_DECK_SIZE' });
  }
  return diagnostics;
}

export function deckSummary(cards: CompiledCard[]): { budget: number; cost: number; size: number } {
  let cost = 0;
  for (const c of cards) cost += c.cost;
  return { budget: cost, cost, size: cards.length };
}
