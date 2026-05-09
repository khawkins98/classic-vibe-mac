/**
 * compile-client.ts — browser client for the stateless Retro68 compile server.
 *
 * POSTs .c/.h source files to VITE_COMPILE_SERVER_URL/compile and returns a
 * complete MacBinary (.bin, both forks) or structured error diagnostics
 * compatible with setEditorDiagnostics() in error-markers.ts.
 *
 * If VITE_COMPILE_SERVER_URL is not set, isCompileServerAvailable() returns
 * false and the UI should disable/hide the Compile & Run button.
 */

import type { Diagnostic } from "./preprocessor";

/** Base URL of the compile server (no trailing slash), or null. */
export const COMPILE_SERVER_URL: string | null = (() => {
  const raw = import.meta.env.VITE_COMPILE_SERVER_URL;
  if (!raw || typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().replace(/\/$/, "");
})();

export function isCompileServerAvailable(): boolean {
  return COMPILE_SERVER_URL !== null;
}

export interface CompileFile {
  name: string;
  content: string;
}

export interface CompileResult {
  ok: boolean;
  /** Complete MacBinary bytes on success. */
  bytes?: Uint8Array;
  /** Structured diagnostics for CodeMirror markers (on failure). */
  diagnostics: Diagnostic[];
  /** Raw stderr from the compiler, capped at 8 KB. */
  rawStderr?: string;
}

/**
 * Send source files to the compile server. Only `.c` and `.h` files are
 * forwarded; `.r` and other files are silently excluded.
 *
 * Throws on network errors or unexpected server responses (non-JSON, HTTP 5xx).
 * A structured compile failure (syntax error, linker error) is returned as
 * `{ ok: false, diagnostics: [...] }` — the caller shows error markers.
 */
export async function compileProject(
  files: CompileFile[],
  appName: string,
): Promise<CompileResult> {
  if (!COMPILE_SERVER_URL) {
    throw new Error(
      "Compile server not configured (VITE_COMPILE_SERVER_URL is not set).",
    );
  }

  const cAndH = files.filter((f) => /\.(c|h)$/i.test(f.name));
  if (cAndH.length === 0) {
    throw new Error("No .c or .h files to compile.");
  }

  let resp: Response;
  try {
    resp = await fetch(`${COMPILE_SERVER_URL}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: cAndH, appName }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new Error("Compile request timed out (server took > 90 seconds).");
    }
    throw new Error(
      `Cannot reach compile server: ${err.message}. ` +
        `Is it running at ${COMPILE_SERVER_URL}?`,
    );
  }

  if (resp.status === 429) {
    throw new Error(
      "Rate limit reached. Please wait a minute before compiling again.",
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Compile server returned HTTP ${resp.status}: ${text.slice(0, 300)}`,
    );
  }

  const json = await resp.json();

  if (!json.ok) {
    const diagnostics: Diagnostic[] = (json.errors ?? []).map(
      (e: {
        file: string;
        line: number;
        column: number;
        message: string;
        severity: string;
      }) => ({
        file: e.file,
        line: e.line,
        column: e.column,
        message: e.message,
        severity: e.severity === "warning" ? "warning" : "error",
      }),
    );
    return { ok: false, diagnostics, rawStderr: json.rawStderr };
  }

  if (!json.binary) {
    throw new Error("Compile server returned ok=true but no binary.");
  }

  return {
    ok: true,
    bytes: base64ToUint8Array(json.binary),
    diagnostics: [],
  };
}

function base64ToUint8Array(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}
