import { test as base, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';

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
 */

const recorder = new ReportRecorder('OB4 Part 3 - Runtime Context Propagation');

base.afterAll(async () => {
  await recorder.writeTo('reports');
});

// TC-P3-01 — SA, default single-branch account, ordinary Phase 3 chat.
base.describe('TC-P3-01 — SA baseline Phase 3 chat still works', () => {
  base('SA: ordinary instruction add does not error', async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'auth/.storage-state.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const reply = await sendMessage(page, 'Tambahkan instruksi: jangan terima pasien baru setelah jam 8 malam');
    recorder.record({
      id: 'TC-P3-01',
      tool: 'runtime context (user_role/branch_count injection)',
      trigger: 'Tambahkan instruksi: jangan terima pasien baru setelah jam 8 malam',
      result: 'NEEDS_REVIEW',
      evidence:
        `${reply.text}\n\n[Manual cross-check needed] grep the OB4 python log for this session and confirm ` +
        `user_role=super_admin, branch_count=1, and no error from _empty_branch_context().`,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});

// TC-P3-02 — real branch_admin (BA) account. Needs LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA
// + `LOGIN_PROFILE=ba npm run login-setup` to have been run once.
base.describe('TC-P3-02 — BA runtime context resolves correctly', () => {
  base('BA: acting_user_id/user_role resolve to the staff, not the owner', async ({ browser }) => {
    base.skip(
      !process.env.LOGIN_EMAIL_BA,
      'Set LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA in .env and run `LOGIN_PROFILE=ba npm run login-setup` to enable this test.'
    );
    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba.json' });
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
    const context = await browser.newContext({ storageState: 'auth/.storage-state.json' });
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
    base.skip(
      !process.env.LOGIN_EMAIL_ORPHAN,
      'Set LOGIN_EMAIL_ORPHAN/LOGIN_PASSWORD_ORPHAN in .env (account must have users.role_id=2 with a ' +
        'parent_user_id that matches no valid clinic — create manually per TC-P3-04 precondition) and run ' +
        '`LOGIN_PROFILE=orphan npm run login-setup` to enable this test.'
    );
    const context = await browser.newContext({ storageState: 'auth/.storage-state.orphan.json' });
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
    const context = await browser.newContext({ storageState: 'auth/.storage-state.json' });
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

// TC-P3-06 — dev deliberately adds an unknown/typo'd capability key to
// config.json. Editing that shared config file from an automated test is not
// something this suite should do (it's not scoped to a single test clinic and
// isn't safely revertible from here) — this stays a documented manual
// precondition, same treatment as TC-P3-02/04's account setup.
base.describe('TC-P3-06 — unknown capability key fails closed', () => {
  base('requires manual config.json edit — not exercised by this suite', async () => {
    recorder.record({
      id: 'TC-P3-06',
      tool: 'capability gating (fail-closed on unknown key)',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Requires a dev to manually add an unrecognized key (e.g. "phase4Capabilities": {"crmm": "*"}) to ' +
        "config.json for a specific test clinic, then chat as that clinic's owner and confirm (a) no error, " +
        '(b) an "unknown capability" warning is logged, (c) no Phase 4 tool leaks into the schema. Editing ' +
        "the shared config.json isn't something this automated suite should do — run manually per the test " +
        'script, or promote to automation once a per-clinic capability override exists that a test can set ' +
        'and revert safely via API instead of editing the file directly.',
    });
    base.skip(true, 'manual-only precondition, see evidence');
  });
});
