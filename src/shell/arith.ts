// Shell arithmetic: $(( ... )), (( ... )), let, and arithmetic for-loops.

export class ArithError extends Error {}

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'unary'; op: string; e: Node }
  | { t: 'pre'; op: '++' | '--'; name: string }
  | { t: 'post'; op: '++' | '--'; name: string }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'assign'; op: string; name: string; e: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'comma'; l: Node; r: Node };

interface Tok {
  t: 'num' | 'id' | 'op' | 'end';
  v: string;
  pos: number;
}

const OPS = [
  '<<=', '>>=', '**', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=',
  '+', '-', '*', '/', '%', '<', '>', '!', '~', '&', '^', '|', '?', ':', '=', '(', ')', ',',
];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z@_]+|[0-9]+)/.exec(src.slice(i))!;
      toks.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      toks.push({ t: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ArithError(`syntax error: invalid arithmetic operator (error token is "${src.slice(i)}")`);
    toks.push({ t: 'op', v: op, pos: i });
    i += op.length;
  }
  toks.push({ t: 'end', v: '', pos: src.length });
  return toks;
}

function parseNumber(s: string): number {
  if (/^0[xX]/.test(s)) return parseInt(s.slice(2), 16);
  const hash = s.indexOf('#');
  if (hash > 0) {
    const base = parseInt(s.slice(0, hash), 10);
    const digits = s.slice(hash + 1);
    if (base < 2 || base > 64) throw new ArithError(`invalid arithmetic base (error token is "${s}")`);
    let n = 0;
    for (const d of digits) {
      let v: number;
      if (/[0-9]/.test(d)) v = d.charCodeAt(0) - 48;
      else if (/[a-z]/.test(d)) v = d.charCodeAt(0) - 87;
      else if (/[A-Z]/.test(d)) v = base <= 36 ? d.charCodeAt(0) - 55 : d.charCodeAt(0) - 29;
      else if (d === '@') v = 62;
      else v = 63;
      if (v >= base) throw new ArithError(`value too great for base (error token is "${s}")`);
      n = n * base + v;
    }
    return n;
  }
  if (s.length > 1 && s.startsWith('0')) {
    if (!/^[0-7]+$/.test(s)) throw new ArithError(`value too great for base (error token is "${s}")`);
    return parseInt(s, 8);
  }
  return parseInt(s, 10);
}

const BINARY_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
  '**': 11,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']);

