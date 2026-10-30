import type { Expr, PyModule, Stmt } from './python';

/**
 * Unified IR. Every syntax feature is lowered into this shape; pricing and execution
 * operate on IR nodes only, so they cannot disagree.
 */

export type IRTarget =
  | { k: 'var'; name: string; line: number }
  | { k: 'state'; key: string; line: number }
  | { k: 'index'; name: string; index: IRExpr; line: number };

export type IRExpr =
  | { id: number; k: 'num'; v: number; line: number }
  | { id: number; k: 'str'; v: string; line: number }
  | { id: number; k: 'bool'; v: boolean; line: number }
  | { id: number; k: 'none'; line: number }
  | { id: number; k: 'var'; name: string; line: number }
  | { id: number; k: 'selffield'; name: string; line: number }
  | { id: number; k: 'state'; key: string; line: number }
  | { id: number; k: 'attr'; obj: IRExpr; name: string; line: number }
  | { id: number; k: 'call'; fn: IRExpr; args: IRExpr[]; line: number }
  | { id: number; k: 'bin'; op: string; l: IRExpr; r: IRExpr; line: number }
  | { id: number; k: 'un'; op: string; e: IRExpr; line: number }
  | { id: number; k: 'cmp'; op: string; l: IRExpr; r: IRExpr; line: number }
  | { id: number; k: 'boolop'; op: 'and' | 'or'; items: IRExpr[]; line: number }
  | { id: number; k: 'ifexp'; test: IRExpr; body: IRExpr; orelse: IRExpr; line: number }
  | { id: number; k: 'list'; items: IRExpr[]; line: number }
  | { id: number; k: 'sub'; obj: IRExpr; index: IRExpr; line: number }
  | {
      id: number;
      k: 'listcomp';
      var: string;
      iter: IRExpr;
      elt: IRExpr;
      cond?: IRExpr;
      line: number;
    };

export type IRStmt =
  | { id: number; k: 'assign'; target: IRTarget; value: IRExpr; line: number }
  | { id: number; k: 'aug'; target: string; op: string; value: IRExpr; line: number }
  | { id: number; k: 'expr'; value: IRExpr; line: number }
  | { id: number; k: 'if'; test: IRExpr; body: IRStmt[]; orelse: IRStmt[]; line: number }
  | { id: number; k: 'for'; var: string; iter: IRExpr; body: IRStmt[]; line: number }
  | { id: number; k: 'while'; test: IRExpr; body: IRStmt[]; line: number }
  | { id: number; k: 'return'; value?: IRExpr; line: number }
  | { id: number; k: 'break' | 'continue' | 'pass'; line: number };

export interface IRFunction {
  name: string;
  params: string[];
  body: IRStmt[];
  line: number;
}

export interface IRProgram {
  kind: 'card' | 'script';
  card: {
    className: string;
    base: string;
    fields: { name: string; value: IRExpr; line: number }[];
    effectParams: string[];
    effect: IRStmt[];
    line: number;
  } | null;
  functions: IRFunction[];
  body: IRStmt[];
  nodeCount: number;
  source: string;
  lines: number;
}

export interface IRLoweringResult {
  program: IRProgram;
  errors: { line: number; message: string }[];
}

