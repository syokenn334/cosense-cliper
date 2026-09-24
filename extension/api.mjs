export const ORIGIN = 'https://scrapbox.io';
export class ClipError extends Error {}
export function projectName(value) {
  const project = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(project)) throw new ClipError('プロジェクト名を半角英数字・ハイフンで入力してください。');
  return project;
}
export function tagsFrom(value) {
  const tags = [...new Set(String(value || '').split(/[\s,、，]+/u).map(t => t.replace(/^#+/, '')).filter(Boolean))];
  if (tags.length > 30 || tags.some(t => t.length > 80 || /[\[\]\x00-\x1f]/.test(t))) throw new ClipError('タグは30個まで、各80文字以内で入力してください。角括弧は使えません。');
  return tags;
}
export function clipLines(clip) {
  const title = String(clip?.title || '').trim();
  if (!title || title.length > 200 || /[\r\n\x00-\x1f]/.test(title)) throw new ClipError('タイトルは改行なしの1〜200文字で入力してください。');
  let url;
  try { url = new URL(clip.url); } catch { throw new ClipError('URLを確認してください。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 8000) throw new ClipError('HTTP/HTTPSのURLのみ保存できます。');
  if (/(^|\.)(x\.com|twitter\.com)$/.test(url.hostname) &&
      !/^\/(?:[a-zA-Z0-9_]+\/status|i\/web\/status)\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/.test(url.pathname)) {
    throw new ClipError('X／Twitterでは個別のツイートだけをクリップできます。');
  }
  const comment = String(clip.comment || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (comment.length > 20000 || comment.includes('\0')) throw new ClipError('コメントは20,000文字以内で入力してください。');
  const tags = tagsFrom(clip.tags);
  const kind = String(clip?.kind || '');
  // Save YouTube and tweet URLs in Cosense's bracket notation.
  const link = ['YouTube', 'X'].includes(kind) ? `[${url.href}]` : url.href;
  const media = [...new Set(Array.isArray(clip?.media) ? clip.media : [])].filter(value => {
    try { const mediaUrl = new URL(value); return ['http:', 'https:'].includes(mediaUrl.protocol) && mediaUrl.href.length <= 8000; } catch { return false; }
  });
  const attachments = kind === 'X' ? media.slice(0, 1) : media;
  return [title, link, ...(comment ? ['', ...comment.split('\n')] : []), ...attachments.map(value => `[${value}]`), ...(tags.length ? ['', tags.map(t => `#${t}`).join(' ')] : [])];
}
export function pageUrl(project, title) { return `${ORIGIN}/${project}/${encodeURIComponent(title.replaceAll(' ', '_'))}`; }
export function errorMessage(error) {
  if (error instanceof ClipError) return error.message;
  return '通信が完了しませんでした。接続を確認してください。';
}
export function client(token, fetcher = fetch) {
  if (typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/.test(token)) throw new ClipError('設定画面でPATを入力してください。');
  return async (path, body) => {
    const res = await fetcher(ORIGIN + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
      headers: { 'x-personal-access-token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      const reasons = { 401: 'PATが無効か期限切れです。設定画面で接続し直してください。', 403: 'このプロジェクトへのアクセスが拒否されました。PATと参加権限を確認してください。', 404: 'プロジェクト・ページが見つからないか、保存の準備が期限切れです。', 409: 'ページの競合が発生しました。保存履歴を確認してください。', 429: 'リクエストが多すぎます。時間をおいてください。' };
      throw new ClipError(reasons[res.status] || `Cosenseへの通信に失敗しました（HTTP ${res.status}）。`);
    }
    return res.json();
  };
}
export async function checkConnection(project, token, fetcher) {
  projectName(project);
  const request = client(token, fetcher);
  const user = await request('/api/users/me');
  if (user.isGuest || !user.id) throw new ClipError('PATによるログインを確認できませんでした。');
  // 読み取り到達性のみ確認。書き込み権限は実際の保存時にも判定する。
  await request(`/api/pages/${project}?limit=1`);
  return { name: String(user.name || ''), displayName: String(user.displayName || user.name || '') };
}
export async function saveClip({ project, token, clip, report, fetcher }) {
  projectName(project);
  const lines = clipLines(clip);
  const request = client(token, fetcher);
  let phase = 'preview';
  let title = lines[0];
  let url = pageUrl(project, title);
  let commitId;
  try {
    await report({ phase, title, url });
    const changes = lines.map(text => ({ _insert: '_end', lines: {
      id: Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join(''), text
    } }));
    const base = `/api/pages/v2/${project}/page-edit-for-ai`;
    const preview = await request(`${base}/preview`, { changes });
    const actual = preview.pagePreview?.lines?.map(line => line.text);
    // 新規ページとして作成され、タイトルが自動変更されていないことを確認する。
    if (!preview.previewId || preview.pagePreview?.persistent !== false || !actual?.[0] ||
        JSON.stringify(actual.slice(1)) !== JSON.stringify(lines.slice(1))) throw new ClipError('保存前の内容確認に失敗しました。ページは作成していません。');
    if (actual[0] !== lines[0]) throw new ClipError('同じタイトルのページが既に存在します。タイトルを変更してください。');
    title = actual[0];
    url = pageUrl(project, title);
    phase = 'submit';
    await report({ phase, title, url }); // 永続記録してから送信。途中停止しても再送しない。
    const result = await request(`${base}/submit`, { previewId: preview.previewId });
    // submitが成功しても、Cosense側の応答にcommitId/pageが含まれない場合がある。
    // previewで確定したタイトルを使って再取得し、実ページの本文一致を成功条件にする。
    if (typeof result.page?.title === 'string' && result.page.title) title = result.page.title;
    url = pageUrl(project, title);
    commitId = typeof result.commitId === 'string' ? result.commitId : undefined;
    phase = 'verify';
    await report({ phase, title, url, commitId });
    const saved = await request(`/api/pages/${project}/${encodeURIComponent(title)}`);
    if (JSON.stringify(saved.lines?.map(line => line.text)) !== JSON.stringify([title, ...lines.slice(1)])) throw new ClipError('作成は完了しましたが、本文の一致を確認できませんでした。ページを確認してください。');
    const final = { phase: 'saved', title, url, ...(commitId ? { commitId } : {}) };
    await report(final);
    return final;
  } catch (error) {
    const final = { phase: phase === 'submit' || phase === 'verify' ? 'uncertain' : 'failed', title, url, ...(commitId ? { commitId } : {}), error: errorMessage(error) };
    await report(final);
    return final;
  }
}
