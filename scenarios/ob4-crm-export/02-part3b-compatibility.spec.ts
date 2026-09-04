import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers Part 3b — Phase 3 Compatibility Guarantee, from
 * QA_TestScript_Phase4_CRM_Export.md (reporty-web-backup),
 * TC-PH3C-01 .. TC-PH3C-03. See 01-part3-runtime-context.spec.ts for why this
 * targets the AI Instruction wizard step (#fo-ai-chat-input), not the disabled
 * "My Clinic AI" widget the source doc names.
 */

const recorder = new ReportRecorder('OB4 Part 3b - Phase 3 Compatibility Guarantee');

test.afterAll(async () => {
  await recorder.writeTo('reports');
});

// TC-PH3C-01 — full Phase 3 regression (list/create/update/delete instructions,
// bulk-instructions, voice-to-text, ordinary chat). This is exactly what
// scenarios/maha-instructions/*.spec.ts already exercises end-to-end
// (`npm run test:maha-all`) — re-scripting the same flows here would just be a
// second copy to keep in sync. Recorded as a pointer, not duplicated.
test.describe('TC-PH3C-01 — full Phase 3 regression', () => {
  test('already covered by scenarios/maha-instructions/ — not duplicated here', async () => {
    recorder.record({
      id: 'TC-PH3C-01',
      tool: 'Phase 3 regression (list/create/update/delete/bulk/voice)',
      trigger: '(see scenarios/maha-instructions/)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Run `npm run test:maha-all` (scenarios/maha-instructions/) for this coverage — it already exercises ' +
        'every Phase 3 tool this test case asks for. Duplicating those flows here would be redundant to ' +
        "maintain; if it ever regresses, that suite's own report is the evidence for this TC too.",
    });
    test.skip(true, 'covered by scenarios/maha-instructions/, see evidence');
  });
});

// TC-PH3C-02 — with capability all-off, zero Phase 4 tools should appear in
// the schema sent to Gemini. That specific claim can only be verified by
// reading the OB4 python backend log (select_tools()/enabled_capabilities());
// a browser script has no visibility into the outbound Gemini tool schema.
// What IS checkable here: an ordinary chat still behaves like plain Phase 3
// (no crash, no mention of Phase 4-only concepts a Phase-3-only reply
// shouldn't produce unprompted).
test.describe('TC-PH3C-02 — zero Phase 4 tools reach the schema when capabilities are off', () => {
  test('ordinary chat behaves like Phase 3 only; log cross-check required for the schema claim', async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'auth/.storage-state.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const reply = await sendMessage(page, 'اعرضي لي كل إعدادات المنشأة');
    recorder.record({
      id: 'TC-PH3C-02',
      tool: 'select_tools() / enabled_capabilities() — schema composition',
      trigger: 'اعرضي لي كل إعدادات المنشأة',
      result: 'NEEDS_REVIEW',
      evidence:
        `${reply.text}\n\n[Manual cross-check needed — this is the actual assertion] no eligible log line ` +
        `exists by default — add a temporary logger.info("tools for clinic %s: %s", clinic_id, [t['name'] ` +
        `for t in tools]) right after the select_tools() call in inapp_agent/orchestrators/` +
        `maha_inapp_agent.py (~line 4770), restart your local app.py, re-run, then confirm the logged tool ` +
        `list contains ONLY Phase 3 tools — zero from crm/export/staff_reminders/template_studio/charts.`,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});

// TC-PH3C-03 — per-clinic capability isolation (clinic A gets `export`
// enabled, clinic B must not see it leak). Requires editing config.json
// scoped to one specific test clinic id + a service restart — same reasoning
// as TC-P3-06: safe to do by hand now that this suite is local-only, but
// still not something a Playwright script should do itself.
test.describe('TC-PH3C-03 — per-clinic capability isolation', () => {
  test('requires manual local config.json edit scoped to one test clinic — not exercised by this suite', async () => {
    recorder.record({
      id: 'TC-PH3C-03',
      tool: 'capability gating (per-clinic isolation)',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'On your LOCAL reporty-onboard-phase3 checkout: enable one capability group (e.g. "export": ' +
        '["clinic_id_A"]) for a single test clinic in config.json, restart app.py, then confirm clinic B ' +
        '(not listed) still behaves Phase-3-only. Same reasoning as TC-P3-06 — editing a config file + ' +
        "restarting a process isn't something this automated suite should do, even locally.",
    });
    test.skip(true, 'manual-only precondition, see evidence');
  });
});
