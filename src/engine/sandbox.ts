import { CREDIT_BUDGET, LIMITS, SANDBOX } from './config';
import type { IRExpr, IRFunction, IRStmt } from './ir';

export interface SourceRef {
  kind: 'script' | 'card' | 'token' | 'ai' | 'engine';
  label: string;
  line: number;
  irId?: number;
}

export type Prim = number | boolean | string;

/** Bounded, locally mutable int array. Never reaches engine storage. */
export class SbList {
  readonly items: RV[];
  constructor(items: RV[]) {
    this.items = items;
  }
}

export interface SbObj {
  readonly shape: 'card' | 'unit' | 'turn' | 'intent';
  readonly fields: Readonly<Record<string, RV>>;
}

export type RV = Prim | null | SbList | SbObj;

export type HaltReason = 'PROTOCOL_HALT' | 'LOOP_FUSE' | 'COMPUTE_OVERLOAD';

export class SandboxHalt extends Error {
  reason: HaltReason;
  label: string;
  ref: SourceRef;
  constructor(reason: HaltReason, label: string, ref: SourceRef, detail: string) {
    super(detail);
    this.name = 'SandboxHalt';
    this.reason = reason;
    this.label = label;
    this.ref = ref;
  }
}

export class TurnBudget {
  apiCalls = 0;
  pileOps = 0;
  credits = 0;
  regWrites = 0;
  iterations = 0;
  generated = 0;
  logs = 0;
  listWrites = 0;
  objects = 0;
  steps = 0;
  startTime: number;

  constructor() {
    this.startTime = now();
  }

  resetClock(): void {
    this.startTime = now();
  }

  /** Starts a fresh execution window without resetting accumulated turn spend. */
  beginChunk(): void {
    this.startTime = now();
    this.steps = 0;
  }

  checkTime(ref: SourceRef): void {
    if (now() - this.startTime > SANDBOX.execMs) {
      throw new SandboxHalt('COMPUTE_OVERLOAD', '算力过载', ref, `执行时间超过 ${SANDBOX.execMs}ms，协议被强制中断`);
    }
  }

  tick(ref: SourceRef): void {
    this.steps += 1;
    if (this.steps % 64 === 0) this.checkTime(ref);
  }

  spendApi(cat: string, ref: SourceRef): void {
    this.checkTime(ref);
    if (cat !== 'read' && cat !== 'log') this.apiCalls += 1;
    if (['pile', 'draw', 'discard', 'play'].includes(cat)) this.pileOps += 1;
    if (cat === 'register') this.regWrites += 1;
    if (cat === 'log') this.logs += 1;
  }

  /** Script-only per-turn credit spend. Card effects are paid with energy instead. */
  spendCredits(amount: number, ref: SourceRef): void {
    this.credits = Math.round((this.credits + Math.max(0, amount)) * 10) / 10;
    if (this.credits > CREDIT_BUDGET + 1e-9) {
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `本回合算力超过 ${CREDIT_BUDGET}（已用 ${this.credits.toFixed(1)}）`);
    }
  }

  countIteration(ref: SourceRef): void {
    this.iterations += 1;
    if (this.iterations > SANDBOX.maxIterationsPerTurn) {
      throw new SandboxHalt('LOOP_FUSE', '循环熔断', ref, `每回合循环总迭代超过 ${SANDBOX.maxIterationsPerTurn} 次`);
    }
    this.checkTime(ref);
  }

  countListWrite(ref: SourceRef): void {
    this.listWrites += 1;
    if (this.listWrites > SANDBOX.maxListWritesPerTurn) {
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `每回合数组写入超过 ${SANDBOX.maxListWritesPerTurn} 次`);
    }
  }

  countObject(ref: SourceRef): void {
    this.objects += 1;
    if (this.objects > 200) {
      throw new SandboxHalt('COMPUTE_OVERLOAD', '算力过载', ref, '临时对象创建超过上限');
    }
  }
}

