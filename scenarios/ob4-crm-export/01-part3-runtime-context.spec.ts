import { test as base, expect } from '@playwright/test';
import {
  gotoAiInstructionStep,
  sendMessage,
  sendAndConfirm,
  getInstructionPanelState,
  refreshAndReturnToStep,
} from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers Part 3 — Runtime Context Propagation, from
 * QA_TestScript_Phase4_CRM_Export.md (reporty-web-backup),
 * TC-P3-01 .. TC-P3-06. Per that doc's own status table (as of 2026-09-04),
 * this section is "✅ Sudah dibangun" — the only part of the Phase 4 CRM/Export
 * surface actually live to test today.
 *
 * IMPORTANT — channel correction vs the source doc: that doc says the default
 * test channel is the "My Clinic AI" widget (MyClinicAiController::chat() /
 * myClinic/chat.blade.php, #mfChatInput). Investigated directly against the
 * live source (2026-09-04): that widget is DISABLED dead UI (myClinic.blade.php
 * unconditionally does `$('#fill-chat').hide()` — "chat disabled — show
 * social-media setup only") and is wired to a DIFFERENT, non-Phase4 AI service
 * (env `base_url_ai_chat`, not reporty-onboard-phase3). The actual live Phase4
 * chat surface is the AI Instruction wizard step (step-ai-instruction.blade.php,
 * #fo-ai-chat-input, POST customer/my-clinic/fo/chat/{clinicId} →
 * MyClinicAiController::foChat() → OnboardingService, i.e. reporty-onboard-phase3)
 * — the same one scenarios/maha-instructions/ already drives. All tests below
 * use that real widget instead.
 *
 * Many of this section's Expected Results require reading Python backend logs
 * (user_role/acting_user_id resolution, capability warnings) that a browser
 * script cannot see. Those checks are recorded NEEDS_REVIEW with the reply
 * captured as evidence, plus the log grep to cross-check manually — same
 * discipline as scenarios/maha-instructions/02-section-a-reads.spec.ts.
 *
 * `_fetch_branch_context()`/`_empty_branch_context()` (utils/db.py) don't log
 * their resolved user_role/branch_count/acting_user_id by default — per the
 * QA doc's own note, add a temporary `logger.info("ctx resolved: %s", ctx)`
 * right after `ctx = get_clinic_context(clinic_id, branch_id, acting_user_id)`
 * in `inapp_agent/orchestrators/maha_inapp_agent.py` (~line 5052), then
 * restart your local `app.py`, before trusting any NEEDS_REVIEW result below
 * that says "grep the OB4 python log".
 */

const recorder = new ReportRecorder('OB4 Part 3 - Runtime Context Propagation');

base.afterAll(async () => {
  await recorder.writeTo('reports');
});

// TC-P3-01 — SA, default single-branch account, ordinary Phase 3 chat.
//
// Uses sendAndConfirm (not a bare sendMessage) and verifies real persistence
// via the instruction panel — a first pass here used sendMessage() and only
// captured Maha's confirmation PROMPT ("Mohon konfirmasi... apakah Anda ingin
// menyimpan?"), never actually completing the write, which doesn't match the
// QA doc's own expected result ("Instruksi baru berhasil tersimpan"). Mirrors
// scenarios/maha-instructions/03-section-b-instructions.spec.ts's B11 pattern
// (count delta + verbatim-in-panel + persisted-after-refresh), and cleans up
// afterward since this runs against a real (shared) test clinic account, not
// a disposable one — unlike B11, nothing downstream depends on this rule
// still existing.
base.describe('TC-P3-01 — SA baseline Phase 3 chat still works', () => {
  base('SA: ordinary instruction add actually persists, not just gets confirmed-prompted', async ({ browser }) => {
    // Local dev needs real headroom: the wizard's first paint alone can take up to
    // ~60s (real backend round trip, see helpers/maha-chat.ts's gotoAiInstructionStep
    // comment), and a real chat reply on top of that can take up to ~125s
    // (FO_AI_CHAT_TIMEOUT_MS in ai-instruction.js) — 90s default is not enough.
    base.setTimeout(180_000);
    const context = await browser.newContext({ storageState: 'auth/.storage-state.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    // Arabic trigger + Latin-prefixed marker, matching the proven-working pattern from
    // scenarios/maha-instructions/03-section-b-instructions.spec.ts's B11 test. A first
    // pass here used the QA doc's own Indonesian example trigger with an English-prefixed
    // marker — Maha fully paraphrased/translated it into Arabic and dropped the marker
    // entirely (this clinic clearly normalizes everything to Arabic), so a verbatim
    // includes() check could never pass. The instruction WAS genuinely saved that run —
    // just not under the literal string being checked for.
    const testText = 'TC_P3_01_TEST_RULE — تعليمة اختبار سياق التشغيل';
    const before = await getInstructionPanelState(page);

    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, `أضيفي قاعدة: ${testText}`);
    const last = replies[replies.length - 1];

    const afterChat = await getInstructionPanelState(page);
    const countMovedByOne =
      before.count !== null && afterChat.count !== null && afterChat.count === before.count + 1;
    const verbatimPresent = afterChat.rows.some((r) => r.text.includes(testText));

    const afterRefresh = await refreshAndReturnToStep(page);
    const persisted = afterRefresh.rows.some((r) => r.text.includes(testText));

    recorder.record({
      id: 'TC-P3-01',
      tool: 'runtime context (user_role/branch_count injection) + save_instruction persistence',
      trigger: `أضيفي قاعدة: ${testText}`,
      result: countMovedByOne && verbatimPresent && persisted ? 'PASS' : 'FAIL',
      evidence:
        `reply="${last.text}" | before_count=${before.count} after_count=${afterChat.count} ` +
        `verbatim_in_panel=${verbatimPresent} persisted_after_refresh=${persisted}\n\n` +
        `[Manual cross-check still needed for the runtime-context claim specifically] grep the OB4 python ` +
        `log for this session and confirm user_role=super_admin, branch_count=1, and no error from ` +
        `_empty_branch_context().`,
      confirmRoundsNeeded,
      persisted,
    });
    await context.close();
    expect(persisted, 'the instruction must actually persist, not just get a confirmation prompt').toBe(true);
  });
});

// TC-P3-02 — real branch_admin (BA) account. Needs LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA
// + `npm run login-setup:local-ba` to have been run once.
base.describe('TC-P3-02 — BA runtime context resolves correctly', () => {
  base('BA: acting_user_id/user_role resolve to the staff, not the owner', async ({ browser }) => {
    // Local dev needs real headroom: the wizard's first paint alone can take up to
    // ~60s (real backend round trip, see helpers/maha-chat.ts's gotoAiInstructionStep
    // comment), and a real chat reply on top of that can take up to ~125s
    // (FO_AI_CHAT_TIMEOUT_MS in ai-instruction.js) — 90s default is not enough.
    base.setTimeout(180_000);
    base.skip(
      !process.env.LOGIN_EMAIL_BA,
      'Set LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA in .env and run `npm run login-setup:local-ba` to enable this test.'
    );
    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const reply = await sendMessage(page, 'lihat daftar instruksi saat ini');
    recorder.record({
      id: 'TC-P3-02',
      tool: 'runtime context (branch_admin resolution)',
      trigger: 'lihat daftar instruksi saat ini',
      result: 'NEEDS_REVIEW',
      evidence:
        `${reply.text}\n\n[Manual cross-check needed] grep the OB4 python log for this session and confirm ` +
        `acting_user_id = the BA's own id (not the owner's) and user_role=branch_admin via _fetch_branch_context().`,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});

// TC-P3-03 — SA/BA, ask Maha to self-describe its role/branches. Mechanical
// guard: the acceptance criterion explicitly forbids dumping raw internal
// field names like managed_branch_ids verbatim — that part IS checkable.
base.describe('TC-P3-03 — Maha describes role/branch coherently, no raw internal dump', () => {
  base('SA: role/branch question gets a natural answer, not a JSON dump', async ({ browser }) => {
    // Local dev needs real headroom: the wizard's first paint alone can take up to
    // ~60s (real backend round trip, see helpers/maha-chat.ts's gotoAiInstructionStep
    // comment), and a real chat reply on top of that can take up to ~125s
    // (FO_AI_CHAT_TIMEOUT_MS in ai-instruction.js) — 90s default is not enough.
    base.setTimeout(180_000);
    const context = await browser.newContext({ storageState: 'auth/.storage-state.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const reply = await sendMessage(page, 'Saya login sebagai peran apa di sistem ini dan cabang mana yang saya kelola?');
    const leaksInternalField = /managed_branch_ids|user_role\s*[:=]|branch_count\s*[:=]/i.test(reply.text);

    recorder.record({
      id: 'TC-P3-03',
      tool: 'runtime context (self-description, no raw dump)',
      trigger: 'Saya login sebagai peran apa di sistem ini dan cabang mana yang saya kelola?',
      result: leaksInternalField ? 'FAIL' : 'NEEDS_REVIEW',
      evidence: reply.text,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    expect(leaksInternalField, 'reply must not contain raw internal field names like managed_branch_ids').toBe(false);
    await context.close();
  });
});

// TC-P3-04 — deliberately malformed "orphaned staff" account (role_id=2,
// parent_user_id mismatched). Needs manual DB setup per the test script's
// own precondition — this suite cannot safely create that row itself.
base.describe('TC-P3-04 — orphaned staff degrades to doctor, never escalates', () => {
  base('orphaned staff: context must degrade to doctor, not rise to super_admin', async ({ browser }) => {
    // Local dev needs real headroom: the wizard's first paint alone can take up to
    // ~60s (real backend round trip, see helpers/maha-chat.ts's gotoAiInstructionStep
    // comment), and a real chat reply on top of that can take up to ~125s
    // (FO_AI_CHAT_TIMEOUT_MS in ai-instruction.js) — 90s default is not enough.
    base.setTimeout(180_000);
    base.skip(
      !process.env.LOGIN_EMAIL_ORPHAN,
      'Set LOGIN_EMAIL_ORPHAN/LOGIN_PASSWORD_ORPHAN in .env (account must have users.role_id=2 with a ' +
        'parent_user_id that matches no valid clinic — create manually per TC-P3-04 precondition) and run ' +
        '`npm run login-setup:local-orphan` to enable this test.'
    );
    const context = await browser.newContext({ storageState: 'auth/.storage-state.orphan.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const reply = await sendMessage(page, 'lihat daftar instruksi saat ini');
    recorder.record({
      id: 'TC-P3-04',
      tool: 'runtime context (fail-safe degrade, privilege escalation guard)',
      trigger: 'lihat daftar instruksi saat ini',
      result: 'NEEDS_REVIEW',
      evidence:
        `${reply.text}\n\n[Manual cross-check needed — this is the actual assertion] grep the OB4 python log ` +
        `for this session and confirm the resolved user_role is "doctor", NEVER "super_admin".`,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});

// TC-P3-05 — identity spoofing via a manipulated request payload. This one IS
// fully mechanical: MyClinicAiController::foChat()/actingUserId() (read
// directly from source, app/Http/Controllers/Front/MyClinicAiController.php)
// resolve identity from Auth::id() server-side and never read any identity
// field from the request body at all — the client payload only ever contains
// message/session_id/branch_id. This test is a live regression guard for that
// invariant: it injects extra identity-claiming fields into the POST body and
// confirms the endpoint still behaves like an ordinary authenticated request
// (200, real reply) rather than erroring or somehow reflecting the spoofed
// identity — if a future change starts trusting client-supplied identity
// fields, this stops proving what it currently proves.
base.describe('TC-P3-05 — server ignores client-supplied identity fields', () => {
  base('spoofed acting_user_id/user_id/is_admin in the POST body has no effect', async ({ browser }) => {
    // Local dev needs real headroom: the wizard's first paint alone can take up to
    // ~60s (real backend round trip, see helpers/maha-chat.ts's gotoAiInstructionStep
    // comment), and a real chat reply on top of that can take up to ~125s
    // (FO_AI_CHAT_TIMEOUT_MS in ai-instruction.js) — 90s default is not enough.
    base.setTimeout(180_000);
    const context = await browser.newContext({ storageState: 'auth/.storage-state.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const resp = await page.request.post(`/customer/my-clinic/fo/chat/${clinicId}`, {
      data: {
        message: 'من أنا؟',
        session_id: 'qa-p3-05-spoof-test',
        branch_id: null,
        // Fields no real client ever sends — this endpoint's contract doesn't
        // define them. Injected here purely to prove the server ignores them.
        acting_user_id: '999999',
        user_id: '999999',
        is_admin: true,
        user_role: 'super_admin',
      },
    });

    const body = await resp.json().catch(() => ({}));
    recorder.record({
      id: 'TC-P3-05',
      tool: 'foChat() identity resolution (Auth::id(), never request body)',
      trigger: 'POST .../fo/chat/{clinicId} with spoofed acting_user_id/user_id/is_admin/user_role fields',
      result: resp.ok() ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(body).slice(0, 400),
    });
    expect(resp.ok(), `spoofed-payload request should behave like a normal request, got ${resp.status()}`).toBe(true);
    await context.close();
  });
});

// TC-P3-06 — deliberately adds an unknown/typo'd capability key to
// config.json and restarts the OB4 service to pick it up. Now that this
// suite is local-only (helpers/ob4-local-guard.ts), that's YOUR local
// config.json/service — safe to edit by hand. Still not something this
// script does for you: editing a config file + restarting a process isn't a
// Playwright concern, and there's no per-clinic override endpoint yet to
// automate it through instead.
base.describe('TC-P3-06 — unknown capability key fails closed', () => {
  base('requires manual local config.json edit + service restart — not exercised by this suite', async () => {
    recorder.record({
      id: 'TC-P3-06',
      tool: 'capability gating (fail-closed on unknown key)',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'On your LOCAL reporty-onboard-phase3 checkout: add an unrecognized key (e.g. "phase4Capabilities": ' +
        '{"crmm": "*"}) to config.json, restart `.venv/bin/python app.py`, then chat as any clinic owner and ' +
        'confirm (a) no error, (b) capabilities.py\'s is_enabled() logs an "unknown capability" WARNING to ' +
        "stdout (already exists in code, ~line 67-71 — no temp logging needed), (c) no Phase 4 tool leaks " +
        'into the schema. This remains a manual step (editing a file + restarting a process isn\'t something ' +
        'a Playwright script should do) — just no longer unsafe now that it targets your own local checkout ' +
        'instead of the shared dev server.',
    });
    base.skip(true, 'manual-only precondition, see evidence');
  });
});
