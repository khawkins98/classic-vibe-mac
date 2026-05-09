"""
compile-server/server.py — stateless Retro68 compile server.

Receives C source files via POST /compile, compiles them with the Retro68
m68k-apple-macos-gcc toolchain (via CMake), and returns a complete MacBinary
(.bin) as a base64-encoded JSON payload. Compiler diagnostics are parsed from
GCC stderr and returned as structured JSON for CodeMirror error markers.

Security model:
  - Runs as a non-root user (appuser, UID 1001).
  - Each request gets its own TemporaryDirectory; cleaned up in finally.
  - Subprocess is launched in a new session (start_new_session=True) so the
    whole process group can be killed on timeout.
  - Filename allowlist: only [A-Za-z0-9_.\\-], no '..', no absolute paths,
    only .c and .h extensions.
  - appName validation: ≤31 chars (Mac filename limit), alphanumeric+space+hyphen.
  - Body size enforced by HTTP layer (MAX_BODY_BYTES).
  - Rate limiting: per-IP, 10 req/min (configurable via env).

Deploy:
  See README.md in this directory for Fly.io and Docker Compose instructions.
"""

import base64
import os
import re
import signal
import subprocess
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── Configuration ──────────────────────────────────────────────────────────────

TOOLCHAIN_FILE = (
    "/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake"
)

ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5173,http://localhost:4173,http://localhost:8080",
).split(",")

RATE_LIMIT_MAX = int(os.getenv("RATE_LIMIT_MAX", "10"))
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))  # seconds

MAX_FILES = 20
MAX_FILE_SIZE = 64 * 1024       # 64 KB per file
MAX_TOTAL_SIZE = 256 * 1024     # 256 KB total source
MAX_APP_NAME_LEN = 31           # classic Mac filename limit
MAX_BINARY_SIZE = 2 * 1024 * 1024  # 2 MB output binary
MAX_STDERR_BYTES = 8 * 1024     # captured stderr cap
MAX_BODY_BYTES = 512 * 1024     # HTTP body limit

CONFIGURE_TIMEOUT = 30   # seconds
BUILD_TIMEOUT = 60        # seconds

# ── Pydantic models ────────────────────────────────────────────────────────────

class CompileFile(BaseModel):
    name: str
    content: str


class CompileRequest(BaseModel):
    files: list[CompileFile]
    appName: str = "UserApp"


class CompileDiagnostic(BaseModel):
    file: str
    line: int
    column: int
    message: str
    severity: str  # "error" | "warning" | "note"


class CompileResponse(BaseModel):
    ok: bool
    binary: Optional[str] = None   # base64-encoded MacBinary
    errors: list[CompileDiagnostic] = []
    rawStderr: Optional[str] = None


# ── In-memory rate limiter ─────────────────────────────────────────────────────

_rate_store: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(client_ip: str) -> bool:
    now = time.monotonic()
    times = _rate_store[client_ip]
    times[:] = [t for t in times if now - t < RATE_LIMIT_WINDOW]
    if len(times) >= RATE_LIMIT_MAX:
        return False
    times.append(now)
    return True


# ── Validation helpers ─────────────────────────────────────────────────────────

_FILENAME_RE = re.compile(r'^[A-Za-z0-9_\-\.]+\.(c|h)$', re.IGNORECASE)


def validate_filename(name: str) -> bool:
    if not name or len(name) > 64:
        return False
    if ".." in name or "/" in name or "\\" in name or name.startswith("."):
        return False
    return bool(_FILENAME_RE.match(name))


_APP_NAME_RE = re.compile(r'^[A-Za-z0-9_ \-]+$')


def validate_app_name(name: str) -> bool:
    return bool(name and len(name) <= MAX_APP_NAME_LEN and _APP_NAME_RE.match(name))


def cmake_target_name(app_name: str) -> str:
    """Convert appName to a valid CMake target: alphanumeric + underscore."""
    target = re.sub(r'[^A-Za-z0-9_]', '_', app_name).strip('_')
    if not target or target[0].isdigit():
        target = "App_" + target
    return target or "UserApp"


def validate_macbinary(data: bytes) -> bool:
    """Minimal MacBinary I/II header sanity check."""
    if len(data) < 128:
        return False
    if data[0] != 0:        # byte 0 is always 0 in valid MacBinary
        return False
    name_len = data[1]
    return 1 <= name_len <= 63


# ── Subprocess helper ──────────────────────────────────────────────────────────

