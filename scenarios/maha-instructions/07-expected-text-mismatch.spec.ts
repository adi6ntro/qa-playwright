import { test, expect } from '../../helpers/fixtures';
import { sendAndConfirm, getInstructionPanelState } from '../../helpers/maha-chat';
import { deleteMarkerUntilGone } from '../../helpers/bug005-probe';
import {
  CANNED,
  classifyErrorMarkers,
  driftUnconfirmedProposals,
  isTransportError,
  looksSaved,
  readMarkerText,
  readPanelAfterRefresh,
  sendMessageTolerant,
  waitForPanelCondition,
} from '../../helpers/expected-text-mismatch';
import { ReportRecorder } from '../../helpers/report';

/**
 * ETM — `expected_text_mismatch` dead end.
 *
 * Reported by QA (dr.mohamed.abdelhady29@gmail.com, clinic 2886) as: "the
 * virtual assistant errors out and stops responding after 2+ interactions".
 * Root cause, mechanism, and why a naive one-edit reproduction can never catch
 * it are all documented in helpers/expected-text-mismatch.ts — read that first.
 *
 * Short version: the failure needs the model to first build a STALE DRAFT of
 * its own (several un-confirmed re-draft turns on the same rule), and only then
 * be told "yes". So ETM-1 below deliberately spends 3-4 turns re-drafting
 * WITHOUT confirming before it confirms anything. That drift phase IS the test.
 *
 * Fix under verification (uncommitted at time of writing, branch
 * `feature/add-doctor` in reporty-onboard-phase3):
 *   - `expected_text_mismatch` added to _KNOWN_ERROR_SENTINELS so the tool's
 *     `actual_text` survives _inv()'s sanitizer instead of being flattened to
 *     "tool_temporarily_unavailable"
 *   - a self-correction hint telling the model to re-issue with that value and
 *     to stop sourcing expected_text from its own unconfirmed drafts
 *
 * Expected outcomes:
 *   BEFORE the fix — ETM-1 FAILs: the confirm turn returns the canned
 *     _TECHNICAL_FAILURE_AFFIRMED_TEXT and the panel is unchanged after refresh.
 *   AFTER the fix  — ETM-1 PASSes: the edit lands (possibly after Maha silently
 *     self-corrects), and the rule's text in the panel really changed.
 *
 * ETM-2 is diagnostic, never a gate: it measures how many extra "try again"
 * rounds a user needs when ETM-1 doesn't land first time — the exact manual
 * recovery the doctor was forced into on 2026-08-24.
 *
 * Run:  npm run test:maha-etm
 * If a run is interrupted, sweep the marker with:  npm run cleanup:maha-etm
 */

const MARKER = 'ETM_TEST_2026';

/**
 * Shaped after the real instruction 30 from clinic 2886: long, multi-bullet,
 * Arabic. Length matters — a one-line rule gives the model nothing to
 * "shorten", so it echoes rather than re-drafts and the drift never builds.
 */
const BASE_TEXT =
  `[${MARKER}] قواعد ثابتة على كل رد:\n` +
  '- الطول: الرد لا يزيد عن سطرين في أقصى الأحوال، وجاوب على قدر السؤال فقط.\n' +
  '- الأسلوب: محترم، لهجة بسيطة، بدون مصطلحات طبية معقدة.\n' +
  '- الحدود الطبية: ممنوع تقديم أي نصيحة طبية أو تشخيص، وممنوع ذكر جرعات أدوية.\n' +
  '- الحدود السلوكية: لا تعرض مساعدات إضافية، ولا تفتح نقاشات جديدة، وأنهِ المحادثة بلطف بعد الرد.';

/** Identical every turn, on purpose — see driftUnconfirmedProposals' comment. */
const DRIFT_NUDGE = `رغم التعليمات اللي في قاعدة ${MARKER}، برضه بحس الكلام كتير، عايزين نقلل الرغي`;

const DRIFT_ROUNDS = Number(process.env.ETM_DRIFT_ROUNDS ?? 3);

const recorder = new ReportRecorder('ETM - expected_text_mismatch');

// ~10 turns of real Maha round trips at up to ~45s each, plus two hard
// refreshes. The 90s per-test default in playwright.config.ts is nowhere near
// enough for a multi-turn conversational scenario like this one.
const LONG_TEST_MS = 900_000;

