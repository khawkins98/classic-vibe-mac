# Troubleshooting

Cmd-F for your symptom. Each entry maps **symptom → root cause → fix**.
Detailed walkthrough follows the quick-reference table.

Cross-links: [`DEVELOPMENT.md`](./DEVELOPMENT.md) (iteration loops),
[`LEARNINGS.md`](../LEARNINGS.md) (running gotchas log),
[`README.md`](../README.md#try-it) (Try it).

---

## Quick-reference table

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| Page loads chrome but no canvas; console shows `SharedArrayBuffer is not defined` or COOP/COEP error | Not in a cross-origin-isolated context | Dev: use `npm run dev` (Vite sets headers). Prod: hard-reload twice to let `coi-serviceworker` install. |
| BasiliskII bombs at launch: "unimplemented trap" dialog | Wrong `modelid` pref, stale boot disk, or app missing from `:System Folder:Startup Items:` | Check `modelid 30` in `emulator-worker.ts`; re-pull CI artifact; verify with `hls -l ":System Folder:Startup Items:"`. |
| Edited Reader source doesn't appear after Build | Forgot to rebuild boot disk, browser cached old disk, or hard reload needed | Re-run `scripts/build-boot-disk.sh`; hard-reload (`Cmd-Shift-R`); disable cache in DevTools during dev. |
| CI fails: `` `Controls.h` not found `` (or other Retro68 header) | Header not in Retro68's universal interfaces | Use a different umbrella header (`Windows.h`, `Quickdraw.h`, `MacTypes.h`). |
| Local Docker build fails with `permission denied` | Container runs as root; bind-mount FS restrictions | Build to a path inside the container and copy out (see below). |
| `hls` says "no such file or directory" for a path that exists | Mac-style HFS paths, not UNIX paths | Use `:` or empty string for root, `:System Folder:` for subdirectory — not `/`. |
| Build & Run succeeds but app doesn't appear | App is on the secondary "Apps" disk, not the boot disk | Open the "Apps" volume icon on the Mac desktop, then double-click the app inside. |
| In-browser C build shows `cc1 exited rc=1` after the first successful build | cc1.wasm's static state (GCC's `decode_options`) persists across `Module.callMain` invocations — second call sees the first's `-o` flag and errors. | Fresh `Module` instance per compile call (this is what `compileToBin` already does — if you hit this in your own code, don't reuse the same cc1 Module). LEARNINGS Key Story #3. |
| In-browser C build: WasmHello downloads but bombs with type-3 at launch | Likely the `--emit-relocs` ld flag is missing — relocations aren't preserved in the output ELF so `Retro68Relocate` walks empty RELA at runtime and pointers fault. | Already fixed on main (cv-mac #97). If you're forking, make sure `cc1.ts`'s ld argv includes `--emit-relocs`. |
| In-browser C build fails with `unknown filename` or similar MEMFS error | The compile pipeline writes intermediate files to `/tmp/` in the Module FS; a previous failed run may have left stale files | Reload the page (each fresh page load gets fresh Modules). Or check `src/web/src/playground/cc1.ts` for `FS.unlink` calls before each write. |
| `bundleVersion` in console doesn't change after deploying a toolchain fix | `bundleVersion` hashes the C sample sources only, not the wasm-cc1 toolchain. Toolchain updates change `toolchainVersion` instead. | Look for `toolchainVersion=<hex>` in the same `[cvm] build` console line. |

---

## Detailed walkthroughs

### "Page shows chrome but no canvas / console errors about SharedArrayBuffer"

You're not in a cross-origin-isolated context. Two cases:

- **Local dev.** Vite sets COOP/COEP for you (see
  `src/web/vite.config.ts`). If you're seeing the error, you may have
  opened a non-Vite preview (e.g. a static `dist/` server). Switch back
  to `npm run dev`.
- **Production (GitHub Pages).** GH Pages can't set custom headers, so
  we ship a `coi-serviceworker.min.js` that re-fetches the page and
  injects the COOP/COEP headers on the way back. **The first load is
  expected to be in the wrong state and reload itself once.** A
  forced reload (Cmd-Shift-R) on the second visit confirms COI is
  installed. See `LEARNINGS.md` (2026-05-08, GH Pages COOP/COEP).

