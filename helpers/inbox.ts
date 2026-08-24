import { Page, expect } from '@playwright/test';

/**
 * Selectors are read from the live source, not guessed:
 * - resources/views/front/customer/inbox.blade.php
 * - resources/views/front/customer/inbox/tab-contact-info.blade.php
 * - public/js/inbox/inbox.js
 */

export async function gotoInbox(page: Page) {
  await page.goto('/customer/inbox');
  await expect(page.locator('#inbox-chat-list')).toBeVisible();
}

export async function waitForConversations(page: Page) {
  // fetchContacts()/fetchConversations() run on DOMContentLoaded; give the
  // proxied external-API round trip a moment before asserting on rows.
  await page.locator('#inbox-chat-list .chat-item').first().waitFor({ timeout: 20_000 });
}

export async function openFirstConversation(page: Page) {
  await page.locator('#inbox-chat-list .chat-item').first().click();
  await expect(page.locator('#inbox-conv')).toBeVisible();
}

export async function sendReply(page: Page, text: string) {
  const input = page.locator('#conv-input');
  await input.fill(text);
  await page.locator('#conv-send-btn').click();
}

export async function openContactTab(page: Page) {
  await page.locator('.conv-tab[data-tab="contact"]').click();
  await expect(page.locator('#tab-contact')).toBeVisible();
}
