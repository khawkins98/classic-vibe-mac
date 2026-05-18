/**
 * shareLink.ts — encode / decode the playground's current state as a
 * shareable URL.
 *
 * URL shape:
 *   <playground-base>?p=<projectId>&f=<filename>[&c=<base64url-gzip>]
 *
 *   p — sample / user project id. Required for a load-from-link.
 *   f — file within that project. Optional; falls back to the project's
 *       first file.
 *   c — base64url-encoded gzip of the file's UTF-8 content. Optional;
 *       when present, the loaded file is seeded with this content
 *       instead of the in-repo / IDB version. Lets users share their
 *       edited snake.c, not just "the snake.c sample."
 *
 * Encoding choices:
 *   - **gzip + base64url** (no `+/=`) so the value survives URL bars
 *     and copy-paste without escaping. CompressionStream is widely
 *     supported (Chrome 80+, FF 113+, Safari 16.4+) — older browsers
 *     fall back to uncompressed base64 (~30% longer URLs but still
 *     load).
 *   - **Hard cap at ~8 KB** total URL. C files typical of cv-mac
 *     samples (≤16 KB raw) compress to ~3-5 KB after gzip+base64,
 *     leaving headroom for project/filename. Beyond that we refuse
 *     to mint a content URL and the share button surfaces a hint
 *     ("file too big — paste to a gist") — better than minting a
 *     link that quietly drops in transit.
 */

const URL_PARAM_PROJECT = "p";
const URL_PARAM_FILENAME = "f";
const URL_PARAM_CONTENT = "c";
const MAX_SHARE_URL_BYTES = 8000;

export interface ShareTarget {
  projectId: string;
  filename?: string;
  /** Decoded UTF-8 file content. Present iff the URL carried `c=`. */
  content?: string;
}

/** Parse the current location's query string. Returns `null` if no
 *  share params are present. Errors during content decoding fall back
 *  to "project + filename only" rather than blowing up the load. */
export async function parseShareUrl(
  search: string = window.location.search,
): Promise<ShareTarget | null> {
  const params = new URLSearchParams(search);
  const projectId = params.get(URL_PARAM_PROJECT);
  if (!projectId) return null;
  const filename = params.get(URL_PARAM_FILENAME) ?? undefined;
  const encoded = params.get(URL_PARAM_CONTENT);
  if (!encoded) return { projectId, filename };
  try {
    const content = await decodeContent(encoded);
    return { projectId, filename, content };
  } catch (err) {
    console.warn("[share] failed to decode ?c= payload — loading without:", err);
    return { projectId, filename };
  }
}

export interface BuildShareUrlResult {
  url: string;
  /** True when content was dropped because the encoded URL exceeded
   *  MAX_SHARE_URL_BYTES. The caller can surface this to the user
   *  ("link too big — sharing project pointer only"). */
  truncated: boolean;
}

/** Build a shareable URL for the given project / filename / content.
 *  If `content` would push the URL over MAX_SHARE_URL_BYTES, the
 *  content is dropped and `truncated: true` is returned. */
export async function buildShareUrl(
  projectId: string,
  filename: string | undefined,
  content: string | undefined,
  base: string = window.location.origin + window.location.pathname,
): Promise<BuildShareUrlResult> {
  const params = new URLSearchParams();
  params.set(URL_PARAM_PROJECT, projectId);
  if (filename) params.set(URL_PARAM_FILENAME, filename);
  const withoutContent = `${base}?${params.toString()}`;
  if (!content) return { url: withoutContent, truncated: false };
  const encoded = await encodeContent(content);
  params.set(URL_PARAM_CONTENT, encoded);
  const full = `${base}?${params.toString()}`;
  if (full.length > MAX_SHARE_URL_BYTES) {
    return { url: withoutContent, truncated: true };
  }
  return { url: full, truncated: false };
}

// ── Codec ────────────────────────────────────────────────────────────

async function encodeContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const gz = await maybeGzip(bytes);
  return base64UrlEncode(gz);
}

async function decodeContent(encoded: string): Promise<string> {
  const gz = base64UrlDecode(encoded);
  const bytes = await maybeGunzip(gz);
  return new TextDecoder().decode(bytes);
}

async function maybeGzip(bytes: Uint8Array): Promise<Uint8Array> {
  // CompressionStream isn't typed in lib.dom.d.ts in all toolchains.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Cs: any = (globalThis as any).CompressionStream;
  if (typeof Cs !== "function") return bytes; // older browser — uncompressed fallback
  const cs = new Cs("gzip");
  const blob = new Blob([bytes as BlobPart]);
  const compressed = await new Response(blob.stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(compressed);
}

async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Same caveat: try the API, fall back to passing through (the encoder
  // would also have skipped gzip in that case).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ds: any = (globalThis as any).DecompressionStream;
  if (typeof Ds !== "function") return bytes;
  const ds = new Ds("gzip");
  const blob = new Blob([bytes as BlobPart]);
  try {
    const out = await new Response(blob.stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
  } catch {
    // If decompression fails the payload was likely encoded by an
    // older browser without CompressionStream — return as-is and let
    // the TextDecoder layer figure it out.
    return bytes;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  // Chunked to dodge call-stack limits on very large arrays.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  // atob is happy without padding but some implementations are picky.
  const padding = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const bin = atob(padded + "=".repeat(padding));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
