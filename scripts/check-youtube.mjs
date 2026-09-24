import { chromium } from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
await mkdir('.browser-test', { recursive: true });
const profile = await mkdtemp(path.resolve('.browser-test/youtube-'));
const extension = path.resolve('extension');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true, viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.locator('ytd-watch-metadata h1').waitFor({ timeout: 15000 });
  const spacing = await page.locator('ytd-watch-metadata [data-cosense-action]').evaluate(button => {
    const wrapper = button.parentElement;
    const previous = wrapper.previousElementSibling;
    const native = previous.querySelector('button') || previous;
    return { gap: button.getBoundingClientRect().left - native.getBoundingClientRect().right,
      margin: getComputedStyle(wrapper).margin, nativeMargin: getComputedStyle(previous).margin };
  });
  console.log('Action button spacing:', spacing);
  if (spacing.margin !== spacing.nativeMargin || Math.abs(spacing.gap - 8) > 0.5) throw new Error('Action spacing differs from native buttons');
  const menu = page.locator('ytd-watch-metadata button[aria-label="その他の操作"]:visible');
  const count = await menu.count();
  console.log('Visible video menu buttons:', count);
  if (count !== 1) throw new Error('Video menu is ambiguous');
  await menu.click();
  await page.screenshot({ path: '.browser-test/youtube-menu-updated.png' });
  const styles = await page.locator('[data-cosense-menu-item]').evaluate(button => {
    const native = button.parentElement.querySelector('tp-yt-paper-item');
    return [native, button].map(e => ({ color: getComputedStyle(e).color, height: e.getBoundingClientRect().height, padding: getComputedStyle(e).padding }));
  });
  console.log('Native / clip menu styles:', styles);
  console.log('Visible menu containers:', await page.locator('ytd-menu-popup-renderer:visible, [role="menu"]:visible').evaluateAll(es => es.map(e => ({ tag: e.tagName, html: e.outerHTML.slice(0,2200) }))));
  await page.getByRole('menuitem', { name: '＋ Cosenseにクリップ' }).click({ timeout: 10000 });
  await page.getByRole('dialog').waitFor();
  console.log('Clip title:', await page.getByLabel('タイトル', { exact: true }).inputValue());
  console.log('Source:', await page.locator('cosense-clip .source').textContent());
  const playerBefore = await page.locator('video').first().evaluate(video => ({ paused: video.paused, theater: document.querySelector('ytd-watch-flexy').hasAttribute('theater') }));
  await page.getByRole('textbox', { name: 'コメント', exact: true }).pressSequentially('test space t k f');
  const playerAfter = await page.locator('video').first().evaluate(video => ({ paused: video.paused, theater: document.querySelector('ytd-watch-flexy').hasAttribute('theater') }));
  if (JSON.stringify(playerBefore) !== JSON.stringify(playerAfter)) throw new Error('YouTube shortcut changed playback/layout while typing');
  if (await page.getByRole('textbox', { name: 'コメント', exact: true }).inputValue() !== 'test space t k f') throw new Error('Typing failed');
  console.log('Live YouTube typing / shortcut isolation OK');
  await page.screenshot({ path: '.browser-test/youtube-live.png' });
  console.log('Live YouTube menu -> modal OK (no save request)');
} finally { await context.close(); }
