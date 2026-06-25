"use strict";

const fs = require("fs");
const path = require("path");

async function startProactiveEventsAdminWebV2(options = {}) {
  const originalReadFileSync = fs.readFileSync;
  const templatePath = path.join(__dirname, "..", "admin", "proactive-events.html");
  const baseTemplate = originalReadFileSync(templatePath, "utf8");
  const enhancedTemplate = enhanceTemplate(baseTemplate);

  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(templatePath)) {
      return enhancedTemplate;
    }
    return originalReadFileSync.call(fs, filePath, ...args);
  };

  try {
    const { startProactiveEventsAdminWeb } = require("./mji-proactive-events-admin-web");
    return await startProactiveEventsAdminWeb(options);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

function enhanceTemplate(html) {
  const beforeMainScript = `
  <script>
    (() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = String(args[0] || '');
        if (!url.includes('/api/events')) return response;
        const payload = await response.clone().json().catch(() => null);
        if (!payload || !Array.isArray(payload.events)) return response;
        payload.events = payload.events.map(enhancePromiseRow);
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(JSON.stringify(payload), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      };

      function enhancePromiseRow(row) {
        if (!row || row.eventType !== 'character_promise') return row;
        const title = String(row.title || '');
        const action = title.includes('起床') ? '叫醒'
          : title.includes('结果') ? '询问结果'
          : title.includes('提醒') ? '提醒'
          : title.includes('陪') ? '陪伴'
          : title.includes('回来') || title.includes('找用户') ? '回来聊天'
          : '承诺兑现';
        const delivery = { ...(row.delivery || {}) };
        const originalOutcome = delivery.outcome || '';
        if (originalOutcome === 'sent') {
          delivery.outcome = 'promise_sent';
          delivery.reason = '角色承诺已成功兑现';
        } else if (originalOutcome === 'retry') {
          delivery.outcome = 'promise_retry';
          delivery.reason = '承诺生成失败，等待重试';
        } else if (originalOutcome === 'failed') {
          delivery.outcome = 'promise_failed';
          delivery.reason = '承诺连续失败后停止';
        } else if (originalOutcome === 'dismissed') {
          delivery.outcome = 'promise_dismissed';
          delivery.reason = '用户已回来聊天或承诺被取消';
        }
        return {
          ...row,
          triggerKind: 'character_promise',
          triggerLabel: '角色承诺',
          eventTypeLabel: action,
          delivery,
        };
      }
    })();
  </script>
`;

  const afterMainScript = `
  <script>
    (() => {
      const originalReasonLabel = window.reasonLabel;
      window.reasonLabel = function enhancedReasonLabel(row) {
        if (!row || row.eventType !== 'character_promise') {
          return typeof originalReasonLabel === 'function'
            ? originalReasonLabel(row)
            : '事件跟进';
        }
        const outcome = row.delivery?.outcome || '';
        const reason = row.delivery?.reason || '';
        if (outcome.startsWith('promise_') && reason) return reason;
        if (row.status === 'pending') return '等待承诺约定时间';
        if (row.status === 'queued') return '承诺已进入生成队列';
        if (row.status === 'expired') return '超过承诺兑现窗口';
        if (row.status === 'dismissed') return '用户已回来聊天或承诺被取消';
        return reason || '角色承诺';
      };
      if (typeof window.loadEvents === 'function') {
        setTimeout(() => window.loadEvents().catch(() => {}), 0);
      }
    })();
  </script>
`;

  return String(html)
    .replace("<title>M叽事件主动后台</title>", "<title>M叽事件与承诺后台</title>")
    .replace("<div class=\"logo\">事</div>", "<div class=\"logo\">伴</div>")
    .replace("<h1>事件主动后台</h1>", "<h1>事件与承诺后台</h1>")
    .replace("事件识别、触发原因、发送状态与扣费结果", "事件跟进、角色承诺兑现、发送状态与扣费结果")
    .replace("placeholder=\"搜索用户、微信ID、事件类型或原话\"", "placeholder=\"搜索用户、微信ID、事件、承诺或原话\"")
    .replace("<h2>事件跟进记录</h2>", "<h2>事件跟进与角色承诺记录</h2>")
    .replace("<th>事件</th><th>原话</th>", "<th>事件/动作</th><th>用户原话/角色承诺</th>")
    .replace("  <script>\n    const token=", `${beforeMainScript}  <script>\n    const token=`)
    .replace("</body>", `${afterMainScript}</body>`);
}

module.exports = {
  enhanceTemplate,
  startProactiveEventsAdminWebV2,
};

if (require.main === module) {
  startProactiveEventsAdminWebV2().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