function lowerExpr(e: Expr, counter: { n: number }): IRExpr {
  const id = ++counter.n;
  const line = e.line;
  switch (e.k) {
    case 'num':
      return { id, k: 'num', v: e.v, line };
    case 'str':
      return { id, k: 'str', v: e.v, line };
    case 'bool':
      return { id, k: 'bool', v: e.v, line };
    case 'none':
      return { id, k: 'none', line };
    case 'name':
      return { id, k: 'var', name: e.id, line };
    case 'attr': {
      if (e.obj.k === 'name' && e.obj.id === 'self') {
        return { id, k: 'selffield', name: e.name, line };
      }
      return { id, k: 'attr', obj: lowerExpr(e.obj, counter), name: e.name, line };
    }
    case 'sub': {
      if (
        e.obj.k === 'attr' &&
        e.obj.obj.k === 'name' &&
        e.obj.obj.id === 'self' &&
        e.obj.name === 'state' &&
        e.index.k === 'str'
      ) {
        return { id, k: 'state', key: e.index.v, line };
      }
      return { id, k: 'sub', obj: lowerExpr(e.obj, counter), index: lowerExpr(e.index, counter), line };
    }
    case 'call':
      return { id, k: 'call', fn: lowerExpr(e.fn, counter), args: e.args.map((a) => lowerExpr(a, counter)), line };
    case 'bin':
      return { id, k: 'bin', op: e.op, l: lowerExpr(e.l, counter), r: lowerExpr(e.r, counter), line };
    case 'un':
      return { id, k: 'un', op: e.op, e: lowerExpr(e.e, counter), line };
    case 'cmp':
      return { id, k: 'cmp', op: e.op, l: lowerExpr(e.l, counter), r: lowerExpr(e.r, counter), line };
    case 'boolop':
      return { id, k: 'boolop', op: e.op, items: e.items.map((i) => lowerExpr(i, counter)), line };
    case 'ifexp':
      return {
        id,
        k: 'ifexp',
        test: lowerExpr(e.test, counter),
        body: lowerExpr(e.body, counter),
        orelse: lowerExpr(e.orelse, counter),
        line,
      };
    case 'list':
      return { id, k: 'list', items: e.items.map((i) => lowerExpr(i, counter)), line };
    case 'comp':
      return {
        id,
        k: 'listcomp',
        var: e.target,
        iter: lowerExpr(e.iter, counter),
        elt: lowerExpr(e.elt, counter),
        cond: e.cond ? lowerExpr(e.cond, counter) : undefined,
        line,
      };
  }
}

function lowerStmts(stmts: Stmt[], counter: { n: number }, errors?: { line: number; message: string }[]): IRStmt[] {
  return stmts.map((s): IRStmt => {
    const id = ++counter.n;
    const line = s.line;
    switch (s.k) {
      case 'assign':
        return {
          id,
          k: 'assign',
          target:
            s.target.k === 'name'
              ? { k: 'var', name: s.target.id, line }
              : s.target.k === 'state'
                ? { k: 'state', key: s.target.key, line }
                : { k: 'index', name: s.target.name, index: lowerExpr(s.target.index, counter), line },
          value: lowerExpr(s.value, counter),
          line,
        };
      case 'aug':
        return { id, k: 'aug', target: s.target, op: s.op, value: lowerExpr(s.value, counter), line };
      case 'expr':
        return { id, k: 'expr', value: lowerExpr(s.value, counter), line };
      case 'if':
        return {
          id,
          k: 'if',
          test: lowerExpr(s.test, counter),
          body: lowerStmts(s.body, counter, errors),
          orelse: lowerStmts(s.orelse, counter, errors),
          line,
        };
      case 'for':
        return { id, k: 'for', var: s.target, iter: lowerExpr(s.iter, counter), body: lowerStmts(s.body, counter, errors), line };
      case 'while':
        return { id, k: 'while', test: lowerExpr(s.test, counter), body: lowerStmts(s.body, counter, errors), line };
      case 'return':
        return { id, k: 'return', value: s.value ? lowerExpr(s.value, counter) : undefined, line };
      case 'break':
      case 'continue':
      case 'pass':
        return { id, k: s.k, line };
      case 'def':
      case 'class':
        errors?.push({ line, message: '不允许嵌套定义函数或类（辅助函数必须写在顶层）' });
        return { id, k: 'pass', line };
      default:
        return { id, k: 'pass', line };
    }
  });
}

