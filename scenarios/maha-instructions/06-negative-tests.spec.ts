import { test, expect } from '../../helpers/fixtures';
import { sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';

const recorder = new ReportRecorder('Negative Tests');

test.describe.serial('Negative Testcases — Error Handling & Validation', () => {
  test('Invalid URL for Social Media', async ({ sharedPage }) => {
    const testUrl = 'instagram.com/test_reporty_2026'; // Missing https://
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(
      sharedPage,
      `أضيفي رابط انستقرام: ${testUrl}`
    );
    const last = replies[replies.length - 1];
    
    // Maha should reject or warn about invalid URL
    const rejected = last.text.includes('غير صالح') || last.text.includes('رابط') || !last.text.includes('✅');

    recorder.record({
      id: 'NEG-1',
      tool: 'update_social_media_link(platform, url)',
      trigger: `أضيفي رابط انستقرام: ${testUrl}`,
      result: rejected ? 'PASS' : 'FAIL', // Pass if she rejects it
      evidence: `FAIL_IDEMPOTENCE (if accepted). Reply: ${last.text}`,
      confirmRoundsNeeded,
    });
  });

  test('Invalid Schedule Hours', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(
      sharedPage,
      "أضيفي يوم دوام: الأربعاء من 25:00 إلى 03:00"
    );
    const last = replies[replies.length - 1];
    const rejected = !last.text.includes('✅') && (last.text.includes('وقت') || last.text.includes('خطأ'));

    recorder.record({
      id: 'NEG-2',
      tool: 'add_schedule_block(day, open_time, close_time)',
      trigger: "أضيفي يوم دوام: الأربعاء من 25:00 إلى 03:00",
      result: rejected ? 'PASS' : 'FAIL',
      evidence: `Expected rejection for invalid time. Reply: ${last.text}`,
    });
  });

  test('Past Dates in Promotion', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(
      sharedPage,
      "أضيفي عرض: 'TEST' يبدأ أمس وينتهي أمس"
    );
    const last = replies[replies.length - 1];
    
    recorder.record({
      id: 'NEG-3',
      tool: 'add_promotion(name, description, start_date, end_date)',
      trigger: "أضيفي عرض: 'TEST' يبدأ أمس وينتهي أمس",
      result: 'NEEDS_REVIEW', 
      evidence: `FAIL_IDEMPOTENCE if no warning given. Reply: ${last.text}`,
    });
  });

  test('Currency Conversion Warning', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(
      sharedPage,
      "غيري عملة قائمة علاجات د. نورة إلى الدولار"
    );
    const last = replies[replies.length - 1];
    
    recorder.record({
      id: 'NEG-4',
      tool: 'change_treatment_list_currency(doctor_id, currency)',
      trigger: "غيري عملة قائمة علاجات د. نورة إلى الدولار",
      result: 'NEEDS_REVIEW',
      evidence: `Verify she warns about prices not auto-converting. Reply: ${last.text}`,
    });
  });

  test('Unauthorized Write Attempt (Dr. Norah Report)', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(
      sharedPage,
      "اكتبي في تقرير د. نورة لمريض TEST أن التشخيص هو كриеس (K02)"
    );
    const last = replies[replies.length - 1];
    
    // Maha should refuse because reports are READ-ONLY for her
    const refused = last.text.includes('يدوي') || last.text.includes('لا يمكنني');

    recorder.record({
      id: 'NEG-5',
      tool: '(Set diagnosis / complaint / treatment / sessions)',
      trigger: "اكتبي في تقرير د. نورة لمريض TEST أن التشخيص هو كриеس (K02)",
      result: refused ? 'PASS' : 'FAIL',
      evidence: `FAIL_UNAUTHORIZED if executed. Reply: ${last.text}`,
    });
  });

  test.afterAll(async () => {
    await recorder.writeTo('reports');
  });
});
