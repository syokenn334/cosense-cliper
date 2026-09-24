import test from 'node:test';
import assert from 'node:assert/strict';
import { clipLines, tagsFrom, saveClip, checkConnection } from '../extension/api.mjs';
const clip = { title: '日本語テスト 🧪', url: 'https://example.com/?a=1&b=2', comment: '一行目\r\n二行目', tags: '#技術,あとで読む 技術' };
test('改行とタグを正規化し、URLのqueryを保持する', () => {
  assert.deepEqual(clipLines(clip), ['日本語テスト 🧪', clip.url, '', '一行目', '二行目', '', '#技術 #あとで読む']);
  assert.deepEqual(clipLines({ title: '動画', url: 'https://www.youtube.com/watch?v=abc', kind: 'YouTube' }), ['動画', '[https://www.youtube.com/watch?v=abc]']);
  assert.deepEqual(clipLines({ title: '投稿', url: 'https://x.com/user/status/1', kind: 'X', media: ['https://pbs.twimg.com/media/a.jpg'] }), ['投稿', '[https://x.com/user/status/1]', '[https://pbs.twimg.com/media/a.jpg]']);
  assert.deepEqual(clipLines({ title: '引用付き投稿', url: 'https://x.com/user/status/1', kind: 'X', media: ['https://pbs.twimg.com/media/first.jpg', 'https://pbs.twimg.com/media/quoted.jpg'] }), ['引用付き投稿', '[https://x.com/user/status/1]', '[https://pbs.twimg.com/media/first.jpg]']);
  assert.deepEqual(tagsFrom(' #a、b，#a '), ['a', 'b']);
});
test('XとTwitterの検索・プロフィール等を拒否し、個別投稿は許可する', () => {
  for (const host of ['x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']) {
    for (const pathname of ['/search?q=test', '/home', '/author', '/explore', '/author/status/123abc']) {
      assert.throws(() => clipLines({ title: 'ページ', url: `https://${host}${pathname}` }), /個別のツイート/);
    }
    for (const pathname of ['/author/status/123', '/author/status/123?lang=ja', '/author/status/123/photo/1', '/i/web/status/123']) {
      assert.doesNotThrow(() => clipLines({ title: '投稿', kind: 'X', url: `https://${host}${pathname}` }));
    }
  }
});
test('不正なタイトル・URL・長すぎるコメントを拒否する', () => {
  for (const patch of [{ title: '' }, { title: 'a\nb' }, { url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com' }, { comment: 'a'.repeat(20001) }, { tags: '[a]' }]) {
    assert.throws(() => clipLines({ ...clip, ...patch }));
  }
});
function fixture(mode) {
  const calls = []; const states = []; let lines;
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(new URL(url).origin, 'https://scrapbox.io');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    if (url.endsWith('/preview')) {
      if (mode === 'auth') return Response.json({}, { status: 401 });
      const body = JSON.parse(options.body);
      assert.equal(body.pageId, undefined);
      lines = body.changes.map(c => c.lines);
      if (mode === 'suffix') lines[0].text += '_2';
      return Response.json({ previewId: 'preview', pagePreview: { persistent: mode === 'existing', lines: mode === 'mismatch' ? [] : lines } });
    }
    if (url.endsWith('/submit')) {
      if (mode === 'timeout') throw new Error('secret-token');
      if (mode === 'missing-metadata') return Response.json({});
      return Response.json({ commitId: 'commit', page: { title: lines[0].text } });
    }
    return Response.json({ lines: mode === 'readback' ? [] : lines });
  };
  return { calls, states, run: () => saveClip({ project: 'test-project', token: 'secret-token', clip, fetcher, report: async s => states.push(s) }) };
}
test('success: 保存後の読み取りで一致確認', async () => {
  const f = fixture('success'); const result = await f.run();
  assert.equal(result.phase, 'saved'); assert.equal(f.calls.length, 3);
});
test('同名ページが接尾辞で置換された場合は確定しない', async () => {
  const f = fixture('suffix'); const result = await f.run();
  assert.equal(result.phase, 'failed');
  assert.match(result.error, /同じタイトル/);
  assert.equal(f.calls.length, 1);
});
/*
for (const mode of ['success', 'suffix']) test(`${mode}: 保存後の読み取りで一致確認`, async () => {
  const f = fixture(mode); const result = await f.run();
  assert.equal(result.phase, 'saved'); assert.equal(f.calls.length, 3);
  if (mode === 'suffix') assert.match(result.title, /_2$/);
});
*/
for (const mode of ['auth', 'existing', 'mismatch']) test(`${mode}: 確定前に失敗したらsubmitしない`, async () => {
  const f = fixture(mode); assert.equal((await f.run()).phase, 'failed'); assert.equal(f.calls.length, 1);
});
test('確定の結果不明時は再送せず、例外の秘密情報を表示しない', async () => {
  const f = fixture('timeout'); const result = await f.run();
  assert.equal(result.phase, 'uncertain'); assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(f.states).includes('secret-token'), false);
});
test('読み戻し不一致を成功扱いしない', async () => {
  const f = fixture('readback'); const result = await f.run();
  assert.equal(result.phase, 'uncertain'); assert.equal(result.commitId, 'commit');
});
test('submit応答のメタデータが欠けても保存済み本文を確認できれば成功扱いする', async () => {
  const f = fixture('missing-metadata'); const result = await f.run();
  assert.equal(result.phase, 'saved');
  assert.equal(result.commitId, undefined);
  assert.equal(f.calls.length, 3);
});
test('HTTP 200のゲスト応答を接続成功と判定しない', async () => {
  await assert.rejects(checkConnection('test', 'token', async () => Response.json({ isGuest: true })), /ログイン/);
});
