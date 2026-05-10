// content.js — DOM監視 & フィルタ適用

// ---- Dev: ファイル変更を検知 → background.js 経由で確実にリロード ----
(function devPageReload() {
  let lastTs = null;
  setInterval(async () => {
    try {
      const r  = await fetch('http://localhost:7654');
      const ts = await r.text();
      if (lastTs === null) { lastTs = ts; return; }
      if (ts !== lastTs) {
        lastTs = ts;
        // background.js に reload 要求を送る（chrome.runtime.reload はそちらで実行）
        chrome.storage.local.set({ _reloadRequest: ts });
      }
    } catch (_) {}
  }, 2000);
})();

// ---- Dev: コンソールログをターミナルに中継 ----
(function patchConsole() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  function relay(level, args) {
    orig[level].apply(console, args);
    // [AIFilter] を含む文字列引数があるか先にチェック（オブジェクトはまだ触らない）
    if (!args.some(a => typeof a === 'string' && a.includes('[AIFilter]'))) return;
    try {
      const msg = args.map(a => {
        if (a === null || typeof a !== 'object') return String(a);
        try { return JSON.stringify(a); } catch (_) { return '[Object]'; }
      }).join(' ');
      fetch('http://localhost:7655', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, msg }),
      }).catch(() => {});
    } catch (_) {}
  }
  console.log   = (...a) => relay('log',   a);
  console.warn  = (...a) => relay('warn',  a);
  console.error = (...a) => relay('error', a);
})();

console.log('[AIFilter] content.js loaded v3-core', location.href);

