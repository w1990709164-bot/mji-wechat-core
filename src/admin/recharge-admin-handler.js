"use strict";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;

async function handleRechargeAdminRequest(options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const pathname = String(options.pathname || "");
  const storage = options.storage;
  const tenant = options.tenant;
  const request = options.request;
  const response = options.response;
  const url = options.url;

  if (!storage?.recharge || !tenant?.id) return false;

  if (method === "GET" && pathname === "/api/recharge/packages") {
    const packages = await storage.recharge.listPackages({ tenantId: tenant.id });
    sendJson(response, 200, { ok: true, packages });
    return true;
  }

  if (method === "POST" && pathname === "/api/recharge/packages") {
    const body = await readJsonBody(request);
    const packageItem = await storage.recharge.createPackage({
      tenantId: tenant.id,
      code: body.code,
      name: body.name,
      priceCents: yuanToCents(body.priceYuan),
      credits: body.credits,
      description: body.description,
      status: body.status,
      sortOrder: body.sortOrder,
      metadata: { operator: "local-admin-hub" },
    });
    sendJson(response, 201, { ok: true, package: packageItem });
    return true;
  }

  const packageMatch = pathname.match(/^\/api\/recharge\/packages\/([0-9a-f-]+)$/i);
  if (method === "PUT" && packageMatch) {
    const packageId = requireUuid(packageMatch[1], "packageId");
    const body = await readJsonBody(request);
    const packageItem = await storage.recharge.updatePackage({
      tenantId: tenant.id,
      packageId,
      code: body.code,
      name: body.name,
      priceCents: yuanToCents(body.priceYuan),
      credits: body.credits,
      description: body.description,
      status: body.status,
      sortOrder: body.sortOrder,
      metadata: { operator: "local-admin-hub" },
    });
    if (!packageItem) throw httpError(404, "充值套餐不存在");
    sendJson(response, 200, { ok: true, package: packageItem });
    return true;
  }

  if (method === "GET" && pathname === "/api/recharge/orders") {
    const orders = await storage.recharge.listOrders({
      tenantId: tenant.id,
      status: normalizeText(url?.searchParams?.get("status")),
      limit: readLimit(url?.searchParams?.get("limit"), 200, 500),
    });
    sendJson(response, 200, { ok: true, orders });
    return true;
  }

  const orderActionMatch = pathname.match(/^\/api\/recharge\/orders\/([0-9a-f-]+)\/(confirm|cancel)$/i);
  if (method === "POST" && orderActionMatch) {
    const orderId = requireUuid(orderActionMatch[1], "orderId");
    const action = orderActionMatch[2].toLowerCase();
    const body = await readJsonBody(request);

    if (action === "confirm") {
      const result = await storage.recharge.confirmOrder({
        tenantId: tenant.id,
        orderId,
        paymentNote: body.paymentNote,
        operator: "local-admin-hub",
      });
      sendJson(response, 200, {
        ok: true,
        duplicate: Boolean(result.duplicate),
        order: result.order,
        wallet: result.wallet,
      });
      return true;
    }

    const order = await storage.recharge.cancelOrder({
      tenantId: tenant.id,
      orderId,
    });
    if (!order) throw httpError(404, "充值订单不存在");
    sendJson(response, 200, { ok: true, order });
    return true;
  }

  return false;
}

function yuanToCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100000) {
    throw httpError(400, "套餐价格必须是大于 0 的有效金额");
  }
  return Math.round(parsed * 100);
}

function requireUuid(value, name) {
  const normalized = normalizeText(value);
  if (!UUID_PATTERN.test(normalized)) throw httpError(400, `${name} 不合法`);
  return normalized;
}

function readLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "提交内容过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid object");
    }
    return value;
  } catch {
    throw httpError(400, "提交内容不是有效 JSON");
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { handleRechargeAdminRequest };
