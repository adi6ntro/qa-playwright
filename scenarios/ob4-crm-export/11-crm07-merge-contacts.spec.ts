import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-07 `crm_merge_contacts`, from QA_TestScript_Phase4_CRM_Export.md's
 * 2026-09-05 implementation note — merge genuinely migrates notes/tags/
 * follow-ups/appointment/conversation history from absorbed→survivor (crm.py's
 * merge_contacts(), ~line 1209). Known, accepted deviation: `campaign_history`
 * is NOT migrated (user_campaign_recipient has no patient_id bridge, only a
 * phone_number join — see crm_get_contact) — an open product item the dev team
 * is aware of, not a hidden bug. TC-CRM07-02 below does not fail on this, per
 * the doc's own instruction.
 *
 * Setup gap (documented, not faked): a merge fundamentally needs TWO real,
 * distinct pre-existing contacts to exercise for real. No second/duplicate
 * contact_id is confirmed to exist alongside this suite's one known contact
 * (patients.id=896, clinic 440, used elsewhere in this suite) — rather than
 * inventing ids, all four test cases below (including TC-CRM07-03, the negative
 * "no primary named" case) are gated on TEST_CRM07_DUPLICATE_CONTACT_ID_A/_B.
 * TC-CRM07-03 still needs two REAL contacts even though it never expects a
 * merge to actually succeed: a fabricated second id would let Maha correctly
 * decline for the wrong reason ("that contact doesn't exist"), which would not
 * actually exercise the "must ask who the primary is" behavior this case is
 * about. See QA_TestScript_Phase4_CRM_Export.md's TC-CRM07-01 setup step 2 for
 * how to create a real duplicate pair by hand (two contacts, same name,
 * different phone numbers).
 *
 * TC-CRM07-03 is declared FIRST in this file even though the doc numbers it
 * after TC-CRM07-01/02 — this suite has no parallelism at all
 * (playwright.config.ts: fullyParallel:false, workers:1), so file declaration
 * order IS execution order, and TC-CRM07-03 needs the pair to NOT already be
 * merged (a real merge is irreversible — running TC-CRM07-03 after the real
 * merge test would leave contact B already `merged_into` contact A, which
 * changes what "ambiguous merge, no primary named" even means for this pair).
 *
 * TC-CRM07-01/02/04 are folded into ONE test below, same precedent as
 * 05-crm05-add-note.spec.ts's TC-CRM05-01+02: 02 and 04 both read state that
 * only exists once the real merge from 01 has actually run, and relying on
 * cross-test in-memory state across separate `test()` blocks is fragile
 * (report.ts's own comment: a worker restarts after any test failure, so state
 * living only in JS variables between tests in the same file cannot be
 * trusted — the underlying DB state persists regardless, but keeping the whole
 * causal chain in one test keeps this run's own log linear and easy to read).
 */

const recorder = new ReportRecorder('OB4 CRM-07 Merge Contacts');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

const DUPLICATE_PAIR_SKIP_REASON =
  'need two known-duplicate test contacts to exercise merge — set TEST_CRM07_DUPLICATE_CONTACT_ID_A/_B (two ' +
  'real, distinct contacts, same name, different phone numbers). See QA_TestScript_Phase4_CRM_Export.md ' +
  'TC-CRM07 setup steps for how to create one by hand.';

/** See 09-crm04-set-responsible.spec.ts's callAction() for the full envelope explanation. */
async function callAction(
  page: import('@playwright/test').Page,
  clinicId: string,
  action: string,
  params: Record<string, unknown>,
  opts: { branchId?: string } = {}
) {
  const resp = await page.request.post(`http://localhost:9559/clinic/${clinicId}/action`, {
    data: {
      action,
      params,
      session_id: `qa-crm07-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

test.describe('TC-CRM07-03 — merge without naming a primary contact is rejected', () => {
  test('Maha asks which contact should survive, instead of auto-picking one or merging blind', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(
      !process.env.TEST_CRM07_DUPLICATE_CONTACT_ID_A || !process.env.TEST_CRM07_DUPLICATE_CONTACT_ID_B,
      DUPLICATE_PAIR_SKIP_REASON
    );

    const idA = process.env.TEST_CRM07_DUPLICATE_CONTACT_ID_A!;
    const idB = process.env.TEST_CRM07_DUPLICATE_CONTACT_ID_B!;

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Deliberately does NOT name a survivor/primary — that's exactly what this
    // case is testing Maha refuses to guess.
    const trigger = `ادمجي جهتي الاتصال رقم ${idA} ورقم ${idB}`;
    const reply = await sendMessage(page, trigger);

    const afterA = await callAction(page, clinicId, 'crm_get_contact', { contact_id: idA });
    const afterB = await callAction(page, clinicId, 'crm_get_contact', { contact_id: idB });
    const neitherMerged = afterA?.success === true && afterB?.success === true;

    recorder.record({
      id: 'TC-CRM07-03',
      tool: 'crm_merge_contacts — must not be called before a survivor/primary contact is explicitly named',
      trigger,
      result: neitherMerged ? 'PASS' : 'FAIL',
      evidence:
        `reply="${reply.text}"\ncontact_${idA}_still_standalone=${afterA?.success} ` +
        `contact_${idB}_still_standalone=${afterB?.success}\n` +
        JSON.stringify({ a: afterA?.data, b: afterB?.data }).slice(0, 500),
    });
    expect(neitherMerged, 'neither contact should be merged before a primary/survivor contact is named').toBe(true);
    await context.close();
  });
});

/**
 * ⚠️ UNRESOLVED FINDING (2026-09-07), left as-is per Adi's call — do not silently retry
 * or loosen this assertion without re-reading this note first.
 *
 * First live run: the merge never actually happened. `crm_get_contact` on both 111 and
 * 254 afterward showed neither reported as merged (absorbed_error=undefined,
 * absorbed_merged_into=undefined) — no partial/corrupted state, just a clean no-op.
 * The chat transcript's very FIRST reply (before this suite's own sendAndConfirm ever
 * sent a "نعم") was already an apology — "عذرًا، لم أتمكن من تجهيز هذا التغيير بشكل
 * صحيح قبل قليل" ("sorry, I couldn't prepare this change correctly a moment ago") —
 * not a proper Tier-4 confirmation prompt naming survivor/absorbed. After 2 further
 * confirm-phrase rounds (our own heuristic treating question-mark replies as prompts),
 * Maha ended up saying it opened a support ticket for a human to handle the contact
 * merge instead of doing it itself.
 *
 * Backend code was checked and looks structurally sound: `merge_contacts()`
 * (crm.py:1209) and all 6 `_MERGE_BRIDGE_TABLES` were confirmed to have the expected
 * `patient_id` column in this DB — nothing there explains a failure. This reads more
 * like a transient Gemini/Vertex hiccup on the LLM side (the "couldn't prepare this
 * change correctly" wording is Maha's own generic retry-request phrasing for a failed
 * tool-call attempt), OR a not-yet-understood policy that routes merge specifically to
 * a support ticket after some kind of retry/failure — not independently confirmed
 * either way. A second run was intentionally NOT attempted immediately: this test
 * performs a REAL, irreversible merge of contacts 111/254 if it succeeds, so repeated
 * runs need a deliberate decision, not an automatic retry loop. Re-run this test
 * on its own (not as part of a full-suite sweep) before drawing further conclusions.
 */
test.describe(
  'TC-CRM07-01 + TC-CRM07-02 + TC-CRM07-04 — merge with Tier-4 confirmation, verify combined survivor profile and the absorbed contact disappearing',
  () => {
    test('merge actually runs after confirmation; survivor gains combined history; absorbed no longer stands alone', async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
      test.skip(
        !process.env.TEST_CRM07_DUPLICATE_CONTACT_ID_A || !process.env.TEST_CRM07_DUPLICATE_CONTACT_ID_B,
        `${DUPLICATE_PAIR_SKIP_REASON} WARNING: running this test actually merges them for real — is_reversible ` +
          'is always false. Do not point it at real production contacts, only at a disposable test pair.'
      );

      const survivorId = process.env.TEST_CRM07_DUPLICATE_CONTACT_ID_A!; // "keeps its identity"
      const absorbedId = process.env.TEST_CRM07_DUPLICATE_CONTACT_ID_B!;

      const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
      const page = await context.newPage();
      await gotoAiInstructionStep(page);
      const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
      expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

      // Baseline BEFORE the merge — this is what TC-CRM07-02 needs to prove got combined.
      const survivorBefore = await callAction(page, clinicId, 'crm_get_contact', { contact_id: survivorId });
      const absorbedBefore = await callAction(page, clinicId, 'crm_get_contact', { contact_id: absorbedId });
      const notesBefore = (survivorBefore?.data?.notes?.length || 0) + (absorbedBefore?.data?.notes?.length || 0);
      const tagsBefore = new Set<string>([...(survivorBefore?.data?.tags || []), ...(absorbedBefore?.data?.tags || [])]);
      const appointmentsBefore =
        (survivorBefore?.data?.appointment_history?.length || 0) + (absorbedBefore?.data?.appointment_history?.length || 0);
      const conversationsBefore =
        (survivorBefore?.data?.conversation_history?.length || 0) + (absorbedBefore?.data?.conversation_history?.length || 0);

      const trigger =
        `ادمجي جهة الاتصال رقم ${survivorId} مع جهة الاتصال رقم ${absorbedId}، ` +
        `واحتفظي بجهة الاتصال رقم ${survivorId} كجهة الاتصال الرئيسية`;
      const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, trigger);

      recorder.record({
        id: 'TC-CRM07-01',
        tool: 'crm_merge_contacts — Tier-4 confirmation must explicitly name both survivor/absorbed and warn it is irreversible',
        trigger,
        result: 'NEEDS_REVIEW',
        evidence:
          `[semantic check needed] the confirmation prompt (the first reply below, prior to any confirm-phrase ` +
          `round trips) must explicitly name survivor=${survivorId} and absorbed=${absorbedId}, and warn the ` +
          `action cannot be undone.\n\nall replies:\n` + replies.map((r, i) => `[${i}] ${r.text}`).join('\n\n'),
        confirmRoundsNeeded,
      });

      const survivorAfter = await callAction(page, clinicId, 'crm_get_contact', { contact_id: survivorId });
      const absorbedAfter = await callAction(page, clinicId, 'crm_get_contact', { contact_id: absorbedId });

      // TC-CRM07-01's mechanical half: did the merge actually run at all once confirmed.
      const survivorStillStandalone = survivorAfter?.success === true;
      const absorbedNowMerged =
        absorbedAfter?.success === false &&
        absorbedAfter?.data?.error === 'contact_merged_into_another_contact' &&
        String(absorbedAfter?.data?.merged_into_patient_id) === String(survivorId);
      const mergeActuallyRan = survivorStillStandalone && absorbedNowMerged;

      recorder.record({
        id: 'TC-CRM07-01-mechanical',
        tool: 'crm_get_contact(survivor)/crm_get_contact(absorbed) — direct read, not chat, confirms the merge really happened',
        trigger: `[direct action, not chat] crm_get_contact ${survivorId} / ${absorbedId}`,
        result: mergeActuallyRan ? 'PASS' : 'FAIL',
        evidence:
          `survivor_success=${survivorAfter?.success} absorbed_error=${absorbedAfter?.data?.error} ` +
          `absorbed_merged_into=${absorbedAfter?.data?.merged_into_patient_id}`,
      });
      expect(mergeActuallyRan, 'after confirming, the merge must have actually run: survivor stands, absorbed reports merged_into').toBe(
        true
      );

      // TC-CRM07-02 — survivor's profile now shows the combined history from both
      // former contacts. campaign_history is deliberately excluded from this check —
      // known, accepted deviation (see file header) — never treated as a failure.
      const notesAfter = survivorAfter?.data?.notes?.length || 0;
      const tagsAfter = new Set<string>(survivorAfter?.data?.tags || []);
      const appointmentsAfter = survivorAfter?.data?.appointment_history?.length || 0;
      const conversationsAfter = survivorAfter?.data?.conversation_history?.length || 0;

      const notesCombined = notesAfter >= notesBefore;
      const tagsCombined = [...tagsBefore].every((t) => tagsAfter.has(t));
      const appointmentsCombined = appointmentsAfter >= appointmentsBefore;
      const conversationsCombined = conversationsAfter >= conversationsBefore;
      const historyCombined = notesCombined && tagsCombined && appointmentsCombined && conversationsCombined;

      recorder.record({
        id: 'TC-CRM07-02',
        tool:
          'crm_get_contact(survivor) — notes/tags/appointment_history/conversation_history combined; ' +
          'campaign_history deliberately NOT checked (known open item, not a bug, per the doc\'s own instruction)',
        trigger: `[direct action, not chat] crm_get_contact ${survivorId}`,
        result: historyCombined ? 'PASS' : 'FAIL',
        evidence:
          `notes ${notesBefore}->${notesAfter} tags_before=${[...tagsBefore]} tags_after=${[...tagsAfter]} ` +
          `appointments ${appointmentsBefore}->${appointmentsAfter} conversations ${conversationsBefore}->${conversationsAfter}`,
      });
      expect(
        historyCombined,
        "the survivor's profile must show combined notes/tags/appointments/conversations from both former contacts"
      ).toBe(true);

      // TC-CRM07-04 — the absorbed contact must not stand as a separate entity anymore.
      recorder.record({
        id: 'TC-CRM07-04',
        tool: 'crm_get_contact(absorbed) — must report contact_merged_into_another_contact, never a standalone profile',
        trigger: `[direct action, not chat] crm_get_contact ${absorbedId}`,
        result: absorbedNowMerged ? 'PASS' : 'FAIL',
        evidence:
          `absorbed_success=${absorbedAfter?.success} absorbed_error=${absorbedAfter?.data?.error} ` +
          `absorbed_merged_into_patient_id=${absorbedAfter?.data?.merged_into_patient_id}`,
      });
      expect(
        absorbedNowMerged,
        'the absorbed contact must report contact_merged_into_another_contact, not a standalone profile'
      ).toBe(true);

      await context.close();
    });
  }
);
