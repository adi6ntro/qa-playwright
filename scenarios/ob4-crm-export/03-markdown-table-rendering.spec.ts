import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage, SEL } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers the "Lampiran — Wave 1 Addendum: Markdown Table Rendering" section of
 * QA_TestScript_Phase4_CRM_Export.md (reporty-web-backup),
 * TC-MDTBL-01/02. Per that doc, this is frontend-only and already present in
 * chat.blade.php's diff — but the widget that diff lives in is the disabled
 * "My Clinic AI" panel (see 01-part3-runtime-context.spec.ts's header comment
 * for why). Testing here against the AI Instruction wizard's real, live chat
 * bubble instead (#fo-ai-messages / .fo-bubble-maha) — if that bubble renders
 * markdown tables as real HTML tables too, this suite can prove it; if it
 * doesn't have the same rendering logic, that's itself a finding worth
 * surfacing rather than silently testing the wrong (disabled) widget.
 *
 * Getting an LLM to reliably reply in table form is inherently non-
 * deterministic — these tests ask explicitly for tabular output but cannot
 * force it, so a run where Maha replies in prose instead is UNABLE_TO_TEST,
 * not a failure.
 */

const recorder = new ReportRecorder('OB4 Markdown Table Rendering');

test.afterAll(async () => {
  await recorder.writeTo('reports');
});

async function lastMahaBubbleTableInfo(page: import('@playwright/test').Page) {
  const bubbles = page.locator(SEL.mahaBubble);
  const count = await bubbles.count();
  const lastBubble = bubbles.nth(count - 1);
  const tableCount = await lastBubble.locator('table').count();
  const rawPipeInText = await lastBubble.innerText().then((t) => /\|.*\|/.test(t) && /-{3,}/.test(t));
  return { tableCount, rawPipeInText, lastBubble };
}

test.describe('TC-MDTBL-01 — markdown table renders as a real HTML table', () => {
  test('a reply asked to be tabular renders <table>, not raw pipe/dash text', async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'auth/.storage-state.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const trigger = 'Tampilkan semua instruksi saya saat ini dalam bentuk tabel markdown dengan kolom Nomor dan Instruksi';
    const reply = await sendMessage(page, trigger);
    const { tableCount, rawPipeInText } = await lastMahaBubbleTableInfo(page);

    if (tableCount === 0 && !rawPipeInText) {
      recorder.record({
        id: 'TC-MDTBL-01',
        tool: 'markdown table rendering',
        trigger,
        result: 'UNABLE_TO_TEST',
        evidence: `Maha did not reply in tabular form this run (neither <table> nor raw pipe/dash markdown found).\n\n${reply.text}`,
      });
      test.skip(true, 'Maha did not reply in tabular form this run — LLM output is non-deterministic, re-run to retry.');
      await context.close();
      return;
    }

    recorder.record({
      id: 'TC-MDTBL-01',
      tool: 'markdown table rendering',
      trigger,
      result: tableCount > 0 ? 'PASS' : 'FAIL',
      evidence: `<table> elements in reply bubble: ${tableCount}. Raw pipe/dash markdown left unrendered: ${rawPipeInText}.\n\n${reply.text}`,
    });
    expect(tableCount, 'reply should contain a real <table> element, not raw markdown pipe/dash text').toBeGreaterThan(0);
    expect(rawPipeInText, 'no raw unrendered markdown table syntax should remain in the bubble text').toBe(false);
    await context.close();
  });
});

test.describe('TC-MDTBL-02 — special characters inside table cells do not break rendering', () => {
  test('a pipe character inside cell content does not corrupt the rendered table', async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'auth/.storage-state.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const trigger =
      'Buatkan tabel markdown 2 kolom "Kode" dan "Keterangan" dengan 2 baris contoh, salah satu nilai Keterangan-nya harus mengandung karakter pipe "|" secara literal, misalnya "opsi A | opsi B"';
    const reply = await sendMessage(page, trigger);
    const { tableCount, lastBubble } = await lastMahaBubbleTableInfo(page);

    if (tableCount === 0) {
      recorder.record({
        id: 'TC-MDTBL-02',
        tool: 'markdown table rendering (special characters)',
        trigger,
        result: 'UNABLE_TO_TEST',
        evidence: `Maha did not reply with a rendered table this run.\n\n${reply.text}`,
      });
      test.skip(true, 'Maha did not reply in tabular form this run — LLM output is non-deterministic, re-run to retry.');
      await context.close();
      return;
    }

    // Best-effort structural integrity check: every row should have the same
    // cell count as the header row. A pipe character leaking unescaped into a
    // cell would typically split that row into an extra column.
    const cellCountsPerRow: number[] = await lastBubble.locator('table tr').evaluateAll((rows) =>
      rows.map((r) => r.querySelectorAll('td,th').length)
    );
    const headerCellCount = cellCountsPerRow[0];
    const consistent = cellCountsPerRow.every((c) => c === headerCellCount);

    recorder.record({
      id: 'TC-MDTBL-02',
      tool: 'markdown table rendering (special characters)',
      trigger,
      result: consistent ? 'PASS' : 'FAIL',
      evidence: `Cell counts per row: [${cellCountsPerRow.join(', ')}]. Consistent: ${consistent}.\n\n${reply.text}`,
    });
    expect(consistent, 'every row should have the same column count as the header — a stray pipe would split a row').toBe(true);
    await context.close();
  });
});
