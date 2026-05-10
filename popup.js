// popup.js — 設定画面ロジック

const enabledToggle = document.getElementById('enabledToggle');
const settingsBody = document.getElementById('settingsBody');
const thresholdSlider = document.getElementById('thresholdSlider');
const thresholdValue = document.getElementById('thresholdValue');
const flagThresholdSlider = document.getElementById('flagThresholdSlider');
const flagThresholdValue = document.getElementById('flagThresholdValue');
const hiddenCount = document.getElementById('hiddenCount');
const resetFlagsBtn = document.getElementById('resetFlagsBtn');
const resetMsg = document.getElementById('resetMsg');

// ストレージから設定を読み込んでUIに反映
chrome.storage.local.get(null, (data) => {
  const enabled = data.enabled ?? true;
  const threshold = data.threshold ?? 65;
  const flagThreshold = data.flagThreshold ?? 5;
  const count = data.sessionDetectedCount ?? 0;

  enabledToggle.checked = enabled;
  settingsBody.classList.toggle('disabled', !enabled);

  thresholdSlider.value = threshold;
  thresholdValue.textContent = threshold;

  flagThresholdSlider.value = flagThreshold;
  flagThresholdValue.textContent = flagThreshold;

  hiddenCount.textContent = count;
});

// ストレージの変更をリアルタイムで反映
chrome.storage.onChanged.addListener((changes) => {
  if (changes.sessionDetectedCount) {
    hiddenCount.textContent = changes.sessionDetectedCount.newValue ?? 0;
  }
});

// 有効/無効トグル
enabledToggle.addEventListener('change', () => {
  const enabled = enabledToggle.checked;
  settingsBody.classList.toggle('disabled', !enabled);
  chrome.storage.local.set({ enabled });
});

// 判定閾値スライダー
thresholdSlider.addEventListener('input', () => {
  const val = parseInt(thresholdSlider.value);
  thresholdValue.textContent = val;
  chrome.storage.local.set({ threshold: val });
});

// フラグ閾値スライダー
flagThresholdSlider.addEventListener('input', () => {
  const val = parseInt(flagThresholdSlider.value);
  flagThresholdValue.textContent = val;
  chrome.storage.local.set({ flagThreshold: val });
});

// フラグリセット
resetFlagsBtn.addEventListener('click', () => {
  chrome.storage.local.set({ flags: {}, whitelist: [], sessionHiddenCount: 0, sessionDetectedCount: 0 }, () => {
    hiddenCount.textContent = '0';
    resetMsg.textContent = 'リセットしました';
    setTimeout(() => { resetMsg.textContent = ''; }, 2000);
  });
});
