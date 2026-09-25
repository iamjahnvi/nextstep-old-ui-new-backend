// =============================================================================
// scraper/operations/logger.js — STEP 13 structured operational logging
// =============================================================================
// WHAT: Minimal structured event logger for the operational layer. Every event
//   carries timestamp, event name, and optional run/candidate/stage context —
//   and every value passes through secret redaction before it reaches the sink.
// WHY: Failures must be visible and actionable without ever leaking
//   credentials, tokens, or document contents. This layer only covers NEW
//   operational code; unrelated modules keep their existing logging untouched.
// SECRETS: any object key matching password|passwd|secret|token|api[_-]?key|
//   authorization|cookie|set-cookie|mongo.*uri|.*uri (when the value looks
//   like a URI with credentials) is replaced with "[REDACTED]", recursively,
//   including inside arrays and nested objects. Document contents are never
//   logged by construction: callers pass counts/hashes/URLs, never bodies.
// CONTRACT:
//   createLogger({ runId?, sink? }) -> { runId, log(event, context?) }.
//     sink defaults to one JSON object per line on stdout. log() returns the
//     emitted record. Pure redaction is exported as redact(value) for tests
//     and the notification layer.
//   STEP 14 additions (API-compatible — createLogger is untouched):
//   createFileSink({ filePath, maxBytes? }) -> sink appending JSON lines,
//     rotating to "<file>.1" (single backup) once maxBytes is exceeded.
//     Rotation guidance for production logrotate(8) lives in DEPLOYMENT.md.
// EVENT NAMES (stable): run.started, run.finished, run.failed,
//   candidate.completed, candidate.failed, candidate.review_required,
//   surveillance.checked, health.checked, notification.sent, lock.acquired,
//   lock.refused, lock.released, retention.planned, retention.applied.
// GENERICITY: no exam names, no content logging.
// =============================================================================

const REDACTED = "[REDACTED]";
const SECRET_KEY_RE = /password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie/i;
const URI_WITH_CREDENTIALS_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (!isPlainObject(value)) {
    if (typeof value === "string" && URI_WITH_CREDENTIALS_RE.test(value)) return REDACTED;
    return value;
  }
  const clean = {};
  for (const key of Object.keys(value)) {
    if (SECRET_KEY_RE.test(key)) {
      clean[key] = REDACTED;
      continue;
    }
    if (/uri$/i.test(key) && typeof value[key] === "string" && URI_WITH_CREDENTIALS_RE.test(value[key])) {
      clean[key] = REDACTED;
      continue;
    }
    clean[key] = redact(value[key]);
  }
  return clean;
}

function createLogger(options = {}) {
  const runId = typeof options.runId === "string" && options.runId
    ? options.runId
    : `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sink = typeof options.sink === "function"
    ? options.sink
    : (record) => {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      };
  function log(event, context = {}) {
    if (typeof event !== "string" || !event) {
      throw new Error("logger: event name is required");
    }
    const record = {
      timestamp: new Date().toISOString(),
      event,
      runId,
      ...redact(context),
    };
    sink(record);
    return record;
  }
  return { runId, log };
}

function createFileSink(options = {}) {
  const fs = require("fs");
  const path = require("path");
  if (typeof options.filePath !== "string" || !options.filePath) {
    throw new Error("logger: filePath is required for a file sink");
  }
  const filePath = options.filePath;
  const maxBytes =
    typeof options.maxBytes === "number" && options.maxBytes > 0 ? Math.floor(options.maxBytes) : 10 * 1024 * 1024;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return (record) => {
    const line = `${JSON.stringify(record)}\n`;
    try {
      const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      if (size + Buffer.byteLength(line) > maxBytes) {
        try {
          fs.renameSync(filePath, `${filePath}.1`);
        } catch {
          // Rotation is best-effort: a missing file simply starts fresh below.
        }
      }
    } catch {
      // Size checks are best-effort; the append below still records the event.
    }
    fs.appendFileSync(filePath, line);
  };
}

module.exports = {
  REDACTED,
  redact,
  createLogger,
  createFileSink,
};