### "BasiliskII bombs at launch with 'unimplemented trap'"

Three things to check, in order:

1. **`modelid`.** It must be `gestaltID − 6`, i.e. `30` for Quadra 650.
   The constant lives in `src/web/src/emulator-worker.ts`. The wrong
   value makes Gestalt report a bogus machine type, System 7.5.5 skips a
   chunk of its trap-patch ladder, and bootstrap calls land in the
   "unimplemented trap" handler. Full story in `LEARNINGS.md`.
2. **CI build status.** If CI is red, the boot disk you just downloaded
   was either the previous green build's, or the disk packing step ran
   on a missing/empty `.bin` and now the resource fork is gone. The
   defensive check in `scripts/build-boot-disk.sh` (resource fork
   non-zero) catches the second case.
3. **The app is actually in `:System Folder:Startup Items:` on the boot
   volume.** Mount the disk and check:
   ```sh
   hmount src/web/public/system755-vibe.dsk
   hls -l ":System Folder:Startup Items:"
   humount src/web/public/system755-vibe.dsk
   ```
   `hls -l` columns are `<flag>  <TYPE>/<CREATOR>  <rsrc>  <data>  <date>  <name>` —
   a non-trivial `<rsrc>` and `Type=APPL` mean the install is correct.
   (`hls -l` columns are listed `rsrc data`, not `data rsrc` —
   `LEARNINGS.md` covers the day we got that backwards.)

### "My Reader changes don't show up"

Almost always one of:

- You forgot to rebuild the boot disk after re-cross-compiling. The
  disk in `src/web/public/` still has the old binary baked in. Re-run
  `scripts/build-boot-disk.sh`.
- You forgot to hard-reload the browser tab. Vite HMR doesn't see
  `.dsk` changes.
- The browser cached the chunked manifest aggressively. Open devtools,
  check the network tab for 304s on `system755-vibe.dsk.json` and the
  chunks under `system755-vibe-chunks/`. Disable cache (devtools →
  Network → "Disable cache" while open) for development sessions.

### "CI says `Controls.h` not found" (or another Retro68 header)

Retro68's universal interfaces don't ship every header. The fix is
usually one of:

- The header is genuinely not in Retro68's tree — find the trap or
  type definition you actually need and pull it from a different
  header (`Windows.h`, `Quickdraw.h`, `MacTypes.h`).
- The header is included indirectly via another umbrella — check what
  the Retro68 sample apps include.

If you discover a Retro68 quirk worth remembering, add it to
[`LEARNINGS.md`](../LEARNINGS.md) — the "hfsutils-vs-hfsprogs",
"`hls -l` columns", and "`modelid = gestaltID − 6`" entries are the kind
of thing this file exists to capture.

### "Retro68 Docker image build fails locally with `permission denied`"

The container runs as root and writes into the bind-mounted `/work`. If
your local repo is on a filesystem that doesn't allow that (some Docker
Desktop setups, or some BSD hosts), build to a path inside the container
and copy out:

```sh
docker run --rm -v "$PWD:/work" -w /work ghcr.io/autc04/retro68:latest \
  bash -c "cmake -S src/app -B /tmp/build \
    -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
    && cmake --build /tmp/build --parallel \
    && cp /tmp/build/Reader.bin /work/build/"
```

### "`hls` says no such file or directory"

`hfsutils` paths are Mac-style. The volume root is `:` or the empty
string, not `/`. `hls /` resolves to nothing. Use `hls` (no arg, or `:`)
for the root, `hls ":System Folder:"` for a subdirectory. See
`LEARNINGS.md` (2026-05-08).

### "Build & Run succeeded but my app isn't visible"

Build & Run mounts your compiled app on a separate secondary volume
called **Apps** — it does _not_ replace the main boot disk. After the
Mac reboots (~820ms warm), look on the desktop for the **Apps** volume
icon, open it, and double-click your app to launch it.

---

_This file is extracted from `docs/DEVELOPMENT.md § Common failure modes`.
If you add a fix here, add the corresponding entry to
[`LEARNINGS.md`](../LEARNINGS.md) too so future contributors can find it._