export interface SandboxHost {
  callApi(name: string, args: Prim[], ref: SourceRef): RV;
  ctxField(name: string, ref: SourceRef): RV;
  selfField(name: string, ref: SourceRef): RV;
  getState(key: string): RV;
  setState(key: string, value: Prim, ref: SourceRef): void;
  stateType(key: string): 'int' | 'bool' | 'str' | undefined;
  getGlobal(name: string): RV;
  /** Read-only queries on snapshot objects, e.g. ctx.enemy.hp(). */
  ctxMethod(object: string, method: string, ref: SourceRef): RV;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function checkInt(n: number, ref: SourceRef): number {
  if (!Number.isInteger(n)) {
    throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '数值必须是整数');
  }
  if (n > SANDBOX.maxNumber || n < -SANDBOX.maxNumber) {
    throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `数值 ${n} 超出安全范围`);
  }
  return n;
}

function checkStr(s: string, ref: SourceRef): string {
  if (s.length > SANDBOX.maxStringLength) {
    throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '字符串超过 64 字符上限');
  }
  return s;
}

type Flow = { kind: 'normal' } | { kind: 'break' } | { kind: 'continue' } | { kind: 'return'; value: RV };

const NORMAL: Flow = { kind: 'normal' };

export class Interpreter {
  private host: SandboxHost;
  private budget: TurnBudget;
  private scopes: Map<string, RV>[] = [];
  private ref: SourceRef;
  private functions: Map<string, IRFunction>;
  private fields: Record<string, RV>;
  private callDepth = 0;

  constructor(host: SandboxHost, budget: TurnBudget, ref: SourceRef, functions: IRFunction[], fields: Record<string, RV> = {}) {
    this.host = host;
    this.budget = budget;
    this.ref = ref;
    this.functions = new Map(functions.map((f) => [f.name, f]));
    this.fields = fields;
    this.scopes = [new Map()];
  }

  private at(line: number, irId?: number): SourceRef {
    return { ...this.ref, line, irId };
  }

  private define(name: string, value: RV): void {
    this.scopes[this.scopes.length - 1].set(name, value);
  }

