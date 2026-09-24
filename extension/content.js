(() => {
  if (globalThis.__cosenseClipLoaded) return;
  globalThis.__cosenseClipLoaded = true;
  const extract = globalThis.CosenseExtract;
  let modal;
  let menuTarget;
  let lastJobId;
  let lastDraft;
  let opening;
  function installActionStyle() {
    if (document.querySelector('style[data-cosense-action-style]')) return;
    const style = document.createElement('style');
    style.dataset.cosenseActionStyle = 'true';
    style.textContent = `
      [data-cosense-action], [data-cosense-menu-item] { box-sizing: border-box; appearance: none; -webkit-appearance: none; }
      [data-cosense-action]:hover { background: color-mix(in srgb, currentColor 12%, transparent) !important; }
      [data-cosense-action][data-cosense-service="twitter"]:hover { color: rgb(29, 155, 240) !important; background: rgba(29, 155, 240, .1) !important; }
      [data-cosense-action]:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
      [data-cosense-menu-item]:hover, [data-cosense-menu-item]:focus-visible { background: var(--cosense-menu-hover, rgba(128,128,128,.12)) !important; }
      [data-cosense-action] svg { color: inherit; stroke: currentColor; }
    `;
    (document.head || document.documentElement).append(style);
  }
  const send = async data => {
    const result = await chrome.runtime.sendMessage(data);
    if (!result?.ok) throw new Error(result?.error || '拡張機能を再読み込みした場合は、このページも再読み込みしてください。');
    return result;
  };
  function open(clip = extract.current()) {
    if (!clip) return Promise.reject(new Error('X／Twitterでは個別のツイートだけをクリップできます。ツイートを開くか、投稿のクリップボタンを使ってください。'));
    if (opening) return opening;
    opening = mount(lastJobId && lastDraft ? lastDraft : clip).finally(() => { opening = null; });
    return opening;
  }
  async function mount(clip) {
    if (modal) { modal.dialog.focus(); return; }
    const config = await send({ type: 'config' });
    const host = document.createElement('cosense-clip');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = config.css;
    const dialog = document.createElement('dialog');
    dialog.className = 'clip-ui';
    dialog.setAttribute('aria-labelledby', 'clip-heading');
    // Static extension markup only. All page data is assigned via value/textContent.
    dialog.innerHTML = `<header><h1 id="clip-heading">クリップ</h1><button class="close" type="button" aria-label="閉じる"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></header>
      <form><p class="source"></p><p class="destination">保存先 <span></span></p>
      <label for="title">タイトル</label><input id="title" name="title" required maxlength="200" placeholder="タイトル">
      <label for="comment">コメント</label><textarea id="comment" name="comment" maxlength="20000" placeholder="コメント"></textarea>
      <label for="tags">タグ</label><input id="tags" name="tags" maxlength="2400" placeholder="タグ名"><p class="hint">スペース・カンマ区切り</p>
      <div class="actions"><button type="button" class="quiet settings">設定</button><div class="right"><button type="button" class="cancel">閉じる</button><button class="primary save" type="submit">保存する</button></div></div>
      <p class="status" role="status" aria-live="polite"></p><a class="result-link" target="_blank" rel="noopener noreferrer" hidden>保存したページを開く ↗</a></form>`;
    shadow.append(style, dialog);
    for (const type of ['keydown', 'keypress', 'keyup']) shadow.addEventListener(type, event => event.stopPropagation());
    document.documentElement.append(host);
    const previousFocus = document.activeElement;
    const find = selector => dialog.querySelector(selector);
    const form = find('form');
    const save = find('.save');
    const status = find('.status');
    const link = find('.result-link');
    let timer;
    let id = lastJobId;
    let saving = false;
    modal = { dialog, host };
    find('#title').value = clip.title;
    find('#tags').value = clip.tags ?? config.defaultTags;
    find('#comment').value = clip.comment || '';
    find('.source').textContent = `${clip.kind} · ${clip.url}`;
    find('.destination span').textContent = config.project ? `/${config.project}` : '未設定';
    save.disabled = !config.connected;
    if (!config.connected) status.textContent = '設定からPATと保存先プロジェクトを登録してください。';
    const close = () => { clearTimeout(timer); dialog.close(); host.remove(); modal = null; previousFocus?.focus(); };
    find('.close').onclick = close;
    find('.cancel').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    find('.settings').onclick = () => send({ type: 'openOptions' }).catch(error => { status.textContent = error.message; });
    function showJob(job) {
      if (!job) return;
      const busy = ['queued', 'preview', 'submit', 'verify'].includes(job.phase);
      const labels = { queued: '保存を準備しています…', preview: '内容を確認しています…', submit: '保存しています…', verify: '保存した内容を確認しています…', saved: '保存しました。', uncertain: '保存結果を確認してください。自動再送はしません。', failed: '保存できませんでした。', reviewed: '確認済みです。' };
      status.textContent = [labels[job.phase], job.error].filter(Boolean).join('\n');
      status.dataset.tone = job.phase === 'saved' ? 'success' : ['failed', 'uncertain'].includes(job.phase) ? 'error' : '';
      save.disabled = busy || ['saved', 'uncertain', 'reviewed'].includes(job.phase);
      save.textContent = busy ? '保存中…' : job.phase === 'saved' ? '保存済み' : '保存する';
      for (const input of form.querySelectorAll('input,textarea')) input.disabled = busy || ['saved', 'uncertain'].includes(job.phase);
      if (job.url && /^https:\/\/scrapbox\.io\//.test(job.url) && job.phase !== 'failed') {
        link.href = job.url; link.hidden = false;
        link.textContent = job.phase === 'saved' ? '保存したページを開く ↗' : '保存先のページを確認 ↗';
      }
      if (busy) timer = setTimeout(poll, 900);
      else {
        saving = false; lastJobId = null;
        if (job.phase === 'failed') id = null;
        if (job.phase === 'saved') timer = setTimeout(close, 3000);
      }
    }
    async function poll() {
      if (!host.isConnected || !id) return;
      try { showJob((await send({ type: 'status', id })).job); }
      catch { status.textContent = '結果を取得できません。設定画面の保存履歴を確認してください。'; save.disabled = true; }
    }
    form.onsubmit = async event => {
      event.preventDefault();
      if (saving || save.disabled) return;
      saving = true; save.disabled = true; status.dataset.tone = ''; link.hidden = true;
      id = crypto.randomUUID(); lastJobId = id;
      lastDraft = { ...clip, title: find('#title').value, tags: find('#tags').value, comment: find('#comment').value };
      status.textContent = '保存を開始しています…';
      try {
        await send({ type: 'save', id, clip: lastDraft });
        await poll();
      } catch (error) {
        saving = false; status.textContent = error.message; status.dataset.tone = 'error';
        // 応答消失なら送信済みの可能性がある。IDの記録を照会してから再入力を許可。
        try {
          const job = (await send({ type: 'status', id })).job;
          if (job) showJob(job);
          else { save.disabled = false; id = null; lastJobId = null; }
        } catch { save.disabled = true; }
      }
    };
    dialog.showModal();
    find('#title').focus();
    if (id) { save.disabled = true; await poll(); }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'open') return;
    open().then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  const youtube = location.hostname === 'www.youtube.com';
  const twitter = ['x.com', 'twitter.com'].includes(location.hostname);
  if (!youtube && !twitter) return;
  // メニューを開いた要素から対象を確定。画面全体のmetaは使わない。
  document.addEventListener('click', event => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest('[data-cosense-menu-item]')) return;
    if (twitter && element.closest('[data-testid="caret"]')) {
      document.querySelectorAll('[data-cosense-menu-item]').forEach(item => item.remove());
      menuTarget = { clip: extract.tweet(element.closest('article[data-testid="tweet"]')), at: Date.now(), page: location.href };
    } else if (youtube && element.closest('ytd-menu-renderer, yt-icon-button, button[aria-label]')) {
      document.querySelectorAll('[data-cosense-menu-item]').forEach(item => item.remove());
      const card = element.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model');
      const clip = card ? extract.video(card) : /\/watch|\/shorts\//.test(location.pathname) ? extract.current() : null;
      menuTarget = { clip, at: Date.now(), page: location.href };
    }
  }, true);
  let scheduled = false;
  function makeClipButton(clip, menuItem = false, reference = null, service = '') {
    const button = document.createElement('button');
    button.type = 'button';
    if (menuItem) { button.role = 'menuitem'; button.dataset.cosenseMenuItem = 'true'; }
    else { button.dataset.cosenseAction = 'true'; if (service) button.dataset.cosenseService = service; button.setAttribute('aria-label', 'Cosenseにクリップ'); button.title = 'Cosenseにクリップ'; }
    button._clip = clip;
    button.style.cssText = menuItem
      ? 'display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;border:0;background:transparent;color:inherit;font:500 14px system-ui;text-align:left;cursor:pointer;'
      : 'display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;margin:0;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer;';
    button.dataset.cosenseService = service;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('width', menuItem ? '20' : '22'); icon.setAttribute('height', menuItem ? '20' : '22');
    icon.setAttribute('aria-hidden', 'true'); icon.dataset.cosenseIcon = 'true';
    icon.style.cssText = `display:block;flex:0 0 ${menuItem ? 20 : 22}px;width:${menuItem ? 20 : 22}px;height:${menuItem ? 20 : 22}px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;`;
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    mark.setAttribute('d', 'M20.8 11.6 12 20.4a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5'); icon.append(mark);
    if (menuItem) { const label = document.createElement('span'); label.textContent = '＋ Cosenseにクリップ'; button.append(icon, label); }
    else button.append(icon);
    if (reference) {
      const style = getComputedStyle(reference);
      const rect = reference.getBoundingClientRect();
      const referenceIcon = reference.querySelector('svg, yt-icon');
      button.style.width = menuItem ? '100%' : `${Math.round(rect.height || 36)}px`;
      button.style.height = `${Math.round(rect.height || 36)}px`;
      button.style.borderRadius = menuItem ? '0' : '9999px';
      button.style.color = referenceIcon ? getComputedStyle(referenceIcon).color : style.color;
      button.style.background = style.backgroundColor;
      button.style.padding = style.padding;
      const size = referenceIcon?.getBoundingClientRect().width || (service === 'twitter' ? 18.75 : 24);
      icon.style.width = icon.style.height = `${size}px`;
      icon.style.flexBasis = `${size}px`;
      icon.style.strokeWidth = service === 'twitter' ? '1.8' : '1.5';
      if (menuItem) {
        const text = reference.querySelector('yt-formatted-string, span');
        button.style.font = getComputedStyle(text || reference).font;
        button.style.gap = service === 'twitter' ? '12px' : '16px';
      } else {
        button.style.padding = '0';
        button.style.flexShrink = '0';
      }
      button._syncColors = () => {
        const color = getComputedStyle(referenceIcon || reference).color;
        const background = getComputedStyle(reference).backgroundColor;
        if (button.style.color !== color) button.style.color = color;
        if (button.style.backgroundColor !== background) button.style.backgroundColor = background;
      };
    }
    button.onclick = event => { event.preventDefault(); event.stopPropagation(); open(button._clip).catch(() => { button.setAttribute('aria-label', 'ページを再読み込みしてください'); }); };
    return button;
  }
  function insertActionButton(anchor, clip, service) {
    // Spacing belongs to the action's outer layout item, not its inner button.
    const row = service === 'twitter' ? anchor.closest('[role="group"]') :
      anchor.closest('#top-level-buttons-computed, #flexible-item-buttons, ytd-menu-renderer');
    let item = anchor;
    if (row) while (item.parentElement && item.parentElement !== row) item = item.parentElement;
    const wrapper = document.createElement('span');
    wrapper.dataset.cosenseActionWrapper = 'true';
    const layout = getComputedStyle(item);
    wrapper.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle;';
    wrapper.style.margin = layout.margin;
    wrapper.style.flex = layout.flex;
    wrapper.style.alignSelf = layout.alignSelf;
    const button = makeClipButton(clip, false, anchor, service);
    wrapper.append(button);
    item.after(wrapper);
  }
  function injectActionButtons() {
    installActionStyle();
    if (twitter) {
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const anchor = article.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]');
        const clip = extract.tweet(article);
        const existing = article.querySelector('[data-cosense-action]');
        if (existing && clip) { existing._clip = clip; existing._syncColors?.(); }
        if (anchor && clip && !existing) insertActionButton(anchor, clip, 'twitter');
      }
    } else {
      for (const card of document.querySelectorAll('ytd-watch-flexy, ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer')) {
        const anchor = [...card.querySelectorAll('button, yt-button-shape button')].find(button => /保存|Save/i.test(button.getAttribute('aria-label') || ''));
        const clip = extract.video(card) || (card.matches('ytd-watch-flexy') ? extract.current() : null);
        const existing = card.querySelector('[data-cosense-action]');
        if (existing && clip) { existing._clip = clip; existing._syncColors?.(); }
        if (anchor && clip && !existing) insertActionButton(anchor, clip, 'youtube');
      }
    }
  }
  function injectMenu() {
    scheduled = false;
    if (!menuTarget?.clip || menuTarget.page !== location.href || Date.now() - menuTarget.at > 15000) return;
    const selector = twitter ? '[role="menu"]' : 'ytd-menu-popup-renderer tp-yt-paper-listbox, yt-sheet-view-model [role="menu"]';
    for (const menu of document.querySelectorAll(selector)) {
      if (!menu.getClientRects().length) continue;
      const existing = menu.querySelector('[data-cosense-menu-item]');
      if (existing) { existing._clip = menuTarget.clip; existing._syncColors?.(); continue; }
      const reference = (!twitter && menu.querySelector('tp-yt-paper-item')) || menu.querySelector('[role="menuitem"]');
      const button = makeClipButton(menuTarget.clip, true, reference, twitter ? 'twitter' : 'youtube');
      button.onclick = event => { event.preventDefault(); event.stopPropagation(); open(button._clip).catch(() => { button.textContent = 'ページを再読み込みしてください'; }); };
      menu.append(button);
      // YouTubeは元の項目数でポップアップ寸法を固定するため、追加項目も見える寸法にする。
      const popup = menu.closest('ytd-menu-popup-renderer');
      if (popup) {
        popup.style.setProperty('min-width', '230px', 'important');
        popup.style.setProperty('max-width', 'min(340px, 90vw)', 'important');
        popup.style.setProperty('max-height', '70vh', 'important');
      }
    }
  }
  const observer = new MutationObserver(() => {
    injectActionButtons();
    if (!scheduled && menuTarget?.clip && Date.now() - menuTarget.at <= 15000) { scheduled = true; requestAnimationFrame(injectMenu); }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'dark', 'src', 'srcset', 'poster'] });
  injectActionButtons();
})();
