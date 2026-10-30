/**
 * A deliberately small, deterministic Python subset.
 * One statement per physical line. No imports, no eval, no attribute writes.
 */

export class ParseError extends Error {
  line: number;
  constructor(message: string, line = 0) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
  }
}

export type Expr =
  | { k: 'num'; v: number; line: number }
  | { k: 'str'; v: string; line: number }
  | { k: 'bool'; v: boolean; line: number }
  | { k: 'none'; line: number }
  | { k: 'name'; id: string; line: number }
  | { k: 'attr'; obj: Expr; name: string; line: number }
  | { k: 'call'; fn: Expr; args: Expr[]; line: number }
  | { k: 'bin'; op: string; l: Expr; r: Expr; line: number }
  | { k: 'un'; op: string; e: Expr; line: number }
  | { k: 'cmp'; op: string; l: Expr; r: Expr; line: number }
  | { k: 'boolop'; op: 'and' | 'or'; items: Expr[]; line: number }
  | { k: 'ifexp'; test: Expr; body: Expr; orelse: Expr; line: number }
  | { k: 'list'; items: Expr[]; line: number }
  | { k: 'sub'; obj: Expr; index: Expr; line: number }
  | { k: 'comp'; elt: Expr; target: string; iter: Expr; cond?: Expr; line: number };

export type Target =
  | { k: 'name'; id: string; line: number }
  | { k: 'state'; key: string; line: number }
  | { k: 'index'; name: string; index: Expr; line: number };

export type Stmt =
  | { k: 'assign'; target: Target; value: Expr; line: number }
  | { k: 'aug'; target: string; op: string; value: Expr; line: number }
  | { k: 'expr'; value: Expr; line: number }
  | { k: 'if'; test: Expr; body: Stmt[]; orelse: Stmt[]; line: number }
  | { k: 'for'; target: string; iter: Expr; body: Stmt[]; line: number }
  | { k: 'while'; test: Expr; body: Stmt[]; line: number }
  | { k: 'return'; value?: Expr; line: number }
  | { k: 'break'; line: number }
  | { k: 'continue'; line: number }
  | { k: 'pass'; line: number }
  | { k: 'def'; name: string; params: string[]; body: Stmt[]; line: number }
  | {
      k: 'class';
      name: string;
      base: string;
      fields: { name: string; value: Expr; line: number }[];
      methods: { name: string; params: string[]; body: Stmt[]; line: number }[];
      line: number;
    };

export interface PyModule {
  statements: Stmt[];
  functions: { name: string; params: string[]; body: Stmt[]; line: number }[];
  clazz: {
    name: string;
    base: string;
    fields: { name: string; value: Expr; line: number }[];
    methods: { name: string; params: string[]; body: Stmt[]; line: number }[];
    line: number;
  } | null;
  lines: number;
  source: string;
}

type Tok = { t: 'name' | 'num' | 'str' | 'op' | 'kw' | 'newline' | 'indent' | 'dedent' | 'eof'; v: string; line: number; col: number };

const KEYWORDS = new Set([
  'class', 'def', 'if', 'elif', 'else', 'for', 'in', 'while', 'return', 'break', 'continue',
  'pass', 'and', 'or', 'not', 'True', 'False', 'None', 'is', 'lambda', 'import', 'from',
  'with', 'try', 'except', 'finally', 'raise', 'global', 'nonlocal', 'async', 'await', 'yield',
  'del', 'assert', 'match', 'case', 'as',
]);

const UNSUPPORTED = new Set([
  'lambda', 'import', 'from', 'with', 'try', 'except', 'finally', 'raise', 'global', 'nonlocal',
  'async', 'await', 'yield', 'del', 'assert', 'match', 'case', 'as', 'is',
]);

/** Strip comments outside string literals. `//` is the player-facing comment used as card text. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Collect inline `//` comments so they can be shown as the card description. */
export function collectComments(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let quote: string | null = null;
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '/' && raw[j + 1] === '/') {
        const text = raw.slice(j + 2).trim();
        if (text) out.push({ line: i + 1, text });
        break;
      }
    }
  }
  return out;
}

