// background.js — Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({
      enabled: true,
      threshold: 35,
      flagThreshold: 5,
      flags: {},
      whitelist: [],
      sessionHiddenCount: 0,
    });
  }
});

// threshold が古いデフォルト(65)のままならリセット
chrome.storage.local.get('threshold', ({ threshold }) => {
  if (threshold === 65) chrome.storage.local.set({ threshold: 35 });
});

// ---- Dev: サービスワーカー起動時に _pendingTabReload チェック ----
// chrome.runtime.reload() 後の再起動時にタブをリロードする
chrome.storage.local.get('_pendingTabReload', async ({ _pendingTabReload }) => {
  if (!_pendingTabReload) return;
  await chrome.storage.local.set({ _pendingTabReload: false });
  const tabs = await chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] });
  for (const tab of tabs) chrome.tabs.reload(tab.id);
});

// ---- Dev: content.js からの _reloadRequest を受け取って拡張機能をリロード ----
chrome.storage.onChanged.addListener(async (changes) => {
  if (!changes._reloadRequest) return;
  const newTs = changes._reloadRequest.newValue;
  const { _devReloadTs } = await chrome.storage.local.get('_devReloadTs');
  if (newTs === _devReloadTs) return; // 重複防止
  await chrome.storage.local.set({ _devReloadTs: newTs, _pendingTabReload: true });
  // 拡張機能をリロード（再起動後に _pendingTabReload でタブをリロード）
  chrome.runtime.reload();
});

// ---- Dev mode: alarms を使ってファイル変更時に自動リロード（フォールバック）----
chrome.alarms.create('devCheck', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'devCheck') return;
  try {
    const r  = await fetch('http://localhost:7654');
    const ts = await r.text();
    const { _devTs } = await chrome.storage.local.get('_devTs');
    if (!_devTs) { await chrome.storage.local.set({ _devTs: ts }); return; }
    if (ts !== _devTs) {
      await chrome.storage.local.set({ _devTs: ts, _pendingTabReload: true });
      chrome.runtime.reload();
    }
  } catch (_) {}
});
