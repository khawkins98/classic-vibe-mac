/**
 * lang-rez.ts — CodeMirror 6 syntax highlighting for Apple/Retro68 Rez files.
 *
 * Rez is the resource-definition language used by Classic Mac development.
 * A `.r` file declares Mac resource types and values; this grammar highlights
 * the tokens that matter most to someone editing resources in the playground:
 *   - 4-char resource-type codes  ('WIND', 'MENU', …)
 *   - hex data literals           ($"4865 6C 6C 6F")
 *   - keywords                    resource, type, data, integer, …
 *   - preprocessor directives     #include, #define, #ifdef, …
 *   - strings and numbers
 *   - block and line comments
 *
 * Uses StreamLanguage (CodeMirror 5-compat bridge) because Rez has no
 * published Lezer grammar and the token set is simple enough that a hand-
 * written stream parser is the right tool.
 */

import { StreamLanguage, LanguageSupport } from "@codemirror/language";

// Structural and field-type keywords. Identifiers from the bundled RIncludes
// (documentProc, goAway, verUS, …) are not keywords — they are defined
// constants from included files and are left un-highlighted.
const REZ_KEYWORDS = new Set([
  // Structural
  "resource", "type", "data", "include", "array",
  // Field types (numeric / bitfield)
  "integer", "longint", "shortint", "byte",
  "boolean", "bitstring", "nibble",
  "char",
  // Field types (string)
  "string", "pstring", "wstring",
  // Field types (composite)
  "rect", "point",
  // Layout / alignment
  "hex", "align", "fill", "wide", "literal",
  // Modifier keywords
  "unsigned", "signed", "key",
  // Control structures inside type definitions
  "switch", "case", "default", "enum", "as", "not",
]);

type RezState = { blockComment: boolean };

const rezStreamLang = StreamLanguage.define<RezState>({
  name: "rez",

  startState: () => ({ blockComment: false }),

  token(stream, state) {
    // Block-comment continuation
    if (state.blockComment) {
      if (stream.match(/.*?\*\//)) {
        state.blockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }

    if (stream.eatSpace()) return null;

    // Line comment (// — GCC-Rez extension used throughout this project)
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }

    // Block comment /* … */
    if (stream.match("/*")) {
      if (!stream.match(/.*?\*\//)) {
        state.blockComment = true;
      }
      return "comment";
    }

    // Preprocessor directive: #include, #define, #ifdef, #ifndef, #endif, …
    if (stream.eat("#")) {
      stream.eatWhile(/[a-zA-Z]/);
      return "meta";
    }

    // Hex data literal: $"4865 6C 6C 6F" — the dollar-sign prefix is the
    // visual cue that distinguishes raw hex from a regular string.
    if (stream.match('$"')) {
      while (!stream.eol()) {
        if (stream.eat("\\")) { stream.next(); continue; }
        if (stream.eat('"')) break;
        stream.next();
      }
      return "string.special";
    }

    // Regular string literal "…"
    if (stream.eat('"')) {
      while (!stream.eol()) {
        if (stream.eat("\\")) { stream.next(); continue; }
        if (stream.eat('"')) break;
        stream.next();
      }
      return "string";
    }

    // 4-char resource-type code 'WIND', 'TEXT', 'ICN#', 'STR ', …
    // Single-quoted; may contain spaces (e.g. 'STR ') — match up to next
    // single quote rather than stopping at whitespace.
    if (stream.eat("'")) {
      stream.match(/[^']*/);
      stream.eat("'");
      return "atom";
    }

    // Hex number 0x1A2B
    if (stream.match(/^0x[0-9a-fA-F]+/i)) return "number";

    // Decimal number
    if (stream.match(/^\d+/)) return "number";

    // Identifiers: keywords get highlighted; plain identifiers do not.
    if (stream.match(/^[a-zA-Z_]\w*/)) {
      return REZ_KEYWORDS.has(stream.current()) ? "keyword" : null;
    }

    // Consume one character; no highlight (punctuation, operators, etc.)
    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { block: { open: "/*", close: "*/" } },
  },
});

/** Returns CodeMirror language support for Rez resource-definition files. */
export function rez(): LanguageSupport {
  return new LanguageSupport(rezStreamLang);
}
