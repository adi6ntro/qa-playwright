import { test, expect } from '../../helpers/fixtures';
import {
  sendMessage,
  sendAndConfirm,
  getInstructionPanelState,
  refreshAndReturnToStep,
} from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';

/**
 * Section B — WRITE tools: MYFACILITY, per
 * docs/handover/QA_Runbook_Reporty_In-App_Maha_Integration_Test.md.
 *
 * B11-B14 (save/update/remove/reset instruction) get real mechanical
 * verification (count deltas + refresh-persistence), not just NEEDS_REVIEW —
 * this is the exact area where two real P0 bugs were found in prod
 * (see project_ob3_prod_audit_2026-08-03.md, items 3 and 9):
 *   - confirm-identity mismatch: saving/updating/deleting can silently need
 *     2-4 confirmation rounds before it actually goes through. This script
 *     records confirmRoundsNeeded so a spike is visible in the report
 *     without having to re-read raw prod logs.
 *   - rapid-fire fabricated success: a "Saved ✅" reply with zero backing
 *     tool call. The dedicated B11-RAPID test at the end reproduces exactly
 *     that scenario (BUG005_TEST_T10a/b/c from the prod incident) so this
 *     file doubles as a regression check once a fix ships.
 *
 * Only B1, B2, B5, B11-B14 are implemented below (the fields/tools most
 * relevant to the known bugs + cheap to verify mechanically). B3, B4, B6-B10,
 * B15-B17 are stubbed as NEEDS_REVIEW/UNABLE_TO_TEST placeholders — same
 * pattern, just add the trigger + verify per the runbook when needed.
 */

const recorder = new ReportRecorder('Section B - MyFacility Writes');