export function lowerCard(mod: PyModule): IRLoweringResult {
  const errors: { line: number; message: string }[] = [];
  const counter = { n: 0 };
  const functions: IRFunction[] = mod.functions.map((f) => ({
    name: f.name,
    params: f.params,
    body: lowerStmts(f.body, counter, errors),
    line: f.line,
  }));
  let card: IRProgram['card'] = null;
  if (mod.clazz) {
    const effect = mod.clazz.methods.find((m) => m.name === 'effect');
    if (!effect) {
      errors.push({ line: mod.clazz.line, message: '缺少 effect(self, ctx) 方法' });
    } else {
      if (mod.clazz.methods.length > 1) {
        errors.push({ line: mod.clazz.line, message: 'MVP 只允许 effect 一个方法（不提供其他钩子）' });
      }
      card = {
        className: mod.clazz.name,
        base: mod.clazz.base,
        fields: mod.clazz.fields.map((f) => ({ name: f.name, value: lowerExpr(f.value, counter), line: f.line })),
        effectParams: effect.params,
        effect: lowerStmts(effect.body, counter, errors),
        line: mod.clazz.line,
      };
    }
  }
  if (mod.statements.some((s) => s.k === 'pass' || s.k === 'def' || s.k === 'class' || s.k === 'expr')) {
    for (const s of mod.statements) {
      if (s.k !== 'def' && s.k !== 'class' && s.k !== 'pass') {
        errors.push({ line: s.line, message: '卡牌源文件的顶层只允许辅助函数与 Card 类定义' });
      }
    }
  }
  return {
    program: {
      kind: 'card',
      card,
      functions,
      body: [],
      nodeCount: counter.n,
      source: mod.source,
      lines: mod.lines,
    },
    errors,
  };
}

export function lowerScript(mod: PyModule): IRLoweringResult {
  const errors: { line: number; message: string }[] = [];
  const counter = { n: 0 };
  const functions: IRFunction[] = mod.functions.map((f) => ({
    name: f.name,
    params: f.params,
    body: lowerStmts(f.body, counter, errors),
    line: f.line,
  }));
  const body = lowerStmts(
    mod.statements.filter((s) => s.k !== 'def'),
    counter,
    errors,
  );
  return {
    program: {
      kind: 'script',
      card: null,
      functions,
      body,
      nodeCount: counter.n,
      source: mod.source,
      lines: mod.lines,
    },
    errors,
  };
}

/** Collect every API/helper call expression in a subtree (used for call-graph and fairness checks). */
export function walkExprs(stmts: IRStmt[], visit: (e: IRExpr) => void): void {
  const expr = (e: IRExpr): void => {
    visit(e);
    switch (e.k) {
      case 'attr':
        expr(e.obj);
        break;
      case 'sub':
        expr(e.obj);
        expr(e.index);
        break;
      case 'call':
        expr(e.fn);
        e.args.forEach(expr);
        break;
      case 'bin':
      case 'cmp':
        expr(e.l);
        expr(e.r);
        break;
      case 'un':
        expr(e.e);
        break;
      case 'boolop':
        e.items.forEach(expr);
        break;
      case 'ifexp':
        expr(e.test);
        expr(e.body);
        expr(e.orelse);
        break;
      case 'list':
        e.items.forEach(expr);
        break;
      case 'listcomp':
        expr(e.iter);
        expr(e.elt);
        if (e.cond) expr(e.cond);
        break;
      default:
        break;
    }
  };
  const stmt = (s: IRStmt): void => {
    switch (s.k) {
      case 'assign':
        expr(s.value);
        break;
      case 'aug':
        expr(s.value);
        break;
      case 'expr':
        expr(s.value);
        break;
      case 'if':
        expr(s.test);
        s.body.forEach(stmt);
        s.orelse.forEach(stmt);
        break;
      case 'for':
        expr(s.iter);
        s.body.forEach(stmt);
        break;
      case 'while':
        expr(s.test);
        s.body.forEach(stmt);
        break;
      case 'return':
        if (s.value) expr(s.value);
        break;
      default:
        break;
    }
  };
  stmts.forEach(stmt);
}