class TimedOut(Exception):
    pass


def run_cmd(cmd: list[str], timeout: int, cwd: Optional[str] = None) -> tuple[int, str, str]:
    """
    Run a command in a new process group. On timeout, kill the entire group and
    raise TimedOut. Returns (returncode, stdout, stderr).
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        start_new_session=True,
    )
    try:
        stdout_b, stderr_b = proc.communicate(timeout=timeout)
        return (
            proc.returncode,
            stdout_b.decode("utf-8", errors="replace"),
            stderr_b.decode("utf-8", errors="replace"),
        )
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait()
        raise TimedOut(f"Command timed out after {timeout}s: {cmd[0]}")


# ── Diagnostics parser ─────────────────────────────────────────────────────────

# Patterns for GCC/Clang diagnostic lines:
#   file:line:col: severity: message
#   file:line: severity: message
_DIAG_WITH_COL = re.compile(
    r'^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$'
)
_DIAG_NO_COL = re.compile(
    r'^(.+?):(\d+):\s+(error|warning|note):\s+(.+)$'
)


def parse_gcc_stderr(stderr: str, tmpdir: str) -> list[CompileDiagnostic]:
    prefix = tmpdir.rstrip("/") + "/"
    diagnostics: list[CompileDiagnostic] = []
    seen: set[tuple[str, int, int, str]] = set()

    for line in stderr.splitlines():
        m = _DIAG_WITH_COL.match(line)
        if m:
            fname = m.group(1)
            if fname.startswith(prefix):
                fname = fname[len(prefix):]
            entry = (fname, int(m.group(2)), int(m.group(3)), m.group(5))
            if entry not in seen:
                seen.add(entry)
                diagnostics.append(CompileDiagnostic(
                    file=fname,
                    line=int(m.group(2)),
                    column=int(m.group(3)),
                    message=m.group(5),
                    severity=m.group(4),
                ))
            continue

        m2 = _DIAG_NO_COL.match(line)
        if m2:
            fname = m2.group(1)
            if fname.startswith(prefix):
                fname = fname[len(prefix):]
            entry = (fname, int(m2.group(2)), 1, m2.group(4))
            if entry not in seen:
                seen.add(entry)
                diagnostics.append(CompileDiagnostic(
                    file=fname,
                    line=int(m2.group(2)),
                    column=1,
                    message=m2.group(4),
                    severity=m2.group(3),
                ))

    return diagnostics


# ── FastAPI app ────────────────────────────────────────────────────────────────

app = FastAPI(
    title="CVM Compile Server",
    description="Stateless Retro68 m68k-apple-macos compile endpoint",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    max_age=600,
)


@app.middleware("http")
async def body_size_limit(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request body too large."})
    return await call_next(request)


@app.get("/health")
async def health():
    try:
        rc, stdout, _ = run_cmd(["m68k-apple-macos-gcc", "--version"], timeout=5)
        toolchain_version = stdout.strip().splitlines()[0] if rc == 0 else "error"
    except Exception as e:
        toolchain_version = f"unavailable: {e}"

    return {
        "ok": True,
        "toolchainVersion": toolchain_version,
        "limits": {
            "maxFiles": MAX_FILES,
            "maxFileSizeBytes": MAX_FILE_SIZE,
            "maxTotalSizeBytes": MAX_TOTAL_SIZE,
            "maxBinarySizeBytes": MAX_BINARY_SIZE,
        },
        "supportedExtensions": [".c", ".h"],
        "rateLimit": {"requestsPerWindow": RATE_LIMIT_MAX, "windowSeconds": RATE_LIMIT_WINDOW},
    }


@app.post("/compile", response_model=CompileResponse)
async def compile_endpoint(req: CompileRequest, request: Request) -> CompileResponse:
    # ── Rate limit ──────────────────────────────────────────────────────────
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    client_ip = forwarded_for.split(",")[0].strip() if forwarded_for else (
        request.client.host if request.client else "unknown"
    )
    if not check_rate_limit(client_ip):
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit: max {RATE_LIMIT_MAX} compilations per {RATE_LIMIT_WINDOW}s.",
        )

    # ── Validate appName ────────────────────────────────────────────────────
    app_name = req.appName.strip()
    if not validate_app_name(app_name):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid appName. Use 1–{MAX_APP_NAME_LEN} alphanumeric characters.",
        )
    target = cmake_target_name(app_name)

    # ── Validate files ──────────────────────────────────────────────────────
    if not req.files:
        raise HTTPException(status_code=400, detail="No files provided.")
    if len(req.files) > MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Too many files (max {MAX_FILES}).")

    total_size = 0
    c_files: list[str] = []
    for f in req.files:
        if not validate_filename(f.name):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid filename {f.name!r}. Only .c/.h files with safe names are accepted.",
            )
        size = len(f.content.encode("utf-8"))
        if size > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=400,
                detail=f"File {f.name!r} exceeds {MAX_FILE_SIZE // 1024} KB.",
            )
        total_size += size
        if total_size > MAX_TOTAL_SIZE:
            raise HTTPException(
                status_code=400,
                detail=f"Total source size exceeds {MAX_TOTAL_SIZE // 1024} KB.",
            )
        if f.name.lower().endswith(".c"):
            c_files.append(f.name)

    if not c_files:
        raise HTTPException(status_code=400, detail="At least one .c file is required.")

    # ── Compile ─────────────────────────────────────────────────────────────
    with tempfile.TemporaryDirectory(prefix="cvm_") as tmpdir:
        tmppath = Path(tmpdir)

        # Write source files.
        for f in req.files:
            (tmppath / f.name).write_text(f.content, encoding="utf-8")

        # Generate CMakeLists.txt.
        sources = "\n    ".join(c_files)
        cmake_txt = (
            f"cmake_minimum_required(VERSION 3.15)\n"
            f"project({target} C)\n\n"
            f"add_application({target}\n"
            f"    CREATOR ????\n"
            f"    {sources}\n"
            f")\n\n"
            f"if(CMAKE_SYSTEM_NAME MATCHES Retro68)\n"
            f"    set_target_properties({target} PROPERTIES\n"
            f"        LINK_FLAGS \"-Wl,-gc-sections -Wl,--mac-strip-macsbug\")\n"
            f"endif()\n"
        )
        (tmppath / "CMakeLists.txt").write_text(cmake_txt)

        build_dir = tmppath / "build"
        build_dir.mkdir()

        # CMake configure.
        try:
            rc, stdout, stderr = run_cmd(
                [
                    "cmake", "-S", str(tmppath), "-B", str(build_dir),
                    f"-DCMAKE_TOOLCHAIN_FILE={TOOLCHAIN_FILE}",
                    "-DCMAKE_BUILD_TYPE=Release",
                    "--no-warn-unused-cli",
                ],
                timeout=CONFIGURE_TIMEOUT,
            )
        except TimedOut:
            return CompileResponse(
                ok=False,
                rawStderr="CMake configure timed out. Try a simpler project.",
            )

        if rc != 0:
            combined = (stderr + stdout)[:MAX_STDERR_BYTES]
            return CompileResponse(
                ok=False,
                rawStderr=f"CMake configure failed:\n{combined}",
            )

        # CMake build.
        try:
            rc, stdout, stderr = run_cmd(
                ["cmake", "--build", str(build_dir), "--parallel"],
                timeout=BUILD_TIMEOUT,
            )
        except TimedOut:
            return CompileResponse(
                ok=False,
                rawStderr="Build timed out after 60 seconds.",
            )

        combined_stderr = (stderr + stdout)[:MAX_STDERR_BYTES]

        if rc != 0:
            diagnostics = parse_gcc_stderr(combined_stderr, tmpdir)
            return CompileResponse(
                ok=False,
                errors=diagnostics,
                rawStderr=combined_stderr,
            )

        # Locate output binary. Retro68 add_application in a flat project
        # puts the .bin at build/<target>.bin.
        bin_path = build_dir / f"{target}.bin"
        if not bin_path.exists():
            return CompileResponse(
                ok=False,
                rawStderr=(
                    f"Build succeeded but {target}.bin was not found. "
                    f"Files in build/: {list(build_dir.iterdir())}"
                ),
            )

        binary = bin_path.read_bytes()

        if len(binary) > MAX_BINARY_SIZE:
            return CompileResponse(
                ok=False,
                rawStderr=f"Compiled binary exceeds maximum size ({MAX_BINARY_SIZE // 1024} KB).",
            )

        if not validate_macbinary(binary):
            return CompileResponse(
                ok=False,
                rawStderr="Output does not look like a valid MacBinary.",
            )

        return CompileResponse(
            ok=True,
            binary=base64.b64encode(binary).decode("ascii"),
        )


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