test.describe.serial('ETM — expected_text_mismatch dead end (clinic 2886 repro)', () => {
  /** Set by ETM-0, read by ETM-1 — the stored text the drift phase starts from. */
  let textAfterFirstEdit: string | null = null;
  /** Set by ETM-1, read by ETM-2 so the recovery probe only runs when it's warranted. */
  let etm1Landed: boolean | null = null;

  test('ETM-0 setup — save the long marker rule, then make ONE confirmed edit', async ({
    sharedPage,
  }) => {
    test.setTimeout(LONG_TEST_MS);

    // Guard against a leftover from an interrupted run: a pre-existing marker
    // row would make "did the text change?" below compare against the wrong
    // baseline and silently invalidate the whole scenario.
    const existing = await readMarkerText(sharedPage, MARKER);
    if (existing) {
      await deleteMarkerUntilGone(sharedPage, MARKER);
      const stillThere = await readMarkerText(sharedPage, MARKER);
      expect(
        stillThere,
        `a leftover ${MARKER} rule is still present — run "npm run cleanup:maha-etm" before this suite`
      ).toBeNull();
    }

    const before = await getInstructionPanelState(sharedPage);
    const { replies: saveReplies, confirmRoundsNeeded: saveRounds } = await sendAndConfirm(
      sharedPage,
      `أضيفي قاعدة جديدة بالنص ده بالظبط:\n${BASE_TEXT}`
    );
    let saved = await readPanelAfterRefresh(sharedPage);
    let savedRow = saved.rows.find((r) => r.text.includes(MARKER));

    // A transport error means the browser never heard back — the write can still be
    // in flight (see FRONTEND_TRANSPORT_ERROR's note: observed landing ~90s after
    // the browser had already given up). Give it a real budget before concluding
    // anything, rather than failing setup on what may be a slow success.
    const saveReplyText = saveReplies[saveReplies.length - 1].text;
    if (!savedRow && isTransportError(saveReplyText)) {
      console.warn(
        '[ETM-0] The chat UI showed its transport-error bubble; re-reading the panel for up to ' +
          '120s before deciding, since the write may still complete server-side.'
      );
      await waitForPanelCondition(sharedPage, (rows) => rows.some((r) => r.text.includes(MARKER)));
      saved = await readPanelAfterRefresh(sharedPage);
      savedRow = saved.rows.find((r) => r.text.includes(MARKER));
    }

    expect(
      savedRow,
      `setup could not save the ${MARKER} rule, so the rest of this suite has nothing to edit. ` +
        `Last reply: ${saveReplyText}`
    ).toBeTruthy();

    // The FIRST edit is expected to work even with the bug present — this is
    // exactly why QA saw it as "not consistent from the first message". Doing it
    // here establishes that, and gives the drift phase a real stored value to
    // diverge from.
    const { replies: editReplies, confirmRoundsNeeded: editRounds } = await sendAndConfirm(
      sharedPage,
      `اختصري قاعدة ${MARKER} شوية وخليها أقصر`
    );
    const afterEdit = await readPanelAfterRefresh(sharedPage);
    textAfterFirstEdit = afterEdit.rows.find((r) => r.text.includes(MARKER))?.text ?? null;

    const firstEditLanded = textAfterFirstEdit !== null && textAfterFirstEdit !== savedRow!.text;

    recorder.record({
      id: 'ETM-0',
      tool: 'save_instruction + update_instruction (setup / first-edit baseline)',
      trigger: `أضيفي قاعدة ${MARKER} ... ثم اختصريها`,
      result: firstEditLanded ? 'PASS' : 'NEEDS_REVIEW',
      evidence:
        `save_reply="${saveReplies[saveReplies.length - 1].text}" | ` +
        `edit_reply="${editReplies[editReplies.length - 1].text}" | ` +
        `panel_count ${before.count}->${saved.count} | first_edit_changed_text=${firstEditLanded}`,
      confirmRoundsNeeded: saveRounds + editRounds,
      persisted: firstEditLanded,
    });

    expect(textAfterFirstEdit, 'the marker rule must exist before the drift phase').toBeTruthy();
  });

  test('ETM-1 REPRO — re-draft without confirming, then confirm', async ({ sharedPage }) => {
    test.setTimeout(LONG_TEST_MS);
    expect(textAfterFirstEdit, 'ETM-0 must have run first').toBeTruthy();

    // Phase 2 — build the stale draft. No confirmation on any of these turns.
    const drift = await driftUnconfirmedProposals(sharedPage, DRIFT_NUDGE, DRIFT_ROUNDS);

    // Phase 3 — the moment of truth: a single, unambiguous "yes".
    const confirmReply = await sendMessageTolerant(sharedPage, 'نعم');
    const markers = classifyErrorMarkers(confirmReply.text);

    // Phase 4 — ground truth. Whatever the chat said, did the stored text move?
    const after = await readPanelAfterRefresh(sharedPage);
    const textAfterDrift = after.rows.find((r) => r.text.includes(MARKER))?.text ?? null;
    const storedTextChanged = textAfterDrift !== null && textAfterDrift !== textAfterFirstEdit;

    etm1Landed = storedTextChanged && !markers.technicalFailureAffirmed;

    // The premise guard exists so a GREEN result can't be read as meaningful when
    // the drift never actually built. It must never be able to suppress a RED one:
    // the canned technical-failure string is emitted only after the orchestrator
    // exhausted every confirm retry, so seeing it is the bug, full stop — however
    // the turns leading up to it happened to be classified.
    //
    // Live-caught on the first baseline run (2026-08-26): a mis-classified drift
    // turn dropped the premise below threshold and this test skipped itself while
    // that exact canned string was sitting in the confirm reply. A guard that can
    // hide a reproduction is worse than no guard.
    const premiseHeld = drift.driftAchieved;
    const reproduced = markers.technicalFailureAffirmed;

    // A transport error on the confirm turn is a different failure entirely (the
    // browser never got a reply) — it can neither confirm nor clear this bug, so it
    // invalidates the run rather than producing a verdict either way.
    if (confirmReply.transportError) {
      recorder.record({
        id: 'ETM-1',
        tool: 'update_instruction(instruction_id, new_text, expected_text) — stale-draft path',
        trigger: `${DRIFT_ROUNDS}x "${DRIFT_NUDGE}" (unconfirmed) → "نعم"`,
        result: 'UNABLE_TO_TEST',
        evidence:
          'The chat UI showed its transport-error bubble on the confirm turn (the browser never ' +
          'received a reply), so this run proves nothing about expected_text_mismatch either way. ' +
          `stored_text_changed=${storedTextChanged}. Re-run.`,
        persisted: storedTextChanged,
      });
      console.warn('[ETM-1] transport error on the confirm turn — run invalidated, re-run needed.');
      test.skip();
      return;
    }

    recorder.record({
      id: 'ETM-1',
      tool: 'update_instruction(instruction_id, new_text, expected_text) — stale-draft path',
      trigger: `${DRIFT_ROUNDS}x "${DRIFT_NUDGE}" (unconfirmed) → "نعم"`,
      result: reproduced ? 'FAIL' : !premiseHeld ? 'NEEDS_REVIEW' : etm1Landed ? 'PASS' : 'FAIL',
      evidence:
        `drift_premise_held=${premiseHeld} (turns=${drift.proposals.length}, ` +
        `looked_like_proposal=${drift.proposals.filter((p) => p.wasProposal).length}, ` +
        `any_saved_mid_drift=${drift.proposals.some((p) => p.saved)}) | ` +
        `confirm_reply="${confirmReply.text}" | ` +
        `error_markers=[${markers.matched.join(', ') || 'none'}] | ` +
        `canned_technical_failure=${markers.technicalFailureAffirmed} | ` +
        `stored_text_changed=${storedTextChanged}`,
      persisted: storedTextChanged,
    });

    // Log the whole drift transcript — the per-turn wording is what a human
    // needs to judge whether the model really was re-drafting from its own
    // previous draft, which no assertion can decide.
    for (const p of drift.proposals) {
      console.log(`[ETM-1 drift turn ${p.turn}] proposal=${p.wasProposal} saved=${p.saved} :: ${p.text}`);
    }
    console.log(`[ETM-1 confirm reply] ${confirmReply.text}`);

    // The hard gate, asserted BEFORE the premise guard for the reason above.
    // This exact canned string is only ever emitted after the orchestrator
    // exhausted every confirm retry — with the fix in place there is a working
    // self-correction path, so it must not appear at all.
    expect(
      confirmReply.text,
      'Maha returned the canned "technical issue" dead-end after a clear "نعم" — ' +
        `this is the reported bug reproduced (${CANNED.technicalFailureAffirmed})`
    ).not.toContain(CANNED.technicalFailureAffirmed);

    if (!premiseHeld) {
      console.warn(
        '[ETM-1] The drift phase did not run 2+ turns without a save, so this run does NOT ' +
          'exercise the stale-draft path — and since the canned failure string did not appear ' +
          'either, the result is not meaningful in either direction. Raise ETM_DRIFT_ROUNDS ' +
          '(default 3) and re-run.'
      );
      test.skip();
      return;
    }

    expect(
      storedTextChanged,
      'the owner confirmed the edit but the stored rule text is unchanged after a hard refresh — ' +
        `the write never happened. Confirm reply was: ${confirmReply.text}`
    ).toBe(true);
  });

  test('ETM-2 recovery cost — how many manual retries a user needs', async ({ sharedPage }) => {
    test.setTimeout(LONG_TEST_MS);

    if (etm1Landed === null) {
      recorder.record({
        id: 'ETM-2',
        tool: '(manual retry recovery probe)',
        trigger: '(skipped)',
        result: 'UNABLE_TO_TEST',
        evidence: 'ETM-1 did not run to a verdict, so there is nothing to measure recovery from.',
      });
      test.skip();
      return;
    }

    if (etm1Landed) {
      recorder.record({
        id: 'ETM-2',
        tool: '(manual retry recovery probe)',
        trigger: '(not needed)',
        result: 'PASS',
        evidence: 'ETM-1 landed on the first confirm — zero manual retry rounds needed.',
        confirmRoundsNeeded: 0,
      });
      return;
    }

    // ETM-1 failed. Replay the doctor's own manual recovery from
    // sess-1787602994817 turns 37-40 ("حاول مرة اخري" → proposal → "نعم") and
    // record how many rounds it takes, if it ever lands at all.
    const beforeText = await readMarkerText(sharedPage, MARKER);
    let rounds = 0;
    let landed = false;
    let lastReply = '';

    for (; rounds < 3 && !landed; ) {
      rounds += 1;
      const retryReply = await sendMessageTolerant(sharedPage, 'حاول مرة اخري');
      lastReply = retryReply.text;
      if (!retryReply.transportError && !looksSaved(retryReply.text)) {
        const confirmAgain = await sendMessageTolerant(sharedPage, 'نعم');
        lastReply = confirmAgain.text;
      }
      const now = await readPanelAfterRefresh(sharedPage);
      const nowText = now.rows.find((r) => r.text.includes(MARKER))?.text ?? null;
      landed = nowText !== null && nowText !== beforeText;
    }

    recorder.record({
      id: 'ETM-2',
      tool: '(manual retry recovery probe)',
      trigger: '"حاول مرة اخري" → "نعم", repeated',
      result: landed ? 'NEEDS_REVIEW' : 'FAIL',
      evidence: landed
        ? `Recovered only after ${rounds} manual retry round(s) — the write is reachable but the ` +
          `first confirm is still being wasted. Last reply: ${lastReply}`
        : `Never recovered after ${rounds} manual retry rounds — the rule is stuck. ` +
          `Last reply: ${lastReply}`,
      confirmRoundsNeeded: rounds,
      persisted: landed,
    });
  });

  test.afterAll(async ({ browser }) => {
    // Own context: the shared worker fixture may already be torn down by the
    // time afterAll runs, and leaving the marker behind would poison ETM-0's
    // baseline guard on the next run.
    const context = await browser.newContext({ storageState: 'auth/.storage-state.json' });
    const page = await context.newPage();
    try {
      const { gotoAiInstructionStep } = await import('../../helpers/maha-chat');
      await gotoAiInstructionStep(page);
      const outcome = await deleteMarkerUntilGone(page, MARKER);
      if (!outcome.success) {
        console.warn(
          `[ETM cleanup] ${MARKER} could not be deleted after ${outcome.attempts} attempts — ` +
            'run "npm run cleanup:maha-etm" before the next run.'
        );
      }
    } catch (err) {
      console.warn(`[ETM cleanup] skipped: ${(err as Error).message}`);
    } finally {
      await context.close();
      await recorder.writeTo('reports');
    }
  });
});
