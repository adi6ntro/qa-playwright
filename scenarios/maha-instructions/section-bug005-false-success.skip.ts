import { test, expect } from '../../helpers/fixtures';
import { sendAndConfirm, getInstructionPanelState, gotoAiInstructionStep } from '../../helpers/maha-chat';
import {
  runFivePhaseInstructionProbe,
  runRapidFireProbe,
  phase3DelayedRead,
  deleteMarkerUntilGone,
  gotoSocialMediaStep,
  readInstagramField,
  gotoRetargetSettings,
  readRetargetDiscount,
  gotoMyReportSettings,
  readDisplayPhoneChecked,
  type ScenarioRecord,
} from '../../helpers/bug005-probe';
import { Bug005Recorder } from '../../helpers/bug005-report';

/**
 * Automates ../../../reporty-onboard-phase3/QA_Prompt_BUG005_False_Success_Writes.md
 * (T1-T12) against the real AI Instructions panel + Instagram field, reusing
 * this harness's existing auth/session/navigation infra (helpers/fixtures.ts,
 * helpers/maha-chat.ts) instead of a separate browser session, per Adi's
 * request to extend the existing Playwright harness rather than build a new one.
 *
 * What's fully mechanical (real DOM verification, matching the runbook's own
 * CLEAN/FALSE_SUCCESS_LAG/FALSE_SUCCESS_TRUE_FAIL/RETRY_DUPLICATE/RETRY_SINGLE
 * result codes exactly): T1-T4, T10, T11, T12 — all against the instructions
 * panel, which is the one write surface this harness has a confirmed,
 * independent-of-Maha DOM signal for (see project-qa-playwright-maha-instructions
 * memory / README "Real DOM selectors ... WERE confirmed against actual
 * source, not guessed").
 *
 * T5 (Instagram) is also mechanical — `#instagram_connect`'s value is
 * confirmed server-rendered from `$myClinic['instagram_link']`
 * (social-media.blade.php:39), so a hard refresh gives real ground truth
 * exactly like the instructions panel does.
 *
 * T7 (retargeting discount) and T8 (report branding "show mobile number")
 * are also mechanical now — confirmed selectors:
 *   - T7: `#discount` on `/customer/retarget`, opened via `#btn_settings`
 *     (Retarget.blade.php:224/306, modal-setting.blade.php:130-139).
 *   - T8: `#display_phone` on `/customer/my-report`
 *     (myReport.blade.php:339) — currently rendered `display:none` in this
 *     app's markup, so it can't be clicked as a real user would, but its
 *     `checked` state is still real ground truth to READ (the WRITE comes
 *     from Maha's chat tool either way, never from us driving this UI).
 *
 * T6 (manager/responsible phone) and T9 (doctor note) are left as
 * UNABLE_TO_TEST — NOT because the search budget ran out, but because a
 * real, exhaustive search (full read of the facility-info wizard step, the
 * `$myClinic` data model, all myDoctors/* views, migrations, models) found
 * that **neither field exists anywhere in this codebase**. If Maha's tool
 * catalog actually exposes `update_facility_info(field=manager_phone)` or
 * `update_doctor(note)`, either the tool is dead code with no real backing
 * column, or the runbook is testing against a tool list that doesn't match
 * what's actually implemented — worth flagging to Adi either way, not
 * something this harness can silently paper over with a guessed selector.
 */

const recorder = new Bug005Recorder();
const T1_MARKER = '[BUG005_TEST_T1]';
const T1_EDITED_MARKER = '[BUG005_TEST_T1_EDITED]';
const T2_MARKER = '[BUG005_TEST_T2]';
const T11_MARKER = '[BUG005_TEST_T11]';
const T12_MARKER = '[BUG005_TEST_T12]';
const T10_MARKERS = ['[BUG005_TEST_T10a]', '[BUG005_TEST_T10b]', '[BUG005_TEST_T10c]'];

let baselineCount: number | null = null;
let baselineTop3: string[] = [];

