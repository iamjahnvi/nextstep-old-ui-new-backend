const mongoose = require("mongoose");

const { getExamCandidateModel } = require("../../scraper/models/examCandidate");
const { getSurveillanceStateModel } = require("../../scraper/models/surveillanceState");
const { getReviewStateModel } = require("../../scraper/models/reviewState");
const { getAllowlistDeclarationModel } = require("../../scraper/models/allowlistDeclaration");
const {
    DashboardRequestError,
    getFreshnessDashboard,
} = require("../../scraper/surveillance/freshnessDashboard");

const adapters = [
    require("../../scraper/registry/exams/gate-2026"),
    require("../../scraper/registry/exams/jee-advanced"),
    require("../../scraper/registry/exams/jee-main"),
];

let scraperConnectionPromise = null;

function normalizeIdentity(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveAdapter(candidate) {
    return adapters.find((adapter) =>
        adapter.slug === candidate.adapterSlug ||
        normalizeIdentity(adapter.name) === normalizeIdentity(candidate.name)
    ) || null;
}

function parseQuery(query = {}) {
    const filters = {};
    if (query.candidateId !== undefined) {
        if (typeof query.candidateId !== "string") {
            throw new DashboardRequestError("candidateId must be a single string");
        }
        filters.candidateId = query.candidateId;
    }
    if (query.limit !== undefined) {
        if (typeof query.limit !== "string" || !/^\d+$/.test(query.limit)) {
            throw new DashboardRequestError("limit must be a positive integer");
        }
        filters.limit = Number(query.limit);
    }
    if (query.status !== undefined) {
        if (typeof query.status !== "string") {
            throw new DashboardRequestError("status must be a single value");
        }
        filters.status = query.status;
    }
    return filters;
}

async function getFreshnessDashboardData(query, connection = mongoose.connection) {
    const filters = parseQuery(query);
    const models = {
        ExamCandidate: getExamCandidateModel(connection, { readOnly: true }),
        SurveillanceState: getSurveillanceStateModel(connection, { readOnly: true }),
        ReviewState: getReviewStateModel(connection, { readOnly: true }),
        AllowlistDeclaration: getAllowlistDeclarationModel(connection, { readOnly: true }),
    };
    return getFreshnessDashboard(filters, models, { resolveAdapter });
}

async function getConfiguredScraperConnection() {
    const scraperUri = process.env.SCRAPER_MONGO_URI;
    if (!scraperUri || scraperUri === process.env.MONGO_URI) {
        return mongoose.connection;
    }
    if (!scraperConnectionPromise) {
        scraperConnectionPromise = mongoose.createConnection(scraperUri).asPromise();
    }
    try {
        return await scraperConnectionPromise;
    } catch (error) {
        scraperConnectionPromise = null;
        throw error;
    }
}

function createFreshnessDashboardController(connection = mongoose.connection) {
    return async function freshnessDashboardController(req, res) {
        try {
            const activeConnection = connection === mongoose.connection
                ? await getConfiguredScraperConnection()
                : connection;
            const data = await getFreshnessDashboardData(req.query, activeConnection);
            return res.json({ success: true, ...data });
        } catch (error) {
            if (error instanceof DashboardRequestError) {
                return res.status(400).json({ success: false, message: error.message });
            }
            console.error("Freshness dashboard request failed");
            return res.status(500).json({
                success: false,
                message: "Unable to load freshness dashboard data",
            });
        }
    };
}

const freshnessDashboardController = createFreshnessDashboardController();

module.exports = {
    freshnessDashboardController,
    createFreshnessDashboardController,
    getFreshnessDashboardData,
    getConfiguredScraperConnection,
    parseQuery,
    resolveAdapter,
};
