/**
 * drawing-watcher.ts — poll PixelPad's saved bitmap and render it live.
 *
 * Architecture (mirrors shared-poller.ts):
 *   - Runs on the **main thread**. Every 2 seconds, posts `poll_drawing`
 *     to the emulator worker; the worker reads /Shared/__drawing.bin from
 *     the Emscripten FS and replies with `drawing_data`.
 *   - On first non-null reply, injects a `<section class="window">` below
 *     the Macintosh emulator section and paints the 64×64 1-bit bitmap
 *     onto an HTML `<canvas>`, scaled 3× (192×192 px) for readability.
 *   - Subsequent replies repaint the canvas in place; the section stays
 *     visible until the page unloads.
 *
 * Canvas encoding (from pixelpad.c):
 *   gPixels[512] — 64 rows × 8 bytes/row.
 *   Each byte holds 8 pixels, MSB-first: bit 7 of byte 0 = pixel (0,0).
 *   Bit 1 = black; bit 0 = white.
 *
 * Worker message protocol:
 *   main → worker: { type: "poll_drawing" }
 *   worker → main: { type: "drawing_data"; bytes: Uint8Array | null }
 *   (types declared in emulator-worker-types.ts)
 */

import { createPollingWatcher } from "./pollingWatcher";

export interface DrawingWatcherConfig {
  /** The BasiliskII worker (already running). */
  worker: Worker;
  /** Poll interval in ms. Default: 2000. */
  intervalMs?: number;
}

const CANVAS_W = 64;
const CANVAS_H = 64;
const DISPLAY_SCALE = 3; // 64×3 = 192 px display size

/**
 * Decode 512-byte MSB-first 1-bit bitmap → RGBA ImageData.
 * Bit 1 = black (0,0,0,255); bit 0 = white (255,255,255,255).
 */
function decodeToImageData(bytes: Uint8Array): ImageData {
  const img = new ImageData(CANVAS_W, CANVAS_H);
  const d = img.data;
  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      const byteIdx = y * 8 + Math.floor(x / 8);
      const bitPos = 7 - (x % 8);
      const black = (bytes[byteIdx] >> bitPos) & 1;
      const base = (y * CANVAS_W + x) * 4;
      const v = black ? 0 : 255;
      d[base] = v;
      d[base + 1] = v;
      d[base + 2] = v;
      d[base + 3] = 255;
    }
  }
  return img;
}

/**
 * Build and inject the drawing preview section into the page.
 * Appended after the first `.window` section in the left pane so it
 * sits below the Macintosh emulator window.
 */
function buildPreviewSection(): {
  section: HTMLElement;
  canvas: HTMLCanvasElement;
} {
  const section = document.createElement("section");
  section.className = "window";
  section.setAttribute("aria-labelledby", "title-drawing");
  section.style.display = "none"; // hidden until first drawing arrives

  const header = document.createElement("header");
  header.className = "window__titlebar";
  const closeSpan = document.createElement("span");
  closeSpan.className = "window__close";
  closeSpan.setAttribute("aria-hidden", "true");
  const h2 = document.createElement("h2");
  h2.className = "window__title";
  h2.id = "title-drawing";
  h2.textContent = "Pixel Pad — live drawing";
  header.appendChild(closeSpan);
  header.appendChild(h2);

  const body = document.createElement("div");
  body.className = "window__body";
  body.style.padding = "8px";

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W * DISPLAY_SCALE;
  canvas.height = CANVAS_H * DISPLAY_SCALE;
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  canvas.setAttribute("aria-label", "Live view of the Pixel Pad drawing");

  const caption = document.createElement("p");
  caption.style.margin = "4px 0 0";
  caption.style.fontSize = "11px";
  caption.style.color = "#555";
  caption.textContent = "The user just drew this on the classic Mac.";

  body.appendChild(canvas);
  body.appendChild(caption);
  section.appendChild(header);
  section.appendChild(body);

  // Inject the Pixel Pad preview alongside the Mac (top-right cell in the
  // #104 IDE grid). The user just drew on the Mac; the preview belongs
  // visually next to the source.
  const macPane = document.querySelector(".cvm-ide__mac");
  if (macPane) {
    macPane.appendChild(section);
  } else {
    document.body.appendChild(section);
  }

  return { section, canvas };
}

/**
 * Render bytes onto the preview canvas (3× scaled via a temp offscreen
 * canvas, then drawImage to scale up with no blurring).
 */
function render(bytes: Uint8Array, canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const img = decodeToImageData(bytes);

  // Paint into a 64×64 offscreen canvas first.
  const offscreen = document.createElement("canvas");
  offscreen.width = CANVAS_W;
  offscreen.height = CANVAS_H;
  const octx = offscreen.getContext("2d");
  if (!octx) return;
  octx.putImageData(img, 0, 0);

  // Scale up with pixelated rendering.
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    offscreen,
    0,
    0,
    CANVAS_W * DISPLAY_SCALE,
    CANVAS_H * DISPLAY_SCALE,
  );
  ctx.restore();
}

/**
 * Start the drawing watcher. Returns a stop() function.
 *
 * Polls `poll_drawing` on a 2 s interval (fires immediately on start
 * so we pick up any drawing saved before the page loaded). The first
 * non-empty reply lazily builds the preview section; subsequent
 * replies repaint in place.
 */
export function startDrawingWatcher(cfg: DrawingWatcherConfig): () => void {
  let section: HTMLElement | null = null;
  let previewCanvas: HTMLCanvasElement | null = null;

  return createPollingWatcher<{ type: "drawing_data"; bytes: Uint8Array | null }>({
    worker: cfg.worker,
    buildPollMessage: () => ({ type: "poll_drawing" }),
    replyType: "drawing_data",
    intervalMs: cfg.intervalMs ?? 2000,
    onReply: ({ bytes }) => {
      if (!bytes || bytes.length !== 512) return;
      if (!section) {
        ({ section, canvas: previewCanvas } = buildPreviewSection());
      }
      render(bytes, previewCanvas!);
      section.style.display = ""; // show (was hidden)
    },
  });
}
