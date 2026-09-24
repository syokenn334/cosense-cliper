(() => {
  if (globalThis.CosenseExtract) return;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const tweetPath = /^\/(?:[a-zA-Z0-9_]+\/status|i\/web\/status)\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/;
  function normalizeUrl(value, base = location.href) {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP/HTTPSのみ対応しています。');
    if (/(^|\.)youtube\.com$/.test(url.hostname) || url.hostname === 'youtu.be') {
      const id = url.hostname === 'youtu.be' ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
      if (id && /^[a-zA-Z0-9_-]+$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (['x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) {
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (match) return `https://x.com/${match[1]}/status/${match[2]}`;
    }
    // 一般Webのhashやqueryには記事の識別情報もあるので、一律には削除しない。
    return url.href;
  }
  function tweet(article) {
    if (!article) return null;
    const link = article.querySelector('a[href*="/status/"] time')?.closest('a');
    if (!link) return null;
    const media = [...article.querySelectorAll('img, video[poster]')]
      .filter(element => element.closest('article') === article && !element.closest('[data-testid="quoteTweet"]'))
      .map(element => element.tagName === 'VIDEO' ? element.poster : element.currentSrc || element.src)
      .map(value => {
        try {
          const url = new URL(value);
          if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' ||
              !/^\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(url.pathname)) return null;
          // Cosense can recognize these as images without Twitter's format query.
          if (!/\.(jpg|jpeg|png|webp)$/i.test(url.pathname)) {
            const format = url.searchParams.get('format');
            if (!/^(jpg|jpeg|png|webp)$/i.test(format || '')) return null;
            url.pathname += `.${format}`;
          }
          url.search = ''; url.hash = '';
          return url.href;
        } catch { return null; }
      }).filter(Boolean);
    // Keep only the first attachment, even when quoted media uses unmarked DOM.
    return { title: '', url: normalizeUrl(link.href), kind: 'X', ...(media.length ? { media: [media[0]] } : {}) };
  }
  function video(card) {
    if (!card) return null;
    const link = card.querySelector('a#video-title, a#video-title-link, a[href*="/watch?v="], a[href*="/shorts/"]');
    if (!link) return null;
    return { title: clean(link.getAttribute('title') || link.textContent || card.querySelector('[role="heading"]')?.textContent).slice(0, 200) || 'YouTubeの動画', url: normalizeUrl(link.href), kind: 'YouTube' };
  }
  function current() {
    const meta = key => document.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.content;
    const isTwitter = ['x.com', 'twitter.com', 'www.twitter.com'].includes(location.hostname);
    if (isTwitter && tweetPath.test(location.pathname)) {
      const target = normalizeUrl(location.href);
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const result = tweet(article);
        if (result?.url === target) return result;
      }
      return { title: '', url: target, kind: 'X' };
    }
    if (isTwitter) return null;
    let url = location.href;
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    const isYoutube = /(^|\.)youtube\.com$/.test(location.hostname);
    if (canonical && !isYoutube && !['x.com', 'twitter.com'].includes(location.hostname)) {
      try { if (new URL(canonical).origin === location.origin) url = canonical; } catch {}
    }
    const heading = isYoutube ? clean(document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata')?.textContent) : '';
    return { title: clean(heading || meta('og:title') || meta('twitter:title') || document.title).slice(0, 200) || location.hostname,
      url: normalizeUrl(url), kind: isYoutube ? 'YouTube' : 'Web' };
  }
  globalThis.CosenseExtract = { normalizeUrl, current, tweet, video };
})();
