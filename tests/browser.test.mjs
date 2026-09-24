import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';

test('Chrome拡張: 設定・Webクリップ・サイト別メニュー・保存結果', { timeout: 90000 }, async () => {
  await mkdir('.browser-test', { recursive: true });
  const profile = await mkdtemp(path.resolve('.browser-test/profile-'));
  const extension = await mkdtemp(path.resolve('.browser-test/extension-'));
  await cp('extension', extension, { recursive: true });
  const testManifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  // ツールバーのactiveTab付与の代わりにfixtureだけ許可。配布manifestには追加しない。
  testManifest.host_permissions.push('https://clip-test.example/*', 'https://www.youtube.com/*', 'https://x.com/*');
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(testManifest));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    headless: true, viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    // 外部への書き込みは行わない。実物のservice workerとUIを使い、Cosense応答だけをモック。
    await worker.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.mock = { requests: [], previews: {}, pages: {}, count: 0, failSubmit: false };
      globalThis.fetch = async (url, options) => {
        if (!String(url).startsWith('https://scrapbox.io/')) return original(url, options);
        const p = new URL(url).pathname;
        mock.requests.push({ path: p, method: options.method, credentials: options.credentials });
        if (options.headers['x-personal-access-token'] !== 'test-only-token') return Response.json({}, { status: 401 });
        if (p === '/api/users/me') return Response.json({ id: 'user', name: 'tester', displayName: 'Test User' });
        if (p === '/api/pages/test-project') return Response.json({ pages: [] });
        if (p.endsWith('/preview')) {
          const key = `p${++mock.count}`;
          const lines = JSON.parse(options.body).changes.map(c => c.lines);
          mock.previews[key] = lines;
          return Response.json({ previewId: key, pagePreview: { persistent: false, lines } });
        }
        if (p.endsWith('/submit')) {
          if (mock.failSubmit) throw new Error('network interrupted');
          const key = JSON.parse(options.body).previewId;
          const lines = mock.previews[key]; mock.pages[lines[0].text] = lines;
          return Response.json({ commitId: `commit-${key}`, page: { title: lines[0].text } });
        }
        const title = decodeURIComponent(p.split('/').at(-1));
        return Response.json({ lines: mock.pages[title] });
      };
    });
    const options = await context.newPage();
    const patternErrors = [];
    options.on('console', message => { if (/Invalid regular expression|Pattern attribute/.test(message.text())) patternErrors.push(message.text()); });
    await options.goto(`chrome-extension://${id}/options.html`);
    const projectInput = options.getByLabel('プロジェクト名', { exact: true });
    assert.equal(await projectInput.getAttribute('pattern'), null);
    assert.match(await projectInput.evaluate(input => getComputedStyle(input, '::placeholder').fontFamily), /Noto Sans/);
    assert.match(await projectInput.evaluate(input => getComputedStyle(input).fontFamily), /Noto Sans/);
    for (const [value, valid] of [['example-project', true], ['project123', true], ['bad_project', false], ['-project', false], ['', false]]) {
      await projectInput.fill(value);
      assert.equal(await projectInput.evaluate(input => input.checkValidity()), valid, `project validity: ${value}`);
    }
    assert.deepEqual(patternErrors, []);
    await options.getByLabel('プロジェクト名', { exact: true }).fill('test-project');
    await options.getByLabel('Personal Access Token', { exact: true }).fill('test-only-token');
    await options.getByLabel('既定のタグ').fill('あとで読む');
    await options.getByRole('button', { name: '接続を確認して保存' }).click();
    await options.getByText('接続設定を保存しました。', { exact: false }).waitFor();
    assert.equal(await options.getByLabel('Personal Access Token', { exact: true }).inputValue(), '');
    const stored = await worker.evaluate(async () => ({ local: await chrome.storage.local.get('settings'), session: await chrome.storage.session.get('token') }));
    assert.equal(stored.local.settings.token, undefined);
    assert.equal(stored.session.token, 'test-only-token');
    for (const colorScheme of ['light', 'dark']) {
      await options.emulateMedia({ colorScheme });
      await options.screenshot({ path: `.browser-test/settings-${colorScheme}.png` });
    }

    await context.route('https://clip-test.example/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta property="og:title" content="クリップする記事 &amp; 技術"><title>Fallback</title></head><body><h1>Example article</h1><p>Local test fixture</p></body></html>' }));
    const page = await context.newPage();
    await page.goto('https://clip-test.example/article');
    async function openClip() {
      await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const target = tabs.find(t => t.url?.startsWith('https://clip-test.example/'));
        // ActiveTabはツールバー操作で付与される。テストでは限定host許可の代わりに下記で注入。
        if (target) {
          await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['extract.js', 'content.js'] });
          await chrome.tabs.sendMessage(target.id, { type: 'open' });
        }
      });
    }
    await openClip();
    assert.equal(await page.getByLabel('タイトル', { exact: true }).inputValue(), 'クリップする記事 & 技術');
    await page.getByRole('button', { name: '保存する', exact: true }).click();
    await page.getByText('保存しました。', { exact: true }).waitFor();

    await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>Video list</title></head><body>
      <ytd-video-renderer><a id="video-title" href="/watch?v=video_A" title="動画A">動画A</a><ytd-menu-renderer><button id="menuA">動画Aのメニュー</button><button aria-label="保存">保存</button></ytd-menu-renderer></ytd-video-renderer>
      <ytd-video-renderer><a id="video-title" href="/watch?v=video_B" title="動画B">動画B</a><ytd-menu-renderer><button id="menuB">動画Bのメニュー</button></ytd-menu-renderer></ytd-video-renderer>
      <div id="popup"></div><script>for(const button of document.querySelectorAll('button'))button.onclick=()=>{document.querySelector('#popup').innerHTML='<ytd-menu-popup-renderer><tp-yt-paper-listbox><div>メニュー</div></tp-yt-paper-listbox></ytd-menu-popup-renderer>'}</script></body></html>` }));
    const youtube = await context.newPage();
    await youtube.goto('https://www.youtube.com/');
    assert.equal(await youtube.locator('[data-cosense-action]').count(), 1);
    await youtube.getByRole('button', { name: '動画Aのメニュー' }).click();
    await youtube.locator('[data-cosense-menu-item]').waitFor();
    assert.equal(await youtube.locator('[data-cosense-menu-item] [data-cosense-icon]').count(), 1);
    await youtube.getByRole('menuitem', { name: '＋ Cosenseにクリップ' }).click();
    await youtube.getByRole('dialog').waitFor();
    assert.equal(await youtube.getByLabel('タイトル', { exact: true }).inputValue(), '動画A');
    await youtube.evaluate(() => {
      window.siteKeys = [];
      for (const type of ['keydown', 'keypress', 'keyup']) {
        window.addEventListener(type, e => window.siteKeys.push(e.key), true);
        document.addEventListener(type, e => window.siteKeys.push(e.key));
      }
    });
    const titleField = youtube.getByLabel('タイトル', { exact: true });
    await titleField.fill('');
    await titleField.pressSequentially('test space');
    assert.equal(await titleField.inputValue(), 'test space');
    await titleField.press('Tab');
    assert.equal(await youtube.getByLabel('コメント').evaluate(e => e.getRootNode().activeElement === e), true);
    assert.deepEqual(await youtube.evaluate(() => window.siteKeys), []);
    await titleField.fill('動画A');
    const closeGeometry = await youtube.getByRole('button', { name: '閉じる', exact: true }).first().evaluate(button => {
      const buttonRect = button.getBoundingClientRect();
      const svgRect = button.querySelector('svg').getBoundingClientRect();
      return { button: [buttonRect.width, buttonRect.height], centerDelta: [
        (svgRect.left + svgRect.width / 2) - (buttonRect.left + buttonRect.width / 2),
        (svgRect.top + svgRect.height / 2) - (buttonRect.top + buttonRect.height / 2)
      ] };
    });
    assert.deepEqual(closeGeometry.button, [30, 30]);
    assert.ok(closeGeometry.centerDelta.every(delta => Math.abs(delta) < 0.1));
    const settingsGeometry = await youtube.getByRole('button', { name: '設定', exact: true }).evaluate(button => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height, paddingLeft: getComputedStyle(button).paddingLeft, paddingRight: getComputedStyle(button).paddingRight };
    });
    assert.equal(settingsGeometry.paddingLeft, settingsGeometry.paddingRight);
    assert.ok(settingsGeometry.height >= 36);
    await youtube.getByLabel('コメント').fill('日本語コメント 🧪\n二行目');
    assert.match(await youtube.getByLabel('コメント').evaluate(input => getComputedStyle(input).fontFamily), /Noto Sans/);
    for (const colorScheme of ['light', 'dark']) {
      await youtube.emulateMedia({ colorScheme });
      const style = await youtube.getByRole('dialog').evaluate(dialog => ({
        bg: getComputedStyle(dialog).backgroundColor,
        backdrop: getComputedStyle(dialog, '::backdrop').backgroundColor,
        blur: getComputedStyle(dialog, '::backdrop').backdropFilter,
        right: innerWidth - dialog.getBoundingClientRect().right,
        top: dialog.getBoundingClientRect().top
      }));
      assert.equal(style.bg, colorScheme === 'dark' ? 'rgb(13, 15, 18)' : 'rgb(255, 255, 255)');
      assert.equal(style.backdrop, 'rgba(0, 0, 0, 0)');
      assert.equal(style.blur, 'none');
      assert.equal(style.right, 16); assert.equal(style.top, 16);
      await youtube.screenshot({ path: `.browser-test/modal-${colorScheme}.png` });
    }
    const before = context.pages().length;
    await youtube.getByRole('button', { name: '保存する', exact: true }).click();
    await youtube.getByText('保存しました。', { exact: true }).waitFor();
    assert.equal(context.pages().length, before, '保存でタブを開かない');
    const data = await worker.evaluate(() => mock.pages['動画A']);
    assert.deepEqual(data.map(line => line.text), ['動画A', '[https://www.youtube.com/watch?v=video_A]', '', '日本語コメント 🧪', '二行目', '', '#あとで読む']);
    assert.equal(await youtube.getByRole('button', { name: '保存済み' }).isDisabled(), true);
    await youtube.waitForTimeout(3200);
    assert.equal(await youtube.getByRole('dialog').count(), 0);
    await youtube.getByRole('button', { name: '動画Bのメニュー' }).click();
    await youtube.getByRole('menuitem', { name: '＋ Cosenseにクリップ' }).click();
    assert.equal(await youtube.getByLabel('タイトル', { exact: true }).inputValue(), '動画B');
    await worker.evaluate(() => { mock.failSubmit = true; });
    await youtube.getByRole('button', { name: '保存する', exact: true }).click();
    await youtube.getByText('保存結果を確認してください。', { exact: false }).waitFor();
    assert.equal(await youtube.getByRole('button', { name: '保存する', exact: true }).isDisabled(), true);
    await options.getByRole('button', { name: '更新', exact: true }).click();
    await options.getByText('要確認', { exact: false }).waitFor();

    await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><article data-testid="tweet"><div data-testid="User-Name">投稿者 @author</div><div data-testid="tweetText">保存したい投稿</div><a href="/author/status/123456789"><time>12:00</time></a><button data-testid="caret">投稿メニュー</button><button data-testid="bookmark">ブックマーク</button></article><div id="popup"></div><script>document.querySelector('[data-testid="caret"]').onclick=()=>document.querySelector('#popup').innerHTML='<div role="menu"><div role="menuitem">既存項目</div></div>'</script></body></html>` }));
    const x = await context.newPage(); await x.goto('https://x.com/home');
    for (const pathname of ['/home', '/author', '/search?q=test']) {
      await x.evaluate(pathname => history.pushState({}, '', pathname), pathname);
      const result = await worker.evaluate(async () => {
        const tab = (await chrome.tabs.query({})).find(tab => tab.url?.startsWith('https://x.com/'));
        return chrome.tabs.sendMessage(tab.id, { type: 'open' });
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /個別のツイート/);
      assert.equal(await x.getByRole('dialog').count(), 0);
    }
    await x.evaluate(() => {
      const article = document.querySelector('article');
      article.insertAdjacentHTML('beforeend', `<img src="https://pbs.twimg.com/profile_images/avatar.jpg">
        <img src="https://pbs.twimg.com/media/photo?format=jpg&name=small">
        <img src="https://pbs.twimg.com/media/photo?format=jpg&name=large">
        <video src="blob:https://x.com/video" poster="https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/thumb.jpg"></video>
        <div data-testid="quoteTweet"><img src="https://pbs.twimg.com/media/quote.jpg"></div>
        <div role="link"><img src="https://pbs.twimg.com/media/unmarked-quote.jpg"></div>`);
    });
    assert.equal(await x.locator('[data-cosense-action]').count(), 1);
    for (const [theme, color, background] of [['light', 'rgb(83, 100, 113)', 'white'], ['dim', 'rgb(139, 152, 165)', 'rgb(21, 32, 43)'], ['dark', 'rgb(113, 118, 123)', 'black']]) {
      await x.evaluate(({ color, background }) => {
        document.body.style.backgroundColor = background;
        document.querySelector('[data-testid="bookmark"]').style.color = color;
      }, { color, background });
      await x.waitForFunction(color => getComputedStyle(document.querySelector('[data-cosense-action]')).color === color, color);
      await x.screenshot({ path: `.browser-test/x-action-${theme}.png` });
    }
    await x.getByRole('button', { name: '投稿メニュー' }).click();
    await x.locator('[data-cosense-menu-item]').waitFor();
    assert.equal(await x.locator('[data-cosense-menu-item] [data-cosense-icon]').count(), 1);
    await x.getByRole('menuitem', { name: '＋ Cosenseにクリップ' }).click();
    assert.equal(await x.getByLabel('タイトル', { exact: true }).inputValue(), '');
    assert.equal(await x.getByLabel('タイトル', { exact: true }).evaluate(input => input.checkValidity()), false);
    await x.getByText('X · https://x.com/author/status/123456789', { exact: true }).waitFor();
    await worker.evaluate(() => { mock.failSubmit = false; });
    await x.getByLabel('タイトル', { exact: true }).fill('画像付き投稿');
    await x.getByRole('button', { name: '保存する', exact: true }).click();
    await x.getByText('保存しました。', { exact: true }).waitFor();
    assert.deepEqual(await worker.evaluate(() => mock.pages['画像付き投稿'].map(line => line.text)), [
      '画像付き投稿', '[https://x.com/author/status/123456789]',
      '[https://pbs.twimg.com/media/photo.jpg]', '', '#あとで読む'
    ]);
    // content scriptからPAT保存先への直接アクセスは拒否される。
    const access = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({}); const tab = tabs.find(t => t.url?.startsWith('https://www.youtube.com/'));
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
        try { return { data: await chrome.storage.session.get('token') }; } catch { return { denied: true }; }
      } }); return result.result;
    });
    assert.equal(access.denied, true);
  } finally { await context.close(); }
});
