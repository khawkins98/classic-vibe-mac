# Contributing

Thanks for your interest in contributing to classic-vibe-mac.

## Your first in-browser edit

No install required. You can change a string in a running Mac app
in under a minute using the playground:

1. Open <https://khawkins98.github.io/classic-vibe-mac/> and pick a
   sample from the **Project** dropdown — **Wasm Hello** is the
   smallest. Click **Build & Run**.
2. ~15s later (first time, cold cache) the Mac boots into System
   7.5.5 with your app's disk on the desktop and the app
   auto-launched.
3. In the editor, change the string in the app's `.c` source
   (Wasm Hello's `DrawString` argument is one line — hard to miss).
4. Click **Build & Run** again. About 1 second later the Mac
   reboots with your change applied — no fork, no push, no
   toolchain.
5. That's it. Your edit lived only in your browser; nothing was
   sent to a server.

Edits persist across page reloads (IndexedDB). "Download as zip"
bags your whole working tree. **Build** (without "Run") gives you a
`.bin` you can run in any Basilisk II.

## Your first code contribution

From fork to live page in one afternoon. The in-browser pipeline
compiles every sample directly in the visitor's tab — no
cross-compile in CI, no Docker, no precompiled binaries to vendor.

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

3. **Make a change.** A safe first target: open
   `src/app/wasm-hello/hello.c`, find the `DrawString` call, change
   the message. Save the file. Hard-reload the tab, pick **Wasm
   Hello**, click Build & Run — your new string is on the screen.

4. **Verify the build locally before pushing.**
   ```sh
   npm run audit:wasm-e2e -- wasm-hello   # both .c + .r, ~1.5s
   npm run test:unit                       # host C + JS tests
   ```

5. **Push to a feature branch on your fork.**
   ```sh
   git checkout -b feat/my-first-change
   git add src/app/wasm-hello/hello.c
   git commit -m "feat(wasm-hello): change the greeting"
   git push -u origin feat/my-first-change
   ```

6. **Open a PR** from your fork's branch to `khawkins98/classic-vibe-mac:main`.
   CI runs the wasm-shelf audit and the unit tests (~3 min).

7. **Once CI is green, squash-merge.** The deploy job publishes to
   GitHub Pages. Your change is live at your fork's Pages URL.

Adding a *new* sample (rather than editing an existing one) is its
own recipe — see
[`docs/VENDORING-A-MAC-APP.md`](./docs/VENDORING-A-MAC-APP.md) for
the third-party-app path, or
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) for the general
flow.

For the full iteration-loop reference and common-task recipes, see
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md). For the commit
message format this project uses (Conventional Commits), see
[Commit messages](#commit-messages--conventional-commits) below.

---

## Branching

- Branch from `main` for each piece of work
- Use short, descriptive branch names. Conventional prefixes the
  project uses today: `feat/<thing>`, `fix/<thing>`, `docs/<thing>`,
  `chore/<thing>`, `refactor/<thing>`, `spike/<thing>` (research,
  do-not-merge).
- Never commit directly to `main`. Open a PR.

For the multi-agent dispatch hygiene the project has converged on
(non-overlapping file ownership, time-boxed spikes, the
five-reviewer Epic pass), see
[`docs/AGENT-PROCESS.md`](./docs/AGENT-PROCESS.md).

## Commit messages — Conventional Commits

All commits follow the [Conventional Commits](https://www.conventionalcommits.org/)
spec:

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

Examples:

```
feat(builder): pack compiled binary into HFS disk image
fix(ci): use Retro68 release tag instead of main
docs: link PRD from README
```

Use `!` after the type or a `BREAKING CHANGE:` footer for breaking changes:

```
feat(api)!: rename disk image output path
```

## Pull requests

- Open a PR against `main` for any non-trivial change
- Keep PRs focused — one logical change per PR when practical
- Include a brief description of *why*, not just *what*
- Link related issues

### Merging

- **Squash and merge** is the default for larger PRs or any branch with
  noisy work-in-progress commits. The squash commit message must itself
  follow Conventional Commits — this keeps `main`'s history clean and
  changelog-friendly.
- For small PRs that already consist of a single well-formed Conventional
  Commit, a regular merge is fine.
- Avoid merge commits from `main` into feature branches; rebase instead.

## Before opening a PR

- Make sure the build passes locally (or in CI on your branch)
- Update `README.md` / `PRD.md` if behavior or architecture changed
- Add a note to [`LEARNINGS.md`](./LEARNINGS.md) if you discovered something
  non-obvious along the way (Retro68 quirks, HFS gotchas, CORS issues,
  System 7 API surprises, etc.) — future contributors will thank you
- Don't commit build artifacts or emulator ROMs

If something breaks during setup or local dev, check
[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) first.
