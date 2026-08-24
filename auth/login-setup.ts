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
 */
test('log in to dev.reporty.sa and save session state', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000); // generous — this may involve a human

  const email = process.env.LOGIN_EMAIL;
  const password = process.env.LOGIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'LOGIN_EMAIL / LOGIN_PASSWORD not set. Copy .env.example to .env and fill them in.'
    );
  }

  await page.goto('/login');
  await page.locator('#login_email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#submit').click();

  // Give the automated path a real chance first (invisible captcha may just
  // pass and the app may redirect straight to the dashboard).
  const loggedInWithinTimeout = await page
    .waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 8_000 })
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

  await page.context().storageState({ path: 'auth/.storage-state.json' });
  console.log('[login-setup] Session saved to auth/.storage-state.json');
});
