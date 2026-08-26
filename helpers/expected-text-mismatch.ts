import type { Page } from '@playwright/test';
import {
  sendMessage,
  sendAndConfirm,
  getInstructionPanelState,
  gotoAiInstructionStep,
} from './maha-chat';
import { deleteMarkerUntilGone } from './bug005-probe';

/**
 * Probe for the `expected_text_mismatch` dead end — root-caused 2026-08-26 from
 * prod clinic 2886's stored chat sessions (`reporty-onboard-phase3/2886/`,
 * sess-1787602994817 and sess-1787518391752) plus the prod pod logs of
 * namespace `reporty-onbrd3-ai-agent-api-prod`.
 *
 * QA reported it as "the assistant errors out and stops responding after 2+
 * interactions". The real mechanism:
 *
 *   1. The owner asks for the same rule to be re-worded several times in a row
 *      without ever confirming. Each turn Maha emits a NEW proposal that
 *      supersedes the previous one, so its idea of "the current wording" drifts
 *      onto its own latest unconfirmed draft.
 *   2. On the eventual "نعم", it calls update_instruction with
 *      expected_text = that draft. The tool correctly rejects it with
 *      {"error": "expected_text_mismatch", "actual_text": <the real stored text>}
 *      so the model can retry with the right value.
 *   3. `expected_text_mismatch` was missing from the orchestrator's
 *      _KNOWN_ERROR_SENTINELS, so _inv()'s sanitizer replaced the whole result —
 *      actual_text included — with a bare "tool_temporarily_unavailable". With
 *      the ground truth stripped out the model could not self-correct: every
 *      retry re-sent the same wrong expected_text until the confirm-retry budget
 *      was exhausted, and the owner got _TECHNICAL_FAILURE_AFFIRMED_TEXT.
 *
 * That is why it never fails on the first message of a session — it needs 2+
 * proposal turns to build the stale draft first. Any reproduction that just
 * sends one edit and confirms it will pass whether the bug is present or not.
 *
 * A browser can't read server logs, so the verdict here rests on the two things
 * a browser CAN see: the exact canned failure string, and whether the rule's
 * text in the panel actually changed after a hard refresh.
 */

/**
 * Server-canned reply templates, copied verbatim from
 * `reporty-onboard-phase3/inapp_agent/orchestrators/maha_inapp_agent.py`. These
 * are fixed strings the orchestrator substitutes for the model's own text, NOT
 * model output — so exact-substring matching is reliable here in a way it never
 * is for free-form replies. If a match stops working, diff against that file
 * first; the wording living in one place is the whole reason this is matchable.
 */
export const CANNED = {
  /** _TECHNICAL_FAILURE_AFFIRMED_TEXT — owner affirmed, every confirm retry failed. */
  technicalFailureAffirmed: 'واجهت مشكلة تقنية حالت دون تنفيذ الإجراء',
  /** _UNARMED_PROPOSAL_CORRECTION_TEXT — retries exhausted with nothing armed. */
  unarmedProposal: 'لم أتمكن من تجهيز هذا التغيير بشكل صحيح',
  /** _FABRICATED_ISSUE_REPROMPT_TEXT — "I didn't get a clear yes/no". */
  unclearAnswer: 'لم أستلم منك ردًا واضحًا بنعم أو لا',
} as const;

/**
 * Free-form "technical problem" wordings the MODEL itself improvises when a tool
 * error reaches it as an opaque failure. Weaker signal than CANNED (the model
 * phrases these differently every time, so this list can never be exhaustive) —
 * recorded as diagnostic context, never as the pass/fail verdict on its own.
 * All three were observed verbatim in the clinic 2886 sessions.
 */
export const MODEL_IMPROVISED_FAILURE = ['مشكلة تقنية', 'مشكلة فنية', 'خطأ فني'];

export interface ErrorMarkers {
  /** The hard signal: the orchestrator gave up after exhausting confirm retries. */
  technicalFailureAffirmed: boolean;
  unarmedProposal: boolean;
  unclearAnswer: boolean;
  /** Soft signal — the model improvised an apology; may or may not be this bug. */
  improvisedFailure: boolean;
  matched: string[];
}