function tokenizeLine(text: string, line: number, out: Tok[]): void {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    const col = i + 1;
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (UNSUPPORTED.has(word)) throw new ParseError(`不支持的语法: ${word}（MVP 仅支持受限 Python 子集）`, line);
      out.push({ t: KEYWORDS.has(word) ? 'kw' : 'name', v: word, line, col });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
      if (text[j] === '.' || text[j] === 'e' || text[j] === 'E') {
        throw new ParseError('只支持整数，不支持浮点数', line);
      }
      out.push({ t: 'num', v: text.slice(i, j), line, col });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let val = '';
      let closed = false;
      while (j < text.length) {
        const d = text[j];
        if (d === '\\') {
          const n = text[j + 1];
          if (n === 'n') val += '\n';
          else if (n === 't') val += '\t';
          else if (n === '\\') val += '\\';
          else if (n === '"' || n === "'") val += n;
          else throw new ParseError(`不支持的转义: \\${n ?? ''}`, line);
          j += 2;
          continue;
        }
        if (d === c) {
          closed = true;
          j++;
          break;
        }
        val += d;
        j++;
      }
      if (!closed) throw new ParseError('字符串未闭合', line);
      out.push({ t: 'str', v: val, line, col });
      i = j;
      continue;
    }
    const three = text.slice(i, i + 3);
    if (three === '//=') throw new ParseError('不支持的运算符 //=', line);
    const two = text.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '//', '+=', '-=', '*=', '%=', '**'].includes(two)) {
      if (two === '**') throw new ParseError('不支持幂运算 **', line);
      out.push({ t: 'op', v: two, line, col });
      i += 2;
      continue;
    }
    if ('+-*/%<>=(),[].:'.includes(c)) {
      out.push({ t: 'op', v: c, line, col });
      i++;
      continue;
    }
    throw new ParseError(`无法识别的字符: ${c}`, line);
  }
}

const MAX_LINE_CHARS = 200;

export function lex(source: string): Tok[] {
  const rawLines = source.replace(/\r\n/g, '\n').split('\n');
  const tokens: Tok[] = [];
  const indents: number[] = [0];
  let depth = 0;
  for (let li = 0; li < rawLines.length; li++) {
    const lineNo = li + 1;
    const raw = rawLines[li];
    if (raw.includes('\t')) throw new ParseError('缩进必须使用空格，禁止制表符', lineNo);
    if (raw.length > MAX_LINE_CHARS) {
      throw new ParseError(`单行超过 ${MAX_LINE_CHARS} 字符上限`, lineNo);
    }
    const text = stripComment(raw).replace(/\s+$/, '');
    if (text.trim() === '') continue;
    const lead = text.length - text.trimStart().length;
    if (lead % 2 !== 0) throw new ParseError('缩进必须为 2 的倍数个空格', lineNo);
    if (lead > indents[indents.length - 1]) {
      indents.push(lead);
      tokens.push({ t: 'indent', v: '', line: lineNo, col: 1 });
      depth++;
    } else {
      while (lead < indents[indents.length - 1]) {
        indents.pop();
        tokens.push({ t: 'dedent', v: '', line: lineNo, col: 1 });
        depth--;
      }
      if (lead !== indents[indents.length - 1]) throw new ParseError('缩进不一致', lineNo);
    }
    tokenizeLine(text.trim(), lineNo, tokens);
    tokens.push({ t: 'newline', v: '', line: lineNo, col: 1 });
  }
  while (indents.length > 1) {
    indents.pop();
    tokens.push({ t: 'dedent', v: '', line: rawLines.length, col: 1 });
  }
  tokens.push({ t: 'eof', v: '', line: rawLines.length, col: 1 });
  return tokens;
}