(async () => {
  console.log('[AIFilter] IIFE開始');
  const DEFAULT_SETTINGS = {
    enabled: true,
    threshold: 65,
    flagThreshold: 5,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let storageData = { flags: {}, whitelist: [] };
  let sessionHiddenCount = 0;

  const authorArticles = new Map();   // handle -> Set<article>
  const filteredArticles = new WeakSet();
  const userThreads = new Map();      // handle -> Set<threadId>（クロススレッド追跡）
  const userIds = new Map();          // handle -> userId (string)
  const detectedAIAccounts = new Map(); // handle -> { userId, score }
  let prelimCount = 0;  // TweetDetail API速報によるAI疑い件数（テキストのみ）
  const prelimSuspects = new Set();   // 速報スキャンで閾値超えしたhandle（未スクロール分含む）

  async function loadStorage() {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        console.log('[AIFilter] loadStorage タイムアウト（デフォルト値で続行）');
        resolve();
      }, 3000);
      chrome.storage.local.get(null, data => {
        clearTimeout(timer);
        settings = {
          enabled: data.enabled ?? DEFAULT_SETTINGS.enabled,
          threshold: data.threshold ?? DEFAULT_SETTINGS.threshold,
          flagThreshold: data.flagThreshold ?? DEFAULT_SETTINGS.flagThreshold,
        };
        storageData = {
          flags: data.flags ?? {},
          whitelist: data.whitelist ?? [],
        };
        console.log(`[AIFilter] loadStorage完了 enabled=${settings.enabled} threshold=${settings.threshold}`);
        resolve();
      });
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled)       settings.enabled       = changes.enabled.newValue;
    if (changes.threshold)     settings.threshold     = changes.threshold.newValue;
    if (changes.flagThreshold) settings.flagThreshold = changes.flagThreshold.newValue;
    if (changes.flags)         storageData.flags      = changes.flags.newValue;
    if (changes.whitelist)     storageData.whitelist  = changes.whitelist.newValue;
  });

  // interceptor.js から認証情報を受け取り、ISOLATED worldでGraphQL fetchを実行
  let _bearer = null;
  let _csrf   = null;
  let _ubsnUrl = null;
  let _features = '';
  let _userTweetsUrl = null;
  const fetchingProfiles = new Set();
  const fetchedUserTweets = new Set(); // 1アカウント1回のみ取得

  let _blockUrl = null;

  // sessionStorage経由のフォールバック（MAIN worldとISOLATED worldで共有される）
  function loadAuthFromSession() {
    try {
      const b = sessionStorage.getItem('aifilter_bearer');
      if (b && !_bearer) { _bearer = b; console.log('[AIFilter] sessionStorageからbearer復元'); }
      const c = sessionStorage.getItem('aifilter_csrf');
      if (c && !_csrf)   _csrf = c;
      const bl = sessionStorage.getItem('aifilter_block_url');
      if (bl && !_blockUrl) { _blockUrl = bl; console.log('[AIFilter] sessionStorageからblockUrl復元:', bl); }
      const mu = sessionStorage.getItem('aifilter_mute_url');
      if (mu && !_muteUrl) { _muteUrl = mu; console.log('[AIFilter] sessionStorageからmuteUrl復元:', mu); }
    } catch(_) {}
  }

  document.addEventListener('aifilter:authready', (e) => {
    const { bearer, csrf, ubsnUrl, features, userTweetsUrl, blockUrl } = e.detail;
    if (userTweetsUrl && !_userTweetsUrl) {
      _userTweetsUrl = userTweetsUrl;
      console.log('[AIFilter] UserTweets URL受信:', _userTweetsUrl);
    }
    if (blockUrl && !_blockUrl) {
      _blockUrl = blockUrl;
      console.log('[AIFilter] ブロックURL受信:', _blockUrl);
    }
    if (muteUrl && !_muteUrl) {
      _muteUrl = muteUrl;
      console.log('[AIFilter] ミュートURL受信:', _muteUrl);
    }
    const hadFeatures = !!_features;
    if (bearer) _bearer = bearer;
    if (csrf)   _csrf   = csrf;
    if (ubsnUrl) _ubsnUrl = ubsnUrl;
    if (features) _features = features;
    console.log(`[AIFilter] authready受信 bearer=${!!_bearer} url=${!!_ubsnUrl} features=${!!_features} pending=${pendingFetches.size}`);
    // features が新たに取得できた場合は既存のfetchを再実行
    if (!hadFeatures && _features) {
      console.log('[AIFilter] features取得 → 既存プロファイルを再フェッチ');
      const handles = [...fetchingProfiles];
      fetchingProfiles.clear();
      handles.forEach(h => fetchProfileIsolated(h));
    }
    drainPendingFetches();
  });

  const pendingFetches = new Set();

  function drainPendingFetches() {
    if (!_bearer || !_ubsnUrl) return;
    for (const h of [...pendingFetches]) {
      pendingFetches.delete(h);
      fetchProfileIsolated(h);
    }
  }

  function fetchProfileIsolated(handle) {
    if (!_bearer || !_ubsnUrl) {
      console.log(`[AIFilter] fetchProfile pending(auth未取得): @${handle} bearer=${!!_bearer} url=${!!_ubsnUrl}`);
      pendingFetches.add(handle); return;
    }
    if (fetchingProfiles.has(handle)) return;
    fetchingProfiles.add(handle);

    const csrf = _csrf || document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || '';
    const variables = JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true });
    const DEFAULT_FEATURES = 'features=' + encodeURIComponent(JSON.stringify({
      hidden_profile_likes_enabled: true,
      hidden_profile_subscriptions_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      subscriptions_verification_info_is_identity_verified_enabled: true,
      subscriptions_verification_info_verified_since_enabled: true,
      highlights_tweets_tab_ui_enabled: true,
      responsive_web_twitter_article_notes_tab_enabled: true,
      subscriptions_feature_can_gift_premium_enabled: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
    }));
    const featuresParam = _features || DEFAULT_FEATURES;
    const url = `${_ubsnUrl}?variables=${encodeURIComponent(variables)}&${featuresParam}`;
    console.log('[AIFilter] ISOLATED GraphQL fetch:', handle);

    fetch(url, {
      credentials: 'include',
      headers: {
        'Authorization': _bearer,
        'x-csrf-token': csrf,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      },
    }).then(r => r.json()).then(data => {
      extractAndUpdateProfile(data, handle);
    }).catch(e => console.log('[AIFilter] ISOLATED GraphQL失敗:', handle, e.message));
  }

  // ---- UserTweets API でリプライ行動を取得・分析 ----
  async function fetchUserTweets(handle) {
    if (!_userTweetsUrl || !_bearer) return;
    if (fetchedUserTweets.has(handle)) return;
    const uid = userIds.get(handle);
    if (!uid) return;
    fetchedUserTweets.add(handle);

    const csrf = _csrf || document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || '';
    const variables = JSON.stringify({
      userId: uid, count: 20,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: true, withV2Timeline: true,
    });
    const featuresParam = _features || ('features=' + encodeURIComponent(JSON.stringify({
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
    })));
    const url = `${_userTweetsUrl}?variables=${encodeURIComponent(variables)}&${featuresParam}`;
    console.log('[AIFilter] UserTweets fetch:', handle, uid);

    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'Authorization': _bearer,
          'x-csrf-token': csrf,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
        },
      });
      if (!res.ok) { console.log('[AIFilter] UserTweets 失敗:', handle, res.status); return; }
      const data = await res.json();
      analyzeAndUpdateTweets(data, handle);
    } catch(e) {
      console.log('[AIFilter] UserTweets 例外:', handle, e.message);
    }
  }

  function analyzeAndUpdateTweets(data, handle) {
    const tweets = [];
    function walkTweets(obj, depth) {
      if (depth > 15 || !obj || typeof obj !== 'object') return;
      if (obj.legacy && typeof obj.legacy.full_text === 'string' &&
          typeof obj.legacy.conversation_id_str === 'string') {
        tweets.push({
          text: obj.legacy.full_text,
          convId: obj.legacy.conversation_id_str,
          isReply: !!obj.legacy.in_reply_to_status_id_str,
          createdAt: obj.legacy.created_at || null,
        });
        return;
      }
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (Array.isArray(val)) val.forEach(i => walkTweets(i, depth + 1));
        else if (val && typeof val === 'object') walkTweets(val, depth + 1);
      }
    }
    walkTweets(data, 0);
    if (tweets.length === 0) return;

    const replies = tweets.filter(t => t.isReply);
    const uniqueConvos = new Set(replies.map(t => t.convId)).size;
    const replyRatio = replies.length / tweets.length;

    // テキスト長の均一性（CV低い = 均一 = 怪しい）
    const lengths = replies.map(t => t.text.replace(/https?:\/\/\S+/g, '').trim().length);
    let textUniformity = 0;
    if (lengths.length >= 3) {
      const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const variance = lengths.reduce((s, l) => s + (l - avg) ** 2, 0) / lengths.length;
      textUniformity = avg > 0 ? Math.max(0, 1 - Math.sqrt(variance) / avg) : 0;
    }

    // 投稿時間帯の広がり（人間は寝る、BOTは24時間稼動）
    const hours = tweets
      .filter(t => t.createdAt)
      .map(t => { try { return new Date(t.createdAt).getUTCHours(); } catch(_) { return -1; } })
      .filter(h => h >= 0);
    const activeHours = new Set(hours).size;

    console.log(`[AIFilter] UserTweets分析 @${handle}: ${tweets.length}件 replies=${replies.length} uniqueConvos=${uniqueConvos} uniformity=${textUniformity.toFixed(2)} activeHours=${activeHours}`);
    window.AIDetector.updateProfile(handle, {
      tweetHistory: { uniqueConvos, textUniformity, replyRatio, activeHours, sampleSize: tweets.length },
    });
    saveProfileToDB(handle);
    rescoreAuthor(handle);
  }

  function extractAndUpdateProfile(obj, targetHandle) {
    // Twitter API の新構造: result.core.screen_name + result.legacy.statuses_count
    // 旧構造: legacy.screen_name + legacy.statuses_count も併用
    let bestMatch = null;

    function tryMatch(postCount, joinDateStr, followers, following, bio, profileImageUrl, isProtected) {
      const joinDateISO = joinDateStr ? (() => { try { return new Date(joinDateStr).toISOString(); } catch(_) { return null; } })() : null;
      const score = (postCount !== null ? 10 : 0) + (followers !== null ? 5 : 0)
                  + (following !== null ? 5 : 0) + (joinDateISO ? 1 : 0);
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { postCount, joinDateISO, followers: followers ?? 0, following: following ?? 0, bio: bio ?? null, profileImageUrl: profileImageUrl ?? null, isProtected: isProtected ?? null, score };
      }
    }

    function walk(o, depth) {
      if (depth > 30 || !o || typeof o !== 'object') return;

      // 新構造: obj.core.screen_name + obj.legacy.statuses_count
      if (o.core && typeof o.core === 'object' &&
          typeof o.core.screen_name === 'string' &&
          o.core.screen_name.toLowerCase() === targetHandle) {
        const lg = (o.legacy && typeof o.legacy === 'object') ? o.legacy : {};
        tryMatch(
          typeof lg.statuses_count === 'number' ? lg.statuses_count : null,
          o.core.created_at || lg.created_at || null,
          typeof lg.followers_count === 'number' ? lg.followers_count : null,
          typeof lg.friends_count   === 'number' ? lg.friends_count   : null,
          typeof lg.description     === 'string' ? lg.description     : null,
          typeof lg.profile_image_url_https === 'string' ? lg.profile_image_url_https : null,
          lg.protected ?? null,
        );
      }

      // 旧構造: obj.screen_name + obj.statuses_count
      if (typeof o.screen_name === 'string' && o.screen_name.toLowerCase() === targetHandle) {
        tryMatch(
          typeof o.statuses_count === 'number' ? o.statuses_count
            : typeof o.tweet_count === 'number' ? o.tweet_count : null,
          o.created_at || null,
          typeof o.followers_count === 'number' ? o.followers_count : null,
          typeof o.friends_count   === 'number' ? o.friends_count   : null,
          typeof o.description === 'string' ? o.description : null,
          typeof o.profile_image_url_https === 'string' ? o.profile_image_url_https : null,
          o.protected ?? null,
        );
      }

      for (const key of Object.keys(o)) {
        const val = o[key];
        if (Array.isArray(val)) { for (const item of val) walk(item, depth + 1); }
        else if (val && typeof val === 'object') walk(val, depth + 1);
      }
    }
    walk(obj, 0);
    if (bestMatch) {
      console.log('[AIFilter] ISOLATED profile: @' + targetHandle + ' posts=' + bestMatch.postCount + ' followers=' + bestMatch.followers + ' defaultIcon=' + (bestMatch.profileImageUrl?.includes('default_profile_images') ?? false));
      window.AIDetector.updateProfile(targetHandle, {
        postCount: bestMatch.postCount,
        joinDate:  bestMatch.joinDateISO ? new Date(bestMatch.joinDateISO) : null,
        followers: bestMatch.followers,
        following: bestMatch.following,
        bio:       bestMatch.bio,
        profileImageUrl: bestMatch.profileImageUrl,
        isProtected: bestMatch.isProtected,
      });
      rescoreAuthor(targetHandle);
    } else {
      console.log('[AIFilter] ISOLATED profile: @' + targetHandle + ' → not found');
    }
  }

  // interceptor.js からユーザーデータを受け取る
  document.addEventListener('aifilter:userdata', (e) => {
    const { handle, postCount, joinDateISO, followers, following, userId, bio, profileImageUrl, isProtected } = e.detail;
    console.log(`[AIFilter] userdata受信: @${handle} posts=${postCount} joined=${joinDateISO} userId=${userId} articles=${authorArticles.get(handle)?.size ?? 0}`);
    if (userId) {
      userIds.set(handle, userId);
      refreshGroupAccountUI(handle);
    }
    window.AIDetector.updateProfile(handle, {
      postCount: postCount ?? null,
      joinDate: joinDateISO ? new Date(joinDateISO) : null,
      followers,
      following,
      bio: bio ?? null,
      profileImageUrl: profileImageUrl ?? null,
      isProtected: isProtected ?? null,
    });
    saveProfileToDB(handle);
    rescoreAuthor(handle);
  });

  // ---- 件数表示（速報 vs DOM確定） ----
  function refreshCountDisplay() {
    const countEl = document.getElementById('ai-panel-count');
    if (!countEl) return;
    const domCount = detectedAIAccounts.size;
    if (domCount >= prelimCount) {
      countEl.textContent = String(domCount);
      countEl.title = '';
    } else {
      countEl.textContent = `~${prelimCount}`;
      countEl.title = 'スクロール前の速報値（テキストのみ判定）';
    }
  }

  // interceptor.js が TweetDetail API を捕捉 → 全リプライテキストで速報スコアリング
  document.addEventListener('aifilter:replydata', (e) => {
    if (!settings.enabled || !isReplyContext()) return;
    const { replies } = e.detail;
    if (!replies?.length) return;
    const originalText = getOriginalTweetText();
    // 速報スキャンは行動シグナルなしのため閾値を70%に引き下げて検出数を補正
    const prelimThreshold = Math.round(settings.threshold * 0.70);
    let count = 0;
    for (const { handle, text } of replies) {
      const result = window.AIDetector.score(text, handle, [], 0, { originalText });
      if (result.total >= prelimThreshold) {
        count++;
        prelimSuspects.add(handle);
      }
    }
    if (count <= prelimCount) return;
    prelimCount = count;
    console.log(`[AIFilter] 速報: ~${prelimCount}件（テキストのみ）suspects=${[...prelimSuspects].join(',')}`);
    // バーがまだなければ早期生成を試みる
    if (!document.getElementById('ai-ctrl-bar') &&
        document.querySelector('[data-testid="cellInnerDiv"]')) {
      getOrCreateControlBar();
    }
    refreshCountDisplay();
  });

  // ---- ユーティリティ ----

  function parseCount(text) {
    if (!text) return 0;
    const t = text.replace(/,/g, '').trim();
    const m = t.match(/([\d.]+)\s*(万|千|K|M)?/i);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    const u = (m[2] || '').toLowerCase();
    if (u === '万') n *= 10000;
    else if (u === '千') n *= 1000;
    else if (u === 'k') n *= 1000;
    else if (u === 'm') n *= 1000000;
    return Math.round(n);
  }

  function parseJoinDate(text) {
    const jp = text.match(/(\d{4})年(\d{1,2})月から/);
    if (jp) return new Date(parseInt(jp[1]), parseInt(jp[2]) - 1, 1);
    const en = text.match(/[Jj]oined\s+([A-Za-z]+)\s+(\d{4})/);
    if (en) { const d = new Date(`${en[1]} 1, ${en[2]}`); if (!isNaN(d)) return d; }
    return null;
  }

  function getCurrentThreadId() {
    const m = location.pathname.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function hashContent(text, author) {
    const str = `${author}:${text.slice(0, 100)}`;
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    return `tweet_${Math.abs(h)}`;
  }

  function extractTweetInfo(article) {
    const textEl     = article.querySelector('[data-testid="tweetText"]');
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    const text = textEl ? textEl.innerText : '';
    let author = '';
    if (userNameEl) {
      for (const a of userNameEl.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (href && href.startsWith('/') && !href.includes('/status/')) {
          author = href.replace('/', '').toLowerCase();
          break;
        }
      }
    }
    return { text, author };
  }

  function getThreadReplies() {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  }

  function isReplyContext() {
    return window.location.href.includes('/status/');
  }

  function getOriginalTweetText() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length === 0) return '';
    const first = articles[0];
    const text = first.querySelector('[data-testid="tweetText"]')?.innerText || '';

    // 画像・動画サムネイルのalt textをDOMから取得（追加APIリクエストなし）
    const skipAltPattern = /^(画像|Image|GIF|動画|Video|写真|Photo|プロフィール|Profile|\d+\/\d+)$/i;
    const altTexts = Array.from(first.querySelectorAll('img[alt], video[poster]'))
      .map(el => el.alt || el.getAttribute('aria-label') || '')
      .filter(a => a.length > 2 && !skipAltPattern.test(a.trim()))
      .join(' ');

    return text + (altTexts ? ' ' + altTexts : '');
  }

  function isMediaOnly(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const hasText = textEl && textEl.innerText.trim().length > 0;
    const hasMedia = !!(
      article.querySelector('[data-testid="tweetPhoto"]') ||
      article.querySelector('[data-testid="videoPlayer"]') ||
      article.querySelector('[data-testid="gif"]')
    );
    return hasMedia && !hasText;
  }

  // ---- AIコントロールバー（記事はその場で折りたたみ、バーだけ上に表示）----
  let panelAllExpanded = false;

  function getOrCreateControlBar() {
    if (document.getElementById('ai-ctrl-bar')) return document.getElementById('ai-ctrl-bar');

    const bar = document.createElement('div');
    bar.id = 'ai-ctrl-bar';
    bar.innerHTML = `
      <div class="ai-ctrl-row">
        <span class="ai-ctrl-title">AIの疑い <span id="ai-panel-count">0</span>件</span>
        <button id="ai-panel-toggle" class="ai-panel-btn">全て表示</button>
        <button id="ai-block-selected-btn" class="ai-panel-btn">選択ブロック&amp;更新</button>
        <button id="ai-mute-all-btn" class="ai-panel-btn ai-panel-btn-warning">全員ミュート&amp;更新</button>
        <button id="ai-block-all-btn" class="ai-panel-btn ai-panel-btn-danger">全員ブロック&amp;更新</button>
      </div>
      <div id="ai-panel-accounts" class="ai-panel-accounts"></div>
    `;

    // 最初の ai-filter-wrapper の直前に挿入（なければ OP ツイートの直後）
    const firstWrapper = document.querySelector('.ai-filter-wrapper');
    if (firstWrapper?.parentNode) {
      firstWrapper.parentNode.insertBefore(bar, firstWrapper);
    } else {
      const firstCell = document.querySelector('[data-testid="cellInnerDiv"]');
      if (firstCell?.parentNode) firstCell.parentNode.insertBefore(bar, firstCell.nextSibling);
    }

    bar.querySelector('#ai-panel-toggle').addEventListener('click', toggleAllWrappers);
    bar.querySelector('#ai-block-all-btn').addEventListener('click', blockAll);
    bar.querySelector('#ai-block-selected-btn').addEventListener('click', blockSelected);
    bar.querySelector('#ai-mute-all-btn').addEventListener('click', muteAll);
    return bar;
  }

  function toggleAllWrappers() {
    panelAllExpanded = !panelAllExpanded;
    document.querySelectorAll('.ai-filter-content').forEach(c =>
      c.classList.toggle('ai-filter-expanded', panelAllExpanded)
    );
    document.querySelectorAll('.ai-filter-expand-btn').forEach(b => {
      b.textContent = panelAllExpanded ? '折りたたむ' : '表示する';
    });
    const btn = document.getElementById('ai-panel-toggle');
    if (btn) btn.textContent = panelAllExpanded ? '全て折りたたむ' : '全て表示';
  }

  function updatePanelAccount(handle, score) {
    getOrCreateControlBar();
    refreshCountDisplay();

    const itemId = `ai-acct-${handle}`;
    if (document.getElementById(itemId)) return;

    const item = document.createElement('label');
    item.id = itemId;
    item.className = 'ai-account-item';
    const hasId = !!userIds.get(handle);
    item.innerHTML = `<input type="checkbox" class="ai-account-checkbox" data-handle="${handle}" ${hasId ? 'checked' : 'disabled'}><span class="ai-account-handle">@${handle}</span><span class="ai-account-score">${score}点</span>`;
    document.getElementById('ai-panel-accounts').appendChild(item);
  }

  function refreshGroupAccountUI(handle) {
    const item = document.getElementById(`ai-acct-${handle}`);
    if (!item) return;
    const cb = item.querySelector('.ai-account-checkbox');
    if (cb?.disabled && userIds.has(handle)) {
      cb.disabled = false;
      cb.checked = true;
    }
    const acc = detectedAIAccounts.get(handle);
    if (acc) acc.userId = userIds.get(handle);
  }

  async function blockUser(userId) {
    if (!userId) { console.log('[AIFilter] blockUser: userId null スキップ'); return false; }
    if (!_bearer) loadAuthFromSession();
    if (!_bearer) { console.log('[AIFilter] blockUser: bearer未取得 スキップ'); return false; }
    const csrf = _csrf || document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || '';
    if (!csrf) console.log('[AIFilter] blockUser: csrf未取得（エラーになる可能性あり）');

    // Twitterが実際に使うURLを優先。なければ同一オリジン経由のパスを使う（CORSを回避）
    const endpoint = _blockUrl || 'https://x.com/i/api/1.1/blocks/create.json';
    console.log(`[AIFilter] blockUser 試行: userId=${userId} endpoint=${endpoint}`);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Authorization': _bearer,
          'x-csrf-token': csrf,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `user_id=${encodeURIComponent(userId)}`,
      });
      const body = await res.text().catch(() => '');
      if (!res.ok) {
        console.log(`[AIFilter] blockUser失敗 userId=${userId} status=${res.status} body=${body.slice(0, 200)}`);
        // 失敗したURLとは別のエンドポイントでリトライ
        if (endpoint !== 'https://api.twitter.com/1.1/blocks/create.json') {
          return blockUserFallback(userId, csrf);
        }
      } else {
        console.log(`[AIFilter] blockUser成功 userId=${userId} status=${res.status}`);
      }
      return res.ok;
    } catch (e) {
      console.log('[AIFilter] blockUser例外:', e.message);
      return blockUserFallback(userId, csrf);
    }
  }

  async function blockUserFallback(userId, csrf) {
    const fallback = 'https://api.twitter.com/1.1/blocks/create.json';
    console.log(`[AIFilter] blockUser フォールバック: userId=${userId} endpoint=${fallback}`);
    try {
      const res = await fetch(fallback, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Authorization': _bearer,
          'x-csrf-token': csrf,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `user_id=${encodeURIComponent(userId)}`,
      });
      const body = await res.text().catch(() => '');
      console.log(`[AIFilter] blockUser フォールバック結果 status=${res.status} body=${body.slice(0, 200)}`);
      return res.ok;
    } catch(e) {
      console.log('[AIFilter] blockUser フォールバック例外:', e.message);
      return false;
    }
  }

  async function blockAll() {
    loadAuthFromSession();
    const btn = document.getElementById('ai-block-all-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'ブロック中...'; }

    if (!_bearer) {
      console.log('[AIFilter] blockAll: bearer未取得のためブロック不可');
      if (btn) { btn.disabled = false; btn.textContent = '全員ブロック&更新'; }
      alert('認証情報が未取得です。少し待ってから再試行してください。');
      return;
    }

    // DOMで確定 + 速報スキャンで疑われた全handleをブロック対象にする
    const allHandles = new Set([...detectedAIAccounts.keys(), ...prelimSuspects]);
    let blocked = 0, skipped = 0;

    for (const handle of allHandles) {
      const uid = userIds.get(handle) || detectedAIAccounts.get(handle)?.userId;
      if (uid) {
        const ok = await blockUser(uid);
        if (ok) blocked++;
        else skipped++;
      } else {
        skipped++;
        console.log(`[AIFilter] @${handle}: userId不明のためスキップ`);
      }
    }

    console.log(`[AIFilter] blockAll完了: ${blocked}件ブロック成功, ${skipped}件スキップ (合計${allHandles.size}件)`);
    window.location.reload();
  }

  async function blockSelected() {
    loadAuthFromSession();
    const checkboxes = document.querySelectorAll('.ai-account-checkbox:checked');
    if (!checkboxes.length) return;
    const btn = document.getElementById('ai-block-selected-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'ブロック中...'; }

    if (!_bearer) {
      console.log('[AIFilter] blockSelected: bearer未取得のためブロック不可');
      if (btn) { btn.disabled = false; btn.textContent = '選択ブロック&更新'; }
      alert('認証情報が未取得です。少し待ってから再試行してください。');
      return;
    }

    let blocked = 0, skipped = 0;
    for (const cb of checkboxes) {
      const handle = cb.dataset.handle;
      const uid = userIds.get(handle) || detectedAIAccounts.get(handle)?.userId;
      if (uid) {
        const ok = await blockUser(uid);
        if (ok) blocked++;
        else skipped++;
      } else {
        skipped++;
        console.log(`[AIFilter] @${handle}: userId不明のためスキップ`);
      }
    }

    console.log(`[AIFilter] blockSelected完了: ${blocked}件ブロック成功, ${skipped}件スキップ`);
    window.location.reload();
  }

  // ---- ホバーカード監視 ----
  const seenHoverCards = new WeakSet();
  const profileFetchTriggered = new Set();  // 自動ホバー済みのhandle

  let hoverTriggeredOnce = false; // UserByScreenName URL捕捉のための初回ホバー

  // interceptor.js にプロフィール取得をリクエスト
  function triggerProfileFetch(article, author) {
    if (profileFetchTriggered.has(author)) return;
    profileFetchTriggered.add(author);

    // 最初の1人だけ mouseenter → UserByScreenName URL を interceptor に捕捉させる
    if (!hoverTriggeredOnce) {
      hoverTriggeredOnce = true;
      setTimeout(() => {
        const userNameEl = article.querySelector('[data-testid="User-Name"]');
        if (!userNameEl) return;
        const link = Array.from(userNameEl.querySelectorAll('a[href]'))
          .find(a => /^\/[A-Za-z0-9_]+$/.test(a.getAttribute('href')));
        if (link) {
          link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
          // mouseleaveは送らない（ホバーカードを出したままAPIコールを完了させる）
          setTimeout(() => {
            link.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true, view: window }));
          }, 2000);
        }
      }, 800);
    }

    // すべての著者に API リクエストを送る（ISOLATED worldから直接fetch）
    fetchProfileIsolated(author);
    // UserTweets: 500〜1500ms のランダム遅延で分散（UserByScreenName が userId を取得してから）
    setTimeout(() => fetchUserTweets(author), 500 + Math.random() * 1000);
  }

  function monitorHoverCards() {
    new MutationObserver(mutations => {
      // 追加されたノードからHoverCardを直接探す（全体querySelectorは避ける）
      let card = null;
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE) continue;
          if (n.dataset?.testid === 'HoverCard') { card = n; break; }
          const found = n.querySelector?.('[data-testid="HoverCard"]');
          if (found) { card = found; break; }
        }
        if (card) break;
      }
      if (!card || seenHoverCards.has(card)) return;
      seenHoverCards.add(card);

      const handleLink = Array.from(card.querySelectorAll('a[href^="/"]'))
        .find(a => /^\/[A-Za-z0-9_]+$/.test(a.getAttribute('href')));
      if (!handleLink) return;
      const handle = handleLink.getAttribute('href').slice(1).toLowerCase();

      const text = card.innerText;
      const joinDate = parseJoinDate(text);

      // パターン1: 数値の後ろにラベル (例: "1,234 フォロワー")
      let followers = 0, following = 0;
      const followersM1 = text.match(/([\d,.]+\s*[万千KkMm]?)\s*(フォロワー|Followers?)/i);
      const followingM1 = text.match(/([\d,.]+\s*[万千KkMm]?)\s*(フォロー中|Following)/i);
      if (followersM1) followers = parseCount(followersM1[1]);
      if (followingM1) following = parseCount(followingM1[1]);

      // パターン2: ラベルの前後が逆 (数値行→ラベル行)
      if (!followers && !following) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          const num = parseCount(lines[i]);
          if (!num) continue;
          const next = (lines[i + 1] || '').toLowerCase();
          if (/フォロワー|followers?/.test(next)) followers = num;
          if (/フォロー中|following/.test(next)) following = num;
        }
      }

      if (joinDate || followers || following) {
        console.log(`[AIFilter] HoverCard @${handle}: joined=${joinDate}, followers=${followers}, following=${following}`);
        window.AIDetector.updateProfile(handle, { joinDate, followers, following });
        rescoreAuthor(handle);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ---- フィルタUI注入 ----
  function injectFilterUI(article, scoreResult, contentKey, author) {
    if (filteredArticles.has(article)) return;
    filteredArticles.add(article);

    const flagCount     = storageData.flags[contentKey] ?? 0;
    const flagThreshold = settings.flagThreshold;

    const wrapper = document.createElement('div');
    wrapper.className = 'ai-filter-wrapper';

    const signalTags = getSignalTags(scoreResult);
    const tagsHtml = signalTags.map(t => `<span class="ai-signal-tag">${t}</span>`).join('');

    const label = document.createElement('div');
    label.className = `ai-filter-label ${scoreResult.confidence.className}`;
    label.innerHTML = `
      <span class="ai-filter-label-text">AIの疑い</span>
      ${tagsHtml}
      <span class="ai-confidence-badge">${scoreResult.confidence.label} (${scoreResult.total}点)</span>
      <button class="ai-filter-expand-btn">${panelAllExpanded ? '折りたたむ' : '表示する'}</button>
      <button class="ai-filter-flag-btn ${flagCount > 0 ? 'ai-flag-voted' : ''}">AIではない (${flagCount}/${flagThreshold})</button>
    `;

    const content = document.createElement('div');
    content.className = 'ai-filter-content';
    if (panelAllExpanded) content.classList.add('ai-filter-expanded');

    // 記事はその場で wrapper に包む（DOM移動なし・Reactツリー安全）
    article.parentNode.insertBefore(wrapper, article);
    content.appendChild(article);
    wrapper.appendChild(label);
    wrapper.appendChild(content);

    // コントロールバーにアカウント登録
    detectedAIAccounts.set(author, { userId: userIds.get(author) ?? null, score: scoreResult.total });
    updatePanelAccount(author, scoreResult.total);

    label.querySelector('.ai-filter-expand-btn').addEventListener('click', () => {
      const expanded = content.classList.toggle('ai-filter-expanded');
      label.querySelector('.ai-filter-expand-btn').textContent = expanded ? '折りたたむ' : '表示する';
    });

    label.querySelector('.ai-filter-flag-btn').addEventListener('click', async () => {
      const data      = await getStorage(['flags', 'whitelist']);
      const flags     = data.flags ?? {};
      const whitelist = data.whitelist ?? [];
      flags[contentKey] = (flags[contentKey] ?? 0) + 1;

      if (flags[contentKey] >= flagThreshold && !whitelist.includes(contentKey)) {
        whitelist.push(contentKey);
        wrapper.parentNode.insertBefore(article, wrapper);
        wrapper.remove();
        detectedAIAccounts.delete(author);
        document.getElementById(`ai-acct-${author}`)?.remove();
        refreshCountDisplay();
        return;
      }
      await setStorage({ flags, whitelist });
      label.querySelector('.ai-filter-flag-btn').textContent =
        `AIではない (${flags[contentKey]}/${flagThreshold})`;
      label.querySelector('.ai-filter-flag-btn').classList.add('ai-flag-voted');
    });

    sessionHiddenCount++;
    chrome.storage.local.set({ sessionHiddenCount });
  }

  function getSignalTags(r) {
    const tags = [];
    if (r.tweetHistoryScore >= 25) tags.push('クロスBOT');
    if (r.profileScore >= 50)      tags.push('大量投稿');
    if (r.langShiftScore >= 20)    tags.push('言語シフト');
    if (r.textScore >= 20)         tags.push('AI表現');
    if (r.topicMismatch >= 20)     tags.push('的外れ返信');
    if (r.mediaScore >= 30)        tags.push('メディアのみ');
    return tags.slice(0, 3);
  }

  function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
  function setStorage(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)); }

  // ---- IndexedDB プロフィールキャッシュ（ページまたぎで永続化）----
  const IDB_NAME = 'aifilter_v1';
  const IDB_STORE = 'profiles';
  const IDB_TTL = 7 * 24 * 60 * 60 * 1000; // 7日
  let _idb = null;

  function openIDB() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE, { keyPath: 'handle' });
      req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
      req.onerror = () => reject(req.error);
    });
  }

  function saveProfileToDB(handle) {
    const profile = window.AIDetector.getProfile(handle);
    if (!profile) return;
    openIDB().then(db => {
      try {
        const record = { handle, ...profile, cachedAt: Date.now() };
        if (record.joinDate instanceof Date) { record.joinDateISO = record.joinDate.toISOString(); delete record.joinDate; }
        db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(record);
      } catch(_) {}
    }).catch(() => {});
  }

  async function loadProfilesFromDB() {
    try {
      const db = await openIDB();
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
      req.onsuccess = () => {
        const now = Date.now();
        const expired = [];
        for (const rec of (req.result || [])) {
          if (now - (rec.cachedAt || 0) > IDB_TTL) { expired.push(rec.handle); continue; }
          const { handle, cachedAt, joinDateISO, ...data } = rec;
          if (joinDateISO) data.joinDate = new Date(joinDateISO);
          window.AIDetector.updateProfile(handle, data);
        }
        if (expired.length) {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          expired.forEach(h => tx.objectStore(IDB_STORE).delete(h));
        }
        console.log(`[AIFilter] IndexedDB: ${(req.result||[]).length - expired.length}件ロード, ${expired.length}件期限切れ削除`);
      };
    } catch(e) { console.log('[AIFilter] IndexedDB load失敗:', e.message); }
  }

  // ---- ミュート ----
  let _muteUrl = null;

  async function muteUser(userId) {
    if (!userId) return false;
    if (!_bearer) loadAuthFromSession();
    if (!_bearer) return false;
    const csrf = _csrf || document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || '';
    const endpoint = _muteUrl || 'https://x.com/i/api/1.1/mutes/users/create.json';
    try {
      const res = await fetch(endpoint, {
        method: 'POST', credentials: 'include',
        headers: {
          'Authorization': _bearer, 'x-csrf-token': csrf,
          'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `user_id=${encodeURIComponent(userId)}`,
      });
      console.log(`[AIFilter] muteUser ${userId}: ${res.status}`);
      return res.ok;
    } catch(e) { console.log('[AIFilter] muteUser例外:', e.message); return false; }
  }

  async function muteAll() {
    loadAuthFromSession();
    const btn = document.getElementById('ai-mute-all-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'ミュート中...'; }
    if (!_bearer) { if (btn) { btn.disabled = false; btn.textContent = '全員ミュート&更新'; } alert('認証情報が未取得です。'); return; }
    const allHandles = new Set([...detectedAIAccounts.keys(), ...prelimSuspects]);
    let muted = 0, skipped = 0;
    for (const handle of allHandles) {
      const uid = userIds.get(handle) || detectedAIAccounts.get(handle)?.userId;
      if (uid) { const ok = await muteUser(uid); if (ok) muted++; else skipped++; }
      else skipped++;
    }
    console.log(`[AIFilter] muteAll完了: ${muted}件成功, ${skipped}件スキップ`);
    window.location.reload();
  }

  // ---- 記事処理 ----
  // threadReplies, originalText は processAllReplies でまとめて取得して渡す（N²クエリ回避）
  function processArticle(article, threadReplies, originalText) {
    if (filteredArticles.has(article)) return;
    if (!isReplyContext()) return;

    const { text, author } = extractTweetInfo(article);
    const mediaOnly = isMediaOnly(article);
    if (!text || text.trim().length < 10) {
      if (!mediaOnly) return;
    }

    // 著者→記事マッピング
    if (!authorArticles.has(author)) authorArticles.set(author, new Set());
    authorArticles.get(author).add(article);

    // プロフィールデータ未取得ならホバーAPIを自動トリガー
    triggerProfileFetch(article, author);

    // クロススレッド追跡
    const threadId = getCurrentThreadId();
    if (threadId && author) {
      if (!userThreads.has(author)) userThreads.set(author, new Set());
      userThreads.get(author).add(threadId);
    }

    const key = hashContent(text || author, author);
    if (storageData.whitelist.includes(key)) return;

    const crossThreadCount = userThreads.get(author)?.size ?? 0;
    const result = window.AIDetector.score(text, author, threadReplies || [], crossThreadCount, {
      hasMediaOnly: mediaOnly,
      originalText: originalText || '',
    });

    if (result.total >= settings.threshold) {
      console.log(
        `[AIFilter] HIT @${author} total=${result.total}` +
        ` (text=${result.textScore} beh=${result.behaviorScore} prof=${result.profileScore})` +
        ` thr=${settings.threshold}`
      );
      injectFilterUI(article, result, key, author);
    }
  }

  function rescoreAuthor(handle) {
    const articles = authorArticles.get(handle);
    if (!articles) return;
    // rescore時も共有コンテキストを一度だけ取得
    const threadReplies = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const originalText = threadReplies[0]?.querySelector('[data-testid="tweetText"]')?.innerText || '';
    for (const article of articles) {
      if (!filteredArticles.has(article)) processArticle(article, threadReplies, originalText);
    }
  }

  function processAllReplies() {
    if (!settings.enabled || !isReplyContext()) return;
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (!articles.length) return;
    // threadReplies と originalText を一度だけ取得して全記事に渡す
    const threadReplies = Array.from(articles);
    const originalText = threadReplies[0]?.querySelector('[data-testid="tweetText"]')?.innerText || '';
    console.log(`[AIFilter] processAllReplies: ${articles.length}件`);
    articles.forEach(a => processArticle(a, threadReplies, originalText));
  }

  function startObserver() {
    const root = document.getElementById('react-root') ?? document.body;
    let pending = false;
    new MutationObserver(mutations => {
      if (!settings.enabled || !isReplyContext()) return;
      let hasNewArticle = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.('article[data-testid="tweet"]') ||
              node.querySelector?.('article[data-testid="tweet"]')) {
            hasNewArticle = true;
            break;
          }
        }
        if (hasNewArticle) break;
      }
      if (!hasNewArticle || pending) return;
      // 新記事追加をまとめて次フレームで処理（連続 mutation をバッチ化）
      pending = true;
      requestAnimationFrame(() => { pending = false; processAllReplies(); });
    }).observe(root, { childList: true, subtree: true });
  }

  // ---- プロフィールページからツイート数を読む ----
  function processProfilePage() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]+)\/?$/);
    if (!m) return;
    const handle = m[1].toLowerCase();

    const tryExtract = () => {
      const body = document.body.innerText;
      const jpMatch = body.match(/([\d,]+)\s*件のポスト/);
      const enMatch = body.match(/([\d,.]+[KkMm]?)\s*[Pp]osts?\b/);
      const raw = jpMatch?.[1] || enMatch?.[1];
      if (!raw) return false;
      const count = parseCount(raw);
      if (!count) return false;
      console.log(`[AIFilter] プロフィールページ @${handle}: ${count}件`);
      window.AIDetector.updateProfile(handle, { postCount: count });
      rescoreAuthor(handle);
      return true;
    };

    if (!tryExtract()) setTimeout(tryExtract, 2000);
  }

  console.log('[AIFilter] 関数定義完了 → SPA observer設定中');

  // SPA遷移対応
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(processAllReplies, 1500);
      setTimeout(processProfilePage, 2500);
    }
  }).observe(document.body, { childList: true, subtree: true });

  try {
    startObserver();
    console.log('[AIFilter] startObserver完了');
    monitorHoverCards();
    loadProfilesFromDB();
    console.log('[AIFilter] init完了 → setTimeout登録');

    // sessionStorageからbearer復元を即時試みる（MAINワールドが先に書き込んでいる可能性）
    loadAuthFromSession();

    // interceptor.js に auth を要求（タイミング差で受け取り損ねた場合のリカバリ）
    const requestAuth = () => {
      loadAuthFromSession(); // sessionStorageも毎回チェック
      document.dispatchEvent(new CustomEvent('aifilter:requestauth'));
    };
    setTimeout(requestAuth, 200);
    setTimeout(requestAuth, 1000);
    // bearer が取れるまで最大 10 秒リトライ
    const authRetry = setInterval(() => {
      if (_bearer) { clearInterval(authRetry); return; }
      requestAuth();
    }, 2000);
    setTimeout(() => clearInterval(authRetry), 10000);

    setTimeout(processAllReplies, 1500);
    setTimeout(processAllReplies, 4000);
    setTimeout(processProfilePage, 3000);

    loadStorage().then(() => {
      console.log('[AIFilter] loadStorage完了 → 再スキャン');
      setTimeout(processAllReplies, 500);
    });
  } catch (e) {
    console.log('[AIFilter] INIT ERROR:', e.message, e.stack);
  }
})();
