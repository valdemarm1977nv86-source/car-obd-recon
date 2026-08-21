// Компилятор формул из извлечённой базы Car Scanner в JS-функции.
// Формулы используют буквы столбцов (A, B, ..., Z, AA, AB, ...) как индексы байт ответа
// (A = первый байт данных после заголовка, как в стандартном ELM327/SAE J1979 соглашении,
// уже используемом в pids.js и kia-pids.js), плюс небольшой набор функций:
// And, Or, Shr, Shl, GetBit(x,бит с 0), IF/if(усл,да,нет), SIGNED/Signed(байт),
// ShortSigned(старший,младший), float32(4 байта, IEEE754), MAX, MIN, ABS.
// См. LESSONS.md (2026-08-21) — формулы извлечены реальным разбором embedded-ресурсов
// Car Scanner (ReEngineer Pro), не подобраны на глаз.

const FUNCS = new Set([
  "and", "or", "shr", "shl", "getbit", "if", "signed", "shortsigned", "float32", "max", "min", "abs",
]);

function letterToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); // A=1
  return n - 1; // нулевой индекс байта в массиве ответа
}

class Tokenizer {
  constructor(src) {
    this.src = src;
    this.pos = 0;
  }
  peekChar() { return this.src[this.pos]; }
  next() {
    // '@' встречается в части формул перед побитовыми операторами (@<<, @>>, @&) — судя по
    // всему, служебный маркер исходного формата, самих вычислений не меняет — пропускаем как пробел.
    while (this.pos < this.src.length && /[\s@]/.test(this.src[this.pos])) this.pos++;
    if (this.pos >= this.src.length) return { type: "eof" };
    const c = this.src[this.pos];
    if (/[0-9.]/.test(c)) {
      let s = "";
      while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) s += this.src[this.pos++];
      return { type: "num", value: s };
    }
    if (/[A-Za-z]/.test(c)) {
      let s = "";
      while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos])) s += this.src[this.pos++];
      return { type: "ident", value: s };
    }
    const two = this.src.slice(this.pos, this.pos + 2);
    if (two === "<<" || two === ">>") {
      this.pos += 2;
      return { type: "op", value: two };
    }
    if ("+-*/^&(),=<>".includes(c)) {
      this.pos++;
      return { type: "op", value: c };
    }
    throw new Error(`Неожиданный символ "${c}" на позиции ${this.pos}`);
  }
}

class Parser {
  constructor(src) {
    this.tk = new Tokenizer(src);
    this.cur = this.tk.next();
  }
  eat(type, value) {
    if (this.cur.type !== type || (value !== undefined && this.cur.value !== value)) {
      throw new Error(`Ожидался ${type}${value ? " '" + value + "'" : ""}, получено ${this.cur.type} '${this.cur.value ?? ""}'`);
    }
    const t = this.cur;
    this.cur = this.tk.next();
    return t;
  }
  parse() {
    const node = this.comparison();
    if (this.cur.type !== "eof") throw new Error(`Лишние символы после выражения: '${this.cur.value ?? ""}'`);
    return node;
  }
  comparison() {
    let left = this.additive();
    if (this.cur.type === "op" && ["=", "<", ">"].includes(this.cur.value)) {
      const op = this.eat("op").value;
      const right = this.additive();
      left = { t: "cmp", op, left, right };
    }
    return left;
  }
  additive() {
    let left = this.term();
    while (this.cur.type === "op" && ["+", "-"].includes(this.cur.value)) {
      const op = this.eat("op").value;
      const right = this.term();
      left = { t: "bin", op, left, right };
    }
    return left;
  }
  term() {
    let left = this.power();
    while (this.cur.type === "op" && ["*", "/", "&", "<<", ">>"].includes(this.cur.value)) {
      const op = this.eat("op").value;
      const right = this.power();
      left = { t: "bin", op, left, right };
    }
    return left;
  }
  power() {
    let left = this.unary();
    while (this.cur.type === "op" && this.cur.value === "^") {
      this.eat("op");
      const right = this.unary();
      left = { t: "pow", left, right };
    }
    return left;
  }
  unary() {
    if (this.cur.type === "op" && this.cur.value === "-") {
      this.eat("op");
      return { t: "neg", value: this.unary() };
    }
    return this.primary();
  }
  primary() {
    if (this.cur.type === "num") {
      const v = this.eat("num").value;
      return { t: "num", value: parseFloat(v) };
    }
    if (this.cur.type === "op" && this.cur.value === "(") {
      this.eat("op", "(");
      const e = this.comparison();
      this.eat("op", ")");
      return e;
    }
    if (this.cur.type === "ident") {
      const name = this.eat("ident").value;
      if (this.cur.type === "op" && this.cur.value === "(") {
        this.eat("op", "(");
        const args = [];
        if (!(this.cur.type === "op" && this.cur.value === ")")) {
          args.push(this.comparison());
          while (this.cur.type === "op" && this.cur.value === ",") {
            this.eat("op", ",");
            args.push(this.comparison());
          }
        }
        this.eat("op", ")");
        const lname = name.toLowerCase();
        if (!FUNCS.has(lname)) throw new Error(`Неизвестная функция "${name}"`);
        return { t: "call", name: lname, args };
      }
      if (!/^[A-Z]+$/.test(name)) throw new Error(`Неверное имя переменной "${name}" (ожидались заглавные буквы столбца)`);
      return { t: "var", index: letterToIndex(name) };
    }
    throw new Error(`Неожиданный токен ${this.cur.type} '${this.cur.value ?? ""}'`);
  }
}

