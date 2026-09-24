import { checkConnection, clipLines, errorMessage, projectName, saveClip, tagsFrom, ClipError } from './api.mjs';

const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
const active = new Set();
const locks = new Set();
const sourceLocks = new Set();
let settingsBusy = false;
const uiCss = fetch(chrome.runtime.getURL('ui.css')).then(r => r.text());
const jobKey = id => `job:${id}`;
async function settings() {
  await ready;
  const local = (await chrome.storage.local.get('settings')).settings || {};
  const session = await chrome.storage.session.get('token');
  return { ...local, token: local.token || session.token || '' };
}
function publicSettings(s) { return { project: s.project || '', account: s.account || null, defaultTags: s.defaultTags || '', remember: !!s.remember, connected: !!s.token }; }
async function jobs() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([key]) => key.startsWith('job:')).map(([, value]) => value).sort((a, b) => b.created - a.created);
}
async function readJob(id) {
  const result = (await chrome.storage.local.get(jobKey(id)))[jobKey(id)];
  if (result && !active.has(id) && ['preview', 'submit', 'verify', 'queued'].includes(result.phase)) {
    return { ...result, phase: 'uncertain', error: '処理が中断された可能性があります。履歴のページを確認し、自動再送はしません。' };
  }
  return result;
}
async function startJob(message, sender) {
  if (!/^[a-f0-9-]{36}$/.test(message.id || '')) throw new ClipError('保存リクエストが不正です。');
  if (locks.has(message.id)) return { accepted: true };
  const source = String(message.clip?.url || '');
  if (sourceLocks.has(source)) throw new ClipError('このURLの保存を開始しています。しばらくお待ちください。');
  locks.add(message.id);
  sourceLocks.add(source);
  try {
    if (await readJob(message.id)) return { accepted: true };
    const s = await settings();
    if (!s.token || !s.project) throw new ClipError('先に設定画面でPATと保存先を登録してください。');
    clipLines(message.clip);
    const previous = (await jobs()).find(job => job.sourceUrl === message.clip.url && job.project === s.project && ['queued', 'preview', 'submit', 'verify', 'uncertain'].includes(job.phase));
    if (previous) throw new ClipError('このURLには処理中または結果未確認の保存があります。設定画面の履歴を確認してください。');
    const job = { id: message.id, tabId: sender.tab.id, project: s.project, sourceUrl: message.clip.url, title: message.clip.title, phase: 'queued', created: Date.now() };
    active.add(message.id);
    await chrome.storage.local.set({ [jobKey(job.id)]: job });
    // 失敗時にも同じリクエストIDを再送しない。結果はポーリングと履歴で取得。
    void saveClip({ project: s.project, token: s.token, clip: message.clip, report: async state => {
      Object.assign(job, state, { updated: Date.now() });
      await chrome.storage.local.set({ [jobKey(job.id)]: job });
    } }).catch(async () => {
      await chrome.storage.local.set({ [jobKey(job.id)]: { ...job, phase: 'uncertain', error: '結果の記録に失敗しました。保存先を確認してください。' } }).catch(() => {});
    }).finally(() => active.delete(job.id));
    // 保存済み／失敗済みだけを古い順に削除。未確認の記録は保持。
    const old = (await jobs()).filter(j => ['saved', 'failed', 'reviewed'].includes(j.phase)).slice(49);
    if (old.length) await chrome.storage.local.remove(old.map(j => jobKey(j.id)));
    return { accepted: true };
  } finally { locks.delete(message.id); sourceLocks.delete(source); }
}
async function handle(message, sender) {
  await ready;
  if (sender.id !== chrome.runtime.id) throw new ClipError('アクセスできません。');
  const options = sender.url === chrome.runtime.getURL('options.html');
  const content = sender.tab && sender.frameId === 0 && /^https?:\/\//.test(sender.url || '');
  if (!options && !content) throw new ClipError('この画面からは操作できません。');
  if (message.type === 'config') return { ...publicSettings(await settings()), css: await uiCss };
  if (message.type === 'openOptions') { await chrome.runtime.openOptionsPage(); return {}; }
  if (message.type === 'save' && content) return startJob(message, sender);
  if (message.type === 'status' && content) {
    const job = await readJob(message.id);
    if (job?.tabId !== sender.tab.id) return { job: null };
    return { job };
  }
  if (!options) throw new ClipError('設定画面から操作してください。');
  if (message.type === 'history') return { jobs: await Promise.all((await jobs()).slice(0, 50).map(j => readJob(j.id))) };
  if (message.type === 'reviewed') {
    const job = await readJob(message.id);
    if (!job || active.has(job.id)) throw new ClipError('処理中の記録は変更できません。');
    await chrome.storage.local.set({ [jobKey(job.id)]: { ...job, phase: 'reviewed' } });
    return {};
  }
  if (message.type === 'disconnect' || message.type === 'connect') {
    if (settingsBusy) throw new ClipError('接続設定を処理中です。');
    settingsBusy = true;
    try {
      if (message.type === 'disconnect') {
        await chrome.storage.local.remove('settings');
        await chrome.storage.session.remove('token');
        return {};
      }
      const old = await settings();
      const token = String(message.token || old.token || '').trim();
      const project = projectName(message.project);
      const defaultTags = tagsFrom(message.defaultTags).join(' ');
      const account = await checkConnection(project, token);
      const remember = !!message.remember;
      await chrome.storage.local.set({ settings: { project, defaultTags, account, remember, ...(remember ? { token } : {}) } });
      if (remember) await chrome.storage.session.remove('token');
      else await chrome.storage.session.set({ token });
      return publicSettings({ project, defaultTags, account, remember, token });
    } finally { settingsBusy = false; }
  }
  throw new ClipError('操作を認識できませんでした。');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message || {}, sender).then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: errorMessage(error) }));
  return true;
});
chrome.action.onClicked.addListener(async tab => {
  try {
    if (!tab.id || !/^https?:\/\//.test(tab.url || '')) throw new Error();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js', 'content.js'] });
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'open' });
    if (!result?.ok) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
      await chrome.action.setTitle({ tabId: tab.id, title: result?.error || 'このページには表示できません。' });
      return;
    }
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    await chrome.action.setTitle({ tabId: tab.id, title: 'Cosenseにクリップ' });
  } catch {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: 'このページには表示できません。通常のWebページで使用してください。' });
  }
});
