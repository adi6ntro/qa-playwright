import { test, expect } from '../../helpers/fixtures';
import { sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';

const recorder = new ReportRecorder('Remaining Tools (C-M)');

test.describe.serial('Full Tools Integration Test (Sections C-M)', () => {

  // --- SECTION C: Treatment Lists ---
  test('C1 add_treatment', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أضيفي علاج 'TEST_TREATMENT_2026' لد. نورة بسعر 999 ريال");
    recorder.record({ id: 'C1', tool: 'add_treatment', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('C2 update_treatment', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي سعر TEST_TREATMENT_2026 إلى 1500 ريال");
    recorder.record({ id: 'C2', tool: 'update_treatment', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('C3 remove_treatment', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "احذفي علاج TEST_TREATMENT_2026");
    recorder.record({ id: 'C3', tool: 'remove_treatment', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('C4 save_treatment_list_changes', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "احفظي تغييرات قائمة العلاجات");
    recorder.record({ id: 'C4', tool: 'save_treatment_list_changes', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('C5 change_treatment_list_currency', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "غيري عملة قائمة علاجات د. نورة إلى الدولار");
    recorder.record({ id: 'C5', tool: 'change_treatment_list_currency', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('C6 toggle_use_for_all_doctors', async () => {
    recorder.record({ id: 'C6', tool: 'toggle_use_for_all_doctors', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Destructive, aborted at confirmation step for safety." });
    test.skip();
  });

  // --- SECTION D: WhatsApp Connect ---
  test('D1 request_whatsapp_business_api_activation', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أبغى أفعل واتساب بيزنس API");
    recorder.record({ id: 'D1', tool: 'request_whatsapp_business_api_activation', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('D2 toggle_chat_mode', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "غيري إلى وضع الإعداد اليدوي");
    recorder.record({ id: 'D2', tool: 'toggle_chat_mode', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });

  // --- SECTION E: MySchedule ---
  test('E1 update_schedule_settings(no_show)', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "غيري حد عدم الحضور إلى 45");
    recorder.record({ id: 'E1', tool: 'update_schedule_settings(no_show)', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('E2 update_schedule_settings(auto_booking=false)', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عطلي الحجز التلقائي");
    recorder.record({ id: 'E2', tool: 'update_schedule_settings(auto_booking=false)', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('E3 update_schedule_settings(double_booking=true)', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "فعّلي الحجز المزدوج التلقائي");
    recorder.record({ id: 'E3', tool: 'update_schedule_settings(double_booking=true)', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('E4 setup_doctor_schedule', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي مدة الجلسة لد. نورة إلى 45 دقيقة");
    recorder.record({ id: 'E4', tool: 'setup_doctor_schedule', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('E5 add_appointment', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أضيفي موعد للمريض TEST_PATIENT بجوال 0500000000 مع د. نورة بكرة الساعة 3 عصرًا لمدة 30 دقيقة");
    recorder.record({ id: 'E5', tool: 'add_appointment', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('E6 cancel_appointment', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "ألغي موعد TEST_PATIENT مع د. نورة السبب: اختبار");
    recorder.record({ id: 'E6', tool: 'cancel_appointment', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('E7 reschedule_appointment', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أعيدي جدولة موعد TEST_PATIENT إلى بعد بكرة الساعة 4 عصرًا");
    recorder.record({ id: 'E7', tool: 'reschedule_appointment', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('E8 approve_pending_appointment', async () => {
    recorder.record({ id: 'E8', tool: 'approve_pending_appointment', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "No pending appointment available; requires seeding via patient side first." });
    test.skip();
  });
  test('E9 reject_pending_appointment', async () => {
    recorder.record({ id: 'E9', tool: 'reject_pending_appointment', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "No pending appointment available." });
    test.skip();
  });

  // --- SECTION F: MyDoctors ---
  test('F1 update_doctor', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي جوال د. نورة إلى 0500000001");
    recorder.record({ id: 'F1', tool: 'update_doctor', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('F2 remove_doctor', async () => {
    recorder.record({ id: 'F2', tool: 'remove_doctor', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Destructive, do not execute against real doctors." });
    test.skip();
  });
  test('F3 Subscribe New Doctor (owner-only)', async () => {
    recorder.record({ id: 'F3', tool: 'Subscribe New Doctor', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Paid action that Maha explicitly does not execute." });
    test.skip();
  });

  // --- SECTION G: Marketing ---
  test('G1 update_retargeting_settings', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي فترات إعادة الاستهداف إلى: 3 أيام، أسبوع، شهر، شهرين");
    recorder.record({ id: 'G1', tool: 'update_retargeting_settings', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('G2 toggle_retargeting', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أوقفي إعادة الاستهداف");
    recorder.record({ id: 'G2', tool: 'toggle_retargeting', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('G3 generate_campaign_content', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "اقترحي رسالة حملة عن عرض تنظيف الأسنان بخصم 20٪");
    recorder.record({ id: 'G3', tool: 'generate_campaign_content', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('G4 refine_campaign_content', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "خليها أقصر");
    recorder.record({ id: 'G4', tool: 'refine_campaign_content', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('G5 Send bulk campaign (owner-only)', async () => {
    recorder.record({ id: 'G5', tool: 'Send bulk campaign', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Maha explicitly does not execute Send." });
    test.skip();
  });

  // --- SECTION H: My Report ---
  test('H1 update_report_branding', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي اسم الدكتور في التقرير إلى 'د. اختبار'");
    recorder.record({ id: 'H1', tool: 'update_report_branding', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('H2 apply_report_theme', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "غيري لون التقرير إلى البرتقالي");
    recorder.record({ id: 'H2', tool: 'apply_report_theme', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('H3 save_report_page', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "احفظي كل تعديلات صفحة التقرير");
    recorder.record({ id: 'H3', tool: 'save_report_page', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('H4 Logo upload / Voice Note (owner-only)', async () => {
    recorder.record({ id: 'H4', tool: 'Binary uploads', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Binary uploads require owner action." });
    test.skip();
  });

  // --- SECTION I: Dr. Norah / Dr. Aziz ---
  test('I1-I16 Dr. Norah and Dr. Aziz Tools', async () => {
    recorder.record({ id: 'I1-I16', tool: 'Dr. Norah/Aziz Tools', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Only accessible from within Dr. Norah/Aziz section." });
    test.skip();
  });
  test('I17 Report submission (owner-only)', async () => {
    recorder.record({ id: 'I17', tool: 'Report submission', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Owner-only irreversible action." });
    test.skip();
  });

  // --- SECTION J: Profile ---
  test('J1 update_account_info', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "عدلي اسمي إلى 'TEST_NAME'");
    recorder.record({ id: 'J1', tool: 'update_account_info', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('J2 Password (owner-only)', async () => {
    recorder.record({ id: 'J2', tool: 'Password update', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Password is never touched by Maha." });
    test.skip();
  });
  test('J3 Profile photo upload (owner-only)', async () => {
    recorder.record({ id: 'J3', tool: 'Profile photo', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Binary upload." });
    test.skip();
  });

  // --- SECTION K: Navigation ---
  test('K1 open_dashboard_section', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "افتحي لي قسم إعدادات جدول المواعيد");
    recorder.record({ id: 'K1', tool: 'open_dashboard_section', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('K2 render_section_chip', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "أعطيني رابط قسم الجدول في المحادثة");
    recorder.record({ id: 'K2', tool: 'render_section_chip', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });
  test('K3 download_template', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "نزلي لي قالب قائمة المرضى للحملة");
    recorder.record({ id: 'K3', tool: 'download_template', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });

  // --- SECTION L: Reset & Support ---
  test('L1 reset_section', async ({ sharedPage }) => {
    recorder.record({ id: 'L1', tool: 'reset_section', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Heavily destructive. Skip execution." });
    test.skip();
  });
  // L2 is reset_all_instructions covered in B14
  test('L3 open_support_widget', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(sharedPage, "افتحي لي قسم الدعم عندي استفسار عن الفوترة");
    recorder.record({ id: 'L3', tool: 'open_support_widget', trigger: "...", result: 'NEEDS_REVIEW', evidence: replies[replies.length-1].text });
  });

  // --- SECTION M: Owner-only tools NOT invoked by Maha (audit only) ---
  test('M1-M7 Owner-only tools', async () => {
    recorder.record({ id: 'M1-M7', tool: 'Owner-only Tools', trigger: "...", result: 'UNABLE_TO_TEST', evidence: "Correctly not-invoked by Maha." });
    test.skip();
  });

  test.afterAll(async () => {
    await recorder.writeTo('reports');
  });
});
