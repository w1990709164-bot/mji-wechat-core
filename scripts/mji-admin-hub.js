"use strict";

const { startUserAdminWeb } = require("./mji-user-admin-web");

startUserAdminWeb().catch((error) => {
  console.error(
    `[mji-admin-hub] 用户管理后台启动失败：${error instanceof Error ? error.stack || error.message : error}`
  );
});

require("./mji-admin-hub-recharge");
