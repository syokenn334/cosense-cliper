import { projectName } from './api.mjs';
const $ = id => document.getElementById(id);
$('version').textContent = `Cosense Clip v${chrome.runtime.getManifest().version}`;
function validateProject() {
  try { projectName($('project').value); $('project').setCustomValidity(''); }
  catch (error) { $('project').setCustomValidity(error.message); }
}
$('project').addEventListener('input', validateProject);
const send = async message => {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '拡張機能との通信に失敗しました。');
  return result;
};
const showError = error => { $('status').textContent = error.message; $('status').dataset.tone = 'error'; };
function fill(config) {
  $('project').value = config.project || '';
  validateProject();
  $('defaultTags').value = config.defaultTags || '';
  $('remember').checked = config.remember;
  $('token').placeholder = config.connected ? 'PAT（登録済み）' : 'PAT';
  $('account').textContent = config.connected ? `接続中：${config.account?.displayName || config.account?.name || ''} / ${config.project}` : '未接続';
}
async function history() {
  const { jobs } = await send({ type: 'history' });
  $('history').replaceChildren();
  if (!jobs.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'まだクリップはありません。'; $('history').append(p); }
  const labels = { saved: '保存済み', failed: '失敗', uncertain: '要確認', preview: '内容確認中', submit: '保存中', verify: '保存確認中', queued: '準備中', reviewed: '確認済み' };
  for (const job of jobs) {
    const item = document.createElement('div'); item.className = 'history-item';
    const title = document.createElement(job.url ? 'a' : 'div'); title.textContent = job.title;
    if (job.url && /^https:\/\/scrapbox\.io\//.test(job.url)) { title.href = job.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
    const meta = document.createElement('p'); meta.textContent = `${labels[job.phase] || job.phase} · /${job.project} · ${new Date(job.created).toLocaleString('ja-JP')}`;
    item.append(title, meta);
    if (job.error) { const p = document.createElement('p'); p.textContent = job.error; item.append(p); }
    if (job.phase === 'uncertain') {
      const button = document.createElement('button'); button.textContent = '確認済みにする'; button.type = 'button';
      button.onclick = async () => { try { await send({ type: 'reviewed', id: job.id }); await history(); } catch (error) { showError(error); } };
      item.append(button);
    }
    $('history').append(item);
  }
}
$('settings').onsubmit = async event => {
  event.preventDefault(); $('connect').disabled = true; $('disconnect').disabled = true;
  $('status').textContent = 'アカウントとプロジェクトを確認しています…'; $('status').dataset.tone = '';
  const token = $('token').value; $('token').value = '';
  try {
    const config = await send({ type: 'connect', project: $('project').value, token, defaultTags: $('defaultTags').value, remember: $('remember').checked });
    fill(config); $('status').textContent = '接続設定を保存しました。'; $('status').dataset.tone = 'success';
  } catch (error) { showError(error); }
  finally { $('connect').disabled = false; $('disconnect').disabled = false; }
};
$('disconnect').onclick = async () => {
  try { await send({ type: 'disconnect' }); fill({}); $('token').value = ''; $('status').textContent = '接続を解除しました。'; } catch (error) { showError(error); }
};
$('refresh').onclick = () => history().catch(showError);
try { fill(await send({ type: 'config' })); await history(); } catch (error) { showError(error); }
