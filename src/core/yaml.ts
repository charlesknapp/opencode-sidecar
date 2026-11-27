// A small YAML reader and writer for the shapes Sidecar meets: agent frontmatter and Roo
// Code / Kilo Code `.roomodes` files. The extension has no runtime dependencies, so this
// covers the common subset instead of all of YAML 1.2: block mappings and sequences
// (compact `- key: value` and `- - item` included), flow `[ ]` and `{ }` collections,
// plain, single- and double-quoted scalars (also over several lines), `|` and `>` block
// scalars with chomping and indentation indicators, and comments. Anchors, aliases, tags,
// complex keys and several documents are refused with a YamlError naming the line, so a
// file Sidecar cannot read is never half-read.

export class YamlError extends Error {
  constructor(
    message: string,
    /** 1-based line of the problem in the text given. */
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = "YamlError";
  }
}

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

/** Parses one YAML document of the supported subset. Empty text is null. */
export function parseYaml(text: string): YamlValue {
  const p = new Parser(text.replace(/^\uFEFF/, "").split(/\r?\n/));
  p.skipBlank();
  if (p.done()) return null;
  const first = p.lines[p.pos];
  if (/^---\s*$/.test(first) || /^\.\.\.\s*$/.test(first))
    throw p.error("Document markers are not supported");
  const value = p.node(0);
  p.skipBlank();
  if (!p.done()) throw p.error("Unexpected content");
  return value;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => /^\s*(#.*)?$/.test(line);

class Parser {
  pos = 0;
  constructor(readonly lines: string[]) {
    for (let i = 0; i < lines.length; i++)
      if (/^ *\t/.test(lines[i]) && !isBlank(lines[i]))
        throw new YamlError("Tabs cannot indent YAML; use spaces", i + 1);
  }

  done(): boolean {
    return this.pos >= this.lines.length;
  }

  error(message: string, line = this.pos): YamlError {
    return new YamlError(message, Math.min(line, this.lines.length - 1) + 1);
  }

  skipBlank(): void {
    while (!this.done() && isBlank(this.lines[this.pos])) this.pos++;
  }

  /** The block node starting on the next line that is indented at least `min`, or null. */
  node(min: number): YamlValue {
    this.skipBlank();
    if (this.done()) return null;
    const line = this.lines[this.pos];
    const ind = indentOf(line);
    if (ind < min) return null;
    const rest = line.slice(ind);
    if (rest === "-" || rest.startsWith("- ")) return this.sequence(ind);
    if (keyOf(rest)) return this.mapping(ind);
    // A scalar or flow collection on its own line (a sequence item's, or the document's).
    this.pos++;
    return this.value(rest, ind - 1, this.pos - 1);
  }

  sequence(ind: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.done()) break;
      const line = this.lines[this.pos];
      const i = indentOf(line);
      const rest = line.slice(i);
      if (i !== ind || !(rest === "-" || rest.startsWith("- "))) {
        if (i > ind) throw this.error("Bad indentation in a list");
        break;
      }
      const after = rest.slice(1);
      const inline = after.trimStart();
      if (!inline || inline.startsWith("#")) {
        this.pos++;
        out.push(this.node(ind + 1));
        continue;
      }
      // `- key: v` and `- - x`: read the rest as a block that starts further right.
      const col = ind + 1 + (after.length - inline.length);
      this.lines[this.pos] = " ".repeat(col) + inline;
      if (inline === "-" || inline.startsWith("- ") || keyOf(inline)) out.push(this.node(col));
      else {
        this.pos++;
        out.push(this.value(inline, ind, this.pos - 1));
      }
    }
    return out;
  }

  mapping(ind: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      this.skipBlank();
      if (this.done()) break;
      const line = this.lines[this.pos];
      const i = indentOf(line);
      if (i < ind) break;
      if (i > ind) throw this.error("Bad indentation in a mapping");
      const k = keyOf(line.slice(i));
      if (!k) {
        if (line.slice(i).startsWith("- ")) break; // `key:` followed by a list at the same indent ends here
        throw this.error("Expected `key: value`");
      }
      if (Object.prototype.hasOwnProperty.call(out, k.key)) throw this.error(`Duplicate key "${k.key}"`);
      const at = this.pos;
      this.pos++;
      const rest = k.rest.trim();
      let v: YamlValue;
      if (!rest || rest.startsWith("#")) {
        this.skipBlank();
        const next = this.done() ? "" : this.lines[this.pos];
        const ni = indentOf(next);
        const nr = next.slice(ni);
        if (!this.done() && ni === ind && (nr === "-" || nr.startsWith("- "))) v = this.sequence(ind);
        else v = this.node(ind + 1);
      } else v = this.value(rest, ind, at);
      out[k.key] = v;
    }
    return out;
  }

  /**
   * A value that starts on line `at` with `text` (after `key:` or `- `): a block scalar,
   * a quoted or flow value (perhaps over more lines), or a plain scalar. Continuation
   * lines must be indented more than `parent`.
   */
  value(text: string, parent: number, at: number): YamlValue {
    const c = text[0];
    if (c === "&" || c === "*" || c === "!")
      throw this.error("Anchors, aliases and tags are not supported", at);
    if (c === "|" || c === ">") return this.blockScalar(text, parent, at);
    if (c === '"' || c === "'" || c === "[" || c === "{") {
      let src = text;
      for (;;) {
        let r: ReturnType<typeof tryInline>;
        try {
          r = tryInline(src);
        } catch (e) {
          if (e instanceof FlowError) throw this.error(e.message, at);
          throw e;
        }
        if (r !== undefined) {
          const tail = src.slice(r.end).trim();
          if (tail && !tail.startsWith("#")) throw this.error("Unexpected text after a value", this.pos - 1);
          return r.value;
        }
        if (this.done() || (indentOf(this.lines[this.pos]) <= parent && !isBlankLine(this.lines[this.pos])))
          throw this.error(
            c === "[" || c === "{" ? "Unclosed flow collection" : "Unclosed quoted string",
            at,
          );
        src += "\n" + this.lines[this.pos].trim();
        this.pos++;
      }
    }
    // A plain scalar, perhaps folded over more-indented lines (not after a comment).
    const first = stripComment(text);
    let s = first;
    let more = first === text.trim();
    let lines = 1;
    while (more && !this.done()) {
      // Blank lines inside a plain scalar are line breaks, if the scalar goes on.
      let j = this.pos;
      while (j < this.lines.length && isBlankLine(this.lines[j])) j++;
      const line = this.lines[j];
      if (line === undefined || indentOf(line) <= parent || isBlank(line)) break;
      const part = line.trim();
      // `key: value` indented under a scalar is a mistake, not more text.
      if (keyOf(part)) throw this.error("Bad indentation: a mapping inside a value", j);
      const cut = stripComment(part);
      s += j > this.pos ? "\n".repeat(j - this.pos) + cut : " " + cut;
      more = cut === part;
      lines++;
      this.pos = j + 1;
    }
    return lines > 1 ? s : plainValue(s);
  }

  blockScalar(header: string, parent: number, at: number): string {
    const m = /^([|>])([1-9])?([+-])?([1-9])?\s*(#.*)?$/.exec(header);
    if (!m) throw this.error("Bad block scalar header", at);
    const folded = m[1] === ">";
    const chomp = m[3] ?? "";
    const explicit = Number(m[2] ?? m[4] ?? 0);
    const start = this.pos;
    let indent = explicit ? Math.max(parent, 0) + explicit : 0;
    if (!indent) {
      for (let j = start; j < this.lines.length; j++) {
        if (this.lines[j].trim() === "") continue;
        indent = indentOf(this.lines[j]);
        break;
      }
      if (indent <= parent) indent = parent + 1;
    }
    const body: string[] = [];
    while (!this.done()) {
      const line = this.lines[this.pos];
      if (line.trim() === "") body.push("");
      else if (indentOf(line) >= indent) body.push(line.slice(indent));
      else break;
      this.pos++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    let s = "";
    if (!folded) s = body.join("\n");
    else {
      // A break between two lines of text is a space; n blank lines between them are n
      // breaks; breaks around more-indented lines are kept.
      const indented = (l: string) => l.startsWith(" ") || l.startsWith("\t");
      let prev: string | null = null;
      let empties = 0;
      for (const line of body) {
        if (line === "") {
          empties++;
          continue;
        }
        if (prev === null) s += "\n".repeat(empties) + line;
        else if (indented(line) || indented(prev)) s += "\n".repeat(empties + 1) + line;
        else s += empties ? "\n".repeat(empties) + line : " " + line;
        prev = line;
        empties = 0;
      }
    }
    if (!body.length) return chomp === "+" ? "\n".repeat(trailing) : "";
    if (chomp === "-") return s;
    if (chomp === "+") return s + "\n".repeat(trailing + 1);
    return s + "\n";
  }
}

const isBlankLine = (line: string): boolean => line.trim() === "";

/** The key a line starts at the top level of a mapping, or null (indented, comment, list, …). */
export function topLevelKey(line: string): string | null {
  if (!line || /^\s/.test(line) || line.startsWith("#")) return null;
  return keyOf(line)?.key ?? null;
}

/** `key: rest` (the key plain or quoted); null when the text is not a mapping entry. */
function keyOf(text: string): { key: string; rest: string } | null {
  if (text.startsWith('"') || text.startsWith("'")) {
    let r: ReturnType<typeof tryInline>;
    try {
      r = tryInline(text);
    } catch {
      return null;
    }
    if (!r || typeof r.value !== "string") return null;
    const after = text.slice(r.end);
    const m = /^\s*:(\s|$)/.exec(after);
    return m ? { key: r.value, rest: after.slice(m[0].length) } : null;
  }
  if (/^[[{#&*!|>%@`-]/.test(text) && !/^-[^\s]/.test(text)) return null;
  const m = /^(.*?[^\s]):(?:\s|$)/.exec(text);
  if (!m || m[1].includes(" #")) return null;
  return { key: m[1], rest: text.slice(m[0].length) };
}

function stripComment(s: string): string {
  const i = s.search(/(^|\s)#/);
  return (i < 0 ? s : s.slice(0, i)).trim();
}

/** A plain scalar's value: null, a boolean, a number or the text. */
function plainValue(s: string): YamlValue {
  if (s === "" || s === "~" || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(s)) return Number(s);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

/**
 * Reads one quoted string or flow collection from the start of `src`; undefined when it
 * is not closed yet (the caller adds the next line).
 */
function tryInline(src: string): { value: YamlValue; end: number } | undefined {
  try {
    return new Flow(src).any(true);
  } catch (e) {
    if (e instanceof Unclosed) return undefined;
    throw e;
  }
}

class Unclosed extends Error {}
/** A problem inside a quoted or flow value; the parser adds the line. */
class FlowError extends Error {}

class Flow {
  i = 0;
  constructor(readonly s: string) {}

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  any(top = false): { value: YamlValue; end: number } {
    this.ws();
    const c = this.s[this.i];
    let value: YamlValue;
    if (c === undefined) throw new Unclosed();
    if (c === '"') value = this.double();
    else if (c === "'") value = this.single();
    else if (c === "[") value = this.seq();
    else if (c === "{") value = this.map();
    else if (top) throw new FlowError("Expected a value");
    else value = plainValue(this.plain(false));
    return { value, end: this.i };
  }

  plain(key: boolean): string {
    const start = this.i;
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (ch === "," || ch === "]" || ch === "}") break;
      if (ch === ":" && (key || /[\s,\]}]/.test(this.s[this.i + 1] ?? " "))) break;
      if (ch === "#" && /\s/.test(this.s[this.i - 1] ?? "")) break;
      this.i++;
    }
    return this.s.slice(start, this.i).replace(/\s+/g, " ").trim();
  }

  seq(): YamlValue[] {
    this.i++;
    const out: YamlValue[] = [];
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) throw new Unclosed();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.any().value);
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") {
        if (this.i >= this.s.length) throw new Unclosed();
        throw new FlowError("Expected , or ] in a flow list");
      }
    }
  }

  map(): { [key: string]: YamlValue } {
    this.i++;
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) throw new Unclosed();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const c = this.s[this.i];
      const key = c === '"' ? this.double() : c === "'" ? this.single() : this.plain(true);
      this.ws();
      let value: YamlValue = null;
      if (this.s[this.i] === ":") {
        this.i++;
        this.ws();
        if (this.s[this.i] !== "," && this.s[this.i] !== "}") value = this.any().value;
      }
      out[key] = value;
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") {
        if (this.i >= this.s.length) throw new Unclosed();
        throw new FlowError("Expected , or } in a flow mapping");
      }
    }
  }

  single(): string {
    this.i++;
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) throw new Unclosed();
      const ch = this.s[this.i];
      if (ch === "'") {
        if (this.s[this.i + 1] === "'") {
          out += "'";
          this.i += 2;
          continue;
        }
        this.i++;
        return fold(out);
      }
      out += ch;
      this.i++;
    }
  }

  double(): string {
    this.i++;
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) throw new Unclosed();
      const ch = this.s[this.i];
      if (ch === '"') {
        this.i++;
        return fold(out);
      }
      if (ch === "\\") {
        const n = this.s[this.i + 1];
        if (n === undefined) throw new Unclosed();
        const simple: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          "0": "\0",
          '"': '"',
          "\\": "\\",
          "/": "/",
          " ": " ",
          b: "\b",
          f: "\f",
          e: "\x1b",
          a: "\x07",
          v: "\v",
          N: "\u0085",
          _: "\u00a0",
        };
        if (n in simple) {
          // A protected character is kept through folding.
          out += n === "n" ? "\uE000" : simple[n];
          this.i += 2;
        } else if (n === "x" || n === "u" || n === "U") {
          const len = n === "x" ? 2 : n === "u" ? 4 : 8;
          const hex = this.s.slice(this.i + 2, this.i + 2 + len);
          if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw new FlowError("Bad escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          this.i += 2 + len;
        } else if (n === "\n") {
          // An escaped line break joins the lines without a space.
          this.i += 2;
          while (this.s[this.i] === " ") this.i++;
          out += "\uE001";
        } else throw new FlowError(`Unknown escape \\${n}`);
        continue;
      }
      out += ch;
      this.i++;
    }
  }
}

