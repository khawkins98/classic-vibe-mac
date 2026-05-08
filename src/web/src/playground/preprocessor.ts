/**
 * preprocessor.ts — TypeScript C-like preprocessor for the in-browser
 * WASM-Rez compiler.
 *
 * ARCHITECTURAL CHOICE — read this before extending.
 *
 * The spike's MiniLexer (vendor/MiniLexer.cc, compiled into wasm-rez.wasm)
 * skips lines starting with `#`. Production needs `#include`, `#define`,
 * `#if`/`#ifdef`/`#else`/`#endif`, and macro substitution to handle real
 * Apple .r files like reader.r and macweather.r.
 *
 * Phase 2 implements this *on the JS side*, BEFORE the source is handed to
 * the WASM. The WASM still only sees the lexer-friendly slice — comments
 * stripped, includes inlined, defines substituted, conditionals already
 * resolved. The decision is documented in tools/wasm-rez/README.md and in
 * LEARNINGS.md (final track of this branch).
 *
 * Why not extend MiniLexer.cc and rebuild WASM?
 *
 * 1. The WASM artefact stays stable. Vendoring prebuilt blobs (Track 1b
 *    of Issue #30) is much friendlier to CI than running emsdk in a
 *    Docker container on every commit.
 * 2. The IDB-VFS bridge — the playground reads source files from
 *    IndexedDB, not a real disk — is naturally a JS concern. Doing
 *    `#include` resolution through Emscripten's FS would mean a
 *    bidirectional async-file callback that's awkward to plumb.
 * 3. Error reporting can use host-side line/column counters and carry
 *    the include-stack as text the editor can render.
 * 4. Future-proofing: if MiniLexer ever needs to be replaced with mcpp
 *    (the agreed week-2 fallback per the spike spec), the JS preprocessor
 *    stays as the orchestration layer — only its codegen target changes.
 *
 * Coverage as of Phase 2 (Issue #30 Tracks 3+4):
 *   - `#include "Filename.r"` resolved against (a) IDB user files in the
 *     same project namespace, (b) static-asset RIncludes/ bundle.
 *   - `#define NAME body` and `#define NAME(args) body`
 *   - `#undef NAME`
 *   - `#if EXPR`, `#elif EXPR`, `#else`, `#endif` with a small constant-
 *     expression evaluator (defined()/!/&&/||/comparisons/integer literals/
 *     identifier-as-macro-substitution)
 *   - `#ifdef NAME`, `#ifndef NAME`
 *   - `#error MESSAGE` and `#warning MESSAGE` — emitted as Diagnostics
 *   - C-style `/* … *\/` and `//` comments stripped before tokenization
 *   - Re-include guards (the standard `#ifndef _FOO_R_ / #define _FOO_R_`
 *     idiom) work without any explicit handling — they fall out of #if
 *     evaluation against the running #define table.
 *
 * Known gaps. The mini lexer's coverage is "compatible with Apple's stock
 * .r headers as bundled in our RIncludes/" — it is NOT a full C99
 * preprocessor. Specifically:
 *   - No variadic macros (`__VA_ARGS__`).
 *   - No stringification (`#x`).
 *   - No token-pasting (`##`).
 *   - Macro arguments are scanned *without* recursive re-expansion of the
 *     replacement list (a known C99 subtlety; the standard's "blue paint"
 *     rules around already-expanded tokens are simplified to: don't expand
 *     a macro inside its own replacement list).
 *   - `#pragma` is silently dropped.
 * If a real .r file in the wild trips one of these, the documented escape
 * hatch is to vendor mcpp as an additional WASM blob (~80 KB) and pipe
 * source through it before our codegen — see tools/wasm-rez/README.md.
 *
 * Diagnostics shape matches the spike's stderr format (file:line: msg) so
 * the same parser consumes both our preprocessor errors and Rez's
 * downstream errors.
 */

export interface Diagnostic {
  /** Source file the issue was discovered in. May be a virtual name like
   *  `<input>` for the top-level user buffer. */
  file: string;
  /** 1-indexed line number within `file`. */
  line: number;
  /** 1-indexed column. Best-effort; we don't always have a real column. */
  column: number;
  /** Human-readable message. */
  message: string;
  /** "error" prevents compile; "warning" lets it continue. */
  severity: "error" | "warning";
}

