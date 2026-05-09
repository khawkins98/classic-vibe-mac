# Compile Server

A stateless HTTP server that compiles C source code for the classic Mac 68k (m68k-apple-macos) using the [Retro68](https://github.com/autc04/Retro68) GCC toolchain. Powers the **Compile & Run** button in the classic-vibe-mac playground — zero configuration for end users.

## How it works

```
Browser (CodeMirror)
  │  POST /compile  { files: [{name, content}, ...], appName }
  ▼
Compile Server  (Docker / Fly.io)
  │  cmake + m68k-apple-macos-gcc
  │  → complete MacBinary (.bin, both code + resource forks)
  ▼
Browser  →  HFS patcher  →  running System 7.5.5 emulator
```

Each request is **fully stateless**: source files are written to a temp directory, compiled, and the directory is removed — all within the request lifetime.

## Quick start (local)

```bash
# Build the image (uses ghcr.io/autc04/retro68:latest as base)
docker build -t cvm-compile-server ./compile-server

# Run with localhost CORS
docker run --rm -p 8080:8080 \
  -e ALLOWED_ORIGINS=http://localhost:5173 \
  cvm-compile-server

# Check it's alive
curl http://localhost:8080/health

# Wire the playground to it
echo "VITE_COMPILE_SERVER_URL=http://localhost:8080" > src/web/.env.local
cd src/web && npm run dev
```

## API

### `GET /health`

Returns toolchain version, limits, and supported extensions. The browser uses this to verify the server is reachable before enabling **Compile & Run**.

### `POST /compile`

**Request body (JSON):**

```json
{
  "files": [
    { "name": "main.c", "content": "#include <Windows.h>\n..." },
    { "name": "utils.h", "content": "..." }
  ],
  "appName": "MyApp"
}
```

- `files`: `.c` and `.h` files only. Max 20 files, 64 KB each, 256 KB total.
- `appName`: shown in the Finder; 1–31 alphanumeric characters. Defaults to `"UserApp"`.

**Success response:**

```json
{
  "ok": true,
  "binary": "<base64-encoded MacBinary>"
}
```

**Error response:**

```json
{
  "ok": false,
  "errors": [
    { "file": "main.c", "line": 5, "column": 3, "message": "...", "severity": "error" }
  ],
  "rawStderr": "full compiler output (capped at 8 KB)"
}
```

Errors are surfaced as CodeMirror inline markers in the playground editor.

## Classic Mac SDK header names

The Retro68 toolchain ships the **System 7 / Universal Headers** — these use the pre-Carbon naming convention. If you're used to macOS Carbon or CFM header names, the key differences are:

| Use this (Retro68 / System 7) | Not this (Carbon / macOS) |
|---|---|
| `#include <Windows.h>` | `MacWindows.h` |
| `#include <Memory.h>` | `MacMemory.h` |
| `#include <Types.h>` | `MacTypes.h` |
| `#include <Errors.h>` | (same) |
| `#include <Events.h>` | (same) |
| `#include <Quickdraw.h>` | (same) |

`Carbon.h` is **not** available — it's a CFM/macOS umbrella header. Include individual toolbox headers instead.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGINS` | `http://localhost:5173,...` | Comma-separated CORS origins |
| `PORT` | `8080` | HTTP listen port |
| `RATE_LIMIT_MAX` | `10` | Max requests per window per IP |
| `RATE_LIMIT_WINDOW` | `60` | Window size in seconds |

## Deploying to Fly.io

```bash
cd compile-server
fly launch --name cvm-compile-server --dockerfile Dockerfile --no-deploy
fly secrets set ALLOWED_ORIGINS=https://khawkins98.github.io
fly deploy
```

After deploy, set the compile server URL in your web build:

```bash
# GitHub Actions / CI
VITE_COMPILE_SERVER_URL=https://cvm-compile-server.fly.dev
```

Or for a permanent deploy:

```bash
# src/web/.env.production (committed)
VITE_COMPILE_SERVER_URL=https://cvm-compile-server.fly.dev
```

## Security notes

- Runs as non-root (`appuser`, UID 1001) inside the container.
- Each compile is in a fresh `tempfile.TemporaryDirectory`, cleaned up in `finally`.
- Subprocess runs in a new process group (`start_new_session=True`); the whole group is killed on timeout.
- Filenames are validated against `[A-Za-z0-9_.-]+.(c|h)` — no `..`, no absolute paths, no shell characters.
- Per-IP rate limiting (10 req/60s by default).
- Run with `--network=none` in production to block outbound connections during compilation.

## Adding to Docker Compose

```yaml
services:
  compile-server:
    build: ./compile-server
    ports:
      - "8080:8080"
    environment:
      ALLOWED_ORIGINS: "http://localhost:5173"
    network_mode: none   # block outbound during compilation
```
