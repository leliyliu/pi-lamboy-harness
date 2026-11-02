const { chromium } = require('playwright');
(async () => {
  const n = parseInt(process.env.COUNT || '1', 10);
  const ctx = await chromium.launchPersistentContext(process.env.UD, {
    headless: true, viewport: { width: 1600, height: 1000 },
    args: ['--disable-popup-blocking'],
  });
  const urls = [];
  for (let i = 0; i < n; i++) {
    const page = await ctx.newPage();
    await page.goto(process.env.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4500);
    await page.locator('.create-card--new').first().click({ timeout: 10000 });
    await page.waitForTimeout(2000);
    const popupP = ctx.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    await page.locator('.c-create-menu-item', { hasText: 'Docs' }).first().click({ timeout: 10000 })
      .catch(async () => { await page.getByText(/^Docs$/).first().click({ timeout: 8000 }); });
    const popup = await popupP;
    let target = popup;
    if (!target) {
      for (let t = 0; t < 30; t++) {
        await page.waitForTimeout(500);
        const cand = ctx.pages().filter(p => /\/pages\/[A-Za-z0-9]{10,}/.test(p.url()));
        if (cand.length) { target = cand[cand.length - 1]; break; }
      }
    }
    if (!target) { console.log('FAIL', i, JSON.stringify(ctx.pages().map(p => p.url()))); continue; }
    await target.waitForLoadState('domcontentloaded').catch(() => {});
    await target.waitForTimeout(5000);
    console.log('CREATED', target.url());
    urls.push(target.url());
  }
  console.log('URLS_JSON', JSON.stringify(urls));
  await ctx.close();
})();