/**
 * A virtual filesystem the preprocessor reads through. Two backends ship
 * out of the box:
 *   - IDB-backed user files (the project's editable source)
 *   - HTTP fetch for the static-asset RIncludes/ bundle
 *
 * Callers compose those into one VFS and hand it to `preprocess`. The
 * VFS interface is intentionally synchronous because preprocessing is
 * one synchronous pass; the *fetching* is hoisted ahead of time by
 * `prefetch` (below) so the preprocessor itself runs to completion in
 * one tick of the event loop.
 */
export interface Vfs {
  /** Resolve `name` (an unquoted #include filename) against `fromFile`
   *  (the file currently being processed, used for relative resolution
   *  and to detect self-includes). Returns the file contents or
   *  `undefined` if the file isn't in the VFS. */
  read(name: string, fromFile: string): string | undefined;
  /** Best-effort canonical name used for include-stack reporting and
   *  re-include detection. Implementations should return the same string
   *  for two `read` calls that reference the same underlying file. */
  canonicalName(name: string, fromFile: string): string;
}

/** Top-level preprocessor entry point. Returns the flattened source plus
 *  any diagnostics. Caller should treat any "error" diagnostic as fatal
 *  even if `output` is non-empty. */
export interface PreprocessResult {
  output: string;
  diagnostics: Diagnostic[];
}

interface MacroDefinition {
  name: string;
  /** `undefined` for object-like macros, `string[]` for function-like. */
  params?: string[];
  body: string;
}

interface IncludeFrame {
  file: string;
  /** 1-indexed line number in `file`. */
  line: number;
}

/**
 * Run the preprocessor. `topName` is the virtual name of the buffer in
 * `topSource` (used in diagnostics; e.g. `reader.r`). `predefined` is the
 * initial macro table — typical use is to pre-seed `Rez=1`, `DeRez=0`,
 * `true=1`, `false=0`, `TRUE=1`, `FALSE=0` (matching the spike's
 * `MiniLexer::addDefine` behaviour).
 */
