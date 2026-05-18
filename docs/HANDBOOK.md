# classic-vibe-mac handbook

A guided tour for *using* the playground — what every button does, the
keyboard shortcuts that matter, where files live, and how to take a
sample from "ran it once" to "fork of my own with my edits." For the
*architectural* tour read [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md); for
*per-app contributor* docs read
[`src/app/README.md`](../src/app/README.md). This file is for the
visitor who just wants to write some classic Mac code.

---

## The 60-second tour

1. Open <https://khawkins98.github.io/classic-vibe-mac/>.
2. The welcome modal greets you on first visit; pick a sample from
   the four featured tiles or click **Get started** to choose your
   own from the Project pane on the left.
3. The Mac canvas (top-right) shows "Welcome to Macintosh — Pick a
   project and Build & Run" until you actually build something.
4. Click **Build & Run** in the playground toolbar. The build modal
   tracks progress; the Mac boots into System 7.5.5 with your
   sample's disk on the desktop in ~15 s cold, ~1 s warm.
5. Edit the source in the editor pane. Build & Run again — the Mac
   reboots in ~1 s with your changes.

That's it. The rest of this doc is detail.

---

## The IDE layout

Four docked panes tile the page at first load. Each is a real
draggable [WinBox](https://nextapps-de.github.io/winbox/) window
with Mac OS 8 chrome — drag the titlebar, double-click to shade,
grab the corner to resize.

- **Project** (top-left) — the sample dropdown + the file list for
  the current project. Click a filename to switch tabs in the
  Playground.
- **Playground** (centre-left) — the source editor (CodeMirror 6
  with C / Rez syntax highlighting), the build toolbar (Build,
  Build & Run, Download, Reset, Show ASM), the tab bar across the
  top, and the Routines popup.
- **Macintosh** (top-right) — the live BasiliskII canvas. Empty
  until your first Build & Run, then your app boots and renders
  inside.
- **Output** (bottom-right) — two tabs:
  - **Build log** — `[cvm]`, `[build-c]`, `[asm]`, `[cvm-fetch]`
    lines from the compile pipeline. Click any
    `file:line:col` diagnostic to jump the editor's cursor there.
  - **Console** — live tail of `cvm_log()` output your Mac app
    writes (see "Debug Console" below).

**View → Reset window layout** snaps everything back to the tiled
grid if you drag things around.

---

## The Project pane and the dropdown

The same project dropdown surfaces in two places: the Project pane
on the left (visible), and a hidden one inside the Playground (the
canonical source of truth for switchTo logic). Changing one updates
the other.

26 samples ship in the default list, ordered roughly by complexity.
Star prefix in the dropdown reads as the complexity rating
(`★☆☆☆☆☆` floor → `★★★★★★` top). Highlights:

| Star | Sample | What it teaches |
|-|-|-|
| ★ | Wasm Hello | the floor — `DrawString` only |
| ★★ | Wasm Clock | `GetDateTime` + analog face in QuickDraw |
| ★★★ | Wasm Notepad | MBAR + TextEdit + system scrap (Cut/Copy/Paste) |
| ★★★★ | Wasm WordPad | Font / Size / Style menus on monostyle TextEdit |
| ★★★★ | Wasm Markdown | split-pane editor + live preview |
| ★★★★★ | Wasm Icon Gallery | `binaryAssets` — precompiled `.rsrc.bin` sibling |
| ★★★★★★ | Glypha III | full vendored 1992 game, 6,600 LOC |

Full per-sample matrix is in
[`src/app/README.md`](../src/app/README.md). Pick by complexity rung
that matches your comfort.

---

## Editing source

CodeMirror 6 with C / Rez highlighting + Toolbox-aware hover cards.

- **Hover a Toolbox call** (`NewGWorld`, `WaitNextEvent`, `TEKey`)
  → an Inside-Macintosh-styled card pops with the signature + a
  one-paragraph blurb + See-Also links.
- **⌘-click any Toolbox identifier** → opens the pinned Toolbox
  Reference WinBox at that entry. Browse via See-Also links.
- **⌘F** → find panel. **⌘G** / **⇧⌘G** walk matches.
  **⌘⌥F** → find-and-replace.
- **Auto-close** brackets, parens, quotes.
- **Fold gutter** for collapsing functions and `#if 0` blocks.
- **Active-line highlight** + **selection-match highlight**.
- **Click a Build-log diagnostic** → editor cursor jumps to that
  line in that file.

Edits persist in IndexedDB per-project per-file. Switching projects
or reloading the page brings your changes back. Storage is best-effort
— Firefox Private Browsing and Safari ITP (after 7 days of no
interaction) can wipe IDB; the page shows a banner if persistence is
unavailable for the session.

---

## File navigation

### Tab bar

The row of tabs below the build toolbar shows every file in the
current project. Click to switch. **Arrow Left/Right** while a tab
has focus walks tabs (ARIA tab pattern).

The **`+`** at the end of the tab bar adds a new `.c`, `.h`, or
`.r` file to the current project. Prompts for a filename, validates
extension + no-collision, drops you into the empty file. Build &
Run picks it up automatically — the build pipeline gathers sources
from the live tab bar's files.

### Routines popup (CodeWarrior style)

Above the editor, a `{ } Routines:` dropdown lists every function
in the current file:

- `.c` — function definitions extracted from the lezer-cpp syntax tree
- `.r` — `data 'TYPE' (id, "label")` resource declarations
- `.h` — function prototypes

Click a routine → cursor jumps to that line. The popup hides
itself for file types it can't parse (or when there are zero
routines).

