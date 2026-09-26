const FRESHNESS_STATUSES = ["", "NO_ACTION", "REVIEW_REQUIRED", "FAILED"];
const MAX_DASHBOARD_LIMIT = 5;

function normalizeObservation(observation) {
    if (!observation || typeof observation !== "object") return null;
    return {
        checkedAt: observation.checkedAt || null,
        outcome: typeof observation.outcome === "string" ? observation.outcome : null,
        snapshot: observation.snapshot && typeof observation.snapshot === "object"
            ? observation.snapshot
            : null,
    };
}

function normalizeBulletin(bulletin) {
    if (!bulletin || typeof bulletin !== "object") return null;
    return {
        url: typeof bulletin.url === "string" ? bulletin.url : "",
        declarationStatus: typeof bulletin.declarationStatus === "string"
            ? bulletin.declarationStatus
            : "unknown",
        freshnessStatus: typeof bulletin.freshnessStatus === "string"
            ? bulletin.freshnessStatus
            : null,
        reasons: Array.isArray(bulletin.reasons)
            ? bulletin.reasons.filter((reason) => typeof reason === "string")
            : [],
        latestObservation: normalizeObservation(bulletin.latestObservation),
        baselineObservation: normalizeObservation(bulletin.baselineObservation),
        historyCount: Number.isInteger(bulletin.historyCount) && bulletin.historyCount >= 0
            ? bulletin.historyCount
            : 0,
        latestHistory: normalizeObservation(bulletin.latestHistory),
        linkedReview: bulletin.linkedReview && typeof bulletin.linkedReview === "object"
            ? bulletin.linkedReview
            : null,
    };
}

function normalizeResult(result) {
    const candidate = result && typeof result.candidate === "object" ? result.candidate : {};
    return {
        candidate: {
            candidateId: typeof candidate.candidateId === "string" ? candidate.candidateId : null,
            name: typeof candidate.name === "string" && candidate.name.trim()
                ? candidate.name
                : "Unknown candidate",
            adapterSlug: typeof candidate.adapterSlug === "string" ? candidate.adapterSlug : null,
            conductingBody: typeof candidate.conductingBody === "string"
                ? candidate.conductingBody
                : null,
            year: candidate.year ?? null,
        },
        freshnessStatus: typeof result?.freshnessStatus === "string"
            ? result.freshnessStatus
            : null,
        reviewReasons: Array.isArray(result?.reviewReasons)
            ? result.reviewReasons.filter((reason) => typeof reason === "string")
            : [],
        linkedReview: result?.linkedReview && typeof result.linkedReview === "object"
            ? result.linkedReview
            : null,
        bulletins: Array.isArray(result?.bulletins)
            ? result.bulletins.map(normalizeBulletin).filter(Boolean)
            : [],
    };
}

export function normalizeDashboardResponse(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.results)) {
        return { limit: 0, total: 0, results: [] };
    }
    return {
        limit: Number.isInteger(data.limit) ? data.limit : 0,
        total: Number.isInteger(data.total) ? data.total : data.results.length,
        results: data.results.map(normalizeResult),
    };
}

export function normalizeDashboardFilters(filters) {
    const source = filters && typeof filters === "object" ? filters : {};
    const limit = Number(source.limit);
    return {
        candidateId: typeof source.candidateId === "string" ? source.candidateId.trim() : "",
        limit: Number.isInteger(limit) && limit > 0
            ? Math.min(limit, MAX_DASHBOARD_LIMIT)
            : MAX_DASHBOARD_LIMIT,
        status: FRESHNESS_STATUSES.includes(source.status) ? source.status : "",
    };
}

export function formatTimestamp(value) {
    if (!value) return "Not recorded";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Not recorded";
    return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export function observationSummary(observation) {
    if (!observation) return "Not recorded";
    const snapshot = observation.snapshot || {};
    const value = snapshot.contentHash || snapshot.value || snapshot.documentUrl;
    return value ? `${observation.outcome} · ${value}` : observation.outcome || "Recorded";
}

export function buildOperationalSummary(dashboard) {
    const results = Array.isArray(dashboard?.results) ? dashboard.results : [];
    const summary = {
        totalCandidates: results.length,
        noAction: 0,
        reviewRequired: 0,
        failed: 0,
        activeDeclarations: 0,
        retiredDeclarations: 0,
        attention: [],
    };

    for (const entry of results) {
        if (entry.freshnessStatus === "NO_ACTION") summary.noAction += 1;
        if (entry.freshnessStatus === "REVIEW_REQUIRED") summary.reviewRequired += 1;
        if (entry.freshnessStatus === "FAILED") summary.failed += 1;

        for (const bulletin of entry.bulletins) {
            if (bulletin.declarationStatus === "active") summary.activeDeclarations += 1;
            if (bulletin.declarationStatus === "retired") summary.retiredDeclarations += 1;
        }

        if (entry.freshnessStatus === "REVIEW_REQUIRED" || entry.freshnessStatus === "FAILED") {
            const relevantBulletin = entry.bulletins.find(
                (bulletin) => bulletin.freshnessStatus === entry.freshnessStatus
            ) || entry.bulletins[0] || null;
            const reasons = [
                ...entry.reviewReasons,
                ...(relevantBulletin?.reasons || []),
            ].filter((reason, index, all) => all.indexOf(reason) === index);
            summary.attention.push({
                candidate: entry.candidate,
                freshnessStatus: entry.freshnessStatus,
                reason: reasons.length > 0 ? reasons.join(" · ") : null,
                bulletinUrl: relevantBulletin?.url || null,
                latestObservedAt: relevantBulletin?.latestObservation?.checkedAt || null,
            });
        }
    }

    return summary;
}