  private lookup(name: string, ref: SourceRef): RV {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name)!;
    }
    throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `未定义变量 ${name}`);
  }

  run(body: IRStmt[]): void {
    this.execBlock(body);
  }

  private execBlock(stmts: IRStmt[]): Flow {
    for (const s of stmts) {
      this.budget.tick(this.at(s.line, s.id));
      const flow = this.execStmt(s);
      if (flow.kind !== 'normal') return flow;
    }
    return NORMAL;
  }

  private execStmt(s: IRStmt): Flow {
    const ref = this.at(s.line, s.id);
    switch (s.k) {
      case 'assign': {
        const value = this.evalExpr(s.value);
        if (s.target.k === 'var') {
          this.define(s.target.name, value);
        } else if (s.target.k === 'index') {
          const list = this.lookup(s.target.name, ref);
          if (!(list instanceof SbList)) {
            throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `数组下标赋值的目标必须是局部数组: ${s.target.name}`);
          }
          const idx = this.evalExpr(s.target.index);
          if (typeof idx !== 'number' || !Number.isInteger(idx)) {
            throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '数组下标必须是整数');
          }
          if (idx < 0 || idx >= list.items.length) {
            throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `数组下标越界: ${idx}`);
          }
          if (typeof value !== 'number' || !Number.isInteger(value)) {
            throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '数组只保存整数');
          }
          this.budget.countListWrite(ref);
          list.items[idx] = checkInt(value, ref);
        } else {
          if (value instanceof SbList || value === null || typeof value === 'object') {
            throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'self.state 只允许 int/bool/短字符串');
          }
          let v = value;
          if (typeof v === 'number') v = checkInt(v, ref);
          if (typeof v === 'string') {
            if (v.length > 32) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'self.state 字符串超长');
            this.host.setState(s.target.key, v, ref);
          } else {
            this.host.setState(s.target.key, v, ref);
          }
        }
        return NORMAL;
      }
      case 'aug': {
        const cur = this.lookup(s.target, ref);
        if (typeof cur !== 'number') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '增强赋值需要整数');
        const rhs = this.evalExpr(s.value);
        if (typeof rhs !== 'number') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '增强赋值需要整数');
        let next: number;
        if (s.op === '+') next = cur + rhs;
        else if (s.op === '-') next = cur - rhs;
        else if (s.op === '*') next = cur * rhs;
        else {
          if (rhs === 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '取模除数为 0');
          next = ((cur % rhs) + rhs) % rhs;
        }
        this.define(s.target, checkInt(next, ref));
        return NORMAL;
      }
      case 'expr':
        this.evalExpr(s.value);
        return NORMAL;
      case 'if': {
        const test = this.evalExpr(s.test);
        if (typeof test !== 'boolean') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'if 条件必须是 bool');
        return test ? this.execBlock(s.body) : this.execBlock(s.orelse);
      }
      case 'for': {
        const range = this.evalRange(s.iter);
        for (let i = 0; i < range.count; i++) {
          this.budget.countIteration(ref);
          if (i >= SANDBOX.maxLoopIterations) {
            throw new SandboxHalt('LOOP_FUSE', '循环熔断', ref, `单循环迭代超过 ${SANDBOX.maxLoopIterations} 次`);
          }
          this.scopes.push(new Map());
          this.define(s.var, range.start + i * range.step);
          const flow = this.execBlock(s.body);
          this.scopes.pop();
          if (flow.kind === 'break') break;
          if (flow.kind === 'continue') continue;
          if (flow.kind === 'return') return flow;
        }
        return NORMAL;
      }
      case 'while': {
        let n = 0;
        while (true) {
          const test = this.evalExpr(s.test);
          if (typeof test !== 'boolean') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'while 条件必须是 bool');
          if (!test) break;
          n++;
          if (n > SANDBOX.maxLoopIterations) {
            throw new SandboxHalt('LOOP_FUSE', '循环熔断', ref, `单循环迭代超过 ${SANDBOX.maxLoopIterations} 次`);
          }
          this.budget.countIteration(ref);
          const flow = this.execBlock(s.body);
          if (flow.kind === 'break') break;
          if (flow.kind === 'return') return flow;
        }
        return NORMAL;
      }
      case 'return': {
        const value = s.value ? this.evalExpr(s.value) : null;
        return { kind: 'return', value };
      }
      case 'break':
        return { kind: 'break' };
      case 'continue':
        return { kind: 'continue' };
      case 'pass':
        return NORMAL;
    }
  }

  private evalRange(e: IRExpr): { start: number; step: number; count: number } {
    const ref = this.at(e.line, e.id);
    if (e.k !== 'call' || e.fn.k !== 'var' || e.fn.name !== 'range') {
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'for 只支持 range()');
    }
    const vals = e.args.map((a) => this.evalExpr(a));
    for (const v of vals) {
      if (typeof v !== 'number') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'range 参数必须是整数');
    }
    const nums = vals as number[];
    let start = 0;
    let end = nums[0];
    let step = 1;
    if (nums.length >= 2) {
      start = nums[0];
      end = nums[1];
    }
    if (nums.length === 3) step = nums[2];
    if (step <= 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'range 步长必须为正');
    if (Math.abs(end) > 1000 || Math.abs(start) > 1000) {
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'range 参数超出范围');
    }
    const count = Math.max(0, Math.ceil((end - start) / step));
    if (count > SANDBOX.maxLoopIterations) {
      throw new SandboxHalt('LOOP_FUSE', '循环熔断', ref, '静态分析未拦截的超大循环在运行时被熔断');
    }
    return { start, step, count };
  }

  private attr(obj: RV, name: string, ref: SourceRef): RV {
    if (!obj || typeof obj !== 'object' || !('shape' in obj)) {
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `无法读取属性 ${name}`);
    }
    const allowed: Record<string, string[]> = {
      // Battle-time card instances expose only the face name and energy cost.
      card: ['name', 'cost'],
      unit: [],
      turn: ['discarded_count', 'played_count'],
    };
    if (!allowed[obj.shape]?.includes(name)) {
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `禁止读取快照字段 ${name}`);
    }
    const value = (obj.fields as Record<string, RV>)[name];
    return value === undefined ? null : value;
  }

  private evalExpr(e: IRExpr): RV {
    const ref = this.at(e.line, e.id);
    this.budget.checkTime(ref);
    switch (e.k) {
      case 'num':
        return checkInt(e.v, ref);
      case 'str':
        return checkStr(e.v, ref);
      case 'bool':
        return e.v;
      case 'none':
        return null;
      case 'var':
        return this.lookup(e.name, ref);
      case 'selffield': {
        const v = this.fields[e.name];
        if (v === undefined) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `禁止访问 self.${e.name}`);
        return v;
      }
      case 'state': {
        const v = this.host.getState(e.key);
        return v;
      }
      case 'attr': {
        if (e.obj.k === 'var' && e.obj.name === 'ctx') {
          return this.host.ctxField(e.name, ref);
        }
        const base = this.evalExpr(e.obj);
        return this.attr(base, e.name, ref);
      }
      case 'sub': {
        const base = this.evalExpr(e.obj);
        const idx = this.evalExpr(e.index);
        if (!(base instanceof SbList)) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '只能索引列表快照');
        if (typeof idx !== 'number') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '索引必须是整数');
        let i = idx;
        if (i < 0) i += base.items.length;
        if (i < 0 || i >= base.items.length) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '列表索引越界');
        return base.items[i];
      }
      case 'list': {
        if (e.items.length > SANDBOX.maxArrayList) {
          throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `数组长度超过 ${SANDBOX.maxArrayList}`);
        }
        this.budget.countObject(ref);
        return new SbList(e.items.map((i) => this.evalExpr(i)));
      }
      case 'listcomp': {
        const range = this.evalRange(e.iter);
        const out: RV[] = [];
        for (let i = 0; i < range.count; i++) {
          this.budget.countIteration(ref);
          if (out.length >= SANDBOX.maxArrayList) {
            throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '推导式长度超限');
          }
          this.scopes.push(new Map());
          this.define(e.var, range.start + i * range.step);
          let include = true;
          if (e.cond) {
            const c = this.evalExpr(e.cond);
            if (typeof c !== 'boolean') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '推导式条件必须是 bool');
            include = c;
          }
          if (include) out.push(this.evalExpr(e.elt));
          this.scopes.pop();
        }
        this.budget.countObject(ref);
        return new SbList(out);
      }
      case 'un': {
        const v = this.evalExpr(e.e);
        if (e.op === 'not') {
          if (typeof v !== 'boolean') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'not 需要 bool');
          return !v;
        }
        if (typeof v !== 'number') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '一元 - 需要整数');
        return checkInt(-v, ref);
      }
      case 'bin': {
        const a = this.evalExpr(e.l);
        const b = this.evalExpr(e.r);
        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '算术运算只支持整数');
        }
        if (e.op === '+') return checkInt(a + b, ref);
        if (e.op === '-') return checkInt(a - b, ref);
        if (e.op === '*') return checkInt(a * b, ref);
        if (e.op === '/') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '不支持浮点除法');
        if (b === 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '除数为 0');
        if (e.op === '//') return checkInt(Math.floor(a / b), ref);
        if (e.op === '%') return checkInt(((a % b) + b) % b, ref);
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `不支持的运算符 ${e.op}`);
      }
      case 'cmp': {
        const a = this.evalExpr(e.l);
        const b = this.evalExpr(e.r);
        if (typeof a === 'number' && typeof b === 'number') {
          return e.op === '<' ? a < b : e.op === '>' ? a > b : e.op === '<=' ? a <= b : e.op === '>=' ? a >= b : e.op === '==' ? a === b : a !== b;
        }
        if (typeof a === 'boolean' && typeof b === 'boolean' && (e.op === '==' || e.op === '!=')) {
          return e.op === '==' ? a === b : a !== b;
        }
        if (typeof a === 'string' && typeof b === 'string' && (e.op === '==' || e.op === '!=')) {
          return e.op === '==' ? a === b : a !== b;
        }
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '比较运算类型不匹配');
      }
      case 'boolop': {
        let last: RV = null;
        for (const item of e.items) {
          const v = this.evalExpr(item);
          if (typeof v !== 'boolean') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `${e.op} 需要 bool`);
          last = v;
          if (e.op === 'and' && !v) return false;
          if (e.op === 'or' && v) return true;
        }
        return last;
      }
      case 'ifexp': {
        const t = this.evalExpr(e.test);
        if (typeof t !== 'boolean') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '三元条件必须是 bool');
        return t ? this.evalExpr(e.body) : this.evalExpr(e.orelse);
      }
      case 'call':
        return this.evalCall(e);
    }
  }

  private evalCall(e: Extract<IRExpr, { k: 'call' }>): RV {
    const ref = this.at(e.line, e.id);
    if (e.fn.k === 'attr' && e.fn.obj.k === 'var' && e.fn.obj.name === 'ctx') {
      const api = e.fn.name;
      const args = e.args.map((a) => this.evalExpr(a));
      if (api === 'getHand' || api === 'getDraw' || api === 'getDiscard') {
        this.budget.spendApi('read', ref);
        return this.host.callApi(api, [], ref);
      }
      this.budget.spendApi(apiCategory(api), ref);
      return this.host.callApi(api, args as Prim[], ref);
    }
    if (
      e.fn.k === 'attr' &&
      e.fn.obj.k === 'attr' &&
      e.fn.obj.obj.k === 'var' &&
      e.fn.obj.obj.name === 'ctx'
    ) {
      if (e.args.length > 0) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '该方法不接受参数');
      return this.host.ctxMethod(e.fn.obj.name, e.fn.name, ref);
    }
    if (e.fn.k === 'var') {
      const name = e.fn.name;
      if (name === 'len') {
        if (e.args.length !== 1) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'len() 需要 1 个参数');
        const v = this.evalExpr(e.args[0]);
        if (v instanceof SbList) return v.items.length;
        if (typeof v === 'string') return v.length;
        throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'len() 参数类型错误');
      }
      if (name === 'abs' || name === 'min' || name === 'max' || name === 'int' || name === 'bool' || name === 'str') {
        const vals = e.args.map((a) => this.evalExpr(a));
        if (name === 'str') return checkStr(String(vals[0] ?? ''), ref);
        if (name === 'bool') return Boolean(vals[0]);
        if (name === 'int') {
          if (typeof vals[0] === 'boolean') return vals[0] ? 1 : 0;
          if (typeof vals[0] === 'number') return checkInt(Math.trunc(vals[0]), ref);
          throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'int() 参数类型错误');
        }
        if (vals.some((v) => typeof v !== 'number')) throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `${name}() 参数类型错误`);
        const nums = vals as number[];
        if (name === 'abs') return checkInt(Math.abs(nums[0]), ref);
        if (name === 'min') return Math.min(nums[0], nums[1]);
        return Math.max(nums[0], nums[1]);
      }
      if (this.functions.has(name)) {
        return this.callHelper(name, e, ref);
      }
      if (name === 'range') throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, 'range() 只能用于 for');
    }
    throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, '未知或不安全的调用');
  }

  private callHelper(name: string, e: Extract<IRExpr, { k: 'call' }>, ref: SourceRef): RV {
    if (this.callDepth >= LIMITS.card.maxCallDepth) {
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `调用深度超过 ${LIMITS.card.maxCallDepth}`);
    }
    const fn = this.functions.get(name)!;
    if (fn.params.length !== e.args.length) {
      throw new SandboxHalt('PROTOCOL_HALT', '协议中断', ref, `${name}() 参数数量不匹配`);
    }
    const args = e.args.map((a) => this.evalExpr(a));
    const scope = new Map<string, RV>();
    fn.params.forEach((p, i) => scope.set(p, args[i]));
    this.scopes.push(scope);
    this.callDepth++;
    try {
      const flow = this.execBlock(fn.body);
      return flow.kind === 'return' ? flow.value : null;
    } finally {
      this.callDepth--;
      this.scopes.pop();
    }
  }
}

function apiCategory(name: string): string {
  if (
    [
      'getHand', 'getDraw', 'getDiscard', 'hand_size', 'draw_size', 'discard_size',
      'get_global', 'pile_costs', 'getTurn', 'getEnergy', 'getBlock', 'getMaxEnergy',
      'getHandLimit', 'getDrawLimit',
    ].includes(name)
  ) return 'read';
  if (['move_card', 'swap', 'shuffle', 'reshuffle'].includes(name)) return 'pile';
  if (name === 'playcard') return 'play';
  if (name === 'draw') return 'draw';
  if (name === 'discard') return 'discard';
  if (name === 'set_global') return 'register';
  if (name === 'log') return 'log';
  return 'command';
}
