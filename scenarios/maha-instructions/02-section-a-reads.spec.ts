import { test, expect } from '../../helpers/fixtures';
import { sendMessage, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';

/**
 * Section A — READ tools (18 tools), per
 * docs/handover/QA_Runbook_Reporty_In-App_Maha_Integration_Test.md.
 *
 * Reads are non-destructive, so this file just sends each trigger and
 * captures Maha's reply as evidence. Whether the reply's CONTENT is correct
 * (matches the panel, isn't fabricated, etc.) is exactly the kind of
 * judgement call this script deliberately does not make automatically —
 * every row is recorded NEEDS_REVIEW with the full reply text, for a human
 * or a follow-up LLM pass to classify against the runbook's Verify notes.
 */

const recorder = new ReportRecorder('Section A - Reads');

test.describe.serial('Section A — READ tools', () => {
  test('A1 read_facility_state()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'اعرضي لي كل إعدادات المنشأة');
    recorder.record({
      id: 'A1',
      tool: 'read_facility_state()',
      trigger: 'اعرضي لي كل إعدادات المنشأة',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
    expect(reply.text.length).toBeGreaterThan(0);
  });

  test('A2 read_schedule_settings()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'أعطيني إعدادات جدول المواعيد الحالية');
    recorder.record({
      id: 'A2',
      tool: 'read_schedule_settings()',
      trigger: 'أعطيني إعدادات جدول المواعيد الحالية',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A3 read_appointments()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'اعرضي المواعيد لهذا الأسبوع');
    recorder.record({
      id: 'A3',
      tool: 'read_appointments(date_range, doctor_id?, specialty?)',
      trigger: 'اعرضي المواعيد لهذا الأسبوع',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A4 read_doctors()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'أعطيني قائمة الأطباء الحاليين في العيادة');
    recorder.record({
      id: 'A4',
      tool: 'read_doctors()',
      trigger: 'أعطيني قائمة الأطباء الحاليين في العيادة',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A5 read_doctor_schedule(doctor_id)', async ({ sharedPage }) => {
    // Runbook: "[pick a real doctor from A4]" — needs a name filled in per-clinic.
    const doctorName = process.env.TEST_DOCTOR_NAME;
    if (!doctorName) {
      recorder.record({
        id: 'A5',
        tool: 'read_doctor_schedule(doctor_id)',
        trigger: '(skipped)',
        result: 'UNABLE_TO_TEST',
        evidence: 'Set TEST_DOCTOR_NAME env var to a real doctor name from this clinic to enable this test.',
      });
      test.skip();
      return;
    }
    const trigger = `أعطيني جدول د. ${doctorName}`;
    const reply = await sendMessage(sharedPage, trigger);
    recorder.record({
      id: 'A5',
      tool: 'read_doctor_schedule(doctor_id)',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A6 read_treatment_list(doctor_id, search?, page?)', async ({ sharedPage }) => {
    const r1 = await sendMessage(sharedPage, "أعطيني قائمة علاجات د. نورة");
    const r2 = await sendMessage(sharedPage, "ابحثي عن 'تنظيف' في قائمة علاجات د. نورة");
    recorder.record({
      id: 'A6',
      tool: 'read_treatment_list(doctor_id, search?, page?)',
      trigger: "أعطيني قائمة علاجات د. نورة / ابحثي عن 'تنظيف' ...",
      result: 'NEEDS_REVIEW',
      evidence: `[list] ${r1.text} | [search] ${r2.text}`,
    });
  });

  test('A7 read_retargeting_settings()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'أعطيني إعدادات إعادة الاستهداف');
    recorder.record({
      id: 'A7',
      tool: 'read_retargeting_settings()',
      trigger: 'أعطيني إعدادات إعادة الاستهداف',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A8 read_retargeting_log(page?)', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'اعرضي لي آخر الرسائل المرسلة عن طريق إعادة الاستهداف');
    recorder.record({
      id: 'A8',
      tool: 'read_retargeting_log(page?)',
      trigger: 'اعرضي لي آخر الرسائل المرسلة عن طريق إعادة الاستهداف',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A9 read_report_branding()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'اعرضي لي إعدادات تقرير المريض الحالي');
    recorder.record({
      id: 'A9',
      tool: 'read_report_branding()',
      trigger: 'اعرضي لي إعدادات تقرير المريض الحالي',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A10 read_account_profile()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'أعطيني بيانات ملفي الشخصي');
    const leakedPassword = /كلمة\s*المرور|password/i.test(reply.text);
    recorder.record({
      id: 'A10',
      tool: 'read_account_profile()',
      trigger: 'أعطيني بيانات ملفي الشخصي',
      result: leakedPassword ? 'FAIL' : 'NEEDS_REVIEW',
      evidence: leakedPassword
        ? `POSSIBLE PASSWORD FIELD LEAK: ${reply.text}`
        : reply.text,
    });
    expect(leakedPassword, 'reply should never surface a password field').toBe(false);
  });

  test('A11 read_subscription()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'أعطيني تفاصيل اشتراكي');
    recorder.record({
      id: 'A11',
      tool: 'read_subscription()',
      trigger: 'أعطيني تفاصيل اشتراكي',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A12 read_analytics() — expected 500 in dev, must not fabricate', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'اعرضي لي تحليلات أداء العيادة');
    const hasNumbers = /\d/.test(reply.text);
    const admitsUnavailable = /غير متاح|متوفر حاليا|حالياً غير|مؤقتا|later|unavailable/i.test(reply.text);
    recorder.record({
      id: 'A12',
      tool: 'read_analytics()',
      trigger: 'اعرضي لي تحليلات أداء العيادة',
      // Only auto-FAIL the clear fabrication case (looks like real metrics AND
      // doesn't admit unavailability); everything else needs a human look.
      result: hasNumbers && !admitsUnavailable ? 'FAIL' : 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A13 read_whatsapp_connection_status()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'هل الواتساب متصل حاليًا؟');
    recorder.record({
      id: 'A13',
      tool: 'read_whatsapp_connection_status()',
      trigger: 'هل الواتساب متصل حاليًا؟',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A14 list_instructions()', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'اعرضي لي كل قواعد مها المحفوظة');
    recorder.record({
      id: 'A14',
      tool: 'list_instructions()',
      trigger: 'اعرضي لي كل قواعد مها المحفوظة',
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A15 icd10_search(query)', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'ابحثي عن كود ICD10 للسكري');
    const saysOnlyInReportFlow = /تقرير|Dr\.\s*Aziz|د\.?\s*عزيز/i.test(reply.text);
    recorder.record({
      id: 'A15',
      tool: 'icd10_search(query)',
      trigger: 'ابحثي عن كود ICD10 للسكري',
      result: saysOnlyInReportFlow ? 'UNABLE_TO_TEST' : 'NEEDS_REVIEW',
      evidence: reply.text,
    });
  });

  test('A16 get_dental_chart_state(report_id?) — likely UNABLE_TO_TEST', async ({ sharedPage }) => {
    const reply = await sendMessage(sharedPage, 'أعطيني حالة مخطط الأسنان لآخر تقرير');
    recorder.record({
      id: 'A16',
      tool: 'get_dental_chart_state(report_id?)',
      trigger: 'أعطيني حالة مخطط الأسنان لآخر تقرير',
      result: 'UNABLE_TO_TEST',
      evidence: `${reply.text} — requires an active Dr. Norah report_id; verify manually in that flow.`,
    });
  });

  test('A17 show_report_preview()', async ({ sharedPage }) => {
    await sendMessage(sharedPage, 'اعرضي لي معاينة تقرير المريض');
    // This tool is supposed to render UI (inline preview or modal), not just chat text.
    const modalOrPreviewVisible = await sharedPage
      .locator('[class*="preview"], [id*="preview"], .modal.show, [role="dialog"]')
      .first()
      .isVisible()
      .catch(() => false);
    recorder.record({
      id: 'A17',
      tool: 'show_report_preview()',
      trigger: 'اعرضي لي معاينة تقرير المريض',
      result: modalOrPreviewVisible ? 'PASS' : 'FAIL',
      evidence: modalOrPreviewVisible
        ? 'A preview/modal-like element became visible after the trigger.'
        : 'No preview or modal element matched a generic [class*="preview"]/[role="dialog"] selector — verify manually, this generic selector may just be wrong for this UI.',
    });
  });

  test('A18 show_schedule_preview(doctor_id?, week?)', async ({ sharedPage }) => {
    await sendMessage(sharedPage, 'اعرضي لي معاينة الجدول لهذا الأسبوع');
    const modalOrPreviewVisible = await sharedPage
      .locator('[class*="preview"], [id*="preview"], .modal.show, [role="dialog"]')
      .first()
      .isVisible()
      .catch(() => false);
    recorder.record({
      id: 'A18',
      tool: 'show_schedule_preview(doctor_id?, week?)',
      trigger: 'اعرضي لي معاينة الجدول لهذا الأسبوع',
      result: modalOrPreviewVisible ? 'PASS' : 'FAIL',
      evidence: modalOrPreviewVisible
        ? 'A preview/modal-like element became visible after the trigger.'
        : 'No preview or modal element matched a generic [class*="preview"]/[role="dialog"] selector — verify manually, this generic selector may just be wrong for this UI.',
    });
  });

  test.afterAll(async () => {
    await recorder.writeTo('reports');
  });
});