export function preprocess(
  topSource: string,
  topName: string,
  vfs: Vfs,
  predefined: Record<string, string> = {},
): PreprocessResult {
  const out: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const macros = new Map<string, MacroDefinition>();
  for (const [k, v] of Object.entries(predefined)) {
    macros.set(k, { name: k, body: v });
  }

  /** Visited-this-pass set keyed by canonical filename — pure cycle
   *  guard, NOT a #pragma once. Real re-include guards are honoured
   *  through #if evaluation against the macro table. We add this guard
   *  on top because a self-recursive include without proper guards
   *  would otherwise spin forever; the guard breaks the cycle and
   *  reports a clean error. */
  const cycleGuard = new Set<string>();

  processOne(topSource, topName, [], cycleGuard);

  return { output: out.join(""), diagnostics };

  // ── Inner helpers, all closing over `out`, `diagnostics`, `macros`. ──

  function processOne(
    source: string,
    file: string,
    includeStack: IncludeFrame[],
    cycleGuard: Set<string>,
  ): void {
    // First, strip C/C++ comments. Doing it as a separate pre-pass keeps
    // every downstream regex simple (no need to dodge "//" inside string
    // literals at every call site). String-literal preservation matters
    // because Rez's own grammar treats `"` and `'` as token delimiters.
    source = stripComments(source);

    const lines = source.split(/\r\n|\n|\r/);

    // Conditional-compilation stack. Each entry: { active, anyTaken } —
    // anyTaken says whether a previous branch in this group was true,
    // so an else-branch knows to stay inactive even when its predicate
    // would be true. We pre-push a sentinel so the top level is "active".
    const condStack: { active: boolean; anyTaken: boolean }[] = [
      { active: true, anyTaken: true },
    ];
    const isActive = () => condStack.every((f) => f.active);

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      let line = lines[lineNo]!;
      // Continuation lines: a trailing `\` glues this line onto the next.
      // Apple .r files use this for long macro bodies and array literals.
      while (line.endsWith("\\") && lineNo + 1 < lines.length) {
        line = line.slice(0, -1) + lines[++lineNo]!;
      }

      const trimmed = line.trimStart();
      if (trimmed.startsWith("#")) {
        handleDirective(
          trimmed.slice(1).trimStart(),
          file,
          lineNo + 1,
          condStack,
          includeStack,
          cycleGuard,
        );
      } else if (isActive()) {
        // Ordinary content line: macro-expand and emit, preserving the
        // original newline. We deliberately keep the newline counts in
        // the output equal to the input so downstream Rez error line
        // numbers match the user's view (the include-stack mapping is
        // what we use to translate back to "which file"; lines within
        // a file map 1:1).
        out.push(expandMacros(line, file, lineNo + 1));
        out.push("\n");
      } else {
        // Inactive branch — emit a bare newline to keep line numbers
        // aligned. This is the standard cpp behaviour and it's what
        // makes "error on line 42" point to the same line the user
        // sees in their editor.
        out.push("\n");
      }
    }

    if (condStack.length > 1) {
      diagnostics.push({
        file,
        line: lines.length,
        column: 1,
        message: "unterminated #if block at end of file",
        severity: "error",
      });
    }
  }

  function handleDirective(
    body: string,
    file: string,
    line: number,
    condStack: { active: boolean; anyTaken: boolean }[],
    includeStack: IncludeFrame[],
    cycleGuard: Set<string>,
  ): void {
    const m = body.match(/^([a-zA-Z_]+)\s*(.*)$/);
    if (!m) {
      // `# 12 "file"` GCC line markers — silently accept.
      // Bare `#` line is also fine.
      return;
    }
    const directive = m[1]!;
    const rest = m[2] ?? "";

    const isActive = () => condStack.every((f) => f.active);

    switch (directive) {
      case "include": {
        if (!isActive()) return;
        const inc = parseIncludeArg(rest);
        if (!inc) {
          diagnostics.push({
            file,
            line,
            column: 1,
            message: `malformed #include: ${rest}`,
            severity: "error",
          });
          return;
        }
        const canon = vfs.canonicalName(inc, file);
        if (cycleGuard.has(canon)) {
          // Cycle guard. The standard re-include idiom (`#ifndef _X_R_`)
          // means we should never hit this in well-formed code — if we
          // do, it's a real cycle and we tell the user about it.
          diagnostics.push({
            file,
            line,
            column: 1,
            message: `cyclic #include of '${inc}'`,
            severity: "error",
          });
          return;
        }
        const text = vfs.read(inc, file);
        if (text === undefined) {
          diagnostics.push({
            file,
            line,
            column: 1,
            message: `cannot find #include file '${inc}'`,
            severity: "error",
          });
          return;
        }
        cycleGuard.add(canon);
        try {
          processOne(text, canon, [...includeStack, { file, line }], cycleGuard);
        } finally {
          cycleGuard.delete(canon);
        }
        return;
      }
      case "define": {
        if (!isActive()) return;
        const def = parseDefine(rest);
        if (!def) {
          diagnostics.push({
            file,
            line,
            column: 1,
            message: `malformed #define: ${rest}`,
            severity: "error",
          });
          return;
        }
        macros.set(def.name, def);
        return;
      }
      case "undef": {
        if (!isActive()) return;
        const name = rest.trim();
        if (name) macros.delete(name);
        return;
      }
      case "ifdef": {
        const name = rest.trim();
        const cond = macros.has(name);
        condStack.push({ active: cond, anyTaken: cond });
        return;
      }
      case "ifndef": {
        const name = rest.trim();
        const cond = !macros.has(name);
        condStack.push({ active: cond, anyTaken: cond });
        return;
      }
      case "if": {
        const cond = !!evaluateExpr(rest, file, line);
        condStack.push({ active: cond, anyTaken: cond });
        return;
      }
      case "elif": {
        const top = condStack[condStack.length - 1];
        if (!top || condStack.length === 1) {
          diagnostics.push({
            file,
            line,
            column: 1,
            message: "#elif without matching #if",
            severity: "error",
          });
          return;
        }
        if (top.anyTaken) {
          top.active = false;
        } else {
          const cond = !!evaluateExpr(rest, file, line);
          top.active = cond;
          if (cond) top.anyTaken = true;
        }
        return;
      }
      case "else": {
        const top = condStack[condStack.length - 1];
        if (!top || condStack.length === 1) {
          diagnostics.push({
            file,
            line,
            column: 1,
            message: "#else without matching #if",
            severity: "error",
          });
          return;
        }
        top.active = !top.anyTaken;
        if (top.active) top.anyTaken = true;
        return;
      }
      case "endif": {
        if (condStack.length === 1) {
          diagnostics.push({
            file,
            line,
            column: 1,
            message: "#endif without matching #if",
            severity: "error",
          });
          return;
        }
        condStack.pop();
        return;
      }
      case "error": {
        if (!isActive()) return;
        diagnostics.push({
          file,
          line,
          column: 1,
          message: `#error: ${rest.trim()}`,
          severity: "error",
        });
        return;
      }
      case "warning": {
        if (!isActive()) return;
        diagnostics.push({
          file,
          line,
          column: 1,
          message: `#warning: ${rest.trim()}`,
          severity: "warning",
        });
        return;
      }
      case "pragma":
        // Silently drop. We have nothing to honour today.
        return;
      default:
        // Unknown directive in an inactive branch is fine; in an active
        // branch we surface a warning so the user knows we ignored it.
        if (isActive()) {
          diagnostics.push({
            file,
            line,
            column: 1,
            message: `unknown preprocessor directive: #${directive}`,
            severity: "warning",
          });
        }
    }
  }

  /**
   * Expand macros on one *line* of source. Function-like macros must close
   * their argument list on the same line (after backslash-continuation
   * gluing in the caller); this matches Apple .r usage. The expansion
   * skips identifiers inside string and character literals.
   */
  function expandMacros(line: string, file: string, lineNo: number): string {
    // Bail out fast for lines with no possible identifier match.
    if (!/[A-Za-z_]/.test(line) || macros.size === 0) return line;

    // Tokenize at the granularity we need: identifiers, strings, chars,
    // everything-else. Using a single regex with alternation keeps order
    // (so we never confuse a string-quoted macro name with a real
    // expansion).
    //
    // Strings: "…" with backslash escapes.
    // Chars: '…' with backslash escapes (used by Rez for ResType
    //        4-char codes like 'STR ', 'MENU').
    // Identifiers: [A-Za-z_][A-Za-z0-9_]* (longest match).
    // Other: a single char.
    const re =
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z0-9_]*|[\s\S]/g;
    let result = "";
    let m: RegExpExecArray | null;
    let i = 0;
    const tokens: string[] = [];
    const positions: number[] = [];
    while ((m = re.exec(line)) !== null) {
      tokens.push(m[0]);
      positions.push(i);
      i = re.lastIndex;
    }

    // Walk the token stream, expanding identifiers that match a macro.
    // Active-set tracks recursive blocking: a macro currently being
    // expanded won't re-expand inside its own replacement list.
    const expanded = expandTokens(tokens, new Set(), file, lineNo);
    for (const t of expanded) result += t;
    return result;
  }

  function expandTokens(
    tokens: string[],
    active: Set<string>,
    file: string,
    lineNo: number,
  ): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      // Identifiers that look like a macro?
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && macros.has(t) && !active.has(t)) {
        const def = macros.get(t)!;
        if (def.params === undefined) {
          // Object-like.
          const sub = tokenize(def.body);
          const next = new Set(active);
          next.add(t);
          out.push(...expandTokens(sub, next, file, lineNo));
          i++;
          continue;
        }
        // Function-like: peek for `(`. Skip whitespace tokens.
        let j = i + 1;
        while (j < tokens.length && /^\s+$/.test(tokens[j]!)) j++;
        if (j >= tokens.length || tokens[j] !== "(") {
          // Not a call — emit verbatim. This is what GCC does too.
          out.push(t);
          i++;
          continue;
        }
        // Collect arguments — a comma at paren depth 0 ends the arg.
        const args: string[][] = [];
        let cur: string[] = [];
        let depth = 1;
        let k = j + 1;
        while (k < tokens.length && depth > 0) {
          const tk = tokens[k]!;
          if (tk === "(") {
            depth++;
            cur.push(tk);
          } else if (tk === ")") {
            depth--;
            if (depth === 0) break;
            cur.push(tk);
          } else if (tk === "," && depth === 1) {
            args.push(cur);
            cur = [];
          } else {
            cur.push(tk);
          }
          k++;
        }
        if (depth !== 0) {
          diagnostics.push({
            file,
            line: lineNo,
            column: 1,
            message: `unterminated argument list for macro '${t}'`,
            severity: "error",
          });
          out.push(t);
          i++;
          continue;
        }
        args.push(cur);
        // Trim leading/trailing whitespace tokens per arg, like cpp does.
        const trimmedArgs = args.map((a) => trimWs(a));
        // Substitute parameter names in the body, then re-expand the
        // result with this macro added to the active set.
        const expandedArgs = trimmedArgs.map((a) =>
          expandTokens(a, active, file, lineNo).join(""),
        );
        const substituted = substituteParams(
          def.body,
          def.params,
          expandedArgs,
        );
        const subTokens = tokenize(substituted);
        const next = new Set(active);
        next.add(t);
        out.push(...expandTokens(subTokens, next, file, lineNo));
        i = k + 1;
        continue;
      }
      out.push(t);
      i++;
    }
    return out;
  }

  /**
   * Evaluate a `#if` constant expression. Honours: integer literals
   * (decimal/hex/octal), `defined NAME`, `defined(NAME)`, the operators
   * `! && || == != < <= > >= + - * / % & | ^ ~ << >>`, and parentheses.
   * Identifiers that aren't `defined()` checks expand through the macro
   * table, falling back to 0 if undefined (cpp behaviour).
   *
   * Returns a number; truthiness is non-zero. We deliberately keep this
   * a separate code path from the general macro expander because `#if`
   * has different semantics around `defined`.
   */
  function evaluateExpr(expr: string, file: string, line: number): number {
    // Replace `defined NAME` and `defined(NAME)` with 0/1 first.
    expr = expr.replace(
      /\bdefined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
      (_, n) => (macros.has(n) ? "1" : "0"),
    );
    expr = expr.replace(
      /\bdefined\s+([A-Za-z_][A-Za-z0-9_]*)/g,
      (_, n) => (macros.has(n) ? "1" : "0"),
    );

    // Macro-substitute remaining identifiers. Anything that's not a
    // known macro becomes 0, matching cpp.
    const exprTokens = tokenize(expr);
    const expanded = expandTokens(exprTokens, new Set(), file, line);
    const subbed = expanded
      .map((t) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(t)
          ? macros.has(t)
            ? macros.get(t)!.body
            : "0"
          : t,
      )
      .join("");

    try {
      return parseAndEvalExpr(subbed);
    } catch (e) {
      diagnostics.push({
        file,
        line,
        column: 1,
        message: `bad #if expression: ${(e as Error).message}`,
        severity: "error",
      });
      return 0;
    }
  }
}

