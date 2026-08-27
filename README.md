# Reporty QA — Playwright automation

Browser automation against `dev.reporty.sa`, covering two independent
suites that share one login/session setup. Lives outside
`reporty-web-backup` on purpose — this is test tooling, not application
code, so it doesn't belong in the app repo's history/CI surface.

## Suites

### 1. Inbox + Marketing (WhatsApp Cloud API) — `scenarios/inbox-marketing/`

Automates the parts of
`reporty-web-backup/docs/handover/QA_Checklist_Inbox_Marketing_WhatsApp.md`
that a script can judge mechanically. That doc is the source of truth for
scope/known-limitations and the parts that still need a human (does a
reply read right, is a template actually approved by Meta, etc).

- **Inbox** (`/customer/inbox`): conversation list, chat history, reply
  send, contact-info save — all live/wired.
- **Marketing** (`/customer/marketing`): Templates tab (CRUD) and the
  Contacts *list* — live/wired. **Campaigns and Segments are real, fully
  loaded UI (multi-step wizard, scripted chat demo) that simply never calls
  a backend** — `bulk-campaign.js`/`create-segment.js` ARE `<script>`-loaded
  (each via its own modal partial), confirmed by reading them end to end;
  they just contain zero `fetch`/`axios` calls. Segments' "Create" button
  goes further: it has **no click handler at all**, not even a broken one.
  Same story for Contacts' "+ Add Contact"/"Import CSV" modal — its own
  submit functions are literally `{ closeAddContact(); }`. `03-marketing-
  campaigns-*` exercises the real wizard/chat flows end to end and asserts
  nothing gets sent/saved anywhere, rather than just checking a modal opens.
- **"Add WhatsApp number" onboarding flow**: no route exists yet
  (`customer/my-clinic/wa-numbers`) — one test asserts it 404s, as a canary
  for when it gets wired up.

**Known real finding (not yet fixed):** submitting a template whose body
is short relative to its `{{n}}` placeholder count gets rejected by Meta
(error_subcode 2388293 "ratio limit" / 2388299 "parameter order" — a
variable can't open/close the body, and variables can't be too dense
relative to static text). `MarketingController::createTemplate` correctly
forwards Meta's real error message in the JSON response, but
`marketing.js`'s `submitForApproval()` only shows a generic
`alert('Failed to submit template. Please try again.')` — the actual
reason never reaches the clinic admin. `02-marketing-templates.spec.ts`'s
create-template test uses a body worded to avoid tripping this so the
happy path is what's actually exercised; this finding is otherwise
unaddressed.

### 2. Maha "AI Instructions" — `scenarios/maha-instructions/`

Migrated 2026-08-24 from a Playwright harness that used to live inside
`reporty-web-backup` itself (`qa-playwright/`, tracked only on that repo's
`qa/playwright` branch — moved here per Adi's call that QA tooling
shouldn't live in the app repo). Automates
`reporty-web-backup/docs/handover/QA_Runbook_Reporty_In-App_Maha_Integration_Test.md`,
driving the real chat UI at `dev.reporty.sa/customer/my-clinic` → MyFacility
→ AI Instruction step.

- **Section A (18 read tools):** fully scripted (`02-section-a-reads.spec.ts`).
- **Section B (14 MyFacility write tools):** B1, B5, B11-B14 fully scripted
  with real mechanical verification (count deltas, refresh-persistence
  checks). B2-B4, B6-B10, B15-B17 are stubs — same pattern, fill in the
  trigger + verify logic from the runbook
  (`03-section-b-instructions.spec.ts`).
- **Sections C-M (~46 more tools):** not scripted yet — `04-remaining-tools.spec.ts`
  is a template; the helpers (`helpers/maha-chat.ts`) are generic.
- **`B11-RAPID`** (inside `03-section-b-instructions.spec.ts`): reproduces a
  real rapid-fire fabricated-save bug found in prod on 2026-08-03. Re-run it
  after that bug is fixed to confirm the fix holds.
- **`05-mix-chat.spec.ts` / `06-negative-tests.spec.ts`:** multi-tool and
  error-handling scenarios.
- **`07-expected-text-mismatch.spec.ts` (ETM):** reproduces the
  `expected_text_mismatch` dead end reported by QA on 2026-08-26 as "the
  assistant errors out and stops responding after 2+ interactions" (clinic
  2886). It deliberately spends 3-4 turns re-drafting the SAME rule **without
  confirming** before it says "نعم" — that drift is what makes the model pass
  its own unconfirmed draft as `expected_text`, and it is exactly what a naive
  one-edit-then-confirm reproduction misses. Verdict rests on two
  browser-visible signals: the canned `_TECHNICAL_FAILURE_AFFIRMED_TEXT` string
  must not appear, and the rule's text in the panel must really have changed
  after a hard refresh. `ETM-2` is diagnostic only — it measures how many manual
  "حاول مرة اخري" rounds a user needs when the first confirm is wasted. See
  `helpers/expected-text-mismatch.ts` for the full mechanism.

  **Reproduction is stochastic — read the result codes carefully.** The bug can
  only fire if Maha actually SUPERSEDES its own pending proposal with a new
  draft; sometimes it just re-explains the one already pending, in which case
  `expected_text` never goes stale and the bug cannot occur. Measured on dev
  against known-buggy code: reproduced in 1 of 2 valid runs. So a single green
  run does **not** clear this bug — run it 3+ times and look at the spread. A
  run where no supersede happened self-reports `UNABLE_TO_TEST` and skips rather
  than claiming a pass.

  The suite tracks its rule by marker **and** by panel position, because Maha
  rewrites the rule when asked to shorten it and has been observed dropping the
  the marker along with the rest of the "filler". Position alone
  isn't safe either (`fo-irow-<id>` renders a 1-based POSITION, which shifts when
  any earlier rule is added or removed), so the positional fallback is only
  trusted while the panel count is unchanged. If both handles are lost the run
  fails loudly instead of asserting against some other clinic rule.