export function classifyErrorMarkers(text: string): ErrorMarkers {
  const matched: string[] = [];
  const hit = (needle: string) => {
    const found = text.includes(needle);
    if (found) matched.push(needle);
    return found;
  };
  return {
    technicalFailureAffirmed: hit(CANNED.technicalFailureAffirmed),
    unarmedProposal: hit(CANNED.unarmedProposal),
    unclearAnswer: hit(CANNED.unclearAnswer),
    improvisedFailure: MODEL_IMPROVISED_FAILURE.some((n) => hit(n)),
    matched,
  };
}

/**
 * Arabic negation immediately before a success verb. Needed because the success
 * phrases below are SUBSTRINGS of their own negations: "تم حفظ" occurs inside
 * "لم يتم حفظه" ("was NOT saved"), and "تم تعديل" inside "لم يتم تعديله".
 *
 * Live-caught on the very first baseline run (2026-08-26, dev): Maha's turn-2
 * reply "أعتذر دكتور، يبدو أن التعديل الأخير لم يتم حفظه بالشكل الصحيح" — a
 * failure apology followed by a fresh proposal — was classified as a SAVE. That
 * ended the drift loop early and dropped the proposal count below the premise
 * threshold, which made ETM-1 skip itself while the bug was reproducing
 * perfectly in the same run. A negated success phrase is the single most likely
 * thing to appear in exactly the failure this suite hunts, so getting this wrong
 * silently disarms the test.
 *
 * The optional trailing [يتن] absorbs the imperfect prefix in "لم يتم ..." —
 * without it the character between the particle and the needle blocks the match.
 */
const NEGATION_BEFORE = /(لم|لن|ما|مش|بدون|غير)\s*[يتن]?$/;

/** True if `needle` appears at least once NOT preceded by a negation particle. */
function hasAffirmative(text: string, needle: string): boolean {
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    const window = text.slice(Math.max(0, idx - 12), idx);
    if (!NEGATION_BEFORE.test(window)) return true;
    idx = text.indexOf(needle, idx + 1);
  }
  return false;
}

/**
 * A reply that claims the write went through. `✅` is treated as affirmative on
 * its own — the orchestrator only emits it on a real success path, and it has
 * never been observed inside a negated sentence.
 */
export function looksSaved(text: string): boolean {
  return (
    text.includes('✅') ||
    hasAffirmative(text, 'تم تعديل') ||
    hasAffirmative(text, 'تم حفظ') ||
    hasAffirmative(text, 'تم إضافة')
  );
}

/** A reply that is asking for a yes/no rather than reporting an outcome. */
export function looksLikeProposal(text: string): boolean {
  return (text.includes('؟') || text.includes('?')) && !looksSaved(text);
}

/**
 * The FRONTEND's own transport-failure bubble (public/js/facility/ai-instruction.js,
 * `_foAiShowChatError`) — rendered by the fetch's `.catch()`, i.e. the browser never
 * got a reply. It is NOT a message from Maha and must never be read as one.
 *
 * Live-caught 2026-08-26 on dev: a turn whose confirm-retry loop ran long took ~90s
 * end to end (message at 05:33:05, agent reply at 05:34:35), which is past the
 * Laravel proxy's own timeout — so the browser showed this error while the agent
 * went on to complete `save_instruction` successfully server-side. Anything reading
 * this bubble as "Maha's reply" concludes the write failed when it actually
 * succeeded, which is exactly backwards.
 *
 * Note for anyone tempted to automate the app's own "Retry" chip: it RE-SENDS the
 * same message (`retryBtn.onclick` → `_foAiSendChatMsg(text, false)`). After a
 * timeout whose write already landed, that is a duplicate-write risk — which is why
 * the helpers below re-read ground truth instead of clicking it.
 */
export const FRONTEND_TRANSPORT_ERROR = "There's a technical issue, please try again.";

export function isTransportError(text: string): boolean {
  return text.includes(FRONTEND_TRANSPORT_ERROR);
}

/**
 * sendMessage with a ceiling high enough for a slow confirm-retry turn, and an
 * explicit transport-error flag so callers can tell "the agent said X" apart from
 * "the browser never heard back".
 */
export async function sendMessageTolerant(
  page: Page,
  message: string,
  timeoutMs = 150_000
): Promise<{ text: string; transportError: boolean }> {
  const reply = await sendMessage(page, message, timeoutMs);
  return { text: reply.text, transportError: isTransportError(reply.text) };
}

