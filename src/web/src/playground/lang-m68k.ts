/**
 * lang-m68k.ts — CodeMirror 6 syntax highlighting for m68k GAS-flavoured
 * assembly, the format cc1.wasm emits in the playground's Show Assembly
 * panel (cv-mac #64 / wasm-retro-cc #17).
 *
 * Same StreamLanguage approach as `lang-rez.ts`: GCC/GAS for m68k has no
 * Lezer grammar (vanishingly few users at this point) and a hand-written
 * stream parser covers the token set the panel actually shows users.
 *
 * Token categories we colour:
 *   - line comments: `#` at the start of a line (gas default for m68k —
 *     `#0` is also the immediate-value prefix, but only when it follows
 *     whitespace inside an operand list; we disambiguate via line-start
 *     state). `|` and `;` are also m68k-gas line-comment leaders.
 *   - directives: `.text`, `.data`, `.file`, `.global`, `.long`, `.byte`,
 *     `.ident`, `.size`, `.type`, `.section`, `.align`, … — anything
 *     starting with a `.` (highlighted as `meta`, matching how
 *     lang-rez.ts highlights `#include`).
 *   - mnemonics: `move.l`, `link.w`, `jsr`, `rts`, … — looked up in a
 *     static set so that user symbols / labels stay un-coloured.
 *   - registers: `%d0`–`%d7`, `%a0`–`%a7`, `%fp`, `%sp`, `%pc`, `%sr`,
 *     `%ccr`, FPU regs `%fp0`–`%fp7` — anything matching `%[a-z][\w]*`.
 *   - immediates and numbers: `#-1`, `#0x10`, `#$1f`, `42`, `0x10`, `$1f`.
 *   - strings: `"…"` with backslash escapes — used by `.ascii` /
 *     `.string` / `.ident` directives.
 *   - ELF type annotations: `@function`, `@object` after `.type`.
 *   - labels: `identifier:` at line start — highlighted as `definition`
 *     so the editor theme reads them as "the named thing here lives".
 *
 * What we deliberately don't model:
 *   - Macro / .if conditionals (cc1 output never contains these).
 *   - Section attribute lists (cc1 emits a handful of fixed sections).
 *   - The GAS-extended addressing notation in full generality. The
 *     common `8(%fp)`, `(%a0)+`, `-(%sp)`, `%pc@(0)` forms all happen to
 *     parse correctly because we treat `(`, `)`, `,`, `+`, `-` as
 *     unhighlighted operators.
 *
 * If a future cc1 emission breaks highlighting in a surprising way, the
 * fix is almost always to add the new keyword to MNEMONICS or to widen
 * one of the regex matchers below — the streaming parser is
 * intentionally simple enough that one read pass diagnoses the issue.
 */

