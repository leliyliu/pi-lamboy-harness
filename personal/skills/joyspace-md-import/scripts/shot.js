#!/usr/bin/env node
/** shot.js — 截图 JoySpace 文档 */
const { chromium } = require('playwright');
const path = require('path');
;(async () => {
const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : def; }
const url = arg('url');
const userData = arg('user-data', path.join(__dirname, '..', '.userdata'));
const out = arg('out', 'shot.png');
const browser = await chromium.launchPersistentContext(userData, { headless: true, viewport: { width: 1440, height: 900 } });
const page = browser.pages()[0] || await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
await page.locator('text=稍后作答').first().click().catch(() => {});
await page.waitForTimeout(1000);
await page.screenshot({ path: out, fullPage: true });
console.log('截图: ' + out);
await browser.close();
})();
