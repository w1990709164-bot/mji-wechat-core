"use strict";

const { startUserAdminWeb } = require("./mji-user-admin-web");
const { startProactiveEventsAdminWeb } = require("./mji-proactive-events-admin-web");

Promise.all([
  startUserAdminWeb(),
  startProactiveEventsAdminWeb(),
]).catch((error) => {
  console.error(
    `[mji-admin-hub] 管理后台启动失败：${error instanceof Error ? error.stack || error.message : error}`
  );
});

require("./mji-admin-hub-recharge");
