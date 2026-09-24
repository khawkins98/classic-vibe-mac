/**
 * errorExplainer.ts — plain-English hints for common build errors.
 *
 * Issue #334 (non-AI MVP). cc1 / ld / Rez diagnostics are accurate but
 * written in GCC vocabulary. This module maps the handful of messages
 * people actually hit when writing classic Mac Toolbox C to a one- or
 * two-sentence hint. It is a static pattern table: no network, no DOM,
 * no AI. Anything we don't recognise returns null and the UI simply
 * shows the raw diagnostic as before.
 *
 * Pure module — unit tested in tests/unit/error-explainer.test.mjs.
 */

export interface ErrorExplanation {
  /** Stable id for the matched rule (useful for tests / telemetry). */
  id: string;
  /** Short plain-English hint. */
  hint: string;
}

interface Rule {
  id: string;
  re: RegExp;
  hint: (m: RegExpMatchArray) => string;
}

/** Toolbox calls → the Universal Interfaces header that declares them.
 *  Not exhaustive; covers the calls our sample projects and newcomers
 *  reach for first. Unknown names fall back to a generic hint. */
const TOOLBOX_HEADERS: Record<string, string> = {
  InitGraf: "Quickdraw.h",
  MoveTo: "Quickdraw.h",
  LineTo: "Quickdraw.h",
  DrawString: "Quickdraw.h",
  DrawChar: "Quickdraw.h",
  FrameRect: "Quickdraw.h",
  PaintRect: "Quickdraw.h",
  EraseRect: "Quickdraw.h",
  InvertRect: "Quickdraw.h",
  FrameOval: "Quickdraw.h",
  PaintOval: "Quickdraw.h",
  SetRect: "Quickdraw.h",
  OffsetRect: "Quickdraw.h",
  InsetRect: "Quickdraw.h",
  SetPort: "Quickdraw.h",
  GetPort: "Quickdraw.h",
  PenSize: "Quickdraw.h",
  ForeColor: "Quickdraw.h",
  BackColor: "Quickdraw.h",
  RGBForeColor: "Quickdraw.h",
  InitCursor: "Quickdraw.h",
  TextFont: "Quickdraw.h",
  TextSize: "Quickdraw.h",
  TextFace: "Quickdraw.h",
  StringWidth: "Quickdraw.h",
  InitFonts: "Fonts.h",
  InitWindows: "MacWindows.h",
  NewWindow: "MacWindows.h",
  NewCWindow: "MacWindows.h",
  GetNewWindow: "MacWindows.h",
  GetNewCWindow: "MacWindows.h",
  DisposeWindow: "MacWindows.h",
  ShowWindow: "MacWindows.h",
  SelectWindow: "MacWindows.h",
  DragWindow: "MacWindows.h",
  FindWindow: "MacWindows.h",
  BeginUpdate: "MacWindows.h",
  EndUpdate: "MacWindows.h",
  SetWTitle: "MacWindows.h",
  InitMenus: "Menus.h",
  GetNewMBar: "Menus.h",
  SetMenuBar: "Menus.h",
  DrawMenuBar: "Menus.h",
  MenuSelect: "Menus.h",
  MenuKey: "Menus.h",
  HiliteMenu: "Menus.h",
  GetMenuHandle: "Menus.h",
  AppendResMenu: "Menus.h",
  TEInit: "TextEdit.h",
  TENew: "TextEdit.h",
  TEKey: "TextEdit.h",
  TEIdle: "TextEdit.h",
  InitDialogs: "Dialogs.h",
  Alert: "Dialogs.h",
  StopAlert: "Dialogs.h",
  NoteAlert: "Dialogs.h",
  GetNewDialog: "Dialogs.h",
  ModalDialog: "Dialogs.h",
  ParamText: "Dialogs.h",
  WaitNextEvent: "Events.h",
  GetNextEvent: "Events.h",
  FlushEvents: "Events.h",
  Button: "Events.h",
  TickCount: "Events.h",
  GetMouse: "Events.h",
  NewHandle: "MacMemory.h",
  NewPtr: "MacMemory.h",
  DisposeHandle: "MacMemory.h",
  DisposePtr: "MacMemory.h",
  HLock: "MacMemory.h",
  HUnlock: "MacMemory.h",
  BlockMove: "MacMemory.h",
  MaxApplZone: "MacMemory.h",
  MoreMasters: "MacMemory.h",
  GetResource: "Resources.h",
  Get1Resource: "Resources.h",
  ReleaseResource: "Resources.h",
  GetString: "TextUtils.h",
  GetIndString: "TextUtils.h",
  NumToString: "TextUtils.h",
  StringToNum: "TextUtils.h",
  SysBeep: "Sound.h",
  ExitToShell: "Processes.h",
};

/** Strip GCC's quoting styles: 'foo', ‘foo’, `foo'. */
const Q = "[‘'`\"]";
const UNQ = "[’'\"]";

