/**
 * tryThisNextCard.ts — surface a "Try this next" prompt after a
 * successful Build & Run.
 *
 * Closes the loop between "the app worked" and "now what?" — without
 * this, a successful build is a dead-end; the user sees their app boot
 * and then…nothing. A 12-second auto-dismissing card with one concrete
 * experiment converts every successful build into a tutorial step.
 *
 * The prompt set comes from SampleProject.tryNext (curated content in
 * types.ts). We cycle through the project's prompts on each successful
 * build, tracking the rotation via localStorage so repeat-builds in a
 * session and across sessions both advance.
 *
 * UX shape:
 *   - Card slides up from the bottom of the Playground pane.
 *   - "💡 Try this next: <prompt>" + a "Try this" button that opens
 *     the file/line if specified, otherwise just dismisses the card.
 *   - × close button. Auto-dismiss after AUTO_HIDE_MS.
 *   - "Don't show again for this project" toggle in the card (per-
 *     project localStorage flag).
 *
 * Non-goals:
 *   - This is not a tutorial framework — no progress tracking, no
 *     achievements. Just a "here's an idea" prod between builds.
 *   - Not surfaced for projects without tryNext entries (no nag for
 *     bare-bones samples).
 */

import type { SampleProject, TryNextPrompt } from "./types";

const ROOT_ID = "cvm-try-next-card";
const ROTATION_KEY = (projectId: string) => `cvm-try-next:rot:${projectId}`;
const DISMISSED_KEY = (projectId: string) =>
  `cvm-try-next:dismissed:${projectId}`;
const AUTO_HIDE_MS = 12_000;

interface ShowOptions {
  /** Optional callback for the "Try this" jump — receives the file +
   *  line from the prompt. The editor's switchTo + scroll plumbing
   *  lives upstream, so we delegate. */
  onJump?: (file: string | undefined, line: number | undefined) => void;
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;

/** Surface a try-next card for `project`. No-op if the project has no
 *  prompts or has been dismissed for keeps. */
export function showTryThisNext(
  project: SampleProject,
  opts: ShowOptions = {},
): void {
  const prompts = project.tryNext;
  if (!prompts || prompts.length === 0) return;
  if (isDismissedForProject(project.id)) return;

  const idx = nextRotationIndex(project.id, prompts.length);
  const prompt = prompts[idx]!;
  renderCard(project, prompt, idx, opts);
}

/** Hide any visible card. Called when the user navigates away from the
 *  project, or before a new card is shown. */
export function hideTryThisNext(): void {
  document.getElementById(ROOT_ID)?.remove();
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

// ── Rotation ────────────────────────────────────────────────────────

function nextRotationIndex(projectId: string, total: number): number {
  let last = -1;
  try {
    const raw = localStorage.getItem(ROTATION_KEY(projectId));
    if (raw !== null) last = parseInt(raw, 10);
    if (!Number.isFinite(last)) last = -1;
  } catch {
    /* private browsing — fall back to "always show prompt 0" */
  }
  const next = (last + 1) % total;
  try {
    localStorage.setItem(ROTATION_KEY(projectId), String(next));
  } catch {
    /* ignore */
  }
  return next;
}

function isDismissedForProject(projectId: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY(projectId)) === "1";
  } catch {
    return false;
  }
}

function markDismissedForProject(projectId: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY(projectId), "1");
  } catch {
    /* ignore */
  }
}

// ── Rendering ───────────────────────────────────────────────────────

function renderCard(
  project: SampleProject,
  prompt: TryNextPrompt,
  index: number,
  opts: ShowOptions,
): void {
  hideTryThisNext();

  // Mount inside the Playground pane root so the card slides up from
  // the right place visually. Fall back to body if that root isn't
  // present (test harness etc.).
  const mountTarget =
    document.getElementById("cvm-playground") ?? document.body;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.className = "cvm-try-next";
  root.setAttribute("role", "status");

  const total = project.tryNext!.length;

  const icon = document.createElement("span");
  icon.className = "cvm-try-next__icon";
  icon.textContent = "💡";

  const body = document.createElement("div");
  body.className = "cvm-try-next__body";

  const heading = document.createElement("div");
  heading.className = "cvm-try-next__heading";
  heading.textContent =
    total > 1
      ? `Try this next  (${index + 1}/${total})`
      : "Try this next";
  body.append(heading);

  const text = document.createElement("div");
  text.className = "cvm-try-next__text";
  text.textContent = prompt.prompt;
  body.append(text);

  const actions = document.createElement("div");
  actions.className = "cvm-try-next__actions";

  const tryBtn = document.createElement("button");
  tryBtn.type = "button";
  tryBtn.className = "cvm-try-next__btn cvm-try-next__btn--primary";
  tryBtn.textContent = "Take me there";
  tryBtn.addEventListener("click", () => {
    opts.onJump?.(prompt.file, prompt.line);
    hideTryThisNext();
  });
  actions.append(tryBtn);

  const dismissProjectBtn = document.createElement("button");
  dismissProjectBtn.type = "button";
  dismissProjectBtn.className = "cvm-try-next__btn";
  dismissProjectBtn.textContent = "Don't show for this sample";
  dismissProjectBtn.addEventListener("click", () => {
    markDismissedForProject(project.id);
    hideTryThisNext();
  });
  actions.append(dismissProjectBtn);

  body.append(actions);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "cvm-try-next__close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => hideTryThisNext());

  root.append(icon, body, close);
  mountTarget.append(root);

  // Auto-dismiss. Mouse-enter cancels the timer so the user gets to
  // read longer prompts; mouse-leave re-arms it.
  scheduleAutoHide();
  root.addEventListener("mouseenter", () => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  root.addEventListener("mouseleave", scheduleAutoHide);
}

function scheduleAutoHide(): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTryThisNext();
  }, AUTO_HIDE_MS);
}
