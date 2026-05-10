// detector.js — AI文章スコアリングエンジン
window.AIDetector = (() => {
  // ユーザープロフィールキャッシュ
  const profileCache = new Map();

  // 日本語の典型的なAI表現
  const JP_PHRASES = [
    { pattern: /もちろんです/g, weight: 15 },
    { pattern: /承知しました/g, weight: 12 },
    { pattern: /素晴らしい質問/g, weight: 20 },
    { pattern: /喜んでお手伝い/g, weight: 20 },
    { pattern: /ご参考まで/g, weight: 10 },
    { pattern: /ご質問ありがとう/g, weight: 12 },
    { pattern: /おっしゃる通り/g, weight: 10 },
    { pattern: /重要なポイント/g, weight: 8 },
    { pattern: /以下の点(に|を)/g, weight: 8 },
    { pattern: /まとめると/g, weight: 7 },
    { pattern: /結論として/g, weight: 8 },
    { pattern: /具体的には/g, weight: 6 },
    { pattern: /ご理解のほど/g, weight: 12 },
    { pattern: /お役に立てれば/g, weight: 15 },
    { pattern: /参考になれば幸いです/g, weight: 18 },
    { pattern: /ご不明な点があれば/g, weight: 18 },
    { pattern: /いつでもご相談/g, weight: 18 },
    { pattern: /どうぞよろしくお願いいたします/g, weight: 10 },
    { pattern: /何かご不明な点/g, weight: 15 },
    { pattern: /以上、ご参考/g, weight: 15 },
  ];

  // 英語の典型的なAI表現
  const EN_PHRASES = [
    { pattern: /\bCertainly[!,]/gi, weight: 18 },
    { pattern: /\bAbsolutely[!,]/gi, weight: 15 },
    { pattern: /\bGreat question/gi, weight: 20 },
    { pattern: /\bI'd be happy to/gi, weight: 18 },
    { pattern: /\bAs an AI/gi, weight: 25 },
    { pattern: /\bOf course[!,]/gi, weight: 12 },
    { pattern: /\bHope this helps/gi, weight: 15 },
    { pattern: /\bFeel free to ask/gi, weight: 15 },
    { pattern: /\bLet me know if you/gi, weight: 12 },
    { pattern: /\bTo summarize/gi, weight: 8 },
    { pattern: /\bIn conclusion/gi, weight: 8 },
    { pattern: /\bKey (points|takeaways)/gi, weight: 10 },
    { pattern: /\bHere are (some|the)/gi, weight: 8 },
    { pattern: /\bIt's important to note/gi, weight: 12 },
    { pattern: /\bI (understand|appreciate) (your|that)/gi, weight: 10 },
    { pattern: /\bThank you for (sharing|asking|your)/gi, weight: 12 },
    { pattern: /\bI'm here to help/gi, weight: 18 },
    { pattern: /\bPlease (note|keep in mind)/gi, weight: 8 },
  ];

  // 汎用スパムフレーズ（多言語）
  const SPAM_PHRASES = [
    // インドネシア語（AIスパムに多い）
    { pattern: /\bkeren\b/gi, weight: 8 },
    { pattern: /\bbagus\b/gi, weight: 8 },
    { pattern: /\bmantap\b/gi, weight: 8 },
    { pattern: /\bcakep\b/gi, weight: 8 },
    { pattern: /\bganteng\b/gi, weight: 8 },
    { pattern: /\brapih\b/gi, weight: 8 },
    { pattern: /\brapi\s+banget\b/gi, weight: 12 },
    { pattern: /\bauto\s+suka\b/gi, weight: 15 },
    { pattern: /\bjadi\s+(cakep|bagus|keren|rapih)\b/gi, weight: 12 },
    { pattern: /\bhasilnya\s+(rapi|bagus|keren)\b/gi, weight: 12 },
    { pattern: /\bjam\s+terbang\b/gi, weight: 10 },
    { pattern: /\bunik\s+banget\b/gi, weight: 10 },
    { pattern: /\bemang\s+(unik|keren|bagus)\b/gi, weight: 10 },
    { pattern: /\b(jadinya|jdnua|jadi)\s+(rapih|keren|bagus|cakep)\b/gi, weight: 12 },
    // フィリピン語
    { pattern: /\bganda\b/gi, weight: 6 },
    { pattern: /\bsarap\b/gi, weight: 6 },
    // 英語汎用
    { pattern: /\bso\s+cool\b/gi, weight: 8 },
    { pattern: /\bso\s+cute\b/gi, weight: 8 },
    { pattern: /\blove\s+(this|it)[!.]*\s*$/gi, weight: 10 },
    { pattern: /\bthis\s+is\s+(so\s+)?(cool|nice|great|amazing)[!.]*\s*$/gi, weight: 10 },
    // ---- 日本語の浅い観察・称賛コメント ----
    // 「[名前]、めっちゃ〜」型（AIが動画・画像を見て書く典型パターン）
    { pattern: /^[^\s、。]{1,12}[、,]\s*(めっちゃ|めちゃ|すごく|マジで|ガチで|かなり)/gm, weight: 15 },
    // 映像の動作を浅く描写（高く飛んでる、速く走ってる等）
    { pattern: /(めっちゃ|めちゃ|すごく)(高く|速く|うまく|強く|低く|遠く)(飛|跳|走|動|蹴|打)/g, weight: 18 },
    { pattern: /(飛んでる|跳んでる|走ってる|泳いでる)(ね[〜~]*|！+|よ)[^\S\n]*$/g, weight: 12 },
    // 内容のない感嘆型日本語コメント
    { pattern: /(えぐ[いく]|やば[いく]|すご[いく])(ね[〜~]*|！+)[^\S\n]*$/g, weight: 10 },
    { pattern: /かっこ(いい|よすぎ)(ね[〜~]*|！+)[^\S\n]*$/g, weight: 8 },
    { pattern: /かわい(い|すぎ)(ね[〜~]*|！+)[^\S\n]*$/g, weight: 8 },
  ];

  // 構造的シグナル
  function scoreStructure(text) {
    let score = 0;
    const bulletLines = (text.match(/^[\s]*[•\-\*\d]+[.)]\s/gm) || []).length;
    if (bulletLines >= 3) score += 15;
    if (bulletLines >= 5) score += 10;

    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20);
    if (paragraphs.length >= 3) {
      const lengths = paragraphs.map(p => p.length);
      const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const variance = lengths.reduce((sum, l) => sum + Math.pow(l - avg, 2), 0) / lengths.length;
      if (Math.sqrt(variance) / avg < 0.3) score += 12;
    }

    const headings = (text.match(/(\*\*[^*]+\*\*|【[^】]+】|「[^」]+」：)/g) || []).length;
    if (headings >= 2) score += 10;

    const longSentences = (text.match(/[^。！？.!?]{200,}/g) || []).length;
    if (longSentences >= 1) score += 8;

    return Math.min(score, 40);
  }

  // テキストスコアリング（0–100）
  function scoreText(text) {
    if (!text || text.trim().length < 3) return 0;

    let score = 0;
    for (const { pattern, weight } of JP_PHRASES) {
      const matches = text.match(pattern);
      if (matches) score += weight * Math.min(matches.length, 2);
    }
    for (const { pattern, weight } of EN_PHRASES) {
      const matches = text.match(pattern);
      if (matches) score += weight * Math.min(matches.length, 2);
    }
    for (const { pattern, weight } of SPAM_PHRASES) {
      const matches = text.match(pattern);
      if (matches) score += weight * Math.min(matches.length, 2);
    }
    score += scoreStructure(text);
    return Math.min(score, 100);
  }

  // スレッド内行動スコアリング（強化版）
  function scoreBehavior(authorHandle, threadReplies) {
    if (!authorHandle || !threadReplies) return 0;
    let score = 0;
    const handle = authorHandle.toLowerCase();

    const sameUserReplies = threadReplies.filter(el => {
      const userEl = el.querySelector('[data-testid="User-Name"]');
      if (!userEl) return false;
      return Array.from(userEl.querySelectorAll('a[href]'))
        .some(a => a.getAttribute('href')?.toLowerCase().includes(handle));
    });

    // 同ツイートへの複数リプライ（分割不要なのに分けている）
    if (sameUserReplies.length >= 2) score += 25;
    if (sameUserReplies.length >= 3) score += 20;
    if (sameUserReplies.length >= 5) score += 15;

    if (sameUserReplies.length >= 2) {
      const texts = sameUserReplies.map(el => {
        const t = el.querySelector('[data-testid="tweetText"]');
        return t ? t.innerText : '';
      }).filter(t => t.length > 0);

      if (texts.length >= 2) {
        const uniformity = measureUniformity(texts);
        score += Math.round(uniformity * 30);
      }
    }

    return Math.min(score, 100);
  }

  // プロフィールスコアリング（0–100）
  function scoreProfile(handle) {
    if (!handle) return 0;
    const profile = profileCache.get(handle.toLowerCase());
    if (!profile) return 0;

    let score = 0;
    const now = new Date();

    if (profile.joinDate) {
      const ageDays = (now - profile.joinDate) / (1000 * 60 * 60 * 24);

      if (ageDays < 30)  score += 25;
      else if (ageDays < 90)  score += 15;
      else if (ageDays < 180) score += 5;

      if (profile.postCount && ageDays > 0) {
        const postsPerDay = profile.postCount / ageDays;
        console.log(`[AIFilter] @${handle} posts/day=${postsPerDay.toFixed(1)} (total=${profile.postCount}, age=${ageDays.toFixed(0)}days)`);
        if (postsPerDay > 200) score += 70;
        else if (postsPerDay > 100) score += 55;
        else if (postsPerDay > 50)  score += 35;
        else if (postsPerDay > 20)  score += 15;
      }
    }

    // フォロー/フォロワー比率（強化版）
    if (profile.following > 0 && profile.followers !== undefined) {
      const ratio = profile.following / (profile.followers + 1);
      if (ratio > 10) score += 30;
      else if (ratio > 5) score += 20;
      else if (ratio > 3) score += 10;
    }

    // フォロワー極端に少ない（鍵垢でない場合のみ）
    if (profile.isProtected === false && profile.followers !== undefined) {
      if (profile.followers < 5) score += 25;
      else if (profile.followers < 20 && (profile.following ?? 0) > 50) score += 12;
    }

    // デフォルトアイコン（プロフィール画像未設定）
    if (profile.profileImageUrl) {
      if (profile.profileImageUrl.includes('default_profile_images') ||
          profile.profileImageUrl.includes('default_avatar')) {
        score += 15;
      }
    }

    return Math.min(score, 100);
  }

  // トピッククラスタ定義
  const TOPIC_CLUSTERS = {
    sports_action: {
      jp: /飛(ぶ|んで|び)|跳(ぶ|んで)|走(る|って)|泳(ぐ|いで)|蹴(る|って)|投(げ|げて)|打(つ|って)|ジャンプ|シュート|ダンク|スポーツ|試合|練習|アクロバット|体操|競技|選手|チーム|得点|ゴール|勝(つ|ち)|負(ける|け)/,
      en: /\b(jump|fly|run|sprint|swim|kick|throw|hit|dunk|sport|game|match|practice|acrobat|gymnastic|athlete|team|score|goal|win|lose|compet)/i,
    },
    beauty_fashion: {
      jp: /髪|ヘア|カット|美容|メイク|スキン|肌|ネイル|おしゃれ|ファッション|コーデ|服|着(る|て)|ブランド|コスメ|リップ|アイシャドウ|まつ毛|眉|スタイル|ウィッグ|染め/,
      en: /\b(hair|cut|trim|salon|beauty|makeup|skin|nail|fashion|outfit|style|cloth|dress|brand|cosme|lip|eyebrow|lash|wig|dye|color)/i,
    },
    food_drink: {
      jp: /食べ|料理|レストラン|カフェ|スイーツ|美味|おいし|ごはん|ランチ|ディナー|朝食|お菓子|飲(む|んで)|コーヒー|お茶|ラーメン|寿司|焼肉|パン|ケーキ/,
      en: /\b(food|eat|cook|restaurant|cafe|sweet|delicious|lunch|dinner|breakfast|snack|drink|coffee|tea|ramen|sushi|cake|bread|menu)/i,
    },
    travel_place: {
      jp: /旅行|観光|ホテル|空港|海外|国内|景色|風景|訪れ|行(く|って)|来(る|て)|帰(る|って)|〜に来た|〜へ来た/,
      en: /\b(travel|trip|tour|hotel|airport|overseas|domestic|scenery|landscape|visit|arrive|destination)/i,
    },
    tech_gaming: {
      jp: /ゲーム|プログラム|コード|アプリ|スマホ|パソコン|AI|プレイ|クリア|レベル|キャラ|アップデート|リリース|バグ/,
      en: /\b(game|code|program|app|smartphone|pc|computer|ai|play|clear|level|character|update|release|bug)/i,
    },
    animals_nature: {
      jp: /動物|犬|猫|鳥|魚|自然|花|木|森|山|海|川|空|雲|天気|季節/,
      en: /\b(animal|dog|cat|bird|fish|nature|flower|tree|forest|mountain|sea|river|sky|cloud|weather|season)/i,
    },
  };

  function classifyTopic(text) {
    if (!text || text.trim().length < 4) return null;
    for (const [topic, { jp, en }] of Object.entries(TOPIC_CLUSTERS)) {
      if (jp.test(text) || en.test(text)) return topic;
    }
    return null;
  }

  // トピックミスマッチスコアリング
  function scoreTopicMismatch(replyText, originalText) {
    if (!replyText || !originalText) return 0;
    const replyTopic    = classifyTopic(replyText);
    const originalTopic = classifyTopic(originalText);
    // どちらか判定不能なら判断しない
    if (!replyTopic || !originalTopic) return 0;
    // 同じトピックなら問題なし
    if (replyTopic === originalTopic) return 0;
    // 明確に異なるカテゴリ → 脈絡なし
    return 28;
  }

  // 言語判定（簡易版）
  function detectLang(text) {
    if (!text || text.trim().length < 6) return null;
    const t = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    const total = t.replace(/\s/g, '').length;
    if (!total) return null;

    // 日本語（ひらがな・カタカナ・漢字）
    const jpChars = (t.match(/[\u3040-\u9FFF]/g) || []).length;
    if (jpChars / total > 0.15) return 'ja';

    // 韓国語
    const koChars = (t.match(/[\uAC00-\uD7AF]/g) || []).length;
    if (koChars / total > 0.15) return 'ko';

    // インドネシア語・マレー語の特徴語
    const idWords = (t.match(/\b(yang|dan|dengan|untuk|tidak|ini|itu|ada|dari|ke|di|nya|keren|bagus|mantap|banget|suka|jadi|emang|udah|bisa|mau|sudah)\b/gi) || []).length;
    if (idWords >= 2) return 'id';

    // フィリピン語（タガログ）
    const tlWords = (t.match(/\b(ang|ng|mga|sa|na|ay|ko|mo|siya|kami|namin|natin|ganda|sarap|talaga|naman)\b/gi) || []).length;
    if (tlWords >= 2) return 'tl';

    return 'en';
  }

  // バイオと返信の言語シフトスコアリング
  function scoreLangShift(replyText, bio) {
    if (!bio || !replyText) return 0;
    const replyLang = detectLang(replyText);
    const bioLang   = detectLang(bio);
    if (!replyLang || !bioLang || replyLang === bioLang) return 0;

    // 日本語アカウントがインドネシア語・フィリピン語で返信 → 高疑惑
    if (bioLang === 'ja' && (replyLang === 'id' || replyLang === 'tl')) return 30;
    // 日本語アカウントが英語で返信 → 軽度（多言語ユーザーもいる）
    if (bioLang === 'ja' && replyLang === 'en') return 5;
    // 韓国語アカウントがインドネシア語・フィリピン語で返信
    if (bioLang === 'ko' && (replyLang === 'id' || replyLang === 'tl')) return 25;
    // その他の言語シフト
    return 10;
  }

  // 画像/GIFのみリプライ（テキストなし）
  function scoreMedia(hasMediaOnly) {
    return hasMediaOnly ? 40 : 0;
  }

  // 元ツイートとの関連性スコア
  function scoreRelevance(replyText, originalText) {
    if (!originalText || !replyText || replyText.trim().length < 3) return 0;

    // 元ツイートから3文字以上のキーワードを抽出（日本語・英語対応）
    const origWords = new Set(
      (originalText.match(/[\w\u3040-\u9FFF\u4E00-\u9FFF]{3,}/g) || [])
        .map(w => w.toLowerCase())
    );
    if (origWords.size === 0) return 0;

    const replyLower = replyText.toLowerCase();
    let overlap = 0;
    for (const word of origWords) {
      if (replyLower.includes(word)) overlap++;
    }

    const ratio = overlap / Math.min(origWords.size, 15);

    // 短い返信で関連性が低いほど怪しい
    if (replyText.trim().length <= 40) {
      if (ratio < 0.05) return 20;
      if (ratio < 0.15) return 10;
    } else {
      if (ratio < 0.03) return 15;
    }
    return 0;
  }

  // 異常パターンスコア（短文・絵文字スパム・繰り返し文字）
  function scorePatterns(text) {
    if (!text || text.trim().length < 2) return 0;
    let score = 0;
    const trimmed = text.trim();

    // 極端に短い返信
    if (trimmed.length <= 15) score += 12;
    else if (trimmed.length <= 25) score += 5;

    // 絵文字の割合が高い
    const emojiMatches = trimmed.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu) || [];
    if (emojiMatches.length > 0) {
      const ratio = emojiMatches.length / trimmed.length;
      if (ratio > 0.5) score += 20;
      else if (ratio > 0.3) score += 10;
    }

    // 同じ文字の繰り返し (wwww, !!!!, 笑笑笑笑)
    if (/(.)\1{3,}/.test(trimmed)) score += 8;

    // 実質的なテキストなし（記号・絵文字のみ）
    const realChars = (trimmed.match(/[\w\u3040-\u9FFF\u4E00-\u9FFF]/g) || []).length;
    if (realChars === 0 && trimmed.length > 0) score += 30;

    return Math.min(score, 50);
  }

  function measureUniformity(texts) {
    const lengths = texts.map(t => t.length);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (avg === 0) return 0;
    const variance = lengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lengths.length;
    const cv = Math.sqrt(variance) / avg;
    return Math.max(0, 1 - cv);
  }

  function confidenceLabel(score) {
    if (score >= 75) return { label: '高', className: 'ai-confidence-high' };
    if (score >= 50) return { label: '中', className: 'ai-confidence-medium' };
    return { label: '低', className: 'ai-confidence-low' };
  }

  function updateProfile(handle, data) {
    if (!handle) return;
    const key = handle.toLowerCase();
    const existing = profileCache.get(key) || {};
    // null で上書きしない（既存データを保持）
    const merged = { ...existing };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) merged[k] = v;
    }
    profileCache.set(key, merged);
  }

  function scoreCrossThread(crossThreadCount) {
    if (!crossThreadCount || crossThreadCount < 2) return 0;
    if (crossThreadCount >= 10) return 40;
    if (crossThreadCount >= 5)  return 25;
    if (crossThreadCount >= 3)  return 15;
    return 8;
  }

  // UserTweets API から得たリプライ行動分析スコア（0–60）
  function scoreTweetHistory(handle) {
    const profile = profileCache.get(handle?.toLowerCase());
    if (!profile?.tweetHistory) return 0;
    const { uniqueConvos, textUniformity, replyRatio, activeHours } = profile.tweetHistory;
    let score = 0;

    // 直近20件で多数の異なるスレッドにリプライ → クロススレッドBOT
    if (uniqueConvos >= 15) score += 45;
    else if (uniqueConvos >= 10) score += 30;
    else if (uniqueConvos >= 5)  score += 15;

    // リプライ比率が高くテキストが均一 → AI量産パターン
    if (replyRatio > 0.8 && textUniformity > 0.65) score += 20;
    else if (textUniformity > 0.75) score += 12;

    // 投稿時間帯が広い → BOTは24時間稼動（人間は寝る）
    if (activeHours !== undefined) {
      if (activeHours >= 18) score += 20;
      else if (activeHours >= 14) score += 10;
    }

    return Math.min(score, 60);
  }

  // メイン判定関数
  // opts: { hasMediaOnly: bool, originalText: string }
  function score(text, authorHandle, threadReplies, crossThreadCount, opts = {}) {
    const { hasMediaOnly = false, originalText = '' } = opts;

    const profile = authorHandle ? profileCache.get(authorHandle.toLowerCase()) : null;

    const textScore        = scoreText(text);
    const behaviorScore    = scoreBehavior(authorHandle, threadReplies);
    const profileScore     = scoreProfile(authorHandle);
    const crossScore       = scoreCrossThread(crossThreadCount ?? 0);
    const mediaScore       = scoreMedia(hasMediaOnly);
    const relevanceScore   = scoreRelevance(text, originalText);
    const patternScore     = scorePatterns(text);
    const langShiftScore   = scoreLangShift(text, profile?.bio || '');
    const topicMismatch    = scoreTopicMismatch(text, originalText);
    const tweetHistoryScore = scoreTweetHistory(authorHandle);

    // ベーススコア: テキスト30% / 行動10% / プロフィール50% / クロス10%
    const base = Math.round(
      textScore     * 0.30 +
      behaviorScore * 0.10 +
      profileScore  * 0.50 +
      crossScore    * 0.10
    );

    // 追加ボーナス（上限50）: メディアのみ / 関連性低 / 異常パターン / 言語シフト / トピックミスマッチ / ツイート履歴
    const bonus = Math.min(50, Math.round(
      mediaScore        * 0.60 +
      relevanceScore    * 0.50 +
      patternScore      * 0.50 +
      langShiftScore    * 0.80 +
      topicMismatch     * 0.90 +
      tweetHistoryScore * 0.85
    ));

    const total = Math.min(100, base + bonus);

    return {
      total, textScore, behaviorScore, profileScore,
      crossScore, mediaScore, relevanceScore, patternScore, langShiftScore, topicMismatch, tweetHistoryScore,
      confidence: confidenceLabel(total),
    };
  }

  return { score, updateProfile, getProfile: (handle) => profileCache.get(handle?.toLowerCase()) ?? null };
})();
