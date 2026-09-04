import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers the CRM-08 stub-honesty checks from
 * QA_TestScript_Phase4_CRM_Export.md (reporty-web-backup),
 * TC-CRM08-STUB-01/02. NOT the same as TC-CRM08-01..04 (the real
 * crm_record_consent functionality) — those stay ⏳ unimplemented; the doc is
 * explicit that the stub-honesty checks are the only CRM-08-adjacent thing
 * live today. See 01-part3-runtime-context.spec.ts's header comment for why
 * this targets the AI Instruction wizard chat, not the disabled "My Clinic AI"
 * widget the source doc names.
 */

const recorder = new ReportRecorder('OB4 CRM-08 Consent Stub');

test.afterAll(async () => {
  await recorder.writeTo('reports');
});

// TC-CRM08-STUB-01 — positive case, requires the `crm` capability to be
// manually enabled for the test clinic first (config.json). Default today is
// OFF everywhere, so this is env-gated and skips by default.
test.describe('TC-CRM08-STUB-01 — with `crm` capability on, stub is honest about not_yet_available', () => {
  test('Maha admits consent recording is not available yet, without leaking the raw error string', async ({ browser }) => {
    test.skip(
      process.env.TEST_CRM_CAPABILITY_ENABLED !== '1',
      'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
        '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.'
    );
    const context = await browser.newContext({ storageState: 'auth/.storage-state.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const trigger = 'Catat: Reem setuju terima promosi, dia bilang iya lewat WhatsApp tadi siang';
    const reply = await sendMessage(page, trigger);

    const leaksRawError = /not_yet_available/i.test(reply.text);
    const claimsSuccess = /(berhasil (disimpan|dicatat)|✅.*(disimpan|dicatat)|tercatat)/i.test(reply.text);

    recorder.record({
      id: 'TC-CRM08-STUB-01',
      tool: 'crm_record_consent (STUB)',
      trigger,
      result: leaksRawError || claimsSuccess ? 'FAIL' : 'NEEDS_REVIEW',
      evidence: `Raw "not_yet_available" leaked: ${leaksRawError}. Claims success: ${claimsSuccess}.\n\n${reply.text}`,
    });
    expect(leaksRawError, 'reply must not leak the raw not_yet_available error string to the owner').toBe(false);
    expect(claimsSuccess, 'reply must not falsely claim the consent was recorded').toBe(false);
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});

// TC-CRM08-STUB-02 — negative case, default state (crm off everywhere).
// Always runnable, no special setup.
test.describe('TC-CRM08-STUB-02 — with `crm` off (default today), no regression', () => {
  test('consent-related chat behaves like plain Phase 3 — no crm_record_consent involvement', async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'auth/.storage-state.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const trigger = 'Catat: Reem setuju terima promosi, dia bilang iya lewat WhatsApp tadi siang';
    const reply = await sendMessage(page, trigger);

    recorder.record({
      id: 'TC-CRM08-STUB-02',
      tool: 'select_tools() — crm_record_consent should not be in schema',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence:
        `${reply.text}\n\n[Manual cross-check needed — this is the actual assertion] add a temporary ` +
        `logger.info("tools for clinic %s: %s", clinic_id, [t['name'] for t in tools]) after the ` +
        `select_tools() call in inapp_agent/orchestrators/maha_inapp_agent.py (~line 4770), restart your ` +
        `local app.py, re-run, and confirm crm_record_consent never appears in the logged tool list.`,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});
