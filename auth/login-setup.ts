import { test } from '@playwright/test';
import 'dotenv/config';

/**
 * One-time (or occasional, whenever the session expires) login helper.
 *
 * Why this isn't fully unattended: the real login page
 * (resources/views/auth/login.blade.php in reporty-web-backup) renders an
 * invisible Google reCAPTCHA v2. It usually passes silently for a
 * normal-looking session, but there's no reliable way to guarantee that
 * from a scripted run — so this runs HEADED (see playwright.config.ts,
 * project "setup") and pauses if login doesn't complete on its own, so a
 * human can solve a challenge once if one appears.
 *
 * Run with: npm run login-setup
 * (re-run whenever auth/.storage-state.json goes stale / session expires)
 *
 * Multi-account support (added for scenarios/ob4-crm-export/, which needs a
 * real branch_admin session and a real "orphaned staff" session — role_id=2
 * with parent_user_id NOT matching any clinic — to exercise role-scoping
 * checks; a single SA session can't cover those):
 *   LOGIN_PROFILE=ba      npm run login-setup   → reads LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA,
 *                                                  saves auth/.storage-state.ba.json
 *   LOGIN_PROFILE=orphan  npm run login-setup   → reads LOGIN_EMAIL_ORPHAN/LOGIN_PASSWORD_ORPHAN,
 *                                                  saves auth/.storage-state.orphan.json
 * Default (LOGIN_PROFILE unset) is unchanged: LOGIN_EMAIL/LOGIN_PASSWORD →
 * auth/.storage-state.json.
 *
 * Local-target support (scenarios/ob4-crm-export/ must run against a local
 * reporty-web-backup, not dev.reporty.sa — see helpers/ob4-local-guard.ts for
 * why). Session cookies are domain-scoped, so a dev.reporty.sa session can't
 * be reused against localhost — this needs its own login, saved to its own
 * file. Detected automatically from BASE_URL, no separate flag needed:
 *   BASE_URL=http://localhost:8000 npm run login-setup
 *     → saves auth/.storage-state.local.json
 *   BASE_URL=http://localhost:8000 LOGIN_PROFILE=ba npm run login-setup
 *     → saves auth/.storage-state.ba.local.json
 * (the npm run login-setup:local / :local-ba / :local-orphan scripts set
 * BASE_URL for you — see package.json)
 */
test('log in and save session state', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000); // generous — this may involve a human

  const profile = process.env.LOGIN_PROFILE?.trim().toLowerCase() || '';
  const suffix = profile ? `_${profile.toUpperCase()}` : '';
  const email = process.env[`LOGIN_EMAIL${suffix}`];
  const password = process.env[`LOGIN_PASSWORD${suffix}`];

  const baseURL = process.env.BASE_URL || '';
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(baseURL);
  const pathParts = ['auth/.storage-state'];
  if (profile) pathParts.push(profile);
  if (isLocal) pathParts.push('local');
  const storagePath = `${pathParts.join('.')}.json`;

  if (!email || !password) {
    throw new Error(
      `LOGIN_EMAIL${suffix} / LOGIN_PASSWORD${suffix} not set. Copy .env.example to .env and fill them in.`
    );
  }

  await page.goto('/login');
  await page.locator('#login_email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#submit').click();

  // Give the automated path a real chance first (invisible captcha may just
  // pass and the app may redirect straight to the dashboard).
  //
  // Bumped from 8_000 to 25_000 (2026-09-21): live-diagnosed via a throwaway
  // network-logging spec that the invisible reCAPTCHA v2 flow is NOT a single
  // round trip — clicking submit fires a real sequence of sequential requests
  // to Google (anchor -> bframe -> reload -> userverify -> clr) before
  // onCaptchaSuccess() ever fires and the form actually POSTs, even with
  // Google's official always-pass test site key. Measured this taking close
  // to (and sometimes over) 8s end-to-end in this harness's headed Chrome,
  // which made this branch look like "login failed" on runs that would have
  // succeeded seconds later — the browser was never stuck, just still
  // mid-flight through reCAPTCHA when the check fired.
  const loggedInWithinTimeout = await page
    .waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);

  if (!loggedInWithinTimeout) {
    console.log(
      '\n[login-setup] Still on the login page after submit — a captcha ' +
      'challenge or validation error likely appeared. The browser window ' +
      'is open: solve it manually, make sure you land on a logged-in page, ' +
      'then click "Resume" in the Playwright Inspector toolbar.\n'
    );
    await page.pause();
  }

  // Sanity check: confirm we're actually authenticated before saving state,
  // by hitting a customer-only page and checking we weren't bounced to /login.
  await page.goto('/customer/inbox');
  if (page.url().includes('/login')) {
    throw new Error(
      'Still redirected to /login after the manual step — session was not established. Re-run login-setup.'
    );
  }

  await page.context().storageState({ path: storagePath });
  console.log(`[login-setup] Session saved to ${storagePath}`);
});
