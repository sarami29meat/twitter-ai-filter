# Twitter AI Filter

Twitter/X のリプライ欄に増えてきたAI生成コメントを自動検出・非表示にするChrome拡張機能です。

![Chrome](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)
![License](https://img.shields.io/badge/License-MIT-green)
![Manifest](https://img.shields.io/badge/Manifest-V3-orange)

---

## 機能

- AI生成リプライをスコアリングして自動で折りたたむ
- 折りたたんだコメントはワンクリックで展開可能
- スレッドのリプライをスクロール前に速報スキャン
- アカウントの一括ブロック・ミュート
- ダークモード対応
- 検出感度をポップアップから調整可能

## スクリーンショット

*(近日公開予定)*

---

## インストール方法

### 開発版（手動インストール）

1. このリポジトリをクローン or ZIPダウンロード
   ```
   git clone https://github.com/YOUR_USERNAME/twitter-ai-filter.git
   ```
2. Chromeで `chrome://extensions` を開く
3. 右上の「デベロッパーモード」をONにする
4. 「パッケージ化されていない拡張機能を読み込む」をクリック
5. ダウンロードしたフォルダを選択

---

## 検出の仕組み

テキストスコアリングとアカウントシグナルの2軸で判定します。

| シグナル | 内容 |
|----------|------|
| テキスト | AI定型フレーズ（日本語・英語）のパターンマッチング |
| 投稿数   | 極端に少ない/多い投稿数 |
| 作成日   | 直近に作られたアカウント |
| フォロワー | フォロワー極少・フォロー多 |
| アイコン | デフォルトアイコン |
| 行動パターン | 短時間に大量リプライなど |

スコアが閾値（デフォルト35点）を超えると非表示になります。

---

## 設定

ツールバーのアイコンからポップアップを開いて調整できます。

- **有効/無効**: フィルター全体のON/OFF
- **検出感度（閾値）**: 低いほど多く検出（デフォルト35）
- **フラグ閾値**: 「AIではない」ボタンを何回押すと解除されるか

---

## ファイル構成

```
twitter-ai-filter/
├── manifest.json     # Chrome拡張設定（MV3）
├── interceptor.js    # ネットワーク傍受（MAIN world）
├── content.js        # DOM監視・UI（ISOLATED world）
├── detector.js       # AIスコアリングエンジン
├── injected.css      # スタイル
├── background.js     # Service Worker
├── popup.html/js/css # 設定ポップアップ
└── icons/
```

---

## ライセンス

MIT

---

## サポート

バグ報告・要望は [Issues](https://github.com/YOUR_USERNAME/twitter-ai-filter/issues) へ。

役に立ったら ☕ [Buy Me a Coffee](https://www.buymeacoffee.com/YOUR_USERNAME) で支援してもらえると励みになります。