const RULES: Rule[] = [
  {
    id: "implicit-decl-toolbox",
    re: new RegExp(`implicit declaration of function ${Q}(\\w+)${UNQ}`),
    hint: (m) => {
      const fn = m[1]!;
      const hdr = TOOLBOX_HEADERS[fn];
      return hdr
        ? `The compiler hasn't seen a declaration for ${fn}. It's a Toolbox call — add #include <${hdr}> at the top of the file.`
        : `The compiler hasn't seen a declaration for ${fn}. Check the spelling, add the #include for the header that declares it, or declare your own function above where it's first used.`;
    },
  },
  {
    id: "undeclared-identifier",
    re: new RegExp(`${Q}(\\w+)${UNQ} undeclared`),
    hint: (m) =>
      `${m[1]} isn't defined anywhere the compiler can see. Check the spelling (C is case-sensitive), declare the variable, or #include the header that defines it (Toolbox constants like inContent or everyEvent come from the Universal Interfaces headers).`,
  },
  {
    id: "unknown-type",
    re: new RegExp(`unknown type name ${Q}(\\w+)${UNQ}|expected .* before ${Q}(Handle|Ptr|Rect|Point|Str255|WindowPtr|WindowRef|EventRecord|GrafPtr|OSErr|Boolean)${UNQ}`),
    hint: (m) =>
      `The type ${m[1] ?? m[2]} isn't known yet. Mac types like Rect, Handle, Str255 and WindowPtr come from the Toolbox headers — add #include <MacTypes.h> (or the specific header, e.g. <Quickdraw.h>, <MacWindows.h>) before using it.`,
  },
  {
    id: "missing-header",
    re: /(\S+\.h): No such file or directory/,
    hint: (m) =>
      `The header ${m[1]} couldn't be found. Check the spelling and capitalisation. Classic Toolbox headers use Universal Interfaces names (e.g. <MacWindows.h>, not <Windows.h>; <MacMemory.h>, not <Memory.h>).`,
  },
  {
    id: "expected-semicolon",
    re: new RegExp(`expected ${Q};${UNQ}`),
    hint: () =>
      "A statement is missing its closing ';'. The error is usually reported on the line AFTER the one that needs the semicolon — look at the end of the previous line.",
  },
  {
    id: "expected-brace-eof",
    re: /expected (declaration or statement|['‘`]\}['’]) at end of input/,
    hint: () =>
      "The file ended while a { was still open. A closing } is missing somewhere — check that every function and block has a matching brace.",
  },
  {
    id: "expected-paren",
    re: new RegExp(`expected ${Q}\\)${UNQ}`),
    hint: () =>
      "A ( was never closed. Count the parentheses on this line (and the one before it) — or a comma or operator is missing between arguments.",
  },
  {
    id: "pascal-string",
    re: /unknown escape sequence:? ['‘`]?\\p|\\p['’]? escape/,
    hint: () =>
      "\\p makes a Pascal string (length-prefixed) for Toolbox calls like DrawString(\"\\pHello\"). It only works as the very first thing inside the quotes, and needs Retro68's -fpascal-strings (on by default here).",
  },
  {
    id: "pascal-vs-c-string",
    re: /(pointer targets in passing argument .* differ in signedness|incompatible pointer type).*(ConstStr255Param|StringPtr|unsigned char \*|const unsigned char \*)/,
    hint: () =>
      "Toolbox string calls want a Pascal string (unsigned char*, length byte first), not a C string. Write the literal as \"\\pText\", or convert a C string with c2pstr / CopyCStringToPascal.",
  },
  {
    id: "incompatible-handle-ptr",
    re: /incompatible pointer type|makes pointer from integer without a cast|makes integer from pointer without a cast/,
    hint: () =>
      "The types on each side don't match. On the Mac a Handle is a pointer to a pointer (char**), while a Ptr is a plain pointer — dereference a Handle with *h (and HLock it first) or cast explicitly, e.g. (WindowPtr)ptr.",
  },
  {
    id: "too-few-args",
    re: /too (few|many) arguments to function/,
    hint: (m) =>
      `This call passes too ${m[1]} arguments. Check the function's declaration (Toolbox calls are listed in Inside Macintosh / the header) and match its parameter list.`,
  },
  {
    id: "undefined-reference",
    re: new RegExp(`undefined reference to ${Q}_?(\\w+)${UNQ}`),
    hint: (m) =>
      `The linker couldn't find the code for ${m[1]}. It was declared (so compiling worked) but never defined — check the spelling, make sure the function body exists in one of your .c files, and that the file is part of the build.`,
  },
  {
    id: "multiple-definition",
    re: new RegExp(`multiple definition of ${Q}_?(\\w+)${UNQ}|redefinition of ${Q}(\\w+)${UNQ}`),
    hint: (m) =>
      `${m[1] ?? m[2]} is defined more than once. If it's in a header, mark variables extern (and define them in one .c file), or make helper functions static.`,
  },
  {
    id: "missing-resource",
    re: /(resource|ResType|'[A-Za-z ]{4}'\s*\(?-?\d+\)?).*(not found|missing|undefined)|(can't|cannot) (find|open) resource/i,
    hint: () =>
      "A resource referenced by ID doesn't exist. Make sure the .r file defines a resource with that exact type and ID (e.g. resource 'WIND' (128)) and that the IDs in your C code match.",
  },
  {
    id: "return-type-main",
    re: new RegExp(`return type of ${Q}main${UNQ} is not ${Q}int${UNQ}`),
    hint: () =>
      "Declare main as int main(void) and end it with return 0; — Retro68 expects the standard C signature.",
  },
  {
    id: "control-reaches-end",
    re: /control reaches end of non-void function/,
    hint: () =>
      "This function promises to return a value but can fall off the end without one. Add a return statement on every path.",
  },
  {
    id: "unused-variable",
    re: new RegExp(`unused variable ${Q}(\\w+)${UNQ}`),
    hint: (m) => `${m[1]} is declared but never used. Harmless — delete it to silence the warning.`,
  },
];

/**
 * Return a plain-English hint for a compiler/linker/Rez message, or
 * null if we don't recognise it. `message` may be the bare message
 * ("expected ';' before 'x'") or a full "file:line:col: error: ..." line.
 */
export function explainError(message: string): ErrorExplanation | null {
  if (!message) return null;
  for (const rule of RULES) {
    const m = message.match(rule.re);
    if (m) return { id: rule.id, hint: rule.hint(m) };
  }
  return null;
}
