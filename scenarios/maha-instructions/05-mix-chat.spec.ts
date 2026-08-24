import { test, expect } from '../../helpers/fixtures';
import { sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';

const recorder = new ReportRecorder('Mix Chat Tests');

test.describe.serial('Mix Chat — Multiple Tool Invocations', () => {

  test('Multiple Different Tools (Facility Info + Auto Booking)', async ({ sharedPage }) => {
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(
      sharedPage,
      "عدلي اسم العيادة إلى 'Klinik Baru' وعطلي الحجز التلقائي"
    );
    const last = replies[replies.length - 1];
    
    recorder.record({
      id: 'MIX-1',
      tool: 'update_facility_info + update_schedule_settings',
      trigger: "عدلي اسم العيادة إلى 'Klinik Baru' وعطلي الحجز التلقائي",
      result: 'NEEDS_REVIEW',
      evidence: `FAIL_MIX_CHAT_PARTIAL if she missed one. Reply: ${last.text}`,
      confirmRoundsNeeded,
    });
  });

  test('Read + Write Combination', async ({ sharedPage }) => {
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(
      sharedPage,
      "أعطيني قائمة الأطباء ثم أضيفي يوم دوام الأربعاء من 9 إلى 5"
    );
    const last = replies[replies.length - 1];

    recorder.record({
      id: 'MIX-2',
      tool: 'read_doctors + add_schedule_block',
      trigger: "أعطيني قائمة الأطباء ثم أضيفي يوم دوام الأربعاء من 9 إلى 5",
      result: 'NEEDS_REVIEW',
      evidence: `Verify she lists doctors AND confirms schedule addition. Reply: ${last.text}`,
      confirmRoundsNeeded,
    });
  });

  test('Valid + Invalid Combination (Negative Mix)', async ({ sharedPage }) => {
    const { replies } = await sendAndConfirm(
      sharedPage,
      "عدلي اسم العيادة إلى 'Test' وعدلي إيميلي إلى 'admin@test.com'"
    );
    const last = replies[replies.length - 1];

    recorder.record({
      id: 'MIX-3',
      tool: 'update_facility_info + update_account_info(email)',
      trigger: "عدلي اسم العيادة إلى 'Test' وعدلي إيميلي إلى 'admin@test.com'",
      result: 'NEEDS_REVIEW',
      evidence: `Should accept name but refuse email. Reply: ${last.text}`,
    });
  });

  test.afterAll(async () => {
    await recorder.writeTo('reports');
  });
});
