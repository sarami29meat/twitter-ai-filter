// interceptor.js — Twitterのfetch/XHRレスポンスからユーザーデータを取得（MAIN world）
(function () {
  console.log('[AIFilter interceptor] 起動');

  const dispatchedHandles = new Set();
  const fetchingProfiles = new Set();
  const pendingProfiles = new Set();

  let _bearer = null;
  let _csrf = null;
  let _userByScreenNameUrl = null; // x.com/i/api/graphql/{hash}/UserByScreenName
  let _userTweetsUrl = null;       // x.com/i/api/graphql/{hash}/UserTweets(AndReplies)
  let _blockUrl = null;            // Twitterが実際に使うブロックエンドポイント
  let _muteUrl  = null;            // Twitterが実際に使うミュートエンドポイント

  function getCt0() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? m[1] : null;
  }

  // ---- UserByScreenName GraphQL で postCount を取得 ----
  function fetchUserProfileGraphQL(handle) {
    if (!_bearer || !_userByScreenNameUrl || fetchingProfiles.has(handle)) return;
    fetchingProfiles.add(handle);
    const csrf = _csrf || getCt0() || '';
    const variables = JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true });
    const url = `${_userByScreenNameUrl}?variables=${encodeURIComponent(variables)}&features=%7B%7D`;
    console.log('[AIFilter interceptor] GraphQL fetch:', handle);
    origFetch(url, {
      credentials: 'include',
      headers: {
        'Authorization': _bearer,
        'x-csrf-token': csrf,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      },
    }).then(r => r.json()).then(data => {
      findUsers(data, 0);
    }).catch(e => console.log('[AIFilter interceptor] GraphQL失敗:', handle, e.message));
  }

  function dispatchAuthReady() {
    if (!_bearer) return; // bearerさえあれば送る（ubsnUrlは省略可）
    let features = '';
    try { features = localStorage.getItem('aifilter_ubsn_features') || ''; } catch(_) {}
    document.dispatchEvent(new CustomEvent('aifilter:authready', {
      detail: { bearer: _bearer, csrf: _csrf || getCt0(), ubsnUrl: _userByScreenNameUrl, features, userTweetsUrl: _userTweetsUrl, blockUrl: _blockUrl, muteUrl: _muteUrl },
    }));
  }

  function tryProcessPending() {
    if (!_bearer) return;
    dispatchAuthReady(); // bearer さえあれば送る
    if (!_userByScreenNameUrl) return;
    for (const h of [...pendingProfiles]) {
      fetchUserProfileGraphQL(h);
    }
    pendingProfiles.clear();
  }

  // content.js から auth 情報を要求されたら即返す
  document.addEventListener('aifilter:requestauth', () => {
    if (_bearer) dispatchAuthReady();
  });

  // content.js からプロフィール取得リクエストを受け取る（fallback）
  document.addEventListener('aifilter:requestprofile', (e) => {
    const { handle } = e.detail;
    if (!handle) return;
    if (_bearer && _userByScreenNameUrl) {
      dispatchAuthReady();
      fetchUserProfileGraphQL(handle);
    } else {
      pendingProfiles.add(handle);
    }
  });

  // ---- ユーザー検索 ----
  function findUsers(obj, depth) {
    if (depth > 30 || !obj || typeof obj !== 'object') return;

    // 新Twitter API構造: obj.core.screen_name + obj.legacy.statuses_count
    if (obj.core && typeof obj.core === 'object' &&
        typeof obj.core.screen_name === 'string' && obj.core.screen_name.length > 0) {
      const handle = obj.core.screen_name.toLowerCase();
      const lg = (obj.legacy && typeof obj.legacy === 'object') ? obj.legacy : {};
      const postCount = typeof lg.statuses_count === 'number' ? lg.statuses_count : null;
      if (postCount !== null || !dispatchedHandles.has(handle)) {
        dispatchedHandles.add(handle);
        const joinDateStr = obj.core.created_at || lg.created_at || null;
        const joinDateISO = joinDateStr ? (() => { try { return new Date(joinDateStr).toISOString(); } catch(_) { return null; } })() : null;
        console.log('[AIFilter interceptor] ユーザー発見(core):', handle, 'posts:', postCount, 'joined:', joinDateISO);
        document.dispatchEvent(new CustomEvent('aifilter:userdata', {
          detail: { handle, postCount, joinDateISO, followers: lg.followers_count ?? 0, following: lg.friends_count ?? 0, userId: obj.rest_id || lg.id_str || null, bio: lg.description || null, profileImageUrl: lg.profile_image_url_https || null, isProtected: lg.protected ?? null },
        }));
      }
    }

    if (typeof obj.screen_name === 'string' && obj.screen_name.length > 0) {
      const handle = obj.screen_name.toLowerCase();
      const postCount = typeof obj.statuses_count === 'number' ? obj.statuses_count
                     : typeof obj.tweet_count    === 'number' ? obj.tweet_count
                     : typeof obj.tweets_count   === 'number' ? obj.tweets_count
                     : null;
      // statuses_countがある場合は常に更新。ない場合は初回のみ
      if (postCount !== null || !dispatchedHandles.has(handle)) {
        dispatchedHandles.add(handle);
        const joinDateISO = obj.created_at ? (() => { try { return new Date(obj.created_at).toISOString(); } catch(_) { return null; } })() : null;
        // user_id_str はツイートlegacyにある投稿者ID。id_str はツイート自身のIDなので使わない
        const userId = obj.rest_id || obj.user_id_str || null;
        console.log('[AIFilter interceptor] ユーザー発見:', handle, 'posts:', postCount, 'userId:', userId, 'joined:', joinDateISO);
        document.dispatchEvent(new CustomEvent('aifilter:userdata', {
          detail: { handle, postCount, joinDateISO, followers: obj.followers_count ?? 0, following: obj.friends_count ?? 0, userId, bio: obj.description || null, profileImageUrl: obj.profile_image_url_https || null, isProtected: obj.protected ?? null },
        }));
      }
    }

    if (typeof obj.twitter_screen_name === 'string' && obj.twitter_screen_name.length > 0) {
      const handle = obj.twitter_screen_name.toLowerCase();
      if (!dispatchedHandles.has(handle)) {
        dispatchedHandles.add(handle);
        const joinDateISO = obj.created_at ? (() => { try { return new Date(obj.created_at).toISOString(); } catch(_) { return null; } })() : null;
        document.dispatchEvent(new CustomEvent('aifilter:userdata', {
          detail: { handle, postCount: obj.tweet_count ?? null, joinDateISO, followers: obj.n_followers ?? 0, following: obj.n_following ?? 0, userId: obj.id_str || null },
        }));
      }
    }

    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const val = obj[keys[i]];
      if (Array.isArray(val)) {
        for (let j = 0; j < val.length; j++) findUsers(val[j], depth + 1);
      } else if (val && typeof val === 'object') {
        findUsers(val, depth + 1);
      }
    }
  }

  // TweetDetail APIレスポンスから全リプライのテキスト+ハンドルを抽出
  function extractReplyTexts(data) {
    const results = [];
    const seen = new Set();
    function walk(obj, depth) {
      if (depth > 25 || !obj || typeof obj !== 'object') return;
      // 新API構造: obj.core.screen_name + obj.legacy.full_text
      if (obj.core && typeof obj.core.screen_name === 'string' &&
          obj.legacy && typeof obj.legacy.full_text === 'string') {
        const handle = obj.core.screen_name.toLowerCase();
        const text = obj.legacy.full_text;
        const key = handle + ':' + text.slice(0, 50);
        if (!seen.has(key)) { seen.add(key); results.push({ handle, text }); }
      }
      // 旧構造: screen_name + full_text 同階層
      if (typeof obj.screen_name === 'string' && typeof obj.full_text === 'string') {
        const handle = obj.screen_name.toLowerCase();
        const text = obj.full_text;
        const key = handle + ':' + text.slice(0, 50);
        if (!seen.has(key)) { seen.add(key); results.push({ handle, text }); }
      }
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        const val = obj[keys[i]];
        if (Array.isArray(val)) {
          for (let j = 0; j < val.length; j++) walk(val[j], depth + 1);
        } else if (val && typeof val === 'object') {
          walk(val, depth + 1);
        }
      }
    }
    walk(data, 0);
    return results;
  }

  function handleJSON(url, text) {
    if (!text || (text[0] !== '{' && text[0] !== '[')) return;
    try {
      const data = JSON.parse(text);
      findUsers(data, 0);
      // TweetDetail API → 全リプライテキストを速報としてcontent.jsに通知
      if (url.includes('TweetDetail') || url.includes('threaded_conversation')) {
        const replies = extractReplyTexts(data);
        if (replies.length > 0) {
          document.dispatchEvent(new CustomEvent('aifilter:replydata', { detail: { replies } }));
        }
      }
    } catch (_) {}
  }

  // 起動時に保存済みURLを復元
  try {
    const saved = localStorage.getItem('aifilter_ubsn_url');
    if (saved) { _userByScreenNameUrl = saved; console.log('[AIFilter interceptor] UBSN URL復元:', saved); }
    const savedUt = localStorage.getItem('aifilter_ut_url');
    if (savedUt) { _userTweetsUrl = savedUt; console.log('[AIFilter interceptor] UserTweets URL復元:', savedUt); }
    const savedBlock = localStorage.getItem('aifilter_block_url');
    if (savedBlock) { _blockUrl = savedBlock; console.log('[AIFilter interceptor] ブロックURL復元:', savedBlock); }
    const savedMute = localStorage.getItem('aifilter_mute_url');
    if (savedMute) { _muteUrl = savedMute; console.log('[AIFilter interceptor] ミュートURL復元:', savedMute); }
  } catch(_) {}

  function captureUserByScreenNameUrl(url) {
    if (url.includes('UserByScreenName')) {
      const m = url.match(/(https?:\/\/[^?]+\/UserByScreenName)/);
      const fMatch = url.match(/[?&](features=[^&]+)/);
      if (m && m[1] !== _userByScreenNameUrl) {
        _userByScreenNameUrl = m[1];
        console.log('[AIFilter interceptor] UserByScreenName URL捕捉:', _userByScreenNameUrl);
        try { localStorage.setItem('aifilter_ubsn_url', _userByScreenNameUrl); } catch(_) {}
        if (fMatch) {
          try { localStorage.setItem('aifilter_ubsn_features', fMatch[1]); } catch(_) {}
        }
        tryProcessPending();
        dispatchAuthReady();
      }
    }
    // UserTweets / UserTweetsAndReplies URL を捕捉
    if ((url.includes('UserTweets') || url.includes('UserReplies')) && !_userTweetsUrl) {
      const m = url.match(/(https?:\/\/[^?]+\/User(?:Tweets(?:AndReplies)?|Replies))/);
      if (m) {
        _userTweetsUrl = m[1];
        console.log('[AIFilter interceptor] UserTweets URL捕捉:', _userTweetsUrl);
        try { localStorage.setItem('aifilter_ut_url', _userTweetsUrl); } catch(_) {}
        dispatchAuthReady();
      }
    }
  }

  // Twitterが実際にブロック/ミュートに使うエンドポイントを捕捉
  function captureBlockUrl(method, url) {
    if (method !== 'POST' && method !== 'post') return;
    if (!_blockUrl && (url.includes('blocks/create') || url.includes('CreateBlock') || url.includes('BlockMutation'))) {
      _blockUrl = url.split('?')[0];
      console.log('[AIFilter interceptor] ブロックURL捕捉:', _blockUrl);
      try { localStorage.setItem('aifilter_block_url', _blockUrl); } catch(_) {}
      try { sessionStorage.setItem('aifilter_block_url', _blockUrl); } catch(_) {}
      dispatchAuthReady();
    }
    if (!_muteUrl && (url.includes('mutes/users/create') || url.includes('CreateMute') || url.includes('MuteMutation'))) {
      _muteUrl = url.split('?')[0];
      console.log('[AIFilter interceptor] ミュートURL捕捉:', _muteUrl);
      try { localStorage.setItem('aifilter_mute_url', _muteUrl); } catch(_) {}
      try { sessionStorage.setItem('aifilter_mute_url', _muteUrl); } catch(_) {}
      dispatchAuthReady();
    }
  }

  function saveBearerToSession() {
    try { sessionStorage.setItem('aifilter_bearer', _bearer); } catch(_) {}
    try { sessionStorage.setItem('aifilter_csrf', _csrf || getCt0() || ''); } catch(_) {}
    if (_blockUrl) try { sessionStorage.setItem('aifilter_block_url', _blockUrl); } catch(_) {}
    if (_muteUrl)  try { sessionStorage.setItem('aifilter_mute_url',  _muteUrl);  } catch(_) {}
  }

  function captureBearerFromHeaders(headers) {
    if (_bearer) return;
    const auth = typeof headers?.get === 'function'
      ? headers.get('authorization')
      : (headers?.['authorization'] || headers?.['Authorization']);
    if (auth && auth.startsWith('Bearer ')) {
      _bearer = auth;
      _csrf = (typeof headers?.get === 'function'
        ? headers.get('x-csrf-token')
        : headers?.['x-csrf-token']) || getCt0();
      console.log('[AIFilter interceptor] bearer取得完了');
      saveBearerToSession();
      tryProcessPending();
      dispatchAuthReady();
    }
  }

  // ---- XHR インターセプト ----
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    let _url = '';
    const _hdrs = {};

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      _url = url || '';
      captureUserByScreenNameUrl(_url);
      captureBlockUrl(method, _url);
      return origOpen(method, url, ...rest);
    };

    const origSetHeader = xhr.setRequestHeader.bind(xhr);
    xhr.setRequestHeader = function (name, value) {
      _hdrs[name.toLowerCase()] = value;
      if (name.toLowerCase() === 'authorization' && value.startsWith('Bearer ') && !_bearer) {
        _bearer = value;
        _csrf = _hdrs['x-csrf-token'] || getCt0();
        console.log('[AIFilter interceptor] bearer取得完了(XHR)');
        saveBearerToSession();
        tryProcessPending();
        dispatchAuthReady();
      }
      if (name.toLowerCase() === 'x-csrf-token' && !_csrf) _csrf = value;
      return origSetHeader(name, value);
    };

    xhr.addEventListener('load', function () {
      try {
        if (this.responseType !== '' && this.responseType !== 'text') return;
        const t = this.responseText;
        if (!t || (t[0] !== '{' && t[0] !== '[')) return;
        if (_url.includes('graphql') || _url.includes('i/api') || _url.includes('api.twitter') || _url.includes('api.x.com')) {
          handleJSON(_url, t);
        } else if (t.includes('statuses_count') || t.includes('screen_name')) {
          handleJSON(_url, t);
        }
      } catch (_) {}
    });
    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;

  // ---- fetch インターセプト ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const method = args[1]?.method || 'GET';
    captureUserByScreenNameUrl(url);
    captureBlockUrl(method, url);
    captureBearerFromHeaders(args[1]?.headers);

    const p = origFetch.apply(this, args);
    p.then(res => {
      res.clone().text().then(t => {
        if (!t || (t[0] !== '{' && t[0] !== '[')) return;
        if (url.includes('graphql') || url.includes('i/api') || url.includes('api.twitter') || url.includes('api.x.com')) {
          handleJSON(url, t);
          return;
        }
        if (t.includes('statuses_count') || t.includes('screen_name')) {
          handleJSON(url, t);
        }
      }).catch(() => {});
    }).catch(() => {});
    return p;
  };

  // ---- ページ初期データをスキャン ----
  setTimeout(() => {
    for (const key of ['__INITIAL_STATE__', '__REDUX_STORE_STATE__', '__NEXT_DATA__', 'initialState']) {
      try {
        if (window[key]) { findUsers(window[key], 0); }
      } catch (_) {}
    }
  }, 2000);
})();