### Tour (annotated samples)

Some samples ship with `/* @cvm-step N: ... */` annotations that
mark the load-bearing parts of the code. When the active file has
them, a yellow **→ Tour:** selector appears next to Routines:

- Click an entry → editor jumps to that landmark.
- Steps are numbered (1, 2, 3…) so you can read them in order.
- Authors can put `step 1` anywhere in the file — sort is by N,
  not by line position.

If you're writing a sample, sprinkle a few `@cvm-step` comments
to give first-time readers a guided path. Three to six landmarks
turn a 400-line C file from "wall of code" into "here's where to
start." See `wasm-hello/hello.c` or `wasm-snake/snake.c` for the
convention in use.

### Hover-docs for Mac Toolbox calls

Hover any classic Mac Toolbox API in the editor — `WaitNextEvent`,
`NewWindow`, `DrawString`, etc. — and a tooltip pops up with the
Inside-Macintosh-style signature, a one-paragraph description,
and a "see also" list. ~150 entries cover the calls the bundled
samples actually reach for. If you find one missing, add it to
`src/web/src/playground/toolbox-reference.json`.

### Open Quickly (⌘P or ⌘D)

Press **⌘P** anywhere on the page (Cmd-P on Mac, Ctrl-P
elsewhere) → a centered fuzzy filename palette opens. **⌘D** is
also accepted — it was CodeWarrior's original Open Quickly binding.

- Type a few letters: `mai` for `main.c`, `gly` for `glypha3.r`
- **↑** / **↓** navigate, **Enter** to open, **Esc** to dismiss
- Click a row to open directly
- Scope: files in the *current* project (matching CodeWarrior's
  Open Quickly behaviour)

Same shortcut also fires from inside the editor — the in-editor
handler complements the menubar's global one.

---

## Build and Run

Three buttons in the playground toolbar:

- **Build** (⌘.) — compiles the project and downloads the resulting
  `.bin`. Doesn't touch the Mac canvas.
- **Build & Run** — compiles, splices the resource fork, hot-loads
  the result onto a fresh secondary disk, and boots the Mac.
  ~1 s warm, ~15 s on cold-cache first run.
- **Download** — packages the current project's source files as a
  `.zip` for off-line keeping.
- **Reset** — discards your IDB edits and re-seeds the project from
  the bundled defaults. One-click "pull latest from the server."
- **Show ASM** — opens a draggable palette with the m68k assembly
  of the active `.c` file, recompiled on edit.

### The build-progress modal

While a build runs, a Mac OS 8-style modal tracks the phases:

```
Compiling C and Rez…
██████████░░░░░░  7.4s elapsed
  ✓  Preparing sources       0ms
  ⌛ Compiling C and Rez   7400ms     ← live, ticks every 100ms
  ·  Packaging MacBinary
  ·  Mounting disk
  ·  Booting Macintosh
```

The active step shows its running elapsed; completed steps show the
final duration. If compile takes >15 s, a "first compile takes a
moment" reassurance hint reveals itself.

On failure, the build log surfaces the error; click any
`file:line:col` to jump.

### "Try this next" cards

