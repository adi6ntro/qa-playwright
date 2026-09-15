import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers TPL-01 `create_template` (+ its read-only sibling `get_template_status`),
 * from `docs/ob4-phase4-docs/Developer_Spec_Phase4_CRM_and_Export_Tools.md`'s
 * TPL-01 section (lines 587-610). Brand new tool, ZERO prior Playwright coverage —
 * added 2026-09-14 as part of the same review pass that produced the CRM-11/CRM-12
 * kind-mismatch fixes and the EXP/DSP-01 new-kind coverage in this same folder.
 *
 * Read directly from `inapp_agent/tools/template_studio.py` and Laravel's brand new
 * `App\Http\Controllers\Api\Agent\AgentTemplateController` (commit `1608a87c9`) —
 * confirmed exact signature:
 *   create_template(clinic_id, name, language, body, variable_fallbacks=None,
 *                    interactive=None, causing_message=None)
 *     → returns Laravel's raw response body: {success, template_id,
 *       meta_status: "waiting_for_approval", error?}
 * Two deviations from the dev spec worth flagging:
 *   1. There is NO `category` parameter anywhere — the spec's own signature doesn't
 *      have one either, so this isn't a deviation, just confirming it by reading the
 *      code rather than assuming.
 *   2. `meta_status` in `AgentTemplateController::create()` (L60-61) is a HARDCODED
 *      literal `'waiting_for_approval'`, not read back from Meta's actual response —
 *      so "returns the real Meta status" (spec AC#1) is only true for the FIRST call;
 *      the real status has to come from the separate `get_template_status` read
 *      afterward, which this file's positive coverage (once unblocked, see below)
 *      should account for rather than assume `create_template`'s own response ever
 *      reflects a later approval.
 *
 * Registered tool convention (registrations.py:938-963, confirmed 2026-09-14):
 * template_studio's registry lambdas do NOT accept `branch_id`/`acting_user_id` at
 * all (silently dropped via `**_` if supplied) — unlike CRM/staff_reminders tools.
 * Capability key is `template_studio` (`capabilities.py:46`), already wildcarded
 * (`"*"`, all clinics) in this checkout's local `reporty-onboard-phase3/config.json`.
 *
 * ⚠️ ENVIRONMENT BLOCKER — FIXED 2026-09-15 (was live 2026-09-14, keeping the history
 * since TC-TPL01-03 below still probes for this specific class of regression):
 *
 * `reporty-web-backup`'s `.env` was MISSING `AGENT_EXPORT_SECRET` entirely, so
 * `AgentServiceAuth` middleware failed CLOSED for every `agent/templates/*` route.
 * Root cause turned out to be one level deeper than "just add the line": the value
 * WAS added, but `php artisan serve`'s auto-reload-on-.env-change watcher strips any
 * `.env` variable added after the server's own last boot when respawning its child —
 * see `reporty-web-backup`'s own commit history / CLAUDE.md for the `--no-reload` fix.
 * `AGENT_EXPORT_SECRET=live-test-secret-abc123` is now correctly read (matching
 * `config.json`'s `agentExportSecret`). TC-TPL01-03 below is what caught this fix
 * landing — its own recorded evidence flagged "no longer unauthorized" and said
 * TC-TPL02-01 should be revisited; it has been (see 31-tpl02-stage-send.spec.ts —
 * now a real, verified PASS with an existing approved template, no new Meta
 * submission needed).
 *
 * `create_template`'s happy path (TC-TPL01-01) still calls the REAL
 * Meta Graph API through `WhatsAppTemplateService` → the remote `INBOX_API_BASE`
 * proxy (`reporty-ai-agent-api-dev.reporty.sa`, NOT a local service) → Meta, using
 * this clinic's real WhatsApp Business Account credentials (`user_clinic_template`
 * table, confirmed by reading `reporty-ai-agent-api`'s `whatsapp_cloud.py` directly —
 * these are per-branch DB rows, not env vars). Submitting a REAL template creation
 * is not something this suite should do automatically and repeatedly (rate limits,
 * genuine Meta-side template-library pollution for a real clinic, no clean
 * undo/delete path exercised anywhere in this codebase) — confirmed unsafe to
 * automate here for real: an ad-hoc manual probe of this exact call during this
 * session was itself refused by the sandbox's own "real-world transaction" guard
 * before this suite was even written. TC-TPL01-01 below is therefore intentionally
 * NOT executed — recorded UNABLE_TO_TEST with both reasons on record, same honesty
 * posture as TC-CRM12-01..04's segment_url block elsewhere in this folder.
 *
 * What IS safe and IS actually run: TC-TPL01-02, the `interactive.type: "list"`
 * rejection. Reading `_validate_meta_limits()` (template_studio.py:219-220) shows
 * this check runs and returns BEFORE any HTTP call to Laravel is made at all — zero
 * network risk, zero dependency on AGENT_EXPORT_SECRET, and exactly the kind of
 * pure-logic regression this suite exists to guard.
 */

const recorder = new ReportRecorder('OB4 TPL-01 Create Template');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const TEMPLATE_STUDIO_SKIP_REASON =
  'Set TEST_TEMPLATE_STUDIO_CAPABILITY_ENABLED=1 only after manually enabling ' +
  '"phase4Capabilities": {"template_studio": "*"} (or this test clinic\'s id) in your ' +
  'LOCAL reporty-onboard-phase3 config.json and restarting app.py. (Already "*" in this ' +
  'checkout as of 2026-09-14 — see this file\'s header.)';

function capabilityGate() {
  test.skip(process.env.TEST_TEMPLATE_STUDIO_CAPABILITY_ENABLED !== '1', TEMPLATE_STUDIO_SKIP_REASON);
}

async function callAction(
  page: import('@playwright/test').Page,
  clinicId: string,
  action: string,
  params: Record<string, unknown>
) {
  const resp = await page.request.post(`http://localhost:9559/clinic/${clinicId}/action`, {
    data: {
      action,
      params,
      session_id: `qa-tpl01-${action}-${Math.floor(Math.random() * 1e9)}`,
    },
  });
  return resp.json();
}

test.describe('TC-TPL01-01 — create a real quick_reply template, real template_id/meta_status returned', () => {
  test('NOT run — deliberately gated behind a human go-ahead (real Meta side effect)', async () => {
    recorder.record({
      id: 'TC-TPL01-01',
      tool: 'create_template(interactive.type=quick_reply) — happy path, deliberately not executed',
      trigger: '(not run — see evidence)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'The AGENT_EXPORT_SECRET blocker this used to also cite (2026-09-14) was fixed 2026-09-15 — see file ' +
        'header — so that is no longer a reason to skip this one. The remaining, still-real reason: a real ' +
        'create_template call submits a genuine WhatsApp template to Meta\'s Graph API via the remote ' +
        'INBOX_API_BASE proxy, using this clinic\'s real WhatsApp Business Account — not something this suite ' +
        'should do unattended and repeatedly (rate limits, real template-library pollution, no clean delete path ' +
        'exercised anywhere in this codebase). A manual probe of this exact action during an earlier session\'s ' +
        'own audit was itself refused by the sandbox\'s "real-world transaction" guard. A human should trigger ' +
        'this specific case manually when actually needed, then confirm template_id/meta_status by hand — ' +
        'TC-TPL02-01 below no longer needs this to run first, since it found existing approved templates already ' +
        'on this clinic\'s WABA from real prior usage.',
    });
    test.skip(true, 'deliberately gated behind a human go-ahead — see recorded evidence');
  });
});

test.describe('TC-TPL01-02 — interactive.type "list" is rejected cleanly, never silently relabeled as buttons', () => {
  test('list_type_not_supported_for_templates — pure client-side check, zero network/Meta risk, safe to run for real', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Meta's template API genuinely has no list-picker button type at all (only
    // quick_reply, capped at 3 buttons) — before this fix, `interactive.type: "list"`
    // was silently mislabeled as quick_reply instead of being rejected. This check
    // runs entirely inside _validate_meta_limits() (template_studio.py:219-220),
    // BEFORE any HTTP call to Laravel — confirmed by reading the function: the
    // rejection is returned directly, no request.post() happens on this path at all.
    const result = await callAction(page, clinicId, 'create_template', {
      name: `qa_tpl01_list_reject_${Date.now()}`,
      language: 'ar',
      body: 'مرحبًا {{1}}، اختر أحد الخيارات التالية من فضلك',
      variable_fallbacks: { '1': 'عميلنا العزيز' },
      interactive: {
        type: 'list',
        options: [{ label: 'خيار 1' }, { label: 'خيار 2' }, { label: 'خيار 3' }],
      },
      causing_message: '[direct action, not chat] TC-TPL01-02 list-type rejection — pure client-side check, no network call',
    });

    const rejectedCorrectly = result?.data?.error === 'list_type_not_supported_for_templates';
    const claimsCreated = result?.data?.success === true || !!result?.data?.template_id;

    recorder.record({
      id: 'TC-TPL01-02',
      tool: 'create_template(interactive.type="list") — direct action call, safe (rejected before any network call)',
      trigger: '[direct action, not chat] create_template with interactive.type="list"',
      result: rejectedCorrectly && !claimsCreated ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(result).slice(0, 500),
    });
    expect(rejectedCorrectly, 'must reject with list_type_not_supported_for_templates').toBe(true);
    expect(claimsCreated, 'must never silently create a template (e.g. mislabeled as quick_reply) for a list request').toBe(false);
    await context.close();
  });
});

