/**
 * background.js — Service worker para downloads e suporte à extensão
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "IG_LIVE_DOWNLOAD") {
    const { content, mimeType, filename } = message;

    try {
      const base64Data = btoa(unescape(encodeURIComponent(content)));
      const dataUrl = `data:${mimeType || "text/plain;charset=utf-8"};base64,${base64Data}`;

      chrome.downloads.download(
        {
          url: dataUrl,
          filename: filename || `ig_live_${Date.now()}.txt`,
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, downloadId });
          }
        }
      );
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true; // async
  }
});