test.describe.serial('BUG-005 — False-Success on Writes (5-phase probe)', () => {
  // Every scenario here can run 2-3 hard-refresh + 10s-wait cycles (Phase 3,
  // then again after a Phase 4 retry) on top of several chat round-trips —
  // comfortably over the project's default 90s test timeout even with no
  // bug present. On top of that, sendAndConfirm retries up to 4 rounds when
  // Maha keeps asking for confirmation instead of confirming (a known,
  // separate pathology — see project_ob3_prod_audit_2026-08-03.md item 3),
  // and EACH round has its own up-to-45s wait for a reply. Worst case that's
  // 4 x 45s = 180s burned on a SINGLE write, before Phase 3/4/5 even start —
  // confirmed to actually happen live (T10c timed out this way on
  // 2026-08-05). Budget for that explicitly rather than treating it as a
  // flake to retry away.
  test.beforeEach(() => {
    test.setTimeout(360_000);
  });

  test('BUG005-baseline — capture panel state before any test writes', async ({ sharedPage }) => {
    const state = await getInstructionPanelState(sharedPage);
    baselineCount = state.count;
    baselineTop3 = state.rows.slice(0, 3).map((r) => r.text);
    expect(state.count, 'baseline panel must be readable before running destructive-adjacent probes').not.toBeNull();

    // Pre-flight contamination check (T3 fix, 2026-08-06): the 2026-08-04 run's T3
    // ("duplicate" verdict on update_instruction) was NOT a real backend bug — it
    // was leftover [BUG005_TEST_T1_EDITED] fixture data from an earlier, incompletely
    // cleaned run, already sitting in the panel at the moment THIS baseline was
    // captured. Because that leftover became part of "baseline", the run had no way
    // to notice it was starting from a dirty state, and the eventual T3 write (which
    // legitimately created its own T1_EDITED row) looked like a duplicate against a
    // row that was never this run's doing. Fail fast here instead of silently running
    // T1-T12 on top of contaminated state and producing a confusing false report —
    // this is cheaper than the log archaeology it took to find the real explanation.
    const leftoverMarkers = state.rows
      .map((r) => r.text)
      .filter((text) => /\[BUG005_TEST_[A-Z0-9]+/i.test(text));
    expect(
      leftoverMarkers,
      `environment not clean — found leftover BUG-005 test markers from a previous ` +
        `incompletely-cleaned run: [${leftoverMarkers.join(' | ')}]. Run cleanup on this ` +
        `clinic's AI Instructions panel first, then re-run this suite.`
    ).toHaveLength(0);
  });

  test('T1 save_instruction (basic add)', async ({ sharedPage }) => {
    const result = await runFivePhaseInstructionProbe(sharedPage, {
      id: 'T1',
      tool: 'save_instruction (basic add)',
      writeTrigger: `أبغى أضيف قاعدة جديدة: ${T1_MARKER} لما يجي مريض جديد استفسر عن تخصصه الأساسي`,
      readTrigger: `أعطيني القاعدة اللي فيها كلمة ${T1_MARKER}`,
      marker: T1_MARKER,
      expectPresent: true,
    });
    recorder.record(result);
    // No standalone cleanup here — T3 renames this rule to T1_EDITED and
    // T3's own cleanup deletes it. Deleting it here would break T3's
    // precondition ("T1 must have committed first"), per the runbook.
  });

  test('T2 save_instruction (long text)', async ({ sharedPage }) => {
    const longText =
      `${T2_MARKER} لما يسأل المريض عن أسعار زراعة الأسنان، لا تعطيه سعر ثابت، وضّح إن السعر يعتمد على نوع ` +
      `الزرعة (سويسرية، ألمانية، كورية) وعدد الأسنان اللي محتاج زرعها، واعرض عليه معاينة مجانية`;
    const result = await runFivePhaseInstructionProbe(sharedPage, {
      id: 'T2',
      tool: 'save_instruction (long text)',
      writeTrigger: `أبغى أضيف قاعدة: ${longText}`,
      readTrigger: `أعطيني القاعدة اللي فيها كلمة ${T2_MARKER}`,
      marker: T2_MARKER,
      expectPresent: true,
    });
    recorder.record(result);
    // No standalone cleanup — T4 deletes this one ("it IS the cleanup").
  });

  test('T3 update_instruction (edit T1 -> T1_EDITED)', async ({ sharedPage }) => {
    const before = await getInstructionPanelState(sharedPage);
    const hasT1 = before.rows.some((r) => r.text.includes(T1_MARKER));
    if (!hasT1) {
      recorder.record({
        id: 'T3',
        tool: 'update_instruction',
        trigger: '(skipped)',
        resultCode: 'UNABLE_TO_TEST',
        retryNeeded: false,
        duplicateOnRetry: 'NA',
        evidence: `Precondition failed: ${T1_MARKER} not found in panel before T3 ran (T1 must commit first, per runbook).`,
      });
      test.skip();
      return;
    }

    const result = await runFivePhaseInstructionProbe(sharedPage, {
      id: 'T3',
      tool: 'update_instruction',
      writeTrigger: `عدّلي القاعدة \`${T1_MARKER}\` وخليها: \`${T1_EDITED_MARKER}\` لما يجي مريض جديد استفسر عن نوع علاجه المطلوب`,
      readTrigger: `أعطيني القاعدة اللي فيها كلمة ${T1_EDITED_MARKER}`,
      marker: T1_EDITED_MARKER,
      expectPresent: true,
    });
    recorder.record(result);

    // Cleanup — delete T1_EDITED (this supersedes T1's own cleanup too).
    // Retries with an escalating wait until confirmed gone (see
    // deleteMarkerUntilGone's comment) — a single delete-and-check here was
    // the source of the 2026-08-12T06-27 baseline-blocking leftover.
    const finalState = await getInstructionPanelState(sharedPage);
    if (finalState.rows.some((r) => r.text.includes(T1_EDITED_MARKER))) {
      const outcome = await deleteMarkerUntilGone(sharedPage, T1_EDITED_MARKER);
      recorder.setCleanup(`${T1_EDITED_MARKER} deleted`, outcome.success);
      if (!outcome.success) {
        recorder.noteAnomaly(`${T1_EDITED_MARKER} cleanup still not gone after ${outcome.attempts} delete attempts.`);
      }
    } else {
      recorder.setCleanup(`${T1_EDITED_MARKER} deleted`, true);
    }
  });

  test('T4 remove_instruction (delete T2 via chat) — this IS the cleanup', async ({ sharedPage }) => {
    const before = await getInstructionPanelState(sharedPage);
    const hasT2 = before.rows.some((r) => r.text.includes(T2_MARKER));
    if (!hasT2) {
      recorder.record({
        id: 'T4',
        tool: 'remove_instruction',
        trigger: '(skipped)',
        resultCode: 'UNABLE_TO_TEST',
        retryNeeded: false,
        duplicateOnRetry: 'NA',
        evidence: `Precondition failed: ${T2_MARKER} not found in panel before T4 ran (T2 must commit first).`,
      });
      test.skip();
      return;
    }

    const result = await runFivePhaseInstructionProbe(sharedPage, {
      id: 'T4',
      tool: 'remove_instruction',
      writeTrigger: `احذفي القاعدة اللي فيها كلمة ${T2_MARKER}`,
      readTrigger: `هل ما زالت موجودة القاعدة اللي فيها كلمة ${T2_MARKER}؟`,
      marker: T2_MARKER,
      expectPresent: false,
    });
    recorder.record(result);
    const finalState = await getInstructionPanelState(sharedPage);
    recorder.setCleanup(`${T2_MARKER} deleted`, !finalState.rows.some((r) => r.text.includes(T2_MARKER)));
  });

  test('T5 update_facility_info (Instagram link round-trip)', async ({ sharedPage }) => {
    await gotoSocialMediaStep(sharedPage);
    const originalUrl = await readInstagramField(sharedPage);
    const testUrl = 'https://instagram.com/bug005_test_t5';

    // Phase 1 — WRITE. Navigate back to the AI Instruction chat step to send
    // the trigger (the chat widget lives there in this app, not on step 0),
    // then return to step 0 to read the field.
    await gotoAiInstructionStep(sharedPage);
    const writeAt = Date.now();
    const { replies: writeReplies } = await sendAndConfirm(sharedPage, `غيّري رابط الإنستقرام لـ: ${testUrl}`);
    const writeReply = writeReplies[writeReplies.length - 1].text;

    // Phase 2 — immediate chat read-back.
    const { replies: readReplies } = await sendAndConfirm(sharedPage, 'اعرضي لي رابط الإنستقرام الحالي');
    const readReply = readReplies[readReplies.length - 1].text;
    const phase2Reflects = readReply.includes(testUrl) || readReply.includes('bug005_test_t5');

    // Phase 3 — hard refresh + 10s + real field value (ground truth).
    await gotoSocialMediaStep(sharedPage);
    await sharedPage.waitForTimeout(10_000);
    await sharedPage.reload();
    await gotoSocialMediaStep(sharedPage);
    const phase3Value = await readInstagramField(sharedPage);
    const phase3Reflects = phase3Value === testUrl;

    let result: ScenarioRecord;
    if (phase2Reflects && phase3Reflects) {
      result = {
        id: 'T5',
        tool: 'update_facility_info(field=instagram_link)',
        trigger: `غيّري رابط الإنستقرام لـ: ${testUrl}`,
        resultCode: 'CLEAN',
        retryNeeded: false,
        duplicateOnRetry: 'NA',
        evidence: `write_reply="${writeReply}" | phase2_read="${readReply}" | phase3_field_value="${phase3Value}"`,
      };
    } else {
      // Phase 4 — retry.
      await gotoAiInstructionStep(sharedPage);
      const retryAt = Date.now();
      const { replies: retryReplies } = await sendAndConfirm(sharedPage, `غيّري رابط الإنستقرام لـ: ${testUrl}`);
      const retryReply = retryReplies[retryReplies.length - 1].text;
      await gotoSocialMediaStep(sharedPage);
      await sharedPage.waitForTimeout(10_000);
      await sharedPage.reload();
      await gotoSocialMediaStep(sharedPage);
      const afterRetryValue = await readInstagramField(sharedPage);
      // Fields can't hold a "duplicate" — a second successful write just
      // overwrites the same value. RETRY_DUPLICATE/SINGLE doesn't map here;
      // classify by whether it ever converged.
      result = {
        id: 'T5',
        tool: 'update_facility_info(field=instagram_link)',
        trigger: `غيّري رابط الإنستقرام لـ: ${testUrl}`,
        resultCode: afterRetryValue === testUrl ? 'FALSE_SUCCESS_LAG' : 'FALSE_SUCCESS_TRUE_FAIL',
        retryNeeded: true,
        duplicateOnRetry: 'NA',
        convergenceDelayMs: phase3Reflects ? retryAt - writeAt : undefined,
        evidence:
          `write_reply="${writeReply}" | phase2_read="${readReply}" | phase2_reflects=${phase2Reflects} | ` +
          `phase3_field_value="${phase3Value}" | phase3_reflects=${phase3Reflects} | ` +
          `retry_reply="${retryReply}" | after_retry_value="${afterRetryValue}"`,
      };
    }
    recorder.record(result);

    // Cleanup — restore original value.
    await gotoAiInstructionStep(sharedPage);
    if (originalUrl) {
      await sendAndConfirm(sharedPage, `رجّعي رابط الإنستقرام للأصلي: ${originalUrl}`);
    } else {
      await sendAndConfirm(sharedPage, 'احذفي رابط الإنستقرام');
    }
    await gotoSocialMediaStep(sharedPage);
    const restoredValue = await readInstagramField(sharedPage);
    recorder.setCleanup('Instagram link reverted to baseline', restoredValue === originalUrl);
    await gotoAiInstructionStep(sharedPage); // leave the shared page where T1-T4/T10-T12 expect it
  });

  // --- T6-T9: no confirmed DOM selector found for these panels within this
  // task's budget. See file header comment. Stubbed honestly rather than
  // faking a mechanical check. ---
  test('T6 update_facility_info(field=manager_phone) — feature not found in codebase', async () => {
    recorder.record({
      id: 'T6',
      tool: 'update_facility_info(field=manager_phone)',
      trigger: '(not implemented)',
      resultCode: 'UNABLE_TO_TEST',
      retryNeeded: false,
      duplicateOnRetry: 'NA',
      evidence:
        'Exhaustive search found no manager/responsible/owner phone field anywhere: not in ' +
        'social-media.blade.php (full 3000+ line read, incl. the inline facility-info step, ' +
        'card2.blade.php, step-ai-instruction.blade.php), not in $myClinic-bound data, not in any ' +
        'migration or model. Only phone-like fields found (user_infos.phone_number, ' +
        'manual.blade.php#phone_number) belong to unrelated features (account profile, manual report ' +
        'form), not the Maha wizard. If this Maha tool exists in the live prompt, it has no real ' +
        'backing field to write to — flag to Adi rather than guess a selector.',
    });
    test.skip();
  });

  test('T7 update_retargeting_settings(discount_pct)', async ({ sharedPage }) => {
    await gotoRetargetSettings(sharedPage);
    const originalDiscount = await readRetargetDiscount(sharedPage);
    const testValue = '15';

    await gotoAiInstructionStep(sharedPage);
    const writeAt = Date.now();
    const { replies: writeReplies } = await sendAndConfirm(sharedPage, `غيّري نسبة خصم إعادة الاستهداف لـ ${testValue}%`);
    const writeReply = writeReplies[writeReplies.length - 1].text;

    const { replies: readReplies } = await sendAndConfirm(sharedPage, 'أعطيني نسبة خصم إعادة الاستهداف الحالية');
    const readReply = readReplies[readReplies.length - 1].text;
    const phase2Reflects = readReply.includes(testValue);

    await sharedPage.waitForTimeout(10_000);
    await sharedPage.reload();
    await gotoRetargetSettings(sharedPage);
    const phase3Value = await readRetargetDiscount(sharedPage);
    const phase3Reflects = phase3Value === testValue;

    let result: ScenarioRecord;
    if (phase2Reflects && phase3Reflects) {
      result = {
        id: 'T7',
        tool: 'update_retargeting_settings(discount_pct)',
        trigger: `غيّري نسبة خصم إعادة الاستهداف لـ ${testValue}%`,
        resultCode: 'CLEAN',
        retryNeeded: false,
        duplicateOnRetry: 'NA',
        evidence: `write_reply="${writeReply}" | phase2_read="${readReply}" | phase3_field_value="${phase3Value}"`,
      };
    } else {
      await gotoAiInstructionStep(sharedPage);
      const retryAt = Date.now();
      const { replies: retryReplies } = await sendAndConfirm(sharedPage, `غيّري نسبة خصم إعادة الاستهداف لـ ${testValue}%`);
      const retryReply = retryReplies[retryReplies.length - 1].text;
      await sharedPage.waitForTimeout(10_000);
      await sharedPage.reload();
      await gotoRetargetSettings(sharedPage);
      const afterRetryValue = await readRetargetDiscount(sharedPage);
      result = {
        id: 'T7',
        tool: 'update_retargeting_settings(discount_pct)',
        trigger: `غيّري نسبة خصم إعادة الاستهداف لـ ${testValue}%`,
        resultCode: afterRetryValue === testValue ? 'FALSE_SUCCESS_LAG' : 'FALSE_SUCCESS_TRUE_FAIL',
        retryNeeded: true,
        duplicateOnRetry: 'NA', // single field, no duplicate-row concept
        convergenceDelayMs: phase3Reflects ? retryAt - writeAt : undefined,
        evidence:
          `write_reply="${writeReply}" | phase2_read="${readReply}" | phase2_reflects=${phase2Reflects} | ` +
          `phase3_field_value="${phase3Value}" | phase3_reflects=${phase3Reflects} | ` +
          `retry_reply="${retryReply}" | after_retry_value="${afterRetryValue}"`,
      };
    }
    recorder.record(result);

    // Cleanup — restore original value.
    await gotoAiInstructionStep(sharedPage);
    await sendAndConfirm(sharedPage, `رجّعي نسبة خصم إعادة الاستهداف لـ ${originalDiscount}%`);
    await gotoRetargetSettings(sharedPage);
    const restored = await readRetargetDiscount(sharedPage);
    recorder.setCleanup('Retargeting discount reverted to baseline', restored === originalDiscount);
    await gotoAiInstructionStep(sharedPage);
  });

  test('T8 update_report_branding(show_mobile_number) — toggle round-trip', async ({ sharedPage }) => {
    await gotoMyReportSettings(sharedPage);
    const originalChecked = await readDisplayPhoneChecked(sharedPage);

    await gotoAiInstructionStep(sharedPage);
    const writeAt = Date.now();
    const { replies: writeReplies } = await sendAndConfirm(sharedPage, 'أخفي رقم الجوال من التقرير');
    const writeReply = writeReplies[writeReplies.length - 1].text;

    const { replies: readReplies } = await sendAndConfirm(sharedPage, 'هل رقم الجوال ظاهر في التقرير الحالي؟');
    const readReply = readReplies[readReplies.length - 1].text;
    const phase2Reflects = /مخفي|لا|غير ظاهر|hidden/i.test(readReply);

    await sharedPage.waitForTimeout(10_000);
    await sharedPage.reload();
    await gotoMyReportSettings(sharedPage);
    const phase3Checked = await readDisplayPhoneChecked(sharedPage);
    const phase3Reflects = phase3Checked === false; // "hide" means display_phone should now be false

    let result: ScenarioRecord;
    if (phase2Reflects && phase3Reflects) {
      result = {
        id: 'T8',
        tool: 'update_report_branding(show_mobile_number=false)',
        trigger: 'أخفي رقم الجوال من التقرير',
        resultCode: 'CLEAN',
        retryNeeded: false,
        duplicateOnRetry: 'NA',
        evidence: `write_reply="${writeReply}" | phase2_read="${readReply}" | phase3_checked=${phase3Checked}`,
      };
    } else {
      await gotoAiInstructionStep(sharedPage);
      const retryAt = Date.now();
      const { replies: retryReplies } = await sendAndConfirm(sharedPage, 'أخفي رقم الجوال من التقرير');
      const retryReply = retryReplies[retryReplies.length - 1].text;
      await sharedPage.waitForTimeout(10_000);
      await sharedPage.reload();
      await gotoMyReportSettings(sharedPage);
      const afterRetryChecked = await readDisplayPhoneChecked(sharedPage);
      result = {
        id: 'T8',
        tool: 'update_report_branding(show_mobile_number=false)',
        trigger: 'أخفي رقم الجوال من التقرير',
        resultCode: afterRetryChecked === false ? 'FALSE_SUCCESS_LAG' : 'FALSE_SUCCESS_TRUE_FAIL',
        retryNeeded: true,
        duplicateOnRetry: 'NA',
        convergenceDelayMs: phase3Reflects ? retryAt - writeAt : undefined,
        evidence:
          `write_reply="${writeReply}" | phase2_read="${readReply}" | phase2_reflects=${phase2Reflects} | ` +
          `phase3_checked=${phase3Checked} | phase3_reflects=${phase3Reflects} | ` +
          `retry_reply="${retryReply}" | after_retry_checked=${afterRetryChecked}`,
      };
    }
    recorder.record(result);

    // Cleanup — restore original toggle state.
    await gotoAiInstructionStep(sharedPage);
    await sendAndConfirm(sharedPage, 'رجّعي إظهار رقم الجوال في التقرير');
    await gotoMyReportSettings(sharedPage);
    const restoredChecked = await readDisplayPhoneChecked(sharedPage);
    recorder.setCleanup('Report branding phone toggle reverted to baseline', restoredChecked === originalChecked);
    await gotoAiInstructionStep(sharedPage);
  });

  test('T9 update_doctor(note) — feature not found in codebase', async () => {
    recorder.record({
      id: 'T9',
      tool: 'update_doctor(note)',
      trigger: '(not implemented)',
      resultCode: 'UNABLE_TO_TEST',
      retryNeeded: false,
      duplicateOnRetry: 'NA',
      evidence:
        'Exhaustive search found no doctor-note field anywhere: myDoctors/*.blade.php (card, table, ' +
        'modal-action, modal-edit-confirm, modal-add-sub-*, modal-wa-linked, modal-confirm-delete, ' +
        'modal-edit-blocked) has no textarea/note field; no "note"/"ملاحظة" column in any migration or ' +
        'model; no Doctor.php model exists at all. The only unrelated "note"-adjacent hits across ' +
        'resources/views/front/customer/ were voice notes (myReport/myMessage/wallet) and ' +
        'imageDiagnosis.blade.php\'s doctor_review textarea (a report review field, not a doctor-profile ' +
        'note). If this Maha tool exists in the live prompt, it has no real backing field — flag to Adi.',
    });
    test.skip();
  });

  test('T10 rapid-fire back-to-back saves (stress test)', async ({ sharedPage }) => {
    // 3 sequential writes, each up to 180s worst-case on confirm-round
    // pileups (see beforeEach comment), plus a same-shaped retry pass for
    // whichever ones didn't stick — budget well above the per-file default.
    test.setTimeout(720_000);
    const result = await runRapidFireProbe(sharedPage, {
      id: 'T10',
      tool: 'save_instruction() x3 rapid-fire',
      markers: T10_MARKERS,
      writeTriggers: [
        `احفظي قاعدة: ${T10_MARKERS[0]} اختبار سرعة الحفظ الأول`,
        `احفظي قاعدة: ${T10_MARKERS[1]} اختبار سرعة الحفظ الثاني`,
        `احفظي قاعدة: ${T10_MARKERS[2]} اختبار سرعة الحفظ الثالث`,
      ],
    });
    recorder.record(result);

    // Cleanup whichever of these actually persisted — retries with an
    // escalating wait until each one is confirmed gone (see
    // deleteMarkerUntilGone's comment: a single delete-and-check left
    // leftovers behind in 3/3 recent runs and blocked the next baseline).
    const finalState = await getInstructionPanelState(sharedPage);
    const cleanupOutcomes: string[] = [];
    for (const marker of T10_MARKERS) {
      if (finalState.rows.some((r) => r.text.includes(marker))) {
        const outcome = await deleteMarkerUntilGone(sharedPage, marker);
        cleanupOutcomes.push(`${marker}:${outcome.success ? 'ok' : 'FAILED'}(${outcome.attempts} attempts)`);
      }
    }
    const allDeleted = !cleanupOutcomes.some((o) => o.includes('FAILED'));
    recorder.setCleanup('T10 rapid-fire markers deleted', allDeleted);
    if (cleanupOutcomes.length) {
      recorder.noteAnomaly(`T10 cleanup delete attempts: ${cleanupOutcomes.join(', ')}`);
    }
  });

  test('T11 same-turn write-then-read consistency', async ({ sharedPage }) => {
    const writeAt = Date.now();
    const { replies } = await sendAndConfirm(
      sharedPage,
      `أضيفي قاعدة ${T11_MARKER} عيادتنا مغلقة يوم الجمعة، وبعد ما تحفظينها اعرضي لي القاعدة`
    );
    const combinedReply = replies.map((r) => r.text).join(' || ');
    const claimsSuccessAndShowsIt = combinedReply.includes(T11_MARKER);

    const phase3State = await phase3DelayedRead(sharedPage);
    const actuallyPersisted = phase3State.rows.some((r) => r.text.includes(T11_MARKER));

    let result: ScenarioRecord;
    if (claimsSuccessAndShowsIt && actuallyPersisted) {
      result = {
        id: 'T11',
        tool: 'save_instruction() + list_instructions() same turn',
        trigger: `أضيفي قاعدة ${T11_MARKER} ... وبعد ما تحفظينها اعرضي لي القاعدة`,
        resultCode: 'CLEAN',
        retryNeeded: false,
        duplicateOnRetry: 'NA',
        marker: T11_MARKER,
        evidence: `combined_reply="${combinedReply}" | actually_persisted=${actuallyPersisted}`,
      };
    } else {
      // Own-turn self-contradiction or true failure — retry once, per methodology.
      const retryAt = Date.now();
      const { replies: retryReplies } = await sendAndConfirm(
        sharedPage,
        `أضيفي قاعدة ${T11_MARKER} عيادتنا مغلقة يوم الجمعة، وبعد ما تحفظينها اعرضي لي القاعدة`
      );
      const retryReply = retryReplies.map((r) => r.text).join(' || ');
      const afterRetryState = await phase3DelayedRead(sharedPage);
      const matchCount = afterRetryState.rows.filter((r) => r.text.includes(T11_MARKER)).length;
      result = {
        id: 'T11',
        tool: 'save_instruction() + list_instructions() same turn',
        trigger: `أضيفي قاعدة ${T11_MARKER} ... وبعد ما تحفظينها اعرضي لي القاعدة`,
        resultCode: matchCount >= 2 ? 'RETRY_DUPLICATE' : matchCount === 1 ? 'RETRY_SINGLE' : 'FALSE_SUCCESS_TRUE_FAIL',
        retryNeeded: true,
        duplicateOnRetry: matchCount >= 2 ? 'Y' : 'N',
        convergenceDelayMs: actuallyPersisted ? retryAt - writeAt : undefined,
        marker: T11_MARKER,
        evidence:
          `combined_reply="${combinedReply}" | claims_success_and_shows_it=${claimsSuccessAndShowsIt} | ` +
          `actually_persisted_before_retry=${actuallyPersisted} | retry_reply="${retryReply}" | after_retry_count=${matchCount}`,
      };
    }
    recorder.record(result);

    // Cleanup — retries with an escalating wait until confirmed gone (see
    // deleteMarkerUntilGone's comment).
    const finalState = await getInstructionPanelState(sharedPage);
    if (finalState.rows.some((r) => r.text.includes(T11_MARKER))) {
      const outcome = await deleteMarkerUntilGone(sharedPage, T11_MARKER);
      recorder.setCleanup(`${T11_MARKER} deleted`, outcome.success);
      if (!outcome.success) {
        recorder.noteAnomaly(`${T11_MARKER} cleanup still not gone after ${outcome.attempts} delete attempts.`);
      }
    } else {
      recorder.setCleanup(`${T11_MARKER} deleted`, true);
    }
  });

  test('T12 retry-and-count check (targeted probe of option a vs b)', async ({ sharedPage }) => {
    test.setTimeout(420_000); // deliberate 60s wait, plus two writes that can each hit the confirm-round worst case

    const priorFalseSuccess = recorder
      .all()
      .find((r) => r.retryNeeded && r.marker && r.id !== 'T12');

    if (priorFalseSuccess) {
      // Branch 1 — a real false-success + retry already happened earlier in
      // this run (T1-T11). Wait 60s, refresh, count rows for that marker.
      await new Promise((r) => setTimeout(r, 60_000));
      const state = await phase3DelayedRead(sharedPage);
      const marker = priorFalseSuccess.marker!.split(',')[0]; // rapid-fire records join markers with ','
      const count = state.rows.filter((r) => r.text.includes(marker)).length;
      recorder.record({
        id: 'T12',
        tool: `retry-and-count follow-up on ${priorFalseSuccess.id}`,
        trigger: `(passive) waited 60s after ${priorFalseSuccess.id}'s retry, re-counted rows for ${marker}`,
        resultCode: count >= 2 ? 'RETRY_DUPLICATE' : 'RETRY_SINGLE',
        retryNeeded: false,
        duplicateOnRetry: count >= 2 ? 'Y' : 'N',
        evidence: `Following up on ${priorFalseSuccess.id} (${priorFalseSuccess.resultCode}). 60s post-retry row count for "${marker}": ${count}.`,
      });
      return;
    }

    // Branch 2 — nothing false-succeeded in T1-T11. Deliberately induce a
    // duplicate probe: add T12's own rule twice, with a real gap (not
    // rapid-fire), and see whether Maha detects the existing duplicate and
    // refuses, or silently creates a second row.
    // (Note: the runbook's literal T12 fallback re-adds T1's original rule —
    // but T1's rule was already renamed to T1_EDITED and deleted by T3's
    // cleanup by this point in the run, so that specific rule no longer
    // exists to duplicate. Using a fresh dedicated marker preserves the
    // actual diagnostic intent — does re-adding an existing, unmodified rule
    // produce a real duplicate row — without depending on T1/T3 ordering.)
    const addTrigger = `أضيفي قاعدة: ${T12_MARKER} قاعدة اختبار التكرار`;
    await sendAndConfirm(sharedPage, addTrigger);
    const { replies: secondReplies } = await sendAndConfirm(
      sharedPage,
      `أضيفي مرة ثانية نفس القاعدة ${T12_MARKER} قاعدة اختبار التكرار`
    );
    const secondReply = secondReplies[secondReplies.length - 1].text;
    const state = await phase3DelayedRead(sharedPage);
    const count = state.rows.filter((r) => r.text.includes(T12_MARKER)).length;
    const detectedDuplicate = /مكرر|already|موجود بالفعل|نفس القاعدة موجودة/i.test(secondReply);

    recorder.record({
      id: 'T12',
      tool: 'save_instruction() deliberate duplicate re-add',
      trigger: addTrigger + ' (then re-sent identically)',
      resultCode: count >= 2 ? 'RETRY_DUPLICATE' : 'RETRY_SINGLE',
      retryNeeded: true,
      duplicateOnRetry: count >= 2 ? 'Y' : 'N',
      marker: T12_MARKER,
      evidence: `second_add_reply="${secondReply}" | detected_duplicate_in_reply=${detectedDuplicate} | final_row_count=${count}`,
    });

    // Cleanup — delete all rows matching this marker, however many there are.
    // maxAttempts padded above `count` since each delete command may only
    // remove one row (duplicate case) and may itself need a retry to stick.
    if (count > 0) {
      const outcome = await deleteMarkerUntilGone(sharedPage, T12_MARKER, { maxAttempts: count + 2 });
      recorder.setCleanup(`${T12_MARKER} deleted (all copies)`, outcome.success);
      if (!outcome.success) {
        recorder.noteAnomaly(`${T12_MARKER} cleanup still not gone after ${outcome.attempts} delete attempts.`);
      }
    } else {
      recorder.setCleanup(`${T12_MARKER} deleted (all copies)`, true);
    }
  });

  test('BUG005-final — verify panel matches baseline exactly', async ({ sharedPage }) => {
    if (baselineCount === null) {
      recorder.noteAnomaly('Baseline panel state was never captured — BUG005-baseline test must have failed early.');
      return;
    }
    const finalState = await phase3DelayedRead(sharedPage);
    const finalTop3 = finalState.rows.slice(0, 3).map((r) => r.text);
    const countMatches = finalState.count === baselineCount;
    const top3Matches = JSON.stringify(finalTop3) === JSON.stringify(baselineTop3);

    recorder.setCleanup(`Panel count matches baseline (${baselineCount})`, countMatches);
    recorder.setCleanup('Top-3 rules match baseline verbatim', top3Matches);

    if (!countMatches || !top3Matches) {
      recorder.noteAnomaly(
        `Baseline mismatch after cleanup — baseline_count=${baselineCount} final_count=${finalState.count} | ` +
          `baseline_top3=[${baselineTop3.join(' | ')}] final_top3=[${finalTop3.join(' | ')}]. ` +
          `Per the runbook, a cleanup mismatch is itself diagnostic data on BUG-005, not just a test-hygiene issue.`
      );
    }
  });

  test.afterAll(async () => {
    const { mdPath } = await recorder.writeTo('reports');
    console.log(`BUG-005 report written to ${mdPath}`);
  });
});
