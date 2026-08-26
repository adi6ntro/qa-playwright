import type { Page } from '@playwright/test';

/**
 * Real selectors below were extracted directly from the app's source, not
 * guessed:
 *   - resources/views/front/customer/facilityOnboarding/step-ai-instruction.blade.php
 *   - public/js/facility/ai-instruction.js
 *   - resources/views/front/customer/myClinic/social-media.blade.php (wizard shell)
 *
 * Wizard navigation (social-media.blade.php:2870-3002), confirmed by reading
 * the actual inline script, not guessed:
 *   - `stepHashes = ['social-media','facility-info','ai-instruction','pricing-promotion']`;
 *     `initialHash` is read from `window.location.hash` SYNCHRONOUSLY when this
 *     script runs, and `showStep(currentStep)` is called unconditionally at the
 *     very end of the same script (line 3002) — so loading the URL directly
 *     with `#ai-instruction` already in it should land on step 3 with no click
 *     needed, as long as this script runs after the step-3 markup
 *     (`@include('front.customer.facilityOnboarding.step-ai-instruction')`,
 *     included earlier in the same blade file) is already in the DOM, which it is.
 *   - If that doesn't hold for some reason, the real fallback is a click, not a
 *     JS function call: on desktop (`window.innerWidth > 800`),
 *     `renderStepIndicators()` (line 2938-2950) creates one `<div class="wizard-tab">`
 *     per step inside `#wizardSteps`, `.textContent` = the step's `caption`.
 *     For index 2 specifically the caption is a HARDCODED literal string
 *     `"AI Instruction"` (line 2873) — not translated via `$translation[...]`
 *     like the other 3 steps — so this selector is stable across languages.
 *     Each tab has a plain `click` listener → `showStep(idx)`.
 */

export const SEL = {
  chatInput: '#fo-ai-chat-input',
  sendBtn: '#fo-ai-send-btn',
  messages: '#fo-ai-messages',
  mahaBubble: '.fo-bubble-row.fo-maha .fo-bubble-maha',
  userBubble: '.fo-bubble-row.fo-user .fo-bubble-user',
  instrList: '#fo-ai-instr-list',
  instrCount: '#fo-ai-instr-count',
  instrRow: (id: string) => `#fo-irow-${id}`,
  instrText: (id: string) => `#fo-itxt-${id}`,
  demoBadge: '#fo-ai-demo-badge',
  addPanel: '#fo-ai-add-panel',
  addTextarea: '#fo-ai-add-textarea',
  previewBtn: '#fo-ai-preview-btn',
  confirmBar: '#fo-ai-confirm-bar',
  agreeBtn: '#fo-ai-agree-btn',
};

/**
 * Transient network failures that are worth one more attempt — they say nothing
 * about the app under test. Live-hit 2026-08-26: a momentary DNS blip raised
 * `net::ERR_NAME_NOT_RESOLVED` for dev.reporty.sa inside the worker-scoped
 * `sharedPage` fixture, which aborted the ENTIRE spec ("2 did not run") — an
 * expensive way to lose a 3-run batch to something that resolved fine seconds
 * later (verified: dig returned 34.166.227.154, curl returned 200).
 *
 * Deliberately narrow: only these connection-level codes retry. An HTTP error,
 * a redirect to /login, or a missing selector must still fail immediately —
 * those are real findings, and retrying them would just hide them.
 */
const TRANSIENT_NAV_ERRORS = [
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_CLOSED',
  'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_TIMED_OUT',
];

async function gotoWithNetworkRetry(page: Page, url: string, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url);
      return;
    } catch (err) {
      const msg = (err as Error).message || '';
      const transient = TRANSIENT_NAV_ERRORS.some((code) => msg.includes(code));
      if (!transient || attempt >= attempts) throw err;
      const backoffMs = attempt * 5_000;
      console.warn(
        `[gotoWithNetworkRetry] transient network error on attempt ${attempt}/${attempts} ` +
          `for ${url} — retrying in ${backoffMs / 1000}s. (${msg.split('\n')[0]})`
      );
      await page.waitForTimeout(backoffMs);
    }
  }
}