After a successful **Build & Run**, some samples surface a small
yellow card at the bottom of the Playground pane with one concrete
experiment you can try ("Make the snake faster — change MOVE_TICKS
to 3"). Click **Take me there** and the editor jumps to the right
line, or × to dismiss. The card auto-hides after 12 seconds and
cycles to a different prompt on each subsequent build.

If you don't want the prompts for a particular sample at all, click
**Don't show for this sample** — the dismissal is per-project and
persists in localStorage.

Authoring: add a `tryNext: [...]` array to your project's
`SampleProject` entry in `src/web/src/playground/types.ts`. Keep
each prompt to one short imperative sentence.

---

## The two ways data crosses Mac ↔ host

### `:Shared:` (host → Mac)

The boot disk includes a `:Shared:` folder seeded at build time
with HTML / data files. Mac apps `FSpOpenDF` on them like any
local file.

### `:Unix:` / extfs (Mac ↔ host live)

BasiliskII surfaces the host's `/Shared/` directory as the
**`Unix:`** volume inside the Mac. Reads + writes are bidirectional
in real time:

- **`cvm_log()`** writes `:Unix:__cvm_console.log`; the Output
  panel's Console tab polls it ~once a second and surfaces new
  lines.
- **`wasm-mdpad`** writes user-Saved `.md` files into `:Shared:` so
  they appear in the host's mounted Shared folder.
- A pattern any sample can opt into:
  `#include <cvm_log.h>` → `cvm_log("anything")`. The header is a
  system header (mounted at `/sysroot/include/` by cc1.ts), no
  vendoring per-sample.

---

## Debug Console

Output panel → **Console** tab. Polls the `:Unix:__cvm_console.log`
file every ~1 s and surfaces new lines in near-real-time.

To emit from your Mac app:

```c
#include <cvm_log.h>

void main(void) {
    cvm_log_reset();              /* wipe the log so each run is clean */
    cvm_log("main: entered");
    cvm_log("main: -> InitWindow");
    InitWindow();
    /* … */
}
```

`cvm_log` takes a single C string. For formatted output use
`sprintf` into a stack buffer first:

```c
char buf[128];
sprintf(buf, "x=%d y=%d", x, y);
cvm_log(buf);
```

Why this matters: when your app silent-crashes or shows an alert
without context, instrumenting the suspect function with `cvm_log`
is the cheapest path to ground truth. Full recipe in
[`DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md).

**Console affordances:**

- **Filter bar at the top** — type a substring to hide non-matching
  lines. New lines that don't match are hidden on arrival; clear
  the filter to see everything again.
- **Keyword highlighting** — lines containing `error` / `fail` /
  `fatal` / `panic` / `aborted` get the word coloured red and
  bolded; `warn` / `warning` / `caution` get amber. Case-insensitive.
- **Empty-state hint** — the pane shows a paste-ready
  `#include <cvm_log.h>` snippet until your first log line lands,
  so first-time visitors don't have to dig for the API.
- **Reset divider** — calling `cvm_log_reset()` from the Mac side
  surfaces as a `— cvm console reset —` line in the pane.
- **Tab unread indicator** — the Console tab gets a dot when new
  output arrives while you're on a different tab.
- **Copy** + **Clear** in the Output panel toolbar do what they say.
- **Auto-scroll lock** — scrolling up to read history won't get
  yanked back to the bottom by new output; resume tracking by
  scrolling to the bottom yourself.

---

## Persistence — what survives a reload, what doesn't

| Thing | Persists | Where |
|-|-|-|
| Your file edits per sample | ✅ | IndexedDB `cvm-playground` → `files` store |
| Your user-added files (`+` button) | ✅ | IDB `ui-state` `cvm:user-files:<id>` + file content |
| Your duplicated user-projects | ✅ | IDB `ui-state` `cvm:user-projects` |
| Last open project / file / cursor | ✅ | IDB `ui-state` |
| Welcome modal seen flag | ✅ | `localStorage['cvm-welcome-seen']` |
| Recent projects (Apple menu) | ✅ | localStorage |
| Pause-when-hidden preference | ✅ | localStorage |
| Built `.bin` (between Build & Runs) | ✅ in-memory only | freshly built each click; the Mac sees the latest |
| Console log | ❌ | wiped between sessions; `cvm_log_reset()` for in-session clear |

**Reset button** discards a single project's IDB edits + re-seeds
from bundle. **localStorage.clear()** in the browser console nukes
everything and gets you the first-visit experience again.

---

## Making a new sample (without a fork)

Two paths, depending on what you're starting from:

### From scratch — "Duplicate as new project"

1. Pick the closest shipped sample in the dropdown (e.g. start
   from `wasm-mdpad` if you want a TextEdit-driven app).
2. **File → Duplicate as new project…** — name it, pick a 4-letter
   creator code (e.g. `CVMN`).
3. The dropdown now lists your new project. The editor switches
   to it. Edit, Build & Run, iterate. Your edits don't touch the
   original sample.
4. `+` in the tab bar adds files as you go.

### From a zip you already have

1. **File → Open .zip…** — pick a `.zip` containing `.c` / `.h` /
   `.r` files. Today this lands them into the *active* project's
   files; a "create new project from zip" variant is on the roadmap
   ([#308](https://github.com/khawkins98/classic-vibe-mac/issues/308)).

### Going further (forking the repo)

If you want your sample to ship on the GitHub Pages deploy
alongside the others (not just IDB-only in your tab), see
[`docs/VENDORING-A-MAC-APP.md`](./VENDORING-A-MAC-APP.md) for the
third-party-vendor recipe and `src/app/README.md` for the
hand-rolled-sample recipe.

---

## Menu bar reference

| Menu | Item | Shortcut | What |
|-|-|-|-|
| Apple | About classic-vibe-mac… | — | About box |
| Apple | Welcome to classic-vibe-mac… | — | re-open the first-run modal |
| Apple | (recent projects) | — | switch directly to a recent project |
| File | Open Project… | ⌘O | richer-than-the-dropdown picker |
| File | **Open Quickly…** | **⌘P** | fuzzy filename palette |
| File | Open .zip… | — | import a .zip into the active project |
| File | Duplicate as new project… | — | fork the current project |
| File | Download .zip | ⌘S | save the current project as a .zip |
| Edit | Undo / Cut / Copy / Paste | — | greyed in the menubar; use CodeMirror's own ⌘Z/X/C/V inside the editor |
| Edit | Preferences… | ⌘, | optimisation level, pause-when-hidden |
| View | Reset window layout | — | snap panes back to the docked grid |
| Special | Reboot Mac | — | re-mount the last-built secondary disk + re-spawn the worker |
| Windows | (open windows) | — | raise a specific window |
| Help | classic-vibe-mac Help | ⌘? | help palette |
| Help | Toolbox Reference… | — | pinned Inside-Mac reference window |

---

## Keyboard reference

| Keys | Where | What |
|-|-|-|
| ⌘P, ⌘D | host panes¹ | Open Quickly (⌘D is the CodeWarrior alias) |
| ⌘O | host panes¹ | Open Project (the richer picker) |
| ⌘S | host panes¹ | Download current project as .zip |
| ⌘? | host panes¹ | Help palette |
| ⌘, | host panes¹ | Preferences |
| ⌘F | editor | Find |
| ⌘G / ⇧⌘G | editor | Walk matches |
| ⌘⌥F | editor | Find-and-replace |
| ⌘Z / X / C / V | editor | Undo / Cut / Copy / Paste |
| ⌘-click | editor | Open Toolbox Reference for an identifier |
| ↑ ↓ ← → | tab bar | Walk tabs (ARIA) |
| ↑ ↓ | Open Quickly | navigate the file list |
| ↵ | Open Quickly | open the highlighted file |
| Esc | Open Quickly / modal | dismiss |

(On non-Mac: Cmd → Ctrl.)

¹ **Focus routing.** ⌘-key shortcuts route to whichever pane you
last clicked into. Click the **Macintosh** pane and ⌘S now Saves
inside the running Mac app (e.g. TextEdit) instead of downloading
your project zip — the shortcut goes to BasiliskII. Click any host
pane (Project / Playground / Output) and the host menubar
shortcuts take over again. The active pane's titlebar shows the
classic Mac OS 8 pinstripes; inactive panes go flat — same
affordance period Mac users will recognise from System 7/8 windows.

### Shortcuts the browser refuses to give us

Even with the Macintosh pane active, your browser keeps a small set
of ⌘-shortcuts for itself and refuses to forward them to the page —
this is a security feature, not a bug we can patch:

| Shortcut | What your browser does | What you wanted |
|-|-|-|
| ⌘N | New browser window | New Mac document |
| ⌘T | New browser tab | (varies) |
| ⌘W | Close browser tab | Close Mac window |
| ⌘Q | Quit browser | Quit Mac app |
| ⌘L | Focus URL bar | (varies) |

Two ways around it:

1. **Use the menubar** inside the running Mac (the actual Mac OS
   menubar at the top of the Macintosh pane). File → New, File →
   Close, etc. all work because they don't depend on the host
   browser releasing the keystroke.
2. **Fullscreen Mac mode** (Chromium-only — Chrome, Edge, Brave,
   etc.). Click the **Fullscreen Mac** button below the canvas.
   The page goes fullscreen and uses the
   [Keyboard Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock)
   to capture the reserved shortcuts. Press Esc to leave fullscreen
   and the host browser gets its shortcuts back.

Firefox and Safari users don't see the Fullscreen Mac button
(they'd just get a fullscreen view with no extra shortcut capture
— the Keyboard Lock API isn't implemented there). You'll see a
one-shot yellow note explaining this the first time you click into
the Mac pane; tick the × to dismiss it for keeps.

---

## Where to go next

- Something broken? Start with
  [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). For
  *vendored-app-specific* silent failures see
  [`DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md).
- Adding a third-party period app to the sample shelf:
  [`docs/VENDORING-A-MAC-APP.md`](./VENDORING-A-MAC-APP.md).
- Want to understand how the whole thing works under the hood:
  [`docs/HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) → guided tour, then
  [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) → engineer deep-dive.
- Hacking on the playground / IDE itself:
  [`docs/DEVELOPMENT.md`](./DEVELOPMENT.md).