/**
 * Poll the panel (with a hard refresh each round) until `predicate` holds or the
 * budget runs out. Used after a transport error: the write may still be in flight
 * server-side, so "the browser saw an error" is not yet evidence it failed.
 */
export async function waitForPanelCondition(
  page: Page,
  predicate: (rows: { id: string; text: string }[]) => boolean,
  opts: { budgetMs?: number } = {}
): Promise<boolean> {
  const budgetMs = opts.budgetMs ?? 120_000;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const state = await readPanelAfterRefresh(page);
    if (predicate(state.rows)) return true;
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Plain timer, NOT `page.waitForTimeout`.
 *
 * Playwright ties `page.waitForTimeout` to the current runnable, so it throws
 * "page.waitForTimeout: Test ended." once the owning test has finished — which is
 * exactly when `test.afterAll` cleanup runs. Live-hit 2026-08-26: after ETM-1
 * failed, cleanup aborted on the very first wait and left the `[ETM_TEST_2026]`
 * rule behind on dev for the next run to trip over. A cleanup path must not use
 * any test-lifecycle-bound API.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Hard refresh → back to the wizard step → read the panel. Ground truth, no Maha. */
export async function readPanelAfterRefresh(page: Page) {
  await page.reload();
  await gotoAiInstructionStep(page);
  await sleep(6_000); // panel polls every 4s (ai-instruction.js)
  return getInstructionPanelState(page);
}

/** Current stored text of the single rule containing `marker`, or null. */
export async function readMarkerText(page: Page, marker: string): Promise<string | null> {
  const state = await getInstructionPanelState(page);
  const row = state.rows.find((r) => r.text.includes(marker));
  return row ? row.text : null;
}

/**
 * A handle on "the rule this test is editing", robust to Maha rewriting it out of
 * recognition.
 *
 * Why this is not just a marker substring (live-hit 2026-08-26, dev run 3): asked
 * to shorten the rule, Maha rewrote it and dropped the `[ETM_TEST_2026]` prefix
 * along with everything else it considered filler. The suite then couldn't find
 * its own rule, ETM-0 failed on a null lookup, and ETM-1/ETM-2 never ran — a test
 * defect reported as an app failure.
 *
 * Why it is not just the panel row id either: `fo-irow-<id>` renders `instr.id`,
 * which the API derives as a 1-BASED POSITION (see the tool logs and
 * update_instruction.py's own `idx = int(instruction_id) - 1`). It shifts the
 * moment any earlier rule is added or removed.
 *
 * So: prefer the marker while it survives, fall back to position — and only trust
 * the position while the panel's total count is unchanged, which is the condition
 * under which a position cannot have shifted.
 */
export interface TrackedRule {
  id: string;
  text: string;
  /** Panel count when this handle was (re)resolved — guards the positional fallback. */
  count: number | null;
}

export async function resolveTrackedRule(
  page: Page,
  marker: string,
  previous: TrackedRule | null
): Promise<TrackedRule | null> {
  const state = await getInstructionPanelState(page);

  const byMarker = state.rows.find((r) => r.text.includes(marker));
  if (byMarker) return { id: byMarker.id, text: byMarker.text, count: state.count };

  if (!previous) return null;

  // Marker gone — fall back to position, but only if nothing else changed the
  // list length since we last looked. If the count moved, a position may now
  // point at a DIFFERENT rule, and silently editing/asserting against the wrong
  // one is worse than admitting we lost track.
  if (previous.count !== null && state.count !== previous.count) {
    console.warn(
      `[resolveTrackedRule] marker "${marker}" is gone AND the panel count moved ` +
        `(${previous.count} -> ${state.count}) — refusing to guess by position.`
    );
    return null;
  }

  const byPosition = state.rows.find((r) => r.id === previous.id);
  if (!byPosition) return null;

  console.warn(
    `[resolveTrackedRule] marker "${marker}" was rewritten out of the rule; ` +
      `tracking by position id=${previous.id} instead (count unchanged at ${state.count}).`
  );
  return { id: byPosition.id, text: byPosition.text, count: state.count };
}

/**
 * Delete the tracked rule at cleanup time. `deleteMarkerUntilGone` alone is not
 * enough here for the same reason as above: once the marker has been rewritten
 * away, asking Maha to "delete the rule containing X" matches nothing and loops
 * until it gives up, leaving the row behind to poison the next run's baseline.
 */
export async function deleteTrackedRule(
  page: Page,
  marker: string,
  tracked: TrackedRule | null
): Promise<{ success: boolean; via: string }> {
  // Deliberately self-contained rather than delegating to bug005-probe's
  // deleteMarkerUntilGone: that helper waits via page.waitForTimeout, which
  // throws once the owning test has ended (see `sleep` above) — the exact reason
  // cleanup silently gave up and stranded the test rule on dev.
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const state = await getInstructionPanelState(page);
    const byMarker = state.rows.find((r) => r.text.includes(marker));
    const byPosition = tracked ? state.rows.find((r) => r.id === tracked.id) : undefined;
    const target = byMarker ?? (tracked && byPosition?.text === tracked.text ? byPosition : undefined);

    if (!target) {
      return { success: true, via: attempt === 1 ? 'already-gone' : `attempt:${attempt - 1}` };
    }

    const request = byMarker
      ? `احذفي القاعدة اللي فيها كلمة ${marker}`
      : `احذفي القاعدة رقم ${target.id}`;

    try {
      await sendAndConfirm(page, request);
    } catch (err) {
      return { success: false, via: `send-failed:${(err as Error).message.split('\n')[0]}` };
    }

    await sleep(attempt * 5_000);
    await page.reload().catch(() => {});
    await gotoAiInstructionStep(page).catch(() => {});
    await sleep(4_000);

    const after = await getInstructionPanelState(page);
    // Verify by the rule's own text being gone, not by the count dropping — a
    // count drop alone could mean some OTHER rule was removed.
    if (!after.rows.some((r) => r.text === target.text)) {
      return { success: true, via: byMarker ? `marker:${attempt}` : `position:${target.id}` };
    }
  }

  return { success: false, via: `exhausted:${attempts}` };
}


