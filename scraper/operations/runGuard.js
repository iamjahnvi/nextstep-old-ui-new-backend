// =============================================================================
// scraper/operations/runGuard.js — STEP 13 overlap protection (deployment-local)
// =============================================================================
// WHAT: Lightweight mutual exclusion for operational runs on one machine: an
//   exclusive-create lock file carrying { pid, startedAt, label }. A second
//   run finding a live lock refuses safely instead of overlapping. Stale locks
//   (older than staleMs, or belonging to a dead PID) are taken over — so an
//   abnormal termination blocks future runs for at most staleMs, never forever.
// WHY: Two surveillance runs over the same staging collections could interleave
//   writes and double-notify. No distributed lock system is warranted for one
//   deployment: a lock file in the OS temp directory is sufficient, portable,
//   and cleans itself on success via release() (always call it in finally).
// CONTRACT:
//   acquireLock({ lockFile?, staleMs? }) -> { acquired, release, info }.
//     acquired true: this process owns the lock; call release() when done
//       (release is idempotent and only removes a lock it still owns).
//     acquired false: info.reason is "held" (live owner PID reported) or the
//       takeover details when stale. The caller must exit safely, not retry
//       in a hot loop.
//   Default lockFile: os.tmpdir()/nextstep-surveillance.lock. Default staleMs:
//   one hour. PID liveness uses process.kill(pid, 0) where the platform
//   allows; failures degrade to age-based staleness (documented, deterministic
//   in tests via injected now/clock where needed).
// GENERICITY: PIDs and paths only. No exam logic.
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_LOCK_FILE = path.join(os.tmpdir(), "nextstep-surveillance.lock");
const DEFAULT_STALE_MS = 60 * 60 * 1000;

function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(options = {}) {
  const lockFile = typeof options.lockFile === "string" && options.lockFile ? options.lockFile : DEFAULT_LOCK_FILE;
  const staleMs = typeof options.staleMs === "number" && options.staleMs > 0 ? options.staleMs : DEFAULT_STALE_MS;
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const label = typeof options.label === "string" ? options.label : "surveillance";

  const claim = { pid: process.pid, startedAt: new Date(now).toISOString(), label };
  try {
    fs.writeFileSync(lockFile, JSON.stringify(claim), { flag: "wx" });
    return { acquired: true, release: makeRelease(lockFile, claim), info: { ...claim, lockFile } };
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  }

  const existing = readLock(lockFile);
  const ageMs = existing && existing.startedAt ? now - new Date(existing.startedAt).getTime() : Number.NaN;
  const stale = !existing || Number.isNaN(ageMs) || ageMs > staleMs || !pidAlive(existing.pid);
  if (!stale) {
    return {
      acquired: false,
      release: () => false,
      info: { reason: "held", ownerPid: existing.pid, lockFile, ageMs },
    };
  }
  try {
    fs.unlinkSync(lockFile);
  } catch {
    return { acquired: false, release: () => false, info: { reason: "held", lockFile } };
  }
  try {
    fs.writeFileSync(lockFile, JSON.stringify(claim), { flag: "wx" });
    return { acquired: true, release: makeRelease(lockFile, claim), info: { ...claim, lockFile, tookOverStale: true } };
  } catch {
    return { acquired: false, release: () => false, info: { reason: "held", lockFile } };
  }
}

function makeRelease(lockFile, claim) {
  let released = false;
  return () => {
    if (released) return true;
    released = true;
    try {
      const current = readLock(lockFile);
      if (current && current.pid === claim.pid && current.startedAt === claim.startedAt) {
        fs.unlinkSync(lockFile);
      }
      return true;
    } catch {
      return false;
    }
  };
}

module.exports = {
  DEFAULT_LOCK_FILE,
  DEFAULT_STALE_MS,
  acquireLock,
};
