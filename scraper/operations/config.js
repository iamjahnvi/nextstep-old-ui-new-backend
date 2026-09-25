// =============================================================================
// scraper/operations/config.js — STEP 14 deployment configuration validation
// =============================================================================
// WHAT: Single place that reads, validates, and documents deployment
//   configuration from the environment (see .env.example at the repo root).
//   Values are validated for shape only; secrets are NEVER logged, printed,
//   or returned in readable form — getSafeSummary() exposes presence (set /
//   unset), never contents.
// WHY: Deployments fail on missing/typoed configuration. Failing fast with a
//   named-variable error beats a midnight crash, and a safe summary lets
//   operators verify configuration without leaking secrets into logs.
// REQUIRED: MONGO_URI (or SCRAPER_MONGO_URI for staging). Everything else
//   carries safe defaults: CRAWLEE_TRANSPORT=off, LLM disabled, notifications
//   local-log only, dry-run posture preserved.
// CONTRACT:
//   loadConfig(env?) -> { mongoUri, scraperMongoUri, crawleeTransport,
//     pythonDocprocUrl, dryRun, llm: { enabled, providerUrl, model },
//     ops: { logDir, logMaxBytes, notifications, lockFile, backupDir } }.
//     Throws on unknown CRAWLEE_TRANSPORT / malformed URLs / bad numbers.
//   getSafeSummary(config) -> same shape with every secret replaced by
//     "set" / "unset" markers (safe to log).
//   REQUIRED_VARS documents the contract for operators and tests.
// GENERICITY: infrastructure only. No exam logic.
// =============================================================================

const REQUIRED_VARS = ["MONGO_URI"];
const CRAWLEE_MODES = ["off", "shadow", "on"];
const NOTIFICATION_TRANSPORTS = ["log", "file", "webhook"];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function httpUrlOrNull(value, label) {
  const text = nonEmptyString(value);
  if (text === null) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`operations/config: ${label} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`operations/config: ${label} must be http(s)`);
  }
  return text;
}

function positiveIntOr(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`operations/config: ${label} must be a positive integer`);
  }
  return parsed;
}

function loadConfig(env = process.env) {
  const source = env || {};
  const mongoUri = nonEmptyString(source.MONGO_URI);
  if (!mongoUri) {
    throw new Error("operations/config: MONGO_URI is required");
  }
  const crawleeTransport = nonEmptyString(source.CRAWLEE_TRANSPORT) || "off";
  if (!CRAWLEE_MODES.includes(crawleeTransport)) {
    throw new Error(`operations/config: CRAWLEE_TRANSPORT must be ${CRAWLEE_MODES.join("|")}`);
  }
  const notificationsTransport = nonEmptyString(source.NOTIFICATIONS_TRANSPORT) || "log";
  if (!NOTIFICATION_TRANSPORTS.includes(notificationsTransport)) {
    throw new Error(`operations/config: NOTIFICATIONS_TRANSPORT must be ${NOTIFICATION_TRANSPORTS.join("|")}`);
  }
  return {
    mongoUri,
    scraperMongoUri: nonEmptyString(source.SCRAPER_MONGO_URI) || mongoUri,
    crawleeTransport,
    pythonDocprocUrl: httpUrlOrNull(source.PYTHON_DOCPROC_URL, "PYTHON_DOCPROC_URL"),
    dryRun: source.DRY_RUN !== "false",
    llm: {
      enabled: source.LLM_SEMANTIC_EXTRACTION === "true",
      providerUrl: httpUrlOrNull(source.LLM_PROVIDER_URL, "LLM_PROVIDER_URL"),
      model: nonEmptyString(source.LLM_MODEL),
    },
    ops: {
      logDir: nonEmptyString(source.OPS_LOG_DIR),
      logMaxBytes: positiveIntOr(source.OPS_LOG_MAX_BYTES, 10 * 1024 * 1024, "OPS_LOG_MAX_BYTES"),
      notificationsEnabled: source.NOTIFICATIONS_ENABLED === "true",
      notificationsTransport,
      notificationsFileDir: nonEmptyString(source.NOTIFICATIONS_FILE_DIR),
      notificationsWebhookUrl: httpUrlOrNull(source.NOTIFICATIONS_WEBHOOK_URL, "NOTIFICATIONS_WEBHOOK_URL"),
      lockFile: nonEmptyString(source.OPS_LOCK_FILE),
      backupDir: nonEmptyString(source.OPS_BACKUP_DIR),
    },
  };
}

function maskSecret(value) {
  if (typeof value !== "string" || !value) return "unset";
  return "set";
}

function getSafeSummary(config) {
  return {
    mongoUri: maskSecret(config.mongoUri),
    scraperMongoUri: config.scraperMongoUri === config.mongoUri ? "same-as-mongo-uri" : maskSecret(config.scraperMongoUri),
    crawleeTransport: config.crawleeTransport,
    pythonDocprocUrl: config.pythonDocprocUrl || "unset",
    dryRun: config.dryRun,
    llm: {
      enabled: config.llm.enabled,
      providerUrl: config.llm.providerUrl || "unset",
      model: config.llm.model ? "set" : "unset",
    },
    ops: {
      logDir: config.ops.logDir || "stdout",
      logMaxBytes: config.ops.logMaxBytes,
      notificationsEnabled: config.ops.notificationsEnabled,
      notificationsTransport: config.ops.notificationsTransport,
      notificationsFileDir: config.ops.notificationsFileDir || "unset",
      notificationsWebhookUrl: maskSecret(config.ops.notificationsWebhookUrl),
      lockFile: config.ops.lockFile || "os-temp-default",
      backupDir: config.ops.backupDir || "unset",
    },
  };
}

module.exports = {
  REQUIRED_VARS,
  CRAWLEE_MODES,
  NOTIFICATION_TRANSPORTS,
  loadConfig,
  getSafeSummary,
};