// Рантайм-хелперы для скомпилированного кода (передаются как второй параметр компилированной функции).
const H = {
  and: (x, y) => x & y,
  or: (x, y) => x | y,
  shr: (x, y) => x >> y,
  shl: (x, y) => x << y,
  getbit: (x, n) => (x >> n) & 1,
  if: (c, a, b) => (c ? a : b),
  signed: (x) => (x > 127 ? x - 256 : x),
  shortsigned: (a, b) => { const r = a * 256 + b; return r > 32767 ? r - 65536 : r; },
  float32: (a, b, c, d) => new DataView(new Uint8Array([a, b, c, d]).buffer).getFloat32(0, false),
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b),
  abs: (a) => Math.abs(a),
};

function emit(node) {
  switch (node.t) {
    case "num": return String(node.value);
    case "var": return `b[${node.index}]`;
    case "neg": return `(-${emit(node.value)})`;
    case "pow": return `Math.pow(${emit(node.left)},${emit(node.right)})`;
    case "bin": {
      const op = node.op === "&" ? "&" : node.op;
      return `(${emit(node.left)}${op}${emit(node.right)})`;
    }
    case "cmp": {
      const op = node.op === "=" ? "===" : node.op;
      return `(${emit(node.left)}${op}${emit(node.right)})`;
    }
    case "call":
      return `H.${node.name}(${node.args.map(emit).join(",")})`;
    default:
      throw new Error("Неизвестный узел формулы: " + node.t);
  }
}

// Максимальный индекс байта, используемый в формуле — чтобы понять, сколько байт ответа нужно.
function maxByteIndex(node) {
  switch (node.t) {
    case "var": return node.index;
    case "num": return -1;
    case "neg": return maxByteIndex(node.value);
    case "pow": case "bin": case "cmp": return Math.max(maxByteIndex(node.left), maxByteIndex(node.right));
    case "call": return node.args.reduce((m, a) => Math.max(m, maxByteIndex(a)), -1);
    default: return -1;
  }
}

// Компилирует строку формулы (например "((J*256)+K)*0.25") в функцию (bytes:number[]) => number.
// Бросает исключение, если формула не распознана — вызывающий код должен это ловить и
// пропускать конкретный параметр, не гадая на замену.
export function compileFormula(src) {
  const ast = new Parser(src).parse();
  const body = emit(ast);
  // eslint-disable-next-line no-new-func
  const fn = new Function("b", "H", `return (${body});`);
  const needBytes = maxByteIndex(ast) + 1;
  const wrapped = (bytes) => {
    if (!bytes || bytes.length < needBytes) return null;
    const v = fn(bytes, H);
    return typeof v === "boolean" ? (v ? 1 : 0) : (Number.isFinite(v) ? v : null);
  };
  wrapped.needBytes = needBytes;
  return wrapped;
}