- **`section-bug005-false-success.skip.ts`:** the separate BUG-005
  false-success 5-phase probe (write → immediate read → delayed read →
  retry → duplicate check). Named `.skip.ts` **on purpose** — it's a
  diagnostic tool for a specific investigation, not a routine regression
  test, so it's excluded from `testMatch` (`/scenarios\/.*\.spec\.ts/`) by
  default. To run it: temporarily rename it to `.spec.ts`.
- **`01-cleanup-leftover-markers.spec.ts`:** sweeps up `[BUG005_TEST_*]`
  marker rules left behind by interrupted runs of the above.
- **`01b-cleanup-etm-marker.spec.ts`:** same, for the ETM suite's
  `ETM_TEST_*` markers (the suite mints a unique one per run). A leftover makes
  ETM-0 merge into it instead of creating its own rule, so clear it before
  re-running.

Results here are mostly `NEEDS_REVIEW`, not `PASS`/`FAIL` — a script can
tell you "the count didn't move" or "the value reverted after refresh", not
"is this Arabic text verbatim correct" or "does this reply read as
fabricated". B11-B14 are the exception (hard mechanical persistence check).

Needs real per-clinic values in `.env` to run meaningfully:
`TEST_DOCTOR_NAME`, `TEST_CLINIC_NAME_ORIGINAL`, `TEST_INSTAGRAM_ORIGINAL` —
without them, some tests skip or don't revert to baseline. Keep
`ALLOW_DESTRUCTIVE_RESET=0` unless you specifically mean to run the
reset-to-baseline test in Section B.

## Setup

```bash
npm install
npx playwright install chromium   # or skip and rely on channel:'chrome' below
cp .env.example .env              # fill in LOGIN_EMAIL / LOGIN_PASSWORD / etc.
npm run login-setup               # one-time (or whenever the session expires), HEADED
```

`login-setup` opens a real browser because `/login` has an invisible
reCAPTCHA that can't be reliably solved unattended. It tries the normal
email+password submit first; if that doesn't clear `/login` within 8
seconds, it **pauses** so you can solve it by hand once, then click Resume
in the Playwright Inspector. Session is saved to `auth/.storage-state.json`
and reused by **both suites** — no repeated logins/captchas after that.

If `npx playwright install` can't reach `storage.googleapis.com` on your
network, `playwright.config.ts` already falls back to the system-installed
Google Chrome (`channel: 'chrome'`) for both projects — just make sure
Chrome is installed, no download needed.

## Running

```bash
# Inbox + Marketing
npm run test:inbox            # Inbox: list, chat, reply, contact save
npm run test:marketing        # Marketing: Templates CRUD, Contacts
npm run test:stubs            # Confirms Campaigns/Segments/Add-WA-number are still stubs
npm run test:inbox-marketing  # all three above

# Maha AI Instructions
npm run test:maha-a           # Section A (reads)
npm run test:maha-b           # Section B (writes) incl. B11-RAPID
npm run test:maha-remaining   # Sections C-M template/stubs
npm run test:maha-mix         # multi-tool scenarios
npm run test:maha-negative    # error-handling scenarios
npm run test:maha-etm         # expected_text_mismatch repro (~10 real Maha turns, slow)
npm run test:maha-all         # everything under maha-instructions/
npm run cleanup:maha-bug005   # sweep leftover [BUG005_TEST_*] markers
npm run cleanup:maha-etm      # sweep leftover ETM_TEST_* markers

npm run test:all              # absolutely everything (both suites)
npm run report                # open the HTML report for the last run
```

## Safety

- Every test that can send a real WhatsApp message only targets
  `TEST_WA_NUMBER` from `.env` (default `+6281266850960`, the sandbox
  number confirmed connected to the hardcoded `user_id=15` on
  `reporty-ai-agent-api-dev`). The reply test explicitly `test.skip()`s
  itself if the open conversation's phone doesn't match, rather than
  guessing.
- `03-marketing-campaigns-segments-stub.spec.ts` is written to **fail loud**
  if a real send/save request ever fires from those tabs — treat a failure
  there as "stop and check with the team", not "fix the assertion".
- Maha's Section B/C-M write tests operate on the real MyFacility data for
  whatever account is logged in — use a burner/test clinic account, not a
  real clinic's account, and never force the tools the runbook itself marks
  `UNABLE_TO_TEST` (owner-only actions, binary uploads, destructive actions
  without a burner clinic).
- Never point `BASE_URL` at production (`https://reporty.sa`). The Inbox/
  Marketing external API base the app itself talks to is a `-dev` host
  regardless, so there's no production-safe path through that feature yet.

## Notes

- `fullyParallel: false` / `workers: 1` globally — required by both suites:
  Inbox tests share real conversation state within a file, and Maha's
  `helpers/fixtures.ts` uses one worker-scoped shared page per spec file so
  later tests can depend on state an earlier one left behind (e.g. B12
  depends on B11's rule still being saved).
- Contact-save tests look for a conversation with **no** saved contact yet
  to exercise the add-contact path; if the shared sandbox data already has
  every conversation named, that test skips with an explanation rather than
  mutating a contact that might matter to someone else's manual testing.
- Maha's wizard-step navigation (`helpers/maha-chat.ts`'s
  `gotoAiInstructionStep()`) is code-confirmed against the real wizard
  script, not guessed — see the function's own comments for exact
  file/line references if it ever stops landing on step 3.
