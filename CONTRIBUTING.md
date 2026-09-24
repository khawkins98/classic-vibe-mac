# Contributing

Thanks for your interest in contributing to classic-vibe-mac.

## Your first in-browser edit

No install required. You can change a string in a running Mac app
in under a minute using the playground:

1. Open <https://khawkins98.github.io/classic-vibe-mac/> and pick a
   sample — from the welcome gallery on first visit, the project
   dropdown in the **Project** pane, or **File → Open Project…**
   (⌘O). **Wasm Hello** is the smallest. Click **Build & Run**.
2. The first build takes a few seconds longer while the page
   fetches the compiler toolchain and boots the Mac. Then System
   7.5.5 comes up with your app's disk on the desktop and the app
   auto-launched.
3. In the editor, change the string in the app's `.c` source
   (in Wasm Hello it's `kHelloStr`, the Pascal string `DrawString`
   paints — a byte array whose first byte is the length, so update
   that when you change the characters).
4. Click **Build & Run** again. About a second later the Mac
   reboots with your change applied — no fork, no push, no
   toolchain install.
5. That's it. Your edit lived only in your browser; nothing was
   sent to a server.

Edits persist across page reloads (IndexedDB). The toolbar's
**Download** button (also **File → Download .zip**, ⌘S) saves the
current project's sources as a `.zip`; **Share** copies a URL that
reopens the project with your edits. **Build** (without "Run")
downloads a MacBinary `.bin` you can run in any Basilisk II. The
[handbook](./docs/HANDBOOK.md) covers every button and shortcut.

## Your first code contribution

