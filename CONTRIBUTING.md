# Contributing

Thanks for your interest in contributing to classic-mac-builder.

## Branching

The project is in early scaffolding. Until the initial scaffold lands on
`main`, expect work to happen on a long-lived feature branch off the first
commit. After that, normal flow resumes:

- Branch from `main` for each piece of work
- Use short, descriptive branch names (e.g. `feat/hfs-packer`,
  `fix/wasm-loader-path`)

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