export async function gotoAiInstructionStep(page: Page): Promise<void> {
  // Ensure the desktop "pill tabs" wizard renders (not the <=800px mobile
  // dropdown variant) so the Strategy 2 fallback's selector is guaranteed to
  // apply if needed — see renderStepIndicators() in social-media.blade.php.
  const viewport = page.viewportSize();
  if (!viewport || viewport.width <= 800) {
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  // Strategy 1: direct hash load. Per the wizard script (see file header
  // comment), this should just work — no click needed.
  await gotoWithNetworkRetry(page, '/customer/my-clinic#ai-instruction');
  if (await page.locator(SEL.chatInput).isVisible().catch(() => false)) return;

  // Strategy 2: click the real step-3 tab. Caption is the hardcoded literal
  // "AI Instruction" (social-media.blade.php:2873), not translated — stable
  // regardless of the account's language setting.
  await page
    .locator('#wizardSteps .wizard-tab', { hasText: 'AI Instruction' })
    .click()
    .catch(() => {});

  // 2026-08-07: bumped from 15_000 — live-reproduced 3x in a row that the step
  // DOES correctly show (click handler fires, chat input + Maha's initial
  // greeting end up fully rendered, confirmed via the failure's own page
  // snapshot at the outer 90s fixture timeout), just not within 15s. The
  // wizard's first paint depends on the same real handle_message() round trip
  // documented elsewhere in this harness as taking up to ~45s (see
  // playwright.config.ts's own timeout comment) — 15s was simply never enough
  // headroom for that, independent of session/auth freshness (ruled out by
  // re-running immediately after a fresh login-setup, same failure each time).
  const gotThere = await page
    .locator(SEL.chatInput)
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => true)
    .catch(() => false);

  if (!gotThere) {
    throw new Error(
      'Could not reach the AI Instruction wizard step (#fo-ai-chat-input never became visible), ' +
      'even after clicking the "AI Instruction" wizard tab (#wizardSteps .wizard-tab). Either the ' +
      'markup changed since this was written (re-check social-media.blade.php:2870-3002), or the ' +
      'account landed on an unexpected page (e.g. a relogin prompt swallowed the navigation — check ' +
      'auth/.storage-state.json is still fresh, re-run `npm run login-setup` if unsure).'
    );
  }
}

export interface MahaReply {
  text: string;
  bubbleIndex: number; // 0-based index among maha bubbles at the time of this reply
}

async function mahaBubbleCount(page: Page): Promise<number> {
  return page.locator(SEL.mahaBubble).count();
}

/**
 * Waits for a locator's innerText to stop changing for `stableForMs`, polling
 * every `pollMs`. Needed because the real UI appears to render the reply
 * progressively (confirmed empirically: reading immediately after the bubble
 * element first appears captured a bare "…" placeholder, not the final text,
 * across an entire test run) rather than swapping in finished text atomically.
 */
async function waitForStableText(
  locator: import('@playwright/test').Locator,
  opts: { timeoutMs: number; stableForMs?: number; pollMs?: number }
): Promise<string> {
  const stableForMs = opts.stableForMs ?? 900;
  const pollMs = opts.pollMs ?? 300;
  const deadline = Date.now() + opts.timeoutMs;

  let lastText = await locator.innerText().catch(() => '');
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const current = await locator.innerText().catch(() => '');
    if (current !== lastText) {
      lastText = current;
      stableSince = Date.now();
      continue;
    }
    // Ignore bare placeholder/ellipsis text — never treat it as "stable final text".
    const isPlaceholder = /^[.…\s]*$/.test(current);
    if (!isPlaceholder && Date.now() - stableSince >= stableForMs) {
      return current.trim();
    }
  }
  return lastText.trim(); // timed out — return whatever we last saw, caller can judge
}

/**
 * Sends one chat message and waits for exactly one new, fully-rendered Maha
 * reply bubble.
 *
 * Empirically found (first live run) that `#fo-ai-send-btn` can briefly stay
 * `disabled` right after `.fill()` — likely the app enables it off an
 * `input`/`keyup` listener that hasn't caught up to the just-set value yet —
 * causing `.click()` to retry against a disabled button until it times out.
 * Waiting for `disabled` to clear before clicking fixes this at the actual
 * failure point. (A prior attempt at fixing this also added a wait for the
 * button to RE-disable-then-enable AFTER the reply, on the theory it stays
 * disabled while the request is in-flight server-side — that was wrong and
 * cost 20-40s of pure dead time per call for no benefit; removed.)
 */
