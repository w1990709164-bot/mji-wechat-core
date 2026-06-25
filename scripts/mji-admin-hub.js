"use strict";

const { startUserAdminWeb } = require("./mji-user-admin-web");
const { startProactiveEventsAdminWebV2 } = require("./mji-proactive-events-admin-web-v2");

Promise.all([
  startUserAdminWeb(),
  startProactiveEventsAdminWebV2(),
]).catch((error) => {
  console.error(
    `[mji-admin-hub] 管理后台启动失败：${error instanceof Error ? error.stack || error.message : error}`
  );
});

require("./mji-admin-hub-recharge");