/** Strip C/C++ comments from `source`. Preserves string and char literals
 *  so a `"//"` inside a string isn't mistaken for a line comment. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const c2 = source[i + 1];
    if (c === '"' || c === "'") {
      // Copy through string/char literal verbatim.
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = source[i]!;
        out += ch;
        if (ch === "\\" && i + 1 < n) {
          out += source[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "/") {
      // Line comment — skip to end of line, preserving the newline so
      // line counts are stable.
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      // Block comment — skip to */, but emit a newline for every newline
      // inside so line counts stay stable.
      i += 2;
      while (i < n) {
        if (source[i] === "\n") out += "\n";
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function parseIncludeArg(s: string): string | undefined {
  s = s.trim();
  if (s.startsWith('"')) {
    const m = s.match(/^"([^"]+)"/);
    return m ? m[1] : undefined;
  }
  if (s.startsWith("<")) {
    const m = s.match(/^<([^>]+)>/);
    return m ? m[1] : undefined;
  }
  return undefined;
}

function parseDefine(rest: string): MacroDefinition | undefined {
  const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!m) return undefined;
  const name = m[1]!;
  let after = rest.slice(m[0].length);
  let params: string[] | undefined;
  if (after.startsWith("(")) {
    // Function-like.
    const close = after.indexOf(")");
    if (close < 0) return undefined;
    const paramSrc = after.slice(1, close).trim();
    params = paramSrc === "" ? [] : paramSrc.split(",").map((p) => p.trim());
    after = after.slice(close + 1);
  }
  const body = after.trim();
  return { name, params, body };
}