From fork to live page in one afternoon. The in-browser pipeline
compiles every sample directly in the visitor's tab, so you don't
need Retro68, Docker, or a cross-compile step to work on a sample.
CI uses Node 20; any current Node LTS works locally (on Node 24 the
`wasm-rez` stack test needs a larger `--stack-size`; the test
spawns its child process with that flag, so there's nothing to set).

1. **Fork and clone.**
   ```sh
   # Fork on GitHub first, then:
   git clone https://github.com/<your-handle>/classic-vibe-mac.git
   cd classic-vibe-mac
   npm install
   ```

2. **Start the dev server.**
   ```sh
   npm run dev        # http://localhost:5173
   ```
   To boot the Mac locally (not just the editor), also run
   `npm run fetch:emulator` and build the boot disk once — see
   [First-time setup](./docs/DEVELOPMENT.md#first-time-setup).

3. **Make a change.** A safe first target: open
   `src/app/wasm-hello/hello.c`, find `kHelloStr` (the Pascal
   string `DrawString` paints), change the characters and the
   leading length byte. Save the file.
   Hard-reload the tab, pick **Wasm Hello**, click Build & Run —
   your new string is on the screen. (If your browser already has
   an edited copy of that project in IndexedDB, use the toolbar's
   **Reset** to re-seed it from disk.)

4. **Verify the build locally before pushing.**
   ```sh
   npm run audit:wasm-e2e -- wasm-hello   # .c + .r compile, a few seconds
   npm run test:unit                       # JS pipeline unit tests
   ```

5. **Push to a feature branch on your fork.**
   ```sh
   git checkout -b feat/my-first-change
   git add src/app/wasm-hello/hello.c
   git commit -m "feat(wasm-hello): change the greeting"
   git push -u origin feat/my-first-change
   ```

6. **Open a PR** from your fork's branch to `khawkins98/classic-vibe-mac:main`.
   The PR template asks for a summary, a type, and a test plan. CI
   runs, in a few minutes: unit tests, the wasm-shelf compile audit,
   Playwright e2e, a markdown link check, and the full site build
   (boot disk + Vite).

7. **A maintainer squash-merges once CI is green.** The push to
   `main` triggers the deploy job, which publishes to GitHub Pages.
   (To preview on your own fork first, enable Pages on the fork —
   the same workflow deploys from your fork's `main`.)

Adding a *new* sample (rather than editing an existing one) takes
three steps: the source under `src/app/wasm-<name>/` (picked up
automatically by `src/web/vite.config.ts`), a `SAMPLE_PROJECTS`
entry in `src/web/src/playground/types.ts`, and a `PICKER_ENTRIES`
blurb in `src/web/src/projectPicker.ts`. The step-by-step is in
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md#add-a-new-sample-to-the-shelf);
for porting a third-party period app, see
[`docs/VENDORING-A-MAC-APP.md`](./docs/VENDORING-A-MAC-APP.md).

For the full iteration-loop reference and common-task recipes, see
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md). For the commit
message format this project uses (Conventional Commits), see
[Commit messages](#commit-messages--conventional-commits) below.

---

## Branching

- Branch from `main` for each piece of work
- Use short, descriptive, kebab-case branch names. A type prefix
  (`feat/`, `fix/`, `docs/`, `chore/`, `refactor/`) is welcome but
  not required — most branches in practice are a bare slug
  (`open-quickly`), optionally led by the issue number
  (`256-glypha-heap-size`). Use `spike/<thing>` for research branches
  that won't be merged. `dependabot/…` branches are automated.
- Never commit directly to `main`. Open a PR.

For the multi-agent dispatch hygiene the project has converged on
(non-overlapping file ownership, time-boxed spikes, the
five-reviewer Epic pass), see
[`docs/AGENT-PROCESS.md`](./docs/AGENT-PROCESS.md).

## Commit messages — Conventional Commits

Commit subjects on `main` follow the
[Conventional Commits](https://www.conventionalcommits.org/) spec.
Because every PR is squash-merged, **the PR title becomes the commit
subject on `main`** — so the title is the thing to get right; commits
on your branch can be as messy as you like. CI checks the PR title
([`.github/workflows/pr-title.yml`](./.github/workflows/pr-title.yml))
and fails the PR if it isn't a valid Conventional Commit subject with
one of the types below; edit the title and the check re-runs. Before
that check existed, a stretch of history from May 2026 drifted to
`area: summary` subjects (`playground: …`, `wasm-glypha3: …`) or
bare sentences (`Add …`). Please don't copy those; use a type, and
put the area in the scope instead: `feat(playground): …`. Scopes are
optional.

```
<type>(<optional scope>): <short summary>

<optional body>

<optional footer>
```

Common types:

- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation only
- `chore` — tooling, deps, build config
- `refactor` — code change that neither fixes a bug nor adds a feature
- `test` — adding or fixing tests
- `ci` — CI/CD pipeline changes
- `build` — build system or external dependency changes
- `perf` — a performance improvement
- `style` — formatting only, no code change
- `revert` — reverts an earlier commit

These are the only types the PR-title check accepts.

`test` is singular — `tests: …` doesn't parse as a type. Common
scopes: `playground`, `samples`, `wasm-<name>`, `deps`, `ci`.
Dependabot PRs are configured to title themselves `chore(deps): …`.

Examples:

```
feat(playground): Open Quickly (⌘P) fuzzy file-jump palette
fix(wasm-notepad): define FALSE/TRUE locally so in-browser compile works
docs: recipe for vendoring a period Mac app
```

Use `!` after the type or a `BREAKING CHANGE:` footer for breaking changes:

```
feat(api)!: rename disk image output path
```

### No AI co-author trailers

Commit messages don't carry AI attribution. `npm install` runs a
`prepare` script that sets `core.hooksPath` to `.githooks/`, whose
`commit-msg` hook strips `Co-authored-by: … @anthropic.com` trailers
and "Generated with Claude Code" footers. Human co-authors are left
alone.

Two things to know:

- Setting `core.hooksPath` for this repo means any hooks you keep in
  `.git/hooks/` (or a global `core.hooksPath`) won't run here. Put
  them in `.githooks/`, or run `git config --unset core.hooksPath`
  to opt out.
- The hook only sees local commits. GitHub squash-merge messages and
  PR descriptions don't pass through it, so leave those lines out
  there by hand.

## Pull requests

- Open a PR against `main` for any non-trivial change
- Keep PRs focused — one logical change per PR when practical
- Include a brief description of *why*, not just *what*
- Link related issues (`closes #123` in the body auto-closes on merge)
- Fill in the PR template's test plan

### Merging

- **Squash and merge**, always. `main` has no merge commits; every
  commit on it is one PR, with the PR number appended to the subject.
  The squash subject (the PR title) must follow Conventional Commits.
- To catch up with `main`, rebase your branch rather than merging
  `main` into it.

## Before opening a PR

- Make sure the build passes locally (or in CI on your branch). For
  `wasm-*` sample changes, run `npm run audit:wasm-e2e -- <sample>`
  — the combined `.c` + `.r` audit catches most regressions in
  seconds. Run `npm run test:unit` for anything touching the host C
  or the JS pipeline modules
- Run `npm run typecheck` (`tsc --noEmit -p src/web`) if you touched
  any TypeScript. CI runs it in the `unit` job, and unused locals or
  parameters count as errors
- Update `README.md` if behavior changed, and
  [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) /
  [`docs/HOW-IT-WORKS.md`](./docs/HOW-IT-WORKS.md) if the architecture
  or build pipeline changed
- Add an entry under `[Unreleased]` in [`CHANGELOG.md`](./CHANGELOG.md) for
  user-visible changes
- **Update [`docs/HANDBOOK.md`](./docs/HANDBOOK.md) when a user-facing
  thing changes** — a new menu item, a new keyboard shortcut, a new
  toolbar button, a new pane, a behavioural change to Build & Run, a
  new persistence key, a new way to make/save/open a project or file.
  The handbook is the end-user manual; if a visitor opening the page
  would notice your change, the handbook should reflect it. Sections
  worth scanning before you ship:
  - "Menu bar reference" / "Keyboard reference" tables — for shortcuts
    or menu items
  - "File navigation" — for tab bar / file-list / picker changes
  - "Build and Run" — for compile pipeline / progress modal changes
  - "Persistence — what survives a reload" — for new IDB / localStorage
    keys
- Add a note to [`LEARNINGS.md`](./LEARNINGS.md) if you discovered
  something non-obvious along the way (Retro68 quirks, HFS gotchas,
  CORS issues, System 7 API surprises, etc.) — future contributors
  will thank you. Cross-cutting meta-lessons belong in the "Key
  stories" section at the top
- Don't commit build artifacts or emulator ROMs

If something breaks during setup or local dev, check
[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) first. For
vendored-app-specific silent failures, the recipes are in
[`docs/DEBUGGING-VENDORED-APPS.md`](./docs/DEBUGGING-VENDORED-APPS.md).