test.describe.serial('Section B — WRITE tools: MyFacility', () => {
  test('B1 update_facility_info(field=clinic_name)', async ({ sharedPage }) => {
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(
      sharedPage,
      "عدلي اسم العيادة إلى 'TEST_CLINIC_2026'"
    );
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B1',
      tool: "update_facility_info(field='clinic_name', value)",
      trigger: "عدلي اسم العيادة إلى 'TEST_CLINIC_2026'",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
      confirmRoundsNeeded,
    });

    // Cleanup — revert. Use TEST_CLINIC_NAME_ORIGINAL if you captured the
    // real baseline name via A1 first; otherwise adjust manually.
    const originalName = process.env.TEST_CLINIC_NAME_ORIGINAL;
    if (originalName) {
      await sendAndConfirm(sharedPage, `عدلي اسم العيادة إلى '${originalName}'`);
    }
  });

  test('B5 update_social_media_link(instagram)', async ({ sharedPage }) => {
    const testUrl = 'https://instagram.com/test_reporty_2026';
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(
      sharedPage,
      `أضيفي رابط انستقرام: ${testUrl}`
    );
    const last = replies[replies.length - 1];
    const echoed = last.text.includes(testUrl);
    recorder.record({
      id: 'B5',
      tool: 'update_social_media_link(platform, url)',
      trigger: `أضيفي رابط انستقرام: ${testUrl}`,
      result: echoed ? 'NEEDS_REVIEW' : 'FAIL',
      evidence: last.text,
      confirmRoundsNeeded,
    });

    // Cleanup — restore original if known.
    const originalUrl = process.env.TEST_INSTAGRAM_ORIGINAL;
    if (originalUrl) {
      await sendAndConfirm(sharedPage, `رجّعي رابط الإنستقرام للأصلي: ${originalUrl}`);
    }
  });

  test('B11 save_instruction — with real persistence + confirm-round check', async ({ sharedPage }) => {
    const before = await getInstructionPanelState(sharedPage);
    const testText = 'TEST_RULE_2026 — تعليمة اختبار';

    const { replies, confirmRoundsNeeded } = await sendAndConfirm(
      sharedPage,
      `أضيفي قاعدة: ${testText}`
    );
    const last = replies[replies.length - 1];

    const afterChat = await getInstructionPanelState(sharedPage);
    const countMovedByOne =
      before.count !== null && afterChat.count !== null && afterChat.count === before.count + 1;
    const verbatimPresent = afterChat.rows.some((r) => r.text.includes(testText));

    const afterRefresh = await refreshAndReturnToStep(sharedPage);
    const persisted = afterRefresh.rows.some((r) => r.text.includes(testText));

    recorder.record({
      id: 'B11',
      tool: 'save_instruction(instruction_text, position?)',
      trigger: `أضيفي قاعدة: ${testText}`,
      result: countMovedByOne && verbatimPresent && persisted ? 'PASS' : 'FAIL',
      evidence: `reply="${last.text}" | before_count=${before.count} after_count=${afterChat.count} verbatim_in_panel=${verbatimPresent} persisted_after_refresh=${persisted}`,
      confirmRoundsNeeded,
      persisted,
    });

    // Leave TEST_RULE_2026 in place — B12/B13 depend on it existing.
    expect(persisted, 'save_instruction must actually persist, not just claim success in chat').toBe(true);
  });

  test('B11-second-angle save_instruction empty text should reject', async ({ sharedPage }) => {
    const before = await getInstructionPanelState(sharedPage);
    const { replies } = await sendAndConfirm(sharedPage, 'أضيفي قاعدة فارغة بدون أي نص');
    const after = await getInstructionPanelState(sharedPage);
    const rejected = before.count === after.count;
    recorder.record({
      id: 'B11b',
      tool: 'save_instruction(instruction_text="") — reject-empty angle',
      trigger: 'أضيفي قاعدة فارغة بدون أي نص',
      result: rejected ? 'PASS' : 'FAIL',
      evidence: `reply="${replies[replies.length - 1].text}" before_count=${before.count} after_count=${after.count}`,
    });
  });

  test('B12 update_instruction — depends on B11 TEST_RULE_2026', async ({ sharedPage }) => {
    const before = await getInstructionPanelState(sharedPage);
    const updatedText = 'TEST_RULE_2026 UPDATED';

    const { replies, confirmRoundsNeeded } = await sendAndConfirm(
      sharedPage,
      `عدلي قاعدة TEST_RULE_2026 لتصبح: ${updatedText}`
    );
    const last = replies[replies.length - 1];

    const afterChat = await getInstructionPanelState(sharedPage);
    const counterUnchanged = before.count !== null && afterChat.count === before.count;
    const verbatimPresent = afterChat.rows.some((r) => r.text.includes(updatedText));

    const afterRefresh = await refreshAndReturnToStep(sharedPage);
    const persisted = afterRefresh.rows.some((r) => r.text.includes(updatedText));

    recorder.record({
      id: 'B12',
      tool: 'update_instruction(instruction_id, new_text)',
      trigger: `عدلي قاعدة TEST_RULE_2026 لتصبح: ${updatedText}`,
      result: counterUnchanged && verbatimPresent && persisted ? 'PASS' : 'FAIL',
      evidence: `reply="${last.text}" | before_count=${before.count} after_count=${afterChat.count} verbatim_in_panel=${verbatimPresent} persisted_after_refresh=${persisted}`,
      confirmRoundsNeeded,
      persisted,
    });

    expect(persisted, 'update_instruction must actually persist').toBe(true);
  });

  test('B13 remove_instruction — depends on B12 TEST_RULE_2026 UPDATED', async ({ sharedPage }) => {
    const before = await getInstructionPanelState(sharedPage);

    const { replies, confirmRoundsNeeded } = await sendAndConfirm(
      sharedPage,
      'احذفي قاعدة TEST_RULE_2026 UPDATED'
    );
    const last = replies[replies.length - 1];

    const afterChat = await getInstructionPanelState(sharedPage);
    const countMovedByMinusOne =
      before.count !== null && afterChat.count !== null && afterChat.count === before.count - 1;
    const goneFromPanel = !afterChat.rows.some((r) => r.text.includes('TEST_RULE_2026'));

    const afterRefresh = await refreshAndReturnToStep(sharedPage);
    const stayedGone = !afterRefresh.rows.some((r) => r.text.includes('TEST_RULE_2026'));

    recorder.record({
      id: 'B13',
      tool: 'remove_instruction(instruction_id)',
      trigger: 'احذفي قاعدة TEST_RULE_2026 UPDATED',
      result: countMovedByMinusOne && goneFromPanel && stayedGone ? 'PASS' : 'FAIL',
      evidence: `reply="${last.text}" | before_count=${before.count} after_count=${afterChat.count} gone_from_panel=${goneFromPanel} stayed_gone_after_refresh=${stayedGone}`,
      confirmRoundsNeeded,
      persisted: stayedGone,
    });

    expect(stayedGone, 'remove_instruction must actually persist the deletion').toBe(true);
  });

  test('B14 reset_all_instructions() — DESTRUCTIVE, opt-in only', async ({ sharedPage }) => {
    if (process.env.ALLOW_DESTRUCTIVE_RESET !== '1') {
      recorder.record({
        id: 'B14',
        tool: 'reset_all_instructions()',
        trigger: '(skipped)',
        result: 'UNABLE_TO_TEST',
        evidence:
          'Skipped by default — wipes ALL real production instructions. Set ALLOW_DESTRUCTIVE_RESET=1 ' +
          'and only run against a burner/test clinic to actually exercise this.',
      });
      test.skip();
      return;
    }
    const before = await getInstructionPanelState(sharedPage);
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(sharedPage, 'صفّري كل قواعد مها');
    const after = await getInstructionPanelState(sharedPage);
    recorder.record({
      id: 'B14',
      tool: 'reset_all_instructions()',
      trigger: 'صفّري كل قواعد مها',
      result: after.count === 0 ? 'PASS' : 'FAIL',
      evidence: `reply="${replies[replies.length - 1].text}" before_count=${before.count} after_count=${after.count}`,
      confirmRoundsNeeded,
    });
  });

  /**
   * Reproduces BUG005_TEST_T10a/b/c from the 2026-08-03 prod incident
   * (project_ob3_prod_audit_2026-08-03.md, item 9): firing consecutive save
   * requests without the usual settle time between them. Live prod showed
   * Maha claim "Saved ✅" with a fabricated incrementing count and ZERO real
   * tool calls, because the fabrication-detector's own corrective retry
   * crashed on a Vertex "too many states for serving" 400 and failed open.
   *
   * This test doesn't inspect server logs (a browser script can't) — it
   * verifies the one thing that matters from the user's side: does a REAL
   * list_instructions() readback (after a page refresh) actually contain
   * every rule Maha claimed to save? If not, that's the bug, reproduced.
   */
  test('B11-RAPID rapid consecutive saves — regression check for known fabrication bug', async ({
    sharedPage,
  }) => {
    const before = await getInstructionPanelState(sharedPage);
    const labels = ['RAPID_TEST_A', 'RAPID_TEST_B', 'RAPID_TEST_C'];
    const claims: string[] = [];

    for (const label of labels) {
      const { replies } = await sendAndConfirm(sharedPage, `احفظي قاعدة: [${label}] اختبار سرعة الحفظ`);
      claims.push(replies[replies.length - 1].text);
    }

    const afterRefresh = await refreshAndReturnToStep(sharedPage);
    const actuallySaved = labels.filter((label) =>
      afterRefresh.rows.some((r) => r.text.includes(label))
    );

    const allSaved = actuallySaved.length === labels.length;
    recorder.record({
      id: 'B11-RAPID',
      tool: 'save_instruction() x3 rapid-fire',
      trigger: '3x "احفظي قاعدة: [RAPID_TEST_X] ..." sent back-to-back',
      result: allSaved ? 'PASS' : 'FAIL',
      evidence: `claimed_saved_in_chat=${claims.length} actually_persisted=${actuallySaved.length}/${labels.length} (${actuallySaved.join(
        ', '
      )}) | before_count=${before.count} after_refresh_count=${afterRefresh.count} | chat replies: ${claims.join(
        ' || '
      )}`,
    });

    // Cleanup whichever of these did save.
    for (const label of actuallySaved) {
      await sendAndConfirm(sharedPage, `احذفي القاعدة اللي فيها كلمة ${label}`);
    }

    expect(
      allSaved,
      'every rapid-fire save claimed in chat must actually persist — if this fails, the known ' +
        'fabrication bug (item 9, project_ob3_prod_audit_2026-08-03.md) has NOT been fixed yet'
    ).toBe(true);
  });

  test('B2 update_facility_info(address)', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي عنوان العيادة إلى 'شارع الملك فهد، الرياض — TEST'");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B2',
      tool: "update_facility_info(field='address', value)",
      trigger: "عدلي عنوان العيادة إلى 'شارع الملك فهد، الرياض — TEST'",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B3 update_facility_info(agent_language)', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "غيري لغة المها إلى الإنجليزية");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B3',
      tool: "update_facility_info(field='agent_language', value)",
      trigger: "غيري لغة المها إلى الإنجليزية",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B4 update_facility_info(agent_country)', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "غيري بلد العيادة إلى الإمارات");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B4',
      tool: "update_facility_info(field='agent_country', value)",
      trigger: "غيري بلد العيادة إلى الإمارات",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B6 trigger_get_information_ai', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "ابحثي في الإنترنت عن حسابات السوشيال ميديا للعيادة");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B6',
      tool: 'trigger_get_information_ai(clinic_name)',
      trigger: "ابحثي في الإنترنت عن حسابات السوشيال ميديا للعيادة",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B7 add_schedule_block', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أضيفي يوم دوام: الأربعاء من 9 صباحًا إلى 9 مساءً");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B7',
      tool: 'add_schedule_block(day, open_time, close_time)',
      trigger: "أضيفي يوم دوام: الأربعاء من 9 صباحًا إلى 9 مساءً",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B8 update_schedule_block', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي بلوك الأربعاء ليصير من 10 صباحًا إلى 8 مساءً");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B8',
      tool: 'update_schedule_block(block_id, ...)',
      trigger: "عدلي بلوك الأربعاء ليصير من 10 صباحًا إلى 8 مساءً",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B9 remove_schedule_block', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "احذفي بلوك الأربعاء");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B9',
      tool: 'remove_schedule_block(block_id)',
      trigger: "احذفي بلوك الأربعاء",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B10 update_insurance_list', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أضيفي شركة تأمين 'TEST_INSURANCE_2026' إلى القائمة");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B10',
      tool: 'update_insurance_list(insurance[])',
      trigger: "أضيفي شركة تأمين 'TEST_INSURANCE_2026' إلى القائمة",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B15 add_promotion', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أضيفي عرض: 'TEST_PROMO_2026' وصف 'اختبار' يبدأ اليوم وينتهي بعد أسبوع");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B15',
      tool: 'add_promotion(name, description, start_date, end_date)',
      trigger: "أضيفي عرض: 'TEST_PROMO_2026' وصف 'اختبار' يبدأ اليوم وينتهي بعد أسبوع",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B16 update_promotion', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي عرض TEST_PROMO_2026 وخلي وصفه 'اختبار محدث'");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B16',
      tool: 'update_promotion(promotion_id, ...)',
      trigger: "عدلي عرض TEST_PROMO_2026 وخلي وصفه 'اختبار محدث'",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test('B17 remove_promotion', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "احذفي عرض TEST_PROMO_2026");
    const last = replies[replies.length - 1];
    recorder.record({
      id: 'B17',
      tool: 'remove_promotion(promotion_id)',
      trigger: "احذفي عرض TEST_PROMO_2026",
      result: 'NEEDS_REVIEW',
      evidence: last.text,
    });
  });

  test.afterAll(async () => {
    await recorder.writeTo('reports');
  });
});
