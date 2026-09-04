/**
 * scenarios/ob4-crm-export/ MUST run against a local reporty-web-backup
 * (`php artisan serve --port=8000`) wired to a local reporty-onboard-phase3
 * (`.venv/bin/python app.py`, port 9559 — see `reference-onboard-phase3-
 * local-integration-setup` for the full two-service local setup, incl. the
 * `ONBOARDING_SERVICE_URL=http://localhost:9559` Laravel .env setting).
 *
 * Why this is a hard requirement, not a preference: QA_TestScript_Phase4_CRM_Export.md
 * (reporty-web-backup) requires editing `config.json` and restarting the OB4
 * Python service for several cases (TC-P3-06, TC-PH3C-02/03, TC-CRM08-STUB-01) —
 * doing that against the shared dev server would disrupt it for everyone else
 * using dev.reporty.sa. This guard throws at module-load time (before any
 * test in the file runs) if BASE_URL isn't clearly local, rather than letting
 * a forgotten `.env` silently point a service-restart-dependent run at dev.
 *
 * The `test:ob4-*` npm scripts already set BASE_URL=http://localhost:8000 —
 * this guard is defense-in-depth for anyone invoking `playwright test`
 * directly, or who has a stale BASE_URL in `.env`.
 */
const baseURL = process.env.BASE_URL || '';
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(baseURL);

if (!isLocal) {
  throw new Error(
    `scenarios/ob4-crm-export/ requires a LOCAL BASE_URL (e.g. http://localhost:8000), got ` +
      `${baseURL ? `"${baseURL}"` : '(unset — defaults to https://dev.reporty.sa)'}. ` +
      'Run `npm run test:ob4-all` (or the other test:ob4-* scripts), which set this for you, ' +
      'or set BASE_URL=http://localhost:8000 yourself before invoking `playwright test` directly. ' +
      'Requires both a local `php artisan serve --port=8000` (reporty-web-backup) and a local ' +
      '`.venv/bin/python app.py` (reporty-onboard-phase3, port 9559) already running.'
  );
}

export const OB4_BASE_URL = baseURL;
