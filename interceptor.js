/**
 * interceptor.js — Injetado no contexto da página do Instagram (world: MAIN)
 * --------------------------------------------------------------------------
 * Intercepta de forma 100% PASSIVA as chamadas de rede que o próprio
 * Instagram Web realiza para carregar comentários de Live.
 * 
 * Vantagens:
 * - 0% risco de Rate Limit (não faz requisições extras ao servidor do Instagram).
 * - 100% de precisão (pega o JSON oficial com ID único `pk`, timestamp real e texto limpo).
 * - Não depende de seletores de CSS nem sofre com listas virtualizadas do DOM.
 * --------------------------------------------------------------------------
 */

(function () {
  "use strict";

  // 1. Interceptação de window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

      // Intercepta comentários de Live
      if (url.includes("/get_comment/") || (url.includes("/api/v1/live/") && url.includes("/comment/"))) {
        const clone = response.clone();
        clone
          .json()
          .then((data) => {
            if (data && (Array.isArray(data.comments) || Array.isArray(data.system_comments))) {
              const all = (data.comments || []).concat(data.system_comments || []);
              window.postMessage(
                {
                  source: "IG_LIVE_INTERCEPTOR",
                  type: "REST_COMMENTS",
                  comments: all,
                },
                "*"
              );
            }
          })
          .catch(() => {});
      }

      // Detecta broadcast_id da Live
      const match = url.match(/\/api\/v1\/live\/(\d+)\//);
      if (match && match[1]) {
        window.postMessage(
          {
            source: "IG_LIVE_INTERCEPTOR",
            type: "BROADCAST_ID_FOUND",
            broadcastId: match[1],
          },
          "*"
        );
      }
    } catch (e) {
      // Ignora silenciosamente para não afetar o Instagram
    }
    return response;
  };

  // 2. Interceptação de XMLHttpRequest (para chamadas legadas/internas)
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener("load", function () {
      try {
        if (typeof url === "string" && url.includes("/get_comment/")) {
          const data = JSON.parse(this.responseText);
          if (data && (Array.isArray(data.comments) || Array.isArray(data.system_comments))) {
            const all = (data.comments || []).concat(data.system_comments || []);
            window.postMessage(
              {
                source: "IG_LIVE_INTERCEPTOR",
                type: "REST_COMMENTS",
                comments: all,
              },
              "*"
            );
          }
        }
      } catch (e) {}
    });
    return originalOpen.call(this, method, url, ...rest);
  };
})();