export async function sendMessage(page: Page, message: string, timeoutMs = 45_000): Promise<MahaReply> {
  const before = await mahaBubbleCount(page);
  await page.locator(SEL.chatInput).fill(message);
  await page.waitForFunction(
    (sel) => !(document.querySelector(sel) as HTMLButtonElement | null)?.disabled,
    SEL.sendBtn,
    { timeout: 10_000 }
  ).catch(() => {}); // best-effort — if it's disabled for an unrelated reason, let the click below surface that clearly
  await page.locator(SEL.sendBtn).click();

  const startWait = Date.now();
  await page.waitForFunction(
    (args) => {
      const nodes = document.querySelectorAll(args.sel);
      return nodes.length > args.before;
    },
    { sel: SEL.mahaBubble, before },
    { timeout: timeoutMs }
  );
  const elapsedOnAppear = Date.now() - startWait;
  const remainingTimeout = Math.max(5_000, timeoutMs - elapsedOnAppear);

  const bubbles = page.locator(SEL.mahaBubble);
  const count = await bubbles.count();
  const text = await waitForStableText(bubbles.nth(count - 1), { timeoutMs: remainingTimeout });

  return { text, bubbleIndex: count - 1 };
}

/**
 * Sends a message; if the reply looks like a yes/no confirmation prompt
 * (contains an Arabic question mark and no success checkmark), automatically
 * replies with confirmPhrase, up to maxConfirms times. This mirrors the
 * runbook's own instruction ("If Maha proposes and asks for confirmation,
 * reply تمام احفظيها") and is deliberately generous with retries — real prod
 * logs showed the confirm-identity-mismatch bug (see
 * project_ob3_prod_audit_2026-08-03.md, item 3) can take 2-4 rounds to
 * actually go through even when nothing is wrong on the user's end. The
 * retry COUNT this function needed is itself useful QA signal — log it.
 */
export async function sendAndConfirm(
  page: Page,
  message: string,
  opts: { confirmPhrase?: string; maxConfirms?: number } = {}
): Promise<{ replies: MahaReply[]; confirmRoundsNeeded: number }> {
  const confirmPhrase = opts.confirmPhrase ?? process.env.CONFIRM_PHRASE ?? 'نعم';
  const maxConfirms = opts.maxConfirms ?? 4;

  const replies: MahaReply[] = [];
  let reply = await sendMessage(page, message);
  replies.push(reply);

  let rounds = 0;
  while (looksLikeConfirmationPrompt(reply.text) && rounds < maxConfirms) {
    rounds += 1;
    reply = await sendMessage(page, confirmPhrase);
    replies.push(reply);
  }

  return { replies, confirmRoundsNeeded: rounds };
}

function looksLikeConfirmationPrompt(text: string): boolean {
  const hasQuestionMark = text.includes('؟') || text.includes('?');
  const looksDone = text.includes('✅') || text.includes('تم ');
  return hasQuestionMark && !looksDone;
}

export interface InstructionRow {
  id: string;
  text: string;
  position: string | null;
}

export interface InstructionPanelState {
  count: number | null; // parsed from "{n} Active"; null if badge text didn't parse
  rows: InstructionRow[];
}

export async function getInstructionPanelState(page: Page): Promise<InstructionPanelState> {
  const countText = await page.locator(SEL.instrCount).innerText().catch(() => '');
  const match = countText.match(/(\d+)/);
  const count = match ? parseInt(match[1], 10) : null;

  const rows = await page.locator(`${SEL.instrList} [id^="fo-irow-"]`).evaluateAll((els) =>
    els.map((el) => {
      const id = (el.id || '').replace(/^fo-irow-/, '');
      const textEl = el.querySelector('[id^="fo-itxt-"]');
      const posEl = el.querySelector('.fo-instr-pos');
      return {
        id,
        text: (textEl?.textContent || '').trim(),
        position: posEl ? (posEl.textContent || '').trim() : null,
      };
    })
  );

  return { count, rows };
}

/** Reloads the page and re-navigates to the AI Instruction step — used for persistence checks. */
export async function refreshAndReturnToStep(page: Page): Promise<InstructionPanelState> {
  await page.reload().catch(async (err) => {
    // Same transient-network reasoning as gotoWithNetworkRetry above; a reload
    // that blips shouldn't lose the persistence check it was about to make.
    if (!TRANSIENT_NAV_ERRORS.some((c) => ((err as Error).message || '').includes(c))) throw err;
    await page.waitForTimeout(5_000);
    await page.reload();
  });
  await gotoAiInstructionStep(page);
  // the panel polls every 4s per ai-instruction.js — give it one cycle
  await page.waitForTimeout(4_500);
  return getInstructionPanelState(page);
}
