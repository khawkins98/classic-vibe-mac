/**
 * vision-assert.ts — natural-language screenshot assertions via Claude.
 *
 * Why this exists:
 *   The classic Mac app runs inside a BasiliskII WASM emulator, which renders
 *   to a <canvas>. Playwright (or any DOM-based tooling) can't see *into*
 *   that canvas. Pixel-diff snapshot testing is the obvious next idea, but
 *   it fails on emulator timing variance — even one frame of cursor blink
 *   or a slightly-different boot sequence will flake the test.
 *
 *   A vision LLM is the right tool for this job: it can answer semantic
 *   questions like "is there a window titled 'Reader' in this image?"
 *   without caring about exact pixel positions.
 *
 * Cost / speed note:
 *   We use claude-haiku-4-5 (the fastest, cheapest model) deliberately. These
 *   tests should be cheap enough to run on every PR without anyone
 *   complaining. If Haiku ever struggles with a specific assertion, escalate
 *   to Sonnet for that one assertion only.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";

/** Result of a vision assertion. Always has reasoning, even on failure. */
export interface VisionAssertResult {
  pass: boolean;
  reasoning: string;
  /** The raw model response text, in case the caller wants to log it. */
  raw: string;
}

const VISION_MODEL = "claude-haiku-4-5-20251001";

/** True when the env has a usable API key. Useful for skip-gating tests. */
export function hasVisionApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Map a file extension to a media type Claude accepts. */
function mediaTypeFor(filePath: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      throw new Error(`unsupported image extension: ${ext}`);
  }
}

/**
 * Assert that a screenshot satisfies a natural-language claim.
 *
 * Example:
 *   const r = await visionAssert(
 *     "test-results/boot.png",
 *     "the screen shows a System 7 desktop with a window titled 'Reader'"
 *   );
 *   expect(r.pass, r.reasoning).toBe(true);
 *
 * The model is prompted to respond with strict JSON so we can parse pass/fail
 * deterministically. If parsing fails we treat that as a test failure with
 * the raw response in the reasoning, so debugging is easy.
 */
export async function visionAssert(
  screenshotPath: string,
  assertion: string,
): Promise<VisionAssertResult> {
  if (!hasVisionApiKey()) {
    throw new Error(
      "ANTHROPIC_API_KEY not set — gate vision tests with hasVisionApiKey().",
    );
  }
  if (!fs.existsSync(screenshotPath)) {
    throw new Error(`screenshot not found: ${screenshotPath}`);
  }

  const imageData = fs.readFileSync(screenshotPath).toString("base64");
  const client = new Anthropic();

  const response = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 512,
    system:
      "You are a strict visual-assertion judge for an automated test suite. " +
      "You are shown one screenshot and one assertion. Decide whether the " +
      "assertion is TRUE for the screenshot. Be literal and conservative — " +
      "if you cannot clearly see the claimed thing, the answer is false. " +
      'Respond with ONLY a JSON object of the form ' +
      '{"pass": boolean, "reasoning": string}. No prose, no markdown fences.',
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaTypeFor(screenshotPath),
              data: imageData,
            },
          },
          {
            type: "text",
            text: `Assertion: ${assertion}`,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  try {
    // Be forgiving: strip code fences if the model adds them anyway.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as { pass: boolean; reasoning: string };
    return { pass: !!parsed.pass, reasoning: parsed.reasoning ?? "", raw };
  } catch (err) {
    return {
      pass: false,
      reasoning: `failed to parse model response as JSON: ${(err as Error).message}`,
      raw,
    };
  }
}