/**
 * Maha wraps rule wordings in Arabic guillemets — «...». Comparing the draft
 * turn-over-turn is the only way to tell a REAL supersede (a new draft, which is
 * what makes expected_text drift) from a turn that merely re-offers the draft
 * already pending.
 *
 * Takes the LAST block, not the first (fixed 2026-08-26 from a dev run): a reply
 * routinely carries TWO quoted blocks — the rule's CURRENT text followed by the
 * PROPOSED replacement, e.g.
 *
 *     القاعدة الحالية: «...old...»   هل تقصدين أعدّلها لتصبح: «...new...»
 *
 * Reading the first block therefore tracked the stored text (identical every
 * turn by definition, since nothing is being saved during the drift phase)
 * rather than the proposal. A single-block reply is unaffected — last === first.
 */
export function extractDraft(text: string): string | null {
  const blocks = [...text.matchAll(/«([\s\S]*?)»/g)];
  if (blocks.length === 0) return null;
  return blocks[blocks.length - 1][1].replace(/\s+/g, ' ').trim();
}


export interface DriftResult {
  /** One entry per un-confirmed re-draft turn, in order. */
  proposals: {
    turn: number;
    text: string;
    wasProposal: boolean;
    saved: boolean;
    draft: string | null;
  }[];
  /** Distinct drafts seen, in first-seen order. */
  distinctDrafts: string[];
  /** Turns recorded despite carrying no reply (retry budget spent) — run quality. */
  transportErrorTurns: number;
  /**
   * True only when the model actually SUPERSEDED its own proposal at least once —
   * i.e. 2+ materially different drafts, with no save in between.
   *
   * Tightened 2026-08-26 after a dev run passed on known-buggy code: all 3 drift
   * turns were proposal-SHAPED, so the old "2+ turns without a save" check was
   * satisfied, but Maha had simply re-explained the SAME pending proposal each
   * time ("التعديل المقترح اللي بانتظار تأكيدك") without ever re-drafting. No
   * supersede means expected_text never drifts, which means the bug cannot fire —
   * so that run proved nothing, yet reported PASS. Proposal shape is not the
   * precondition; a changed draft is.
   */
  driftAchieved: boolean;
}