/** Line folding inside a quoted string: a line break is a space, a blank line a break. */
function fold(raw: string): string {
  const s = raw.includes("\n")
    ? raw
        .split("\n")
        .map((l, i, all) => (i === 0 ? l.trimEnd() : i === all.length - 1 ? l.trimStart() : l.trim()))
        .reduce(
          (acc, l, i) => (i === 0 ? l : l === "" ? acc + "\n" : acc.endsWith("\n") ? acc + l : acc + " " + l),
          "",
        )
    : raw;
  return s.replace(/ ?\uE001/g, "").replace(/\uE000/g, "\n");
}

// ------------------------------------------------------------------- writing

/** A string as a YAML scalar: plain when that reads back the same, double-quoted otherwise. */
export function yamlString(s: string): string {
  const plainOk =
    s !== "" &&
    s === s.trim() &&
    !/[\n\r\t]/.test(s) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) &&
    !/: |:$| #/.test(s) &&
    typeof plainValue(s) === "string";
  // JSON's string syntax is valid YAML double-quoted syntax.
  return plainOk ? s : JSON.stringify(s);
}

/** A scalar as YAML. */
export function yamlScalar(v: null | boolean | number | string): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return yamlString(v);
}

const isMap = (v: YamlValue): v is { [key: string]: YamlValue } =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** `key: value` as block YAML lines (nested mappings and lists indented by two spaces). */
export function yamlEntry(key: string, value: YamlValue, indent = 0): string[] {
  const pad = " ".repeat(indent);
  const k = yamlString(key);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}${k}: []`];
    return [`${pad}${k}:`, ...yamlList(value, indent + 2)];
  }
  if (isMap(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return [`${pad}${k}: {}`];
    return [`${pad}${k}:`, ...keys.flatMap((sub) => yamlEntry(sub, value[sub], indent + 2))];
  }
  return [`${pad}${k}: ${yamlScalar(value)}`];
}

function yamlList(items: YamlValue[], indent: number): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (const item of items) {
    if (isMap(item) && Object.keys(item).length) {
      // `- key: value`, the other keys under the first.
      const lines = Object.keys(item).flatMap((sub) => yamlEntry(sub, item[sub], indent + 2));
      out.push(`${pad}- ${lines[0].slice(indent + 2)}`, ...lines.slice(1));
    } else if (Array.isArray(item) && item.length) {
      const lines = yamlList(item, indent + 2);
      out.push(`${pad}- ${lines[0].slice(indent + 2)}`, ...lines.slice(1));
    } else if (Array.isArray(item)) out.push(`${pad}- []`);
    else if (isMap(item)) out.push(`${pad}- {}`);
    else out.push(`${pad}- ${yamlScalar(item)}`);
  }
  return out;
}
