import { test, expect } from '@playwright/test';
import 'dotenv/config';
import { gotoInbox, waitForConversations, openFirstConversation, sendReply, openContactTab } from '../../helpers/inbox';

/**
 * Covers docs/handover/QA_Checklist_Inbox_Marketing_WhatsApp.md Sections A-C
 * in reporty-web-backup. Every account hits the same hardcoded external
 * user_id=15 (see InboxController::INBOX_USER_ID) — this is a shared sandbox
 * conversation set, not per-tester data. Any real send in this file targets
 * ONLY the sandbox number, never a real patient.
 */

const TEST_WA_NUMBER = process.env.TEST_WA_NUMBER || '+6281266850960';

test.describe('Inbox', () => {
  test('page loads and conversation list populates', async ({ page }) => {
    await gotoInbox(page);
    await waitForConversations(page);
    const count = await page.locator('#inbox-chat-list .chat-item').count();
    expect(count).toBeGreaterThan(0);
  });

  test('opening a conversation loads chat history', async ({ page }) => {
    await gotoInbox(page);
    await waitForConversations(page);
    await openFirstConversation(page);

    // conv-msgs is populated by loadChatHistory() -> POST inbox/chat-history
    await expect(page.locator('#conv-msgs')).toBeVisible();
    await expect(page.locator('#conv-name')).not.toHaveText('');
  });

  test('sending an empty message does not fire a request', async ({ page }) => {
    await gotoInbox(page);
    await waitForConversations(page);
    await openFirstConversation(page);

    // New behavior (commit 35787d7c1): when the WA 24h customer-service
    // window is closed (`windowOpen === false`), renderConvStatus() hides
    // #conv-input-area entirely — only template sends are allowed by WA's
    // own rules outside that window. Picking a conversation in that state
    // isn't a bug; this test just needs a conversation where free-text
    // reply is actually possible.
    const inputVisible = await page.locator('#conv-input').isVisible();
    test.skip(!inputVisible, 'Open conversation has its 24h window closed — composer is hidden by design (INB-20).');

    let sendFired = false;
    page.on('request', (req) => {
      if (req.url().includes('/send-reply')) sendFired = true;
    });

    await page.locator('#conv-input').fill('');
    await page.locator('#conv-send-btn').click();
    await page.waitForTimeout(1000);
    expect(sendFired).toBe(false);
  });

  test('INB-20: 24h window closed hides the composer and shows the warning bar', async ({ page }) => {
    await gotoInbox(page);
    await waitForConversations(page);

    // Find any conversation whose composer is hidden (window closed) by
    // walking the list rather than assuming the first one.
    const items = page.locator('#inbox-chat-list .chat-item');
    const count = await items.count();
    let found = false;
    for (let i = 0; i < count; i++) {
      await items.nth(i).click();
      const inputVisible = await page.locator('#conv-input').isVisible();
      if (!inputVisible) { found = true; break; }
    }
    test.skip(!found, 'No conversation in the current list has a closed 24h window right now.');

    await expect(page.locator('#conv-window-warning')).toBeVisible();
    await expect(page.locator('#conv-window-warning')).toContainText('24h window closed');
  });

  test('reply to the sandbox conversation actually sends', async ({ page }) => {
    await gotoInbox(page);
    await waitForConversations(page);
    await openFirstConversation(page);

    // Safety: confirm the open conversation is the sandbox number before
    // sending anything. If it isn't, this test intentionally fails loud
    // rather than silently messaging an unknown recipient.
    const phoneText = await page.locator('#conv-phone').textContent();
    const digitsOnly = (phoneText || '').replace(/\D/g, '');
    const sandboxDigits = TEST_WA_NUMBER.replace(/\D/g, '');
    test.skip(
      !digitsOnly.includes(sandboxDigits.slice(-9)),
      `Open conversation (${phoneText}) doesn't match TEST_WA_NUMBER (${TEST_WA_NUMBER}) — ` +
      `select the sandbox conversation manually before running this test, or confirm .env.`
    );
    test.skip(
      !(await page.locator('#conv-input').isVisible()),
      'Sandbox conversation currently has its 24h window closed — free-text reply is disabled by design (INB-20).'
    );

    const marker = `[QA-INBOX ${Date.now() % 100000}] automated reply test`;
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/send-reply') && r.request().method() === 'POST'),
      sendReply(page, marker),
    ]);
    expect(resp.ok()).toBeTruthy();
  });

  test('contact info tab renders and add-contact form is reachable', async ({ page }) => {
    await gotoInbox(page);
    await waitForConversations(page);
    await openFirstConversation(page);
    await openContactTab(page);

    const hasContact = page.locator('#ci-has-contact');
    const noContact = page.locator('#ci-no-contact');
    // exactly one of the two states should be visible
    const hasVisible = await hasContact.isVisible();
    const noVisible = await noContact.isVisible();
    expect(hasVisible !== noVisible).toBe(true);

    if (noVisible) {
      await page.locator('#ci-add-contact-btn').click();
      await expect(page.locator('#ci-add-form')).toBeVisible();
    }
  });

  test('saving a contact name persists after reload', async ({ page }) => {
    await gotoInbox(page);
    await waitForConversations(page);
    await openFirstConversation(page);
    await openContactTab(page);

    const noContact = page.locator('#ci-no-contact');
    test.skip(!(await noContact.isVisible()), 'First conversation already has a saved contact — pick a fresh one manually to test the add-contact path.');

    const testName = `QA Test Contact ${Date.now() % 100000}`;
    await page.locator('#ci-add-contact-btn').click();
    await page.locator('#ci-add-name-input').fill(testName);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/conversation/') && r.request().method() === 'PUT'),
      page.locator('#ci-add-form button', { hasText: 'Save' }).click(),
    ]);
    expect(resp.ok()).toBeTruthy();

    await expect(page.locator('#conv-name')).toHaveText(testName);

    await page.reload();
    await waitForConversations(page);
    // conversation list is sorted by wait time by default, so re-find by name
    await expect(page.locator('#inbox-chat-list .chat-name', { hasText: testName })).toBeVisible();
  });
});
