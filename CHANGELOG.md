# Changelog

All notable user-visible changes to classic-vibe-mac are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project deploys continuously from `main` and has no versioned releases,
so history below is grouped into dated milestones instead of version numbers.

**Maintaining this file:** if your PR changes something a user or contributor
would notice (a feature, a behaviour change, a bug fix, a removal), add a line
under `[Unreleased]` in the right group (Added / Changed / Fixed / Removed),
linking the PR number. Skip pure refactors, test-only changes and dependency
bumps. When a batch of work lands, a maintainer can move `[Unreleased]` into a
new dated section.

## [Unreleased]

### Pending (in review)

- Agent sweep, open in [#358](https://github.com/khawkins98/classic-vibe-mac/pull/358):
  - Fixed: Pascal-string bugs in several sample apps, overlapping builds when
    Build & Run is clicked twice, and the HFS date offset in the in-browser disk
    patcher.
  - Added: friendlier compiler error hints ([#334](https://github.com/khawkins98/classic-vibe-mac/issues/334)).
  - Changed: AppleTalk relay hardening, accessibility improvements, heavy
    playground modules now lazy-load, docs refresh.

## 2026-06: Maintenance

### Fixed

- Toolchain wasm fetch is now resilient to GitHub Pages hiccups ([#346](https://github.com/khawkins98/classic-vibe-mac/pull/346)).

### Changed

- Dependabot now waits 14 days before proposing updates and groups `/src/web`
  minor/patch bumps ([#347](https://github.com/khawkins98/classic-vibe-mac/pull/347)).
  Routine dependency bumps (CodeMirror, dev deps, Actions) landed throughout May and June.

## 2026-05-18: Playground UX and onboarding

### Added

- A welcome modal with a "vibe-code a Mac app" pitch and a sample gallery ([#307](https://github.com/khawkins98/classic-vibe-mac/pull/307)).
- Project management: New file, Duplicate as new project ([#319](https://github.com/khawkins98/classic-vibe-mac/pull/319), [#320](https://github.com/khawkins98/classic-vibe-mac/pull/320)).
- Editor navigation: CodeWarrior-style Routines popup and Open Quickly (⌘P / ⌘D) ([#321](https://github.com/khawkins98/classic-vibe-mac/pull/321), [#322](https://github.com/khawkins98/classic-vibe-mac/pull/322), [#325](https://github.com/khawkins98/classic-vibe-mac/pull/325)).
- Shareable project URLs via a Share button and `?p=&f=&c=` deep links ([#337](https://github.com/khawkins98/classic-vibe-mac/pull/337)).
- Guided tours from `@cvm-step` annotations, and "Try this next" cards after a successful build ([#338](https://github.com/khawkins98/classic-vibe-mac/pull/338), [#339](https://github.com/khawkins98/classic-vibe-mac/pull/339)).
- Fullscreen-Mac mode on Chromium ([#331](https://github.com/khawkins98/classic-vibe-mac/pull/331)).
- Debug Console filter, keyword highlighting and empty-state hint ([#326](https://github.com/khawkins98/classic-vibe-mac/pull/326)).
- `wasm-mdpad` Markdown editor sample with Open / Save / Save As ([#296](https://github.com/khawkins98/classic-vibe-mac/pull/296), [#305](https://github.com/khawkins98/classic-vibe-mac/pull/305)).
- `docs/HANDBOOK.md`, an end-user manual for the playground ([#323](https://github.com/khawkins98/classic-vibe-mac/pull/323)).

### Changed

- ⌘-shortcuts are routed by the active pane (emulated Mac vs host page) ([#327](https://github.com/khawkins98/classic-vibe-mac/pull/327)).
- The build progress window shows running elapsed time and splits "Fetching toolchain" from "Compiling" ([#318](https://github.com/khawkins98/classic-vibe-mac/pull/318), [#329](https://github.com/khawkins98/classic-vibe-mac/pull/329)).
- README now leads with the vibe-coding pitch; ARCHITECTURE, HOW-IT-WORKS and PRD got a full refresh ([#306](https://github.com/khawkins98/classic-vibe-mac/pull/306), [#314](https://github.com/khawkins98/classic-vibe-mac/pull/314), [#315](https://github.com/khawkins98/classic-vibe-mac/pull/315)).

### Fixed

- Malformed `ALRT` resources in wordpad / notepad / mdpad ([#297](https://github.com/khawkins98/classic-vibe-mac/pull/297)).
- Stale state when the build progress window is reused ([#298](https://github.com/khawkins98/classic-vibe-mac/pull/298)).

## 2026-05-17: Glypha III, legacy retirement and pipeline consolidation

### Added

- Glypha III runs in the browser, built from source with its full upstream
  resource fork. This is the first real period app on the shelf
  ([#255](https://github.com/khawkins98/classic-vibe-mac/pull/255), [#288](https://github.com/khawkins98/classic-vibe-mac/pull/288), epic [#256](https://github.com/khawkins98/classic-vibe-mac/issues/256)).
- Precompiled resource-fork merging (MacBinary extractor and fork merger) for vendored apps ([#284](https://github.com/khawkins98/classic-vibe-mac/pull/284)–[#286](https://github.com/khawkins98/classic-vibe-mac/pull/286)).
- A Debug Console tab and a `cvm_log.h` system header, so any project can log to the host ([#261](https://github.com/khawkins98/classic-vibe-mac/pull/261), [#263](https://github.com/khawkins98/classic-vibe-mac/pull/263), [#330](https://github.com/khawkins98/classic-vibe-mac/pull/330)).
- Tooling and docs for debugging and vendoring period Mac apps ([#294](https://github.com/khawkins98/classic-vibe-mac/pull/294), [#295](https://github.com/khawkins98/classic-vibe-mac/pull/295)).

### Changed

- The Mac canvas now boots on demand instead of at page load ([#279](https://github.com/khawkins98/classic-vibe-mac/pull/279)).
- Compile paths (Build, Show Assembly) share one pipeline runner and one sysroot helper ([#268](https://github.com/khawkins98/classic-vibe-mac/pull/268)–[#270](https://github.com/khawkins98/classic-vibe-mac/pull/270), [#273](https://github.com/khawkins98/classic-vibe-mac/pull/273), closes [#271](https://github.com/khawkins98/classic-vibe-mac/issues/271)).
- Relicensed as GPL-3.0-or-later ([#281](https://github.com/khawkins98/classic-vibe-mac/pull/281)).

### Fixed

- `wasm-rez` no longer crashes on Glypha-sized input (8 MB stack) ([#287](https://github.com/khawkins98/classic-vibe-mac/pull/287)).

### Removed

- Legacy demo apps (Reader, MacWeather, Hello Mac, Pixel Pad, Markdown Viewer)
  and the old precompiled "Path C" build path ([#277](https://github.com/khawkins98/classic-vibe-mac/pull/277), [#278](https://github.com/khawkins98/classic-vibe-mac/pull/278), epic [#276](https://github.com/khawkins98/classic-vibe-mac/issues/276)).

## 2026-05-16: Sample shelf, Platinum chrome and Toolbox Reference

### Added

- The sample shelf grew to over 20 in-browser-compilable apps, ordered by
  Toolbox surface area: TextEdit, notepad, calculator, scribble, scroll
  windows, patterns, bounce, dialogs, sound, color, sticky note, clock,
  word processor, multi-window, cursors, file I/O, GWorlds, Arkanoid and an
  icon gallery ([#129](https://github.com/khawkins98/classic-vibe-mac/pull/129)–[#252](https://github.com/khawkins98/classic-vibe-mac/pull/252)).
- A real Mac OS menu bar with keyboard shortcuts, arrow-key and type-ahead navigation, and Recent Projects ([#124](https://github.com/khawkins98/classic-vibe-mac/pull/124)–[#142](https://github.com/khawkins98/classic-vibe-mac/pull/142)).
- Editor: syntax highlighting, Find/Replace, and a Toolbox API reference with 150+ entries, available as hover tooltips or a pinned window via ⌘-click ([#169](https://github.com/khawkins98/classic-vibe-mac/pull/169), [#203](https://github.com/khawkins98/classic-vibe-mac/pull/203)–[#210](https://github.com/khawkins98/classic-vibe-mac/pull/210)).
- Build: clickable compiler diagnostics, an artefact cache that skips unchanged sources, a Reset button, build stats, and a Mac OS 8 "File Copy"-style progress window ([#162](https://github.com/khawkins98/classic-vibe-mac/pull/162)–[#164](https://github.com/khawkins98/classic-vibe-mac/pull/164), [#171](https://github.com/khawkins98/classic-vibe-mac/pull/171), [#259](https://github.com/khawkins98/classic-vibe-mac/pull/259)).
- A toolchain backend abstraction and a CI job that compile-audits every sample ([#212](https://github.com/khawkins98/classic-vibe-mac/pull/212), [#213](https://github.com/khawkins98/classic-vibe-mac/pull/213)).
- Hot-loaded apps mount as a per-project floppy with its own icon ([#241](https://github.com/khawkins98/classic-vibe-mac/pull/241), [#247](https://github.com/khawkins98/classic-vibe-mac/pull/247)).

### Changed

- A Mac OS 8 Platinum accuracy pass covering scrollbars, title bars, toolbar icons, tabs, popup menus and density ([#166](https://github.com/khawkins98/classic-vibe-mac/pull/166), [#174](https://github.com/khawkins98/classic-vibe-mac/pull/174), [#229](https://github.com/khawkins98/classic-vibe-mac/issues/229)).
- Slimmer playground chrome; legacy below-the-fold sections removed ([#223](https://github.com/khawkins98/classic-vibe-mac/pull/223), [#226](https://github.com/khawkins98/classic-vibe-mac/pull/226)).

### Removed

- Boot-disk cruft (Backdrop, Aladdin, StuffIt Lite alias) and Finder auto-open windows ([#239](https://github.com/khawkins98/classic-vibe-mac/pull/239)–[#248](https://github.com/khawkins98/classic-vibe-mac/pull/248)).

## 2026-05-15: In-browser C compilation and the IDE

### Added

- **C compiles in the browser.** cc1, as, ld and Elf2Mac run as wasm to
  produce a MacBinary that boots in the emulator ([#80](https://github.com/khawkins98/classic-vibe-mac/pull/80)–[#97](https://github.com/khawkins98/classic-vibe-mac/pull/97)).
- Show Assembly panel (C to m68k) ([#80](https://github.com/khawkins98/classic-vibe-mac/pull/80), [#81](https://github.com/khawkins98/classic-vibe-mac/pull/81)).
- Multi-file C, mixed C + Rez builds, an optimization-level toggle, and Wasm Snake, the first playable game (epic [#100](https://github.com/khawkins98/classic-vibe-mac/issues/100): [#113](https://github.com/khawkins98/classic-vibe-mac/pull/113)–[#116](https://github.com/khawkins98/classic-vibe-mac/pull/116)).
- A Mac OS 8 IDE layout built from WinBox windows: startup project picker, Output panel, `.zip` import, Help palette and About box (epic [#104](https://github.com/khawkins98/classic-vibe-mac/issues/104): [#106](https://github.com/khawkins98/classic-vibe-mac/pull/106)–[#128](https://github.com/khawkins98/classic-vibe-mac/pull/128)).

### Fixed

- A string of linker and runtime fixes (re-entrant tools, crt link order,
  multi-segment script, SIZE resource, `--emit-relocs`) that got the compiled
  apps to actually run ([#84](https://github.com/khawkins98/classic-vibe-mac/pull/84)–[#97](https://github.com/khawkins98/classic-vibe-mac/pull/97)).

### Removed

- Legacy splice-path projects and prebuilt bisect-probe demos ([#79](https://github.com/khawkins98/classic-vibe-mac/pull/79), [#117](https://github.com/khawkins98/classic-vibe-mac/pull/117), [#120](https://github.com/khawkins98/classic-vibe-mac/pull/120)).

## 2026-05-10 to 2026-05-14: wasm-retro-cc integration

### Added

- Integrated the [wasm-retro-cc](https://github.com/khawkins98/wasm-retro-cc)
  toolchain, with prebuilt probe demos used to bisect Toolbox boot issues and the first
  Retro68 GCC-built demo ([#62](https://github.com/khawkins98/classic-vibe-mac/pull/62)–[#78](https://github.com/khawkins98/classic-vibe-mac/pull/78)).

## 2026-05-07 to 2026-05-09: Initial scaffold

### Added

- Project scaffold: BasiliskII in the browser booting System 7.5.5 with
  period chrome, a CI-built boot disk, and GitHub Pages deploy.
- Demo apps (Minesweeper, then Reader, MacWeather, Hello Mac, Pixel Pad,
  Markdown Viewer; all retired on 2026-05-17).
- Playground phases 1 to 3: an editor with IndexedDB storage, in-browser WASM-Rez, and an
  in-browser HFS patcher so Build & Run reboots the Mac with the new app.
- Emulator audio through Web Audio, pause-on-hidden-tab, and an AppleTalk WebSocket relay.
- Two-pane IDE layout, a file tab bar and a first-run Build & Run explainer ([#22](https://github.com/khawkins98/classic-vibe-mac/pull/22), [#45](https://github.com/khawkins98/classic-vibe-mac/issues/45), [#46](https://github.com/khawkins98/classic-vibe-mac/issues/46)).

### Fixed

- Emulator bombs on launch (Quadra 650 model ID) and mouse/keyboard input not
  reaching BasiliskII.
