// injector.js — document_start に実行し、interceptor.js をMAIN worldへ注入
const s = document.createElement('script');
s.src = chrome.runtime.getURL('interceptor.js');
(document.head || document.documentElement).appendChild(s);
s.onload = () => s.remove();
