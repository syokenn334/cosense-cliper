import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
await mkdir('.browser-test', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded' });
  await page.locator('ytd-watch-metadata h1').waitFor();
  await page.locator('ytd-watch-metadata button[aria-label="その他の操作"]:visible').click();
  console.log('YouTube', await page.locator('ytd-menu-popup-renderer:visible tp-yt-paper-item').evaluateAll(items => items.map(e => {
    const s = getComputedStyle(e), text = e.querySelector('yt-formatted-string'), icon = e.querySelector('yt-icon');
    return { text: e.textContent.trim(), color: s.color, background: s.backgroundColor, padding: s.padding, height: e.getBoundingClientRect().height, font: text && getComputedStyle(text).font, icon: icon && { width: getComputedStyle(icon).width, color: getComputedStyle(icon).color } };
  })));
  await page.screenshot({ path: '.browser-test/youtube-native-menu.png' });
  try {
    await page.goto('https://x.com', { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: '.browser-test/x-native.png' });
    console.log('X page:', await page.title());
  } catch (error) { console.log('X live inspection unavailable:', error.message.split('\n')[0]); }
} finally { await browser.close(); }