/**
 * Phase 2: nudge the SAME rule to be shortened again N times WITHOUT confirming.
 * This is the part that actually builds the stale draft, and the part every
 * simpler reproduction attempt leaves out.
 *
 * The nudges ESCALATE rather than repeat (changed 2026-08-26 after three dev
 * runs produced no valid verdict). The original design repeated the doctor's own
 * message verbatim, as in sess-1787602994817 (turns 25/27/29/31). On dev that
 * reliably produced the SAME proposal every time — 6 turns, 5 proposals, 1
 * distinct draft — so no supersede ever happened and expected_text never went
 * stale. Same input, same output: the model is far more deterministic here than
 * the messy production session was.
 *
 * What the bug actually needs is not a repeated MESSAGE but a superseded
 * PROPOSAL — a second, materially different draft replacing the pending one.
 * Escalating the nudge makes that happen reliably while preserving the real
 * precondition, so the scenario stays faithful to the mechanism rather than to
 * one transcript's surface details.
 */
export async function driftUnconfirmedProposals(
  page: Page,
  nudges: string[],
  rounds: number
): Promise<DriftResult> {
  const proposals: DriftResult['proposals'] = [];
  const distinctDrafts: string[] = [];

  // `rounds` is a FLOOR, not a cap: the loop keeps nudging until it has actually
  // seen 2 distinct drafts (a real supersede), up to maxRounds. Whether Maha
  // re-drafts or just re-explains the pending proposal is stochastic, so a fixed
  // round count silently produces meaningless runs — see driftAchieved's note.
  const maxRounds = Math.max(rounds, Number(process.env.ETM_MAX_DRIFT_ROUNDS ?? 6));

  // Per-turn, not a single shared budget. Live-hit 2026-08-26: turn 1 alone burned
  // both retries, so turns 3, 4 and 5 — also transport errors — were each recorded
  // as real drift turns carrying "There's a technical issue…" as if it were Maha's
  // answer. 4 of 6 turns were noise, yet the run still produced a verdict.
  const perTurnTransportRetries = 2;
  // Global stop so a sustained outage can't spin here forever.
  const maxTransportRetriesTotal = Number(process.env.ETM_MAX_TRANSPORT_RETRIES ?? 8);
  let transportRetriesTotal = 0;

  for (let turn = 1; turn <= maxRounds; turn++) {
    let turnTransportRetries = 0;
    // Escalating nudges rather than one repeated string — see the note on the
    // nudge list in the spec for why an identical message stopped working.
    const nudge = nudges[Math.min(turn - 1, nudges.length - 1)];
    const reply = await sendMessageTolerant(page, nudge);

    // A transport error is a lost round, not a drift turn: the agent never
    // answered, so nothing about the proposal state changed. Don't let it burn a
    // round of the budget (observed consuming turn 3 of 6 on a dev run).
    if (
      reply.transportError &&
      turnTransportRetries < perTurnTransportRetries &&
      transportRetriesTotal < maxTransportRetriesTotal
    ) {
      turnTransportRetries += 1;
      transportRetriesTotal += 1;
      console.warn(
        `[driftUnconfirmedProposals] transport error on turn ${turn} — not counting it as a ` +
          `drift turn (turn retry ${turnTransportRetries}/${perTurnTransportRetries}, ` +
          `total ${transportRetriesTotal}/${maxTransportRetriesTotal}).`
      );
      turn -= 1;
      continue;
    }
    if (reply.transportError) {
      console.warn(
        `[driftUnconfirmedProposals] transport error on turn ${turn} and the retry budget is ` +
          'spent — recording it, but this turn carries no reply from Maha.'
      );
    }
    // A transport error is not a reply — it is neither a save nor a proposal, and
    // counting it as either would corrupt the drift bookkeeping.
    const saved = !reply.transportError && looksSaved(reply.text);
    const draft = reply.transportError ? null : extractDraft(reply.text);
    if (draft && !distinctDrafts.includes(draft)) distinctDrafts.push(draft);

    proposals.push({
      turn,
      text: reply.text,
      wasProposal: !reply.transportError && looksLikeProposal(reply.text),
      saved,
      draft,
    });

    // A save that slipped through mid-drift means the premise no longer holds —
    // stop rather than keep pushing, and let the caller see it in `proposals`.
    if (saved) break;
    // Enough supersedes to have made expected_text stale, and at least the
    // caller's requested number of turns — stop early rather than burn round trips.
    if (distinctDrafts.length >= 2 && turn >= rounds) break;
  }

  return {
    proposals,
    distinctDrafts,
    transportErrorTurns: proposals.filter((p) => isTransportError(p.text)).length,
    driftAchieved: distinctDrafts.length >= 2 && proposals.every((p) => !p.saved),
  };
}