class ArithParser {
  private toks: Tok[];
  private i = 0;
  private src: string;
  constructor(src: string) {
    this.src = src;
    this.toks = tokenize(src);
  }
  private peek(): Tok {
    return this.toks[this.i];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private fail(): never {
    const t = this.peek();
    const rest = this.src.slice(t.pos);
    if (t.t === 'end') throw new ArithError(`syntax error: operand expected (error token is "${rest}")`);
    throw new ArithError(`syntax error: invalid arithmetic operator (error token is "${rest}")`);
  }
  parse(): Node {
    const n = this.parseComma();
    if (this.peek().t !== 'end') {
      const rest = this.src.slice(this.peek().pos);
      throw new ArithError(`syntax error in expression (error token is "${rest}")`);
    }
    return n;
  }
  private parseComma(): Node {
    let l = this.parseAssign();
    while (this.peek().t === 'op' && this.peek().v === ',') {
      this.next();
      l = { t: 'comma', l, r: this.parseAssign() };
    }
    return l;
  }
  private parseAssign(): Node {
    const t = this.peek();
    const n2 = this.toks[this.i + 1];
    if (t.t === 'id' && n2 && n2.t === 'op' && ASSIGN_OPS.has(n2.v)) {
      this.i += 2;
      return { t: 'assign', op: n2.v, name: t.v, e: this.parseAssign() };
    }
    return this.parseTernary();
  }
  private parseTernary(): Node {
    const c = this.parseBinary(1);
    if (this.peek().t === 'op' && this.peek().v === '?') {
      this.next();
      const a = this.parseAssign();
      if (!(this.peek().t === 'op' && this.peek().v === ':')) this.fail();
      this.next();
      const b = this.parseAssign();
      return { t: 'cond', c, a, b };
    }
    return c;
  }
  private parseBinary(minPrec: number): Node {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op') break;
      const prec = BINARY_PREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      // ** is right-associative
      const r = this.parseBinary(t.v === '**' ? prec : prec + 1);
      l = { t: 'bin', op: t.v, l, r };
    }
    return l;
  }
  private parseUnary(): Node {
    const t = this.peek();
    if (t.t === 'op') {
      if (t.v === '++' || t.v === '--') {
        this.next();
        const id = this.next();
        if (id.t !== 'id') {
          this.i--;
          this.fail();
        }
        return { t: 'pre', op: t.v, name: id.v };
      }
      if (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~') {
        this.next();
        return { t: 'unary', op: t.v, e: this.parseUnary() };
      }
    }
    return this.parsePostfix();
  }
  private parsePostfix(): Node {
    const t = this.next();
    if (t.t === 'num') return { t: 'num', v: parseNumber(t.v) };
    if (t.t === 'id') {
      const n = this.peek();
      if (n.t === 'op' && (n.v === '++' || n.v === '--')) {
        this.next();
        return { t: 'post', op: n.v, name: t.v };
      }
      return { t: 'var', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      const e = this.parseComma();
      const close = this.next();
      if (close.t !== 'op' || close.v !== ')') {
        this.i--;
        this.fail();
      }
      return e;
    }
    this.i--;
    this.fail();
  }
}

export interface ArithEnv {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

function toInt(n: number): number {
  return Math.trunc(n);
}

export function evaluateArithmetic(src: string, env: ArithEnv, depth = 0): number {
  if (src.trim() === '') return 0;
  if (depth > 32) throw new ArithError('expression recursion level exceeded');
  const ast = new ArithParser(src).parse();
  const readVar = (name: string): number => {
    const v = env.get(name);
    if (v === undefined || v === '') return 0;
    const trimmed = v.trim();
    if (/^-?[0-9]+$/.test(trimmed)) return parseInt(trimmed, 10);
    return evaluateArithmetic(trimmed, env, depth + 1);
  };
  const ev = (n: Node): number => {
    switch (n.t) {
      case 'num':
        return n.v;
      case 'var':
        return readVar(n.name);
      case 'unary': {
        const v = ev(n.e);
        if (n.op === '-') return -v;
        if (n.op === '+') return v;
        if (n.op === '!') return v === 0 ? 1 : 0;
        return ~v;
      }
      case 'pre': {
        const v = readVar(n.name) + (n.op === '++' ? 1 : -1);
        env.set(n.name, String(v));
        return v;
      }
      case 'post': {
        const v = readVar(n.name);
        env.set(n.name, String(v + (n.op === '++' ? 1 : -1)));
        return v;
      }
      case 'comma':
        ev(n.l);
        return ev(n.r);
      case 'cond':
        return ev(n.c) !== 0 ? ev(n.a) : ev(n.b);
      case 'assign': {
        let v = ev(n.e);
        if (n.op !== '=') {
          const cur = readVar(n.name);
          v = applyBinary(n.op.slice(0, -1), cur, v, src);
        }
        env.set(n.name, String(v));
        return v;
      }
      case 'bin': {
        if (n.op === '&&') return ev(n.l) !== 0 && ev(n.r) !== 0 ? 1 : 0;
        if (n.op === '||') return ev(n.l) !== 0 || ev(n.r) !== 0 ? 1 : 0;
        return applyBinary(n.op, ev(n.l), ev(n.r), src);
      }
    }
  };
  return toInt(ev(ast));
}

function applyBinary(op: string, a: number, b: number, src: string): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return Math.trunc(a * b);
    case '/':
      if (b === 0) throw new ArithError(`division by 0 (error token is "${lastToken(src)}")`);
      return Math.trunc(a / b);
    case '%':
      if (b === 0) throw new ArithError(`division by 0 (error token is "${lastToken(src)}")`);
      return a % b;
    case '**':
      if (b < 0) throw new ArithError(`exponent less than 0 (error token is "${lastToken(src)}")`);
      return Math.trunc(a ** b);
    case '<<':
      return a << b;
    case '>>':
      return a >> b;
    case '<':
      return a < b ? 1 : 0;
    case '>':
      return a > b ? 1 : 0;
    case '<=':
      return a <= b ? 1 : 0;
    case '>=':
      return a >= b ? 1 : 0;
    case '==':
      return a === b ? 1 : 0;
    case '!=':
      return a !== b ? 1 : 0;
    case '&':
      return a & b;
    case '^':
      return a ^ b;
    case '|':
      return a | b;
  }
  throw new ArithError(`syntax error: invalid arithmetic operator`);
}

function lastToken(src: string): string {
  const m = /(\S+)\s*$/.exec(src);
  return m ? m[1] : src;
}
