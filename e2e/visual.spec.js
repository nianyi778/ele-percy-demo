import { test, expect } from '@playwright/test'
import percySnapshot from '@percy/playwright'

test('首页商品卡片', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.card')).toHaveCount(3)
  await percySnapshot(page, '首页')
})
