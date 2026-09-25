// =============================================================================
// scraper/operations/notifications.js — STEP 13 operator notifications
// =============================================================================
// WHAT: Provider-independent operator notifications for operationally
//   important events. The interface is fixed — notify({ type, severity,
//   candidateId, examName, message, details }) — and the transport is
//   injectable. The default transport is structured local log output: no paid
//   services, no external dependencies, no network.
// WHY: REVIEW_REQUIRED, failures, and readiness problems must reach a human.
//   Notifications inform; they never trigger publishing, acceptance, or data
//   changes — this module has no path to any of those systems.
// TYPES: REVIEW_REQUIRED | SURVEILLANCE_FAILED | INGESTION_FAILED |
//   SCHEDULER_FAILED | READINESS_FAILED. SEVERITIES: info | warning | critical.
//   Details pass through the logger's secret redaction, so tokens, URIs with
//   credentials, and document contents can never leak into a notification.
// CONTRACT:
//   notify(input, options?) -> { delivered, transport, at, notification }.
//     options.transport defaults to the local log transport
//     ({ name: "log" }); custom transports implement
//     send(notification) and may be async. Unknown type/severity throws
//     (fail fast on programmer error, never silently misroute).
// GENERICITY: message shapes only. No exam names, no content.
// =============================================================================

const { redact, createLogger } = require("./logger");

const NOTIFICATION_TYPES = [
  "REVIEW_REQUIRED",
  "SURVEILLANCE_FAILED",
  "INGESTION_FAILED",
  "SCHEDULER_FAILED",
  "READINESS_FAILED",
];
const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"];

function logTransport(logger) {
  return {
    name: "log",
    async send(notification) {
      logger.log("notification.sent", { notification });
      return { delivered: true, transport: "log" };
    },
  };
}

async function notify(input = {}, options = {}) {
  const { type, severity, candidateId, examName, message, details } = input;
  if (!NOTIFICATION_TYPES.includes(type)) {
    throw new Error(
      `notifications: unknown type "${type}" (expected ${NOTIFICATION_TYPES.join("|")})`
    );
  }
  if (!NOTIFICATION_SEVERITIES.includes(severity)) {
    throw new Error(
      `notifications: unknown severity "${severity}" (expected ${NOTIFICATION_SEVERITIES.join("|")})`
    );
  }
  if (typeof message !== "string" || !message) {
    throw new Error("notifications: message is required");
  }
  const notification = {
    type,
    severity,
    candidateId: candidateId === undefined ? null : candidateId,
    examName: examName === undefined ? null : examName,
    message,
    details: redact(details === undefined ? {} : details),
    at: new Date().toISOString(),
  };
  const logger = options.logger || createLogger({});
  const transport = options.transport || logTransport(logger);
  const receipt = await transport.send(notification);
  return {
    delivered: receipt && receipt.delivered !== false,
    transport: (receipt && receipt.transport) || transport.name || "unknown",
    at: notification.at,
    notification,
  };
}

// STEP 14 additions (API-compatible — notify() and logTransport are untouched):
// fileTransport spools one JSON file per notification into a directory
// (free, local, auditable); webhookTransport POSTs the redacted payload to a
// configurable self-hosted endpoint (no paid service). resolveTransportConfig
// reads NOTIFICATIONS_* env so delivery enables/disables safely. None of them
// can publish, accept, or modify exam data — they only carry the notification.

function createFileTransport(options = {}) {
  const fs = require("fs");
  const path = require("path");
  if (typeof options.dir !== "string" || !options.dir) {
    throw new Error("notifications: file transport requires a dir");
  }
  fs.mkdirSync(options.dir, { recursive: true });
  return {
    name: "file",
    async send(notification) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(options.dir, `notification-${stamp}.json`);
      fs.writeFileSync(file, JSON.stringify(notification, null, 2));
      return { delivered: true, transport: "file", file };
    },
  };
}

function createWebhookTransport(options = {}, fetchFn) {
  if (typeof options.url !== "string" || !options.url) {
    throw new Error("notifications: webhook transport requires a url");
  }
  let parsed;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new Error("notifications: webhook url is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("notifications: webhook url must be http(s)");
  }
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const post = typeof fetchFn === "function" ? fetchFn : fetch;
  return {
    name: "webhook",
    async send(notification) {
      const response = await post(options.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notification),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`notifications: webhook answered HTTP ${response.status}`);
      }
      return { delivered: true, transport: "webhook" };
    },
  };
}

function resolveTransportConfig(env = process.env) {
  const source = env || {};
  const enabled = source.NOTIFICATIONS_ENABLED === "true";
  const transport = (source.NOTIFICATIONS_TRANSPORT || "log").trim() || "log";
  if (!["log", "file", "webhook"].includes(transport)) {
    throw new Error("notifications: NOTIFICATIONS_TRANSPORT must be log|file|webhook");
  }
  if (transport === "file" && !(typeof source.NOTIFICATIONS_FILE_DIR === "string" && source.NOTIFICATIONS_FILE_DIR)) {
    throw new Error("notifications: file transport requires NOTIFICATIONS_FILE_DIR");
  }
  if (transport === "webhook" && !(typeof source.NOTIFICATIONS_WEBHOOK_URL === "string" && source.NOTIFICATIONS_WEBHOOK_URL)) {
    throw new Error("notifications: webhook transport requires NOTIFICATIONS_WEBHOOK_URL");
  }
  return {
    enabled,
    transport,
    fileDir: source.NOTIFICATIONS_FILE_DIR || null,
    webhookUrl: source.NOTIFICATIONS_WEBHOOK_URL || null,
  };
}

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_SEVERITIES,
  logTransport,
  notify,
  createFileTransport,
  createWebhookTransport,
  resolveTransportConfig,
};