test.describe('TC-TPL01-03 — environment probe: confirm the AGENT_EXPORT_SECRET gap is still the current state', () => {
  test('get_template_status for a nonexistent id — read-only, no side effect, safe to run repeatedly', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const result = await callAction(page, clinicId, 'get_template_status', {
      template_id: '999999999',
      causing_message: '[direct action, not chat] TC-TPL01-03 environment probe — read-only, no side effect',
    });

    const stillUnauthorized = result?.data?.error === 'unauthorized';

    recorder.record({
      id: 'TC-TPL01-03',
      tool: 'get_template_status — environment probe for the AGENT_EXPORT_SECRET gap (read-only, no side effect)',
      trigger: '[direct action, not chat] get_template_status template_id=999999999',
      result: 'NEEDS_REVIEW',
      evidence: stillUnauthorized
        ? `Confirms the AGENT_EXPORT_SECRET gap documented in this file's header is STILL the current state: ` +
          `${JSON.stringify(result)}. TC-TPL01-01 (happy path) and 31-tpl02-stage-send.spec.ts's core frozen-` +
          `segment test remain genuinely blocked in this environment, not skipped out of caution.`
        : `UNEXPECTED: this no longer returns "unauthorized" (${JSON.stringify(result)}) — the AGENT_EXPORT_SECRET ` +
          `gap this file's header describes may have been fixed since this was written. If so, TC-TPL01-01 and ` +
          `31-tpl02-stage-send.spec.ts's frozen-segment test should be revisited and actually run for real ` +
          `(TC-TPL01-01 still needs a human's explicit go-ahead per the Meta-side-effect caution, independent of ` +
          `this fix).`,
    });
    // Deliberately not a hard expect() — this is an environment-state probe, not a
    // correctness assertion about the tool itself (an "unauthorized" fix landing is
    // GOOD news, not a regression). Recorded NEEDS_REVIEW so a human/CI dashboard
    // notices either state without this file failing red for an unrelated env change.
  });
});