import {
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** m68k mnemonics we want to highlight as `keyword`. Sources:
 *  - GCC 12 m68k backend (md/m68k.md) — every output we've seen from cc1.
 *  - Motorola M68000 Family Programmer's Reference Manual (1992 ed.).
 *
 *  The lookup is on the base mnemonic (without `.l`/`.w`/`.b`/`.s`
 *  size suffixes), so any `move.X` for X ∈ {l,w,b} is one entry. FPU
 *  mnemonics (`fadd`, `fmul`, …) are included because Retro68's libm
 *  emits them on `-m68881` builds even though the default `-mcpu=68020`
 *  target doesn't. Cheap to include; cheap to forget. */
const M68K_MNEMONICS = new Set<string>([
  // Data movement
  "move", "movea", "moveq", "movem", "movep", "lea", "pea", "exg", "swap",
  "link", "unlk",
  // Arithmetic
  "add", "adda", "addi", "addq", "addx",
  "sub", "suba", "subi", "subq", "subx",
  "neg", "negx", "ext", "extb",
  "muls", "mulu", "divs", "divu", "divsl", "divul",
  "cmp", "cmpa", "cmpi", "cmpm", "tst",
  "clr", "abcd", "sbcd", "nbcd",
  // Logical
  "and", "andi", "or", "ori", "eor", "eori", "not",
  // Shift / rotate
  "asl", "asr", "lsl", "lsr", "rol", "ror", "roxl", "roxr",
  // Bit
  "bchg", "bclr", "bset", "btst", "bfchg", "bfclr", "bfexts", "bfextu",
  "bfffo", "bfins", "bfset", "bftst",
  // Control flow
  "bra", "bsr", "bcc", "bcs", "beq", "bne", "bge", "bgt", "ble", "blt",
  "bhi", "bls", "bmi", "bpl", "bvc", "bvs",
  "dbra", "dbcc", "dbcs", "dbeq", "dbne", "dbge", "dbgt", "dble", "dblt",
  "dbhi", "dbls", "dbmi", "dbpl", "dbvc", "dbvs", "dbf", "dbt",
  "scc", "scs", "seq", "sne", "sge", "sgt", "sle", "slt",
  "shi", "sls", "smi", "spl", "svc", "svs", "sf", "st",
  "jmp", "jsr", "rts", "rtr", "rtd", "rte",
  "trap", "trapv", "trapcc", "chk", "chk2", "illegal", "nop", "reset",
  "stop", "bkpt",
  // System
  "andi.b", "ori.b", "eori.b", "move16", "moves",
  // FPU (m68881/68882, occasional under -m68881)
  "fadd", "fsub", "fmul", "fdiv", "fneg", "fabs", "fsqrt", "fmove", "fmovem",
  "fcmp", "ftst", "fbcc", "fbeq", "fbne",
  "fsin", "fcos", "ftan", "fatan", "flog2", "flog10", "flogn",
]);

/** Per-document streaming-parser state. We only need to remember whether
 *  we're at the *logical* start of a line (after any leading whitespace
 *  but before any token) so we can:
 *
 *    - treat `#` at line start as a comment rather than as an immediate
 *      operand prefix;
 *    - treat `identifier:` as a label rather than a plain symbol. */
type M68kState = { atLineStart: boolean };

const m68kStreamLang = StreamLanguage.define<M68kState>({
  name: "m68k-asm",

  startState: () => ({ atLineStart: true }),

  token(stream, state) {
    // At column 0, we are by definition at "line start" — reset the flag
    // so it survives across line breaks. CodeMirror calls token() per
    // contiguous chunk, including once at the start of each line.
    if (stream.sol()) state.atLineStart = true;

    // Skip leading whitespace without clearing atLineStart — the very
    // first non-whitespace token on the line is what determines whether
    // a leading `#` is comment or immediate.
    if (stream.eatSpace()) return null;

    // Line comments. `#` is only a comment at line start; `|` and `;`
    // are unconditional m68k-gas line-comment leaders.
    if (state.atLineStart && stream.peek() === "#") {
      stream.skipToEnd();
      state.atLineStart = false;
      return "comment";
    }
    if (stream.peek() === "|" || stream.peek() === ";") {
      stream.skipToEnd();
      state.atLineStart = false;
      return "comment";
    }

    // String "…" with backslash escapes. Used by .ascii / .string / .ident.
    if (stream.eat('"')) {
      while (!stream.eol()) {
        if (stream.eat("\\")) {
          stream.next();
          continue;
        }
        if (stream.eat('"')) break;
        stream.next();
      }
      state.atLineStart = false;
      return "string";
    }

    // Registers: %d0, %a7, %fp, %sp, %pc, %sr, %ccr, FPU %fp0..%fp7.
    if (stream.match(/^%[a-zA-Z][\w]*/)) {
      state.atLineStart = false;
      return "atom";
    }

    // ELF type annotations: @function, @object, @progbits, …
    if (stream.match(/^@[a-zA-Z][\w]*/)) {
      state.atLineStart = false;
      return "atom";
    }

    // Immediate-prefixed numbers: #42, #-1, #0x10, #$1f.
    if (stream.match(/^#-?(?:0[xX][0-9a-fA-F]+|\$[0-9a-fA-F]+|\d+)/)) {
      state.atLineStart = false;
      return "number";
    }

    // Bare numbers: 0x10, $1f, decimal (with optional leading minus).
    if (stream.match(/^(?:0[xX][0-9a-fA-F]+|\$[0-9a-fA-F]+|-?\d+)/)) {
      state.atLineStart = false;
      return "number";
    }

    // Directives: .text, .file, .global, .long, .byte, etc. Always start
    // with `.` and consume an identifier-with-dots run (so `.cfi_def_cfa`
    // and similar GCC unwind directives all colour as one token).
    if (stream.match(/^\.[a-zA-Z_][\w.]*/)) {
      state.atLineStart = false;
      return "meta";
    }

    // Identifier — either a label (followed by `:`), a mnemonic, or a
    // plain symbol. We consume the bare identifier first; for mnemonics
    // we eat the optional `.X` size suffix to keep `move.l` highlighted
    // as one token.
    if (stream.match(/^[a-zA-Z_][\w]*/)) {
      // Label?
      if (stream.peek() === ":") {
        state.atLineStart = false;
        return "labelName";
      }
      const base = stream.current().toLowerCase();
      // Size-suffix is optional and only meaningful on mnemonics —
      // `move.l`, `link.w`, `bra.s`. We consume it before the keyword
      // lookup so the visual token covers the whole mnemonic.
      const next2 = stream.string.slice(stream.pos, stream.pos + 2);
      if (/^\.[lwbs]\b/i.test(next2)) {
        stream.eat(".");
        stream.next();
      }
      state.atLineStart = false;
      return M68K_MNEMONICS.has(base) ? "keyword" : null;
    }

    // Anything else (operators, punctuation, unmatched chars): consume
    // one char and emit no colour. Keeps `8(%fp),%d0` rendering cleanly
    // because parens/comma fall through silently.
    stream.next();
    state.atLineStart = false;
    return null;
  },

  languageData: {
    // m68k-gas uses `|` and `;` for line comments, and `#` at line start.
    // CodeMirror's commentTokens hint drives the default toggle-comment
    // behaviour — pick `|` because it's unambiguous everywhere.
    commentTokens: { line: "|" },
  },
});

/**
 * HighlightStyle rules for the m68k tokens we emit. We ship this with
 * the LanguageSupport so the asm viewer doesn't have to wire
 * @codemirror/language's `defaultHighlightStyle` separately — and so the
 * directive colour (`meta`, not in defaultHighlightStyle) actually shows.
 *
 * Palette: warm earth tones to read clearly on the off-white viewer
 * background and match the System 7 / playground chrome — bright modern
 * IDE colours would look out of place. Mnemonics get the most weight
 * (they're the structural skeleton); operands and directives are subdued.
 */
const m68kHighlight = HighlightStyle.define([
  { tag: t.comment, color: "#7d6f64", fontStyle: "italic" },
  { tag: t.keyword, color: "#1c3e8a", fontWeight: "bold" }, // mnemonics
  { tag: t.meta, color: "#7c4c00" }, // directives (.text, .file, ...)
  { tag: t.string, color: "#7a3e23" },
  { tag: t.number, color: "#155a8a" },
  { tag: t.atom, color: "#0d6e6e" }, // registers, @function/@object
  { tag: t.labelName, color: "#603895", fontWeight: "bold" },
]);

/** Returns CodeMirror language support for m68k GAS-flavoured assembly. */
export function m68k(): LanguageSupport {
  return new LanguageSupport(m68kStreamLang, [
    syntaxHighlighting(m68kHighlight),
  ]);
}