function tokenize(s: string): string[] {
  const re =
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z0-9_]*|\s+|[\s\S]/g;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) tokens.push(m[0]);
  return tokens;
}

function trimWs(toks: string[]): string[] {
  let i = 0;
  let j = toks.length;
  while (i < j && /^\s+$/.test(toks[i]!)) i++;
  while (j > i && /^\s+$/.test(toks[j - 1]!)) j--;
  return toks.slice(i, j);
}

function substituteParams(
  body: string,
  params: string[] | undefined,
  args: string[],
): string {
  if (!params || params.length === 0) return body;
  // Substitute as identifier-only matches inside the body.
  return body.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (id) => {
    const idx = params.indexOf(id);
    return idx >= 0 ? args[idx] ?? "" : id;
  });
}

// ── Tiny constant-expression evaluator for #if. ──
//
// Pratt-style precedence climber over a hand-tokenized stream. Just enough
// to evaluate things like `(MAJOR > 6 || (MAJOR == 6 && MINOR >= 3))`
// which is the shape Apple headers most often use. NOT a full C expression
// evaluator: no comma operator, no ternary, no assignment. Throws on
// invalid input; caller catches and emits a diagnostic.

function parseAndEvalExpr(src: string): number {
  const toks = exprTokenize(src);
  let pos = 0;

  function peek(): string | undefined {
    return toks[pos];
  }
  function eat(): string {
    return toks[pos++]!;
  }

  function parsePrimary(): number {
    const t = eat();
    if (t === undefined) throw new Error("unexpected end of expression");
    if (t === "(") {
      const v = parseExpr(0);
      const c = eat();
      if (c !== ")") throw new Error("missing ')'");
      return v;
    }
    if (t === "!") return parsePrimary() ? 0 : 1;
    if (t === "~") return ~parsePrimary();
    if (t === "+") return +parsePrimary();
    if (t === "-") return -parsePrimary();
    if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
    if (/^0[0-7]+$/.test(t)) return parseInt(t, 8);
    if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
    throw new Error(`unexpected token '${t}'`);
  }

  // Precedence table — higher binds tighter. Matches C semantics for the
  // operators we support; not exhaustive. `**` is C `*` etc.; no
  // ambiguity because we never see literal "*" outside this evaluator.
  const PREC: Record<string, number> = {
    "||": 1,
    "&&": 2,
    "|": 3,
    "^": 4,
    "&": 5,
    "==": 6,
    "!=": 6,
    "<": 7,
    "<=": 7,
    ">": 7,
    ">=": 7,
    "<<": 8,
    ">>": 8,
    "+": 9,
    "-": 9,
    "*": 10,
    "/": 10,
    "%": 10,
  };

  function parseExpr(minPrec: number): number {
    let lhs = parsePrimary();
    while (true) {
      const op = peek();
      if (op === undefined) break;
      const p = PREC[op];
      if (p === undefined || p < minPrec) break;
      eat();
      const rhs = parseExpr(p + 1);
      lhs = applyBinary(op, lhs, rhs);
    }
    return lhs;
  }

  const v = parseExpr(0);
  if (pos < toks.length) throw new Error(`trailing token '${toks[pos]}'`);
  return v;
}

