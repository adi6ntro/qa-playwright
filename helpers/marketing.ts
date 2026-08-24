import { Page, expect } from '@playwright/test';

/**
 * Selectors read from live source:
 * - resources/views/front/customer/Marketing/*.blade.php
 * - public/js/marketing/marketing.js
 */

export async function gotoMarketing(page: Page, tab: 'campaigns' | 'templates' | 'contacts' | 'segments' = 'templates') {
  await page.goto(`/customer/marketing?tab=${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

export async function openCreateTemplate(page: Page) {
  await page.locator('a', { hasText: '+ New Template' }).click();
  await expect(page.locator('#modal-choose-template')).toBeVisible();
  await page.locator('button', { hasText: '+ Create Template' }).click();
  await expect(page.locator('#modal-create-template')).toBeVisible();
}

export async function fillTemplateForm(page: Page, { name, body, category, language }: { name: string; body: string; category?: string; language?: string }) {
  await page.locator('#crt-name').fill(name);
  await page.locator('#crt-body').fill(body);
  if (category) await page.locator('#crt-category').selectOption(category);
  if (language) await page.locator('#crt-language').selectOption(language);
}