class Parser {
  private toks: Tok[];
  private pos = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }
  private at(t: Tok['t'], v?: string): boolean {
    const tok = this.peek();
    return tok.t === t && (v === undefined || tok.v === v);
  }
  private eat(t: Tok['t'], v?: string): Tok {
    if (!this.at(t, v)) {
      const got = this.peek();
      throw new ParseError(`语法错误：期望 ${v ?? t}，实际为 ${got.v || got.t}`, got.line);
    }
    return this.next();
  }
  private skipNewlines(): void {
    while (this.at('newline')) this.pos++;
  }

  parseModule(): PyModule {
    const statements: Stmt[] = [];
    this.skipNewlines();
    while (!this.at('eof')) {
      statements.push(this.parseStatement());
      this.skipNewlines();
    }
    const functions: PyModule['functions'] = [];
    let clazz: PyModule['clazz'] = null;
    for (const s of statements) {
      if (s.k === 'def') functions.push({ name: s.name, params: s.params, body: s.body, line: s.line });
      else if (s.k === 'class') {
        if (clazz) throw new ParseError('每个源文件只能定义一个 Card 类', s.line);
        clazz = { name: s.name, base: s.base, fields: s.fields, methods: s.methods, line: s.line };
      }
    }
    return { statements, functions, clazz, lines: this.toks.length ? this.toks[this.toks.length - 1].line : 0, source: '' };
  }

  /** Turn-script module: no class allowed. */
  parseScript(): PyModule {
    const statements: Stmt[] = [];
    this.skipNewlines();
    while (!this.at('eof')) {
      const s = this.parseStatement();
      if (s.k === 'class') throw new ParseError('回合脚本中不允许定义类', s.line);
      statements.push(s);
      this.skipNewlines();
    }
    const functions: PyModule['functions'] = statements
      .filter((s): s is Extract<Stmt, { k: 'def' }> => s.k === 'def')
      .map((s) => ({ name: s.name, params: s.params, body: s.body, line: s.line }));
    return { statements, functions, clazz: null, lines: 0, source: '' };
  }

  private parseStatement(): Stmt {
    this.skipNewlines();
    const tok = this.peek();
    if (tok.t === 'kw') {
      switch (tok.v) {
        case 'class':
          return this.parseClass();
        case 'def':
          return this.parseDef();
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'while':
          return this.parseWhile();
        case 'return': {
          this.next();
          let value: Expr | undefined;
          if (!this.at('newline') && !this.at('dedent') && !this.at('eof')) value = this.parseExpr();
          this.eat('newline');
          return { k: 'return', value, line: tok.line };
        }
        case 'break':
          this.next();
          this.eat('newline');
          return { k: 'break', line: tok.line };
        case 'continue':
          this.next();
          this.eat('newline');
          return { k: 'continue', line: tok.line };
        case 'pass':
          this.next();
          this.eat('newline');
          return { k: 'pass', line: tok.line };
        case 'elif':
        case 'else':
          throw new ParseError(`意外的 ${tok.v}`, tok.line);
        default:
          break;
      }
    }
    // simple statement
    const start = this.pos;
    const first = this.peek();
    let expr = this.parseExpr();
    if (this.at('op', '=')) {
      this.next();
      const value = this.parseExpr();
      this.eat('newline');
      const target = this.toTarget(expr, first.line);
      return { k: 'assign', target, value, line: first.line };
    }
    const aug = this.peek();
    if (aug.t === 'op' && ['+=', '-=', '*=', '%='].includes(aug.v)) {
      this.next();
      const value = this.parseExpr();
      this.eat('newline');
      if (expr.k !== 'name') throw new ParseError('增强赋值的目标必须是局部变量', aug.line);
      return { k: 'aug', target: expr.id, op: aug.v.slice(0, -1), value, line: aug.line };
    }
    if (expr.k !== 'call') {
      throw new ParseError('表达式语句只能是函数调用', first.line);
    }
    this.pos = start;
    expr = this.parseExpr();
    this.eat('newline');
    return { k: 'expr', value: expr, line: first.line };
  }

  private toTarget(expr: Expr, line: number): Target {
    if (expr.k === 'name') return { k: 'name', id: expr.id, line };
    if (
      expr.k === 'sub' &&
      expr.index.k === 'str' &&
      expr.obj.k === 'attr' &&
      expr.obj.obj.k === 'name' &&
      expr.obj.obj.id === 'self' &&
      expr.obj.name === 'state'
    ) {
      return { k: 'state', key: expr.index.v, line };
    }
    if (expr.k === 'sub' && expr.obj.k === 'name') {
      return { k: 'index', name: expr.obj.id, index: expr.index, line };
    }
    throw new ParseError('只能写入局部变量、局部数组下标或 self.state["key"]，禁止直接修改引擎字段', line);
  }

  private parseBlock(): Stmt[] {
    this.eat('newline');
    this.eat('indent');
    const body: Stmt[] = [];
    this.skipNewlines();
    while (!this.at('dedent') && !this.at('eof')) {
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    if (body.length === 0) throw new ParseError('代码块不能为空', this.peek().line);
    if (this.at('dedent')) this.next();
    return body;
  }

  private parseIf(): Stmt {
    const line = this.eat('kw', 'if').line;
    const test = this.parseExpr();
    this.eat('op', ':');
    const body = this.parseBlock();
    this.skipNewlines();
    let orelse: Stmt[] = [];
    if (this.at('kw', 'elif')) {
      orelse = [this.parseIf()];
      return { k: 'if', test, body, orelse, line };
    }
    if (this.at('kw', 'else')) {
      this.next();
      this.eat('op', ':');
      orelse = this.parseBlock();
    }
    return { k: 'if', test, body, orelse, line };
  }

  private parseFor(): Stmt {
    const line = this.eat('kw', 'for').line;
    const target = this.eat('name').v;
    this.eat('kw', 'in');
    const iter = this.parseExpr();
    this.eat('op', ':');
    const body = this.parseBlock();
    return { k: 'for', target, iter, body, line };
  }

  private parseWhile(): Stmt {
    const line = this.eat('kw', 'while').line;
    const test = this.parseExpr();
    this.eat('op', ':');
    const body = this.parseBlock();
    return { k: 'while', test, body, line };
  }

  private parseDef(): Stmt {
    const line = this.eat('kw', 'def').line;
    const name = this.eat('name').v;
    this.eat('op', '(');
    const params: string[] = [];
    if (!this.at('op', ')')) {
      while (true) {
        const p = this.eat('name').v;
        params.push(p);
        if (this.at('op', ',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.eat('op', ')');
    this.eat('op', ':');
    const body = this.parseBlock();
    return { k: 'def', name, params, body, line };
  }

  private parseClass(): Stmt {
    const line = this.eat('kw', 'class').line;
    const name = this.eat('name').v;
    let base = '';
    if (this.at('op', '(')) {
      this.next();
      base = this.eat('name').v;
      this.eat('op', ')');
    }
    this.eat('op', ':');
    this.eat('newline');
    this.eat('indent');
    const fields: { name: string; value: Expr; line: number }[] = [];
    const methods: { name: string; params: string[]; body: Stmt[]; line: number }[] = [];
    this.skipNewlines();
    while (!this.at('dedent') && !this.at('eof')) {
      if (this.at('kw', 'def')) {
        const m = this.parseDef();
        if (m.k !== 'def') throw new ParseError('类方法定义错误', m.line);
        methods.push({ name: m.name, params: m.params, body: m.body, line: m.line });
      } else {
        const fieldLine = this.peek().line;
        const fieldName = this.eat('name').v;
        this.eat('op', '=');
        const value = this.parseExpr();
        this.eat('newline');
        fields.push({ name: fieldName, value, line: fieldLine });
      }
      this.skipNewlines();
    }
    const body: Stmt[] = [];
    if (this.at('dedent')) this.next();
    return { k: 'class', name, base, fields, methods, line };
  }

  parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const body = this.parseOr();
    if (this.at('kw', 'if')) {
      const line = this.next().line;
      const test = this.parseOr();
      this.eat('kw', 'else');
      const orelse = this.parseTernary();
      return { k: 'ifexp', test, body, orelse, line };
    }
    return body;
  }

  private parseOr(): Expr {
    const first = this.parseAnd();
    if (!this.at('kw', 'or')) return first;
    const line = this.peek().line;
    const items = [first];
    while (this.at('kw', 'or')) {
      this.next();
      items.push(this.parseAnd());
    }
    return { k: 'boolop', op: 'or', items, line };
  }

  private parseAnd(): Expr {
    const first = this.parseNot();
    if (!this.at('kw', 'and')) return first;
    const line = this.peek().line;
    const items = [first];
    while (this.at('kw', 'and')) {
      this.next();
      items.push(this.parseNot());
    }
    return { k: 'boolop', op: 'and', items, line };
  }

  private parseNot(): Expr {
    if (this.at('kw', 'not')) {
      const line = this.next().line;
      return { k: 'un', op: 'not', e: this.parseNot(), line };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdd();
    const line = this.peek().line;
    const items: Expr[] = [left];
    const ops: string[] = [];
    while (this.at('op') && ['==', '!=', '<', '>', '<=', '>='].includes(this.peek().v)) {
      ops.push(this.next().v);
      items.push(this.parseAdd());
    }
    if (ops.length === 1) return { k: 'cmp', op: ops[0], l: items[0], r: items[1], line };
    if (ops.length > 1) {
      // a < b < c  ==>  (a < b) and (b < c)
      const parts: Expr[] = ops.map((op, i) => ({ k: 'cmp', op, l: items[i], r: items[i + 1], line }));
      return { k: 'boolop', op: 'and', items: parts, line };
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.at('op') && ['+', '-'].includes(this.peek().v)) {
      const tok = this.next();
      const right = this.parseMul();
      left = { k: 'bin', op: tok.v, l: left, r: right, line: tok.line };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.at('op') && ['*', '//', '%', '/'].includes(this.peek().v)) {
      const tok = this.next();
      const right = this.parseUnary();
      left = { k: 'bin', op: tok.v, l: left, r: right, line: tok.line };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.at('op', '-')) {
      const line = this.next().line;
      return { k: 'un', op: '-', e: this.parseUnary(), line };
    }
    if (this.at('op', '+')) {
      const line = this.next().line;
      return { k: 'un', op: '+', e: this.parseUnary(), line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parseAtom();
    while (true) {
      if (this.at('op', '(')) {
        const line = this.next().line;
        const args: Expr[] = [];
        if (!this.at('op', ')')) {
          while (true) {
            args.push(this.parseExpr());
            if (this.at('op', ',')) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.eat('op', ')');
        expr = { k: 'call', fn: expr, args, line };
        continue;
      }
      if (this.at('op', '.')) {
        const line = this.next().line;
        const name = this.eat('name').v;
        expr = { k: 'attr', obj: expr, name, line };
        continue;
      }
      if (this.at('op', '[')) {
        const line = this.next().line;
        const index = this.parseExpr();
        this.eat('op', ']');
        expr = { k: 'sub', obj: expr, index, line };
        continue;
      }
      break;
    }
    return expr;
  }

  private parseAtom(): Expr {
    const tok = this.peek();
    if (tok.t === 'num') {
      this.next();
      return { k: 'num', v: Number(tok.v), line: tok.line };
    }
    if (tok.t === 'str') {
      this.next();
      if (tok.v.length > 64) throw new ParseError('字符串常量超过 64 字符上限', tok.line);
      return { k: 'str', v: tok.v, line: tok.line };
    }
    if (tok.t === 'kw') {
      if (tok.v === 'True' || tok.v === 'False') {
        this.next();
        return { k: 'bool', v: tok.v === 'True', line: tok.line };
      }
      if (tok.v === 'None') {
        this.next();
        return { k: 'none', line: tok.line };
      }
      if (tok.v === 'not') return this.parseNot();
    }
    if (tok.t === 'name') {
      this.next();
      return { k: 'name', id: tok.v, line: tok.line };
    }
    if (tok.t === 'op' && tok.v === '(') {
      this.next();
      const e = this.parseExpr();
      this.eat('op', ')');
      return e;
    }
    if (tok.t === 'op' && tok.v === '[') {
      this.next();
      if (this.at('op', ']')) {
        this.next();
        return { k: 'list', items: [], line: tok.line };
      }
      const first = this.parseExpr();
      if (this.at('kw', 'for')) {
        this.next();
        const target = this.eat('name').v;
        this.eat('kw', 'in');
        const iter = this.parseExpr();
        let cond: Expr | undefined;
        if (this.at('kw', 'if')) {
          this.next();
          cond = this.parseExpr();
        }
        this.eat('op', ']');
        return { k: 'comp', elt: first, target, iter, cond, line: tok.line };
      }
      const items = [first];
      while (this.at('op', ',')) {
        this.next();
        if (this.at('op', ']')) break;
        items.push(this.parseExpr());
      }
      this.eat('op', ']');
      return { k: 'list', items, line: tok.line };
    }
    throw new ParseError(`意外的记号: ${tok.v || tok.t}`, tok.line);
  }
}

export function parseModule(source: string): PyModule {
  const mod = new Parser(lex(source)).parseModule();
  mod.source = source;
  const lineCount = source.split('\n').filter((l) => stripComment(l).trim() !== '').length;
  mod.lines = lineCount;
  return mod;
}

export function parseScript(source: string): PyModule {
  const mod = new Parser(lex(source)).parseScript();
  mod.source = source;
  const lineCount = source.split('\n').filter((l) => stripComment(l).trim() !== '').length;
  mod.lines = lineCount;
  return mod;
}

export { stripComment };
export type PyFunction = PyModule['functions'][number];
export type PyClass = NonNullable<PyModule['clazz']>;