function applyBinary(op: string, l: number, r: number): number {
  switch (op) {
    case "||": return l || r ? 1 : 0;
    case "&&": return l && r ? 1 : 0;
    case "|": return l | r;
    case "^": return l ^ r;
    case "&": return l & r;
    case "==": return l === r ? 1 : 0;
    case "!=": return l !== r ? 1 : 0;
    case "<": return l < r ? 1 : 0;
    case "<=": return l <= r ? 1 : 0;
    case ">": return l > r ? 1 : 0;
    case ">=": return l >= r ? 1 : 0;
    case "<<": return l << r;
    case ">>": return l >> r;
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/":
      if (r === 0) throw new Error("division by zero");
      return Math.trunc(l / r);
    case "%":
      if (r === 0) throw new Error("modulo by zero");
      return l % r;
    default:
      throw new Error(`unknown operator '${op}'`);
  }
}

function exprTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Two-char operators first.
    const two = src.slice(i, i + 2);
    if (
      two === "==" ||
      two === "!=" ||
      two === "<=" ||
      two === ">=" ||
      two === "<<" ||
      two === ">>" ||
      two === "&&" ||
      two === "||"
    ) {
      tokens.push(two);
      i += 2;
      continue;
    }
    // Hex literal.
    if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
      let j = i + 2;
      while (j < n && /[0-9a-fA-F]/.test(src[j]!)) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j]!)) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    // Single-char operator or paren.
    if ("+-*/%&|^~!<>()".includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    throw new Error(`unexpected character '${c}' in expression`);
  }
  return tokens;
}
