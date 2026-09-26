import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    formatTimestamp,
    normalizeDashboardFilters,
    normalizeDashboardResponse,
    observationSummary,
    buildOperationalSummary,
} from "./freshnessDashboardViewModel.js";

describe("STEP 26 freshness dashboard view model", () => {
    it("handles an empty endpoint response", () => {
        assert.deepEqual(normalizeDashboardResponse({ limit: 25, total: 0, results: [] }), {
            limit: 25, total: 0, results: [],
        });
    });

    it("preserves candidate, status, and bounded limit filters", () => {
        assert.deepEqual(normalizeDashboardFilters({
            candidateId: " candidate-1 ", limit: 5, status: "REVIEW_REQUIRED",
        }), {
            candidateId: "candidate-1", limit: 5, status: "REVIEW_REQUIRED",
        });
        assert.equal(normalizeDashboardFilters({ limit: 1000 }).limit, 5);
    });

    it("formats observations and missing timestamps deterministically", () => {
        assert.equal(observationSummary({
            outcome: "NO_ACTION", snapshot: { contentHash: "hash-1" },
        }), "NO_ACTION · hash-1");
        assert.equal(formatTimestamp(null), "Not recorded");
        assert.equal(formatTimestamp("not-a-date"), "Not recorded");
    });

    it("normalizes the dashboard states without duplicating freshness logic", () => {
        const result = normalizeDashboardResponse({
            limit: 4,
            total: 4,
            results: [
                { candidate: { candidateId: "stable", name: "Stable" }, freshnessStatus: "NO_ACTION" },
                { candidate: { candidateId: "review", name: "Review" }, freshnessStatus: "REVIEW_REQUIRED" },
                { candidate: { candidateId: "failed", name: "Failed" }, freshnessStatus: "FAILED" },
                {
                    candidate: { candidateId: "retired", name: "Retired" },
                    bulletins: [{ url: "https://example.test/retired", declarationStatus: "retired" }],
                },
            ],
        });
        assert.deepEqual(result.results.map((entry) => entry.freshnessStatus), [
            "NO_ACTION", "REVIEW_REQUIRED", "FAILED", null,
        ]);
        assert.equal(result.results[3].bulletins[0].declarationStatus, "retired");
    });

    it("handles malformed and missing optional fields without inventing observations", () => {
        const result = normalizeDashboardResponse({
            results: [{ candidate: {}, bulletins: [null, { reasons: [null, "drift"] }] }],
        });
        assert.equal(result.results[0].candidate.name, "Unknown candidate");
        assert.equal(result.results[0].candidate.candidateId, null);
        assert.equal(result.results[0].bulletins.length, 1);
        assert.equal(result.results[0].bulletins[0].url, "");
        assert.deepEqual(result.results[0].bulletins[0].reasons, ["drift"]);
        assert.equal(result.results[0].bulletins[0].latestObservation, null);
        assert.equal(result.results[0].bulletins[0].historyCount, 0);
    });

    it("preserves bounded, candidate, and status filter requests", () => {
        const filters = normalizeDashboardFilters({
            candidateId: "candidate-7",
            status: "FAILED",
            limit: 5,
        });
        assert.deepEqual(filters, {
            candidateId: "candidate-7",
            status: "FAILED",
            limit: 5,
        });
    });

    it("preserves baseline, latest history, and linked review data from the endpoint", () => {
        const result = normalizeDashboardResponse({
            results: [{
                candidate: { candidateId: "reviewed", name: "Reviewed exam" },
                bulletins: [{
                    url: "https://example.test/bulletin.pdf",
                    declarationStatus: "active",
                    baselineObservation: {
                        checkedAt: "2026-02-01T00:00:00Z",
                        outcome: "BASELINE",
                        snapshot: { contentHash: "baseline" },
                    },
                    latestObservation: {
                        checkedAt: "2026-02-02T00:00:00Z",
                        outcome: "REVIEW_REQUIRED",
                        snapshot: { contentHash: "latest" },
                    },
                    latestHistory: { checkedAt: "2026-02-02T00:00:00Z", outcome: "REVIEW_REQUIRED" },
                    historyCount: 2,
                    linkedReview: { stage: "REVIEW_REQUIRED", reviewKey: "surveillance:reviewed" },
                }],
            }],
        });
        const bulletin = result.results[0].bulletins[0];
        assert.equal(bulletin.baselineObservation.snapshot.contentHash, "baseline");
        assert.equal(bulletin.latestObservation.snapshot.contentHash, "latest");
        assert.equal(bulletin.historyCount, 2);
        assert.equal(bulletin.linkedReview.stage, "REVIEW_REQUIRED");
    });

    it("builds bounded operational counts and attention records from returned data", () => {
        const dashboard = normalizeDashboardResponse({
            limit: 4,
            total: 4,
            results: [
                {
                    candidate: { candidateId: "stable", name: "Stable" },
                    freshnessStatus: "NO_ACTION",
                    bulletins: [{ declarationStatus: "active" }],
                },
                {
                    candidate: { candidateId: "review", name: "Review" },
                    freshnessStatus: "REVIEW_REQUIRED",
                    reviewReasons: ["content drift"],
                    bulletins: [{
                        url: "https://example.test/review.pdf",
                        declarationStatus: "active",
                        freshnessStatus: "REVIEW_REQUIRED",
                        latestObservation: { checkedAt: "2026-02-02T00:00:00Z" },
                        reasons: ["content drift"],
                    }],
                },
                {
                    candidate: { candidateId: "failed", name: "Failed" },
                    freshnessStatus: "FAILED",
                    bulletins: [{ declarationStatus: "retired", freshnessStatus: "FAILED" }],
                },
                {
                    candidate: { candidateId: "unknown", name: "Unknown" },
                    bulletins: [{ declarationStatus: "retired" }],
                },
            ],
        });
        assert.deepEqual(buildOperationalSummary(dashboard), {
            totalCandidates: 4,
            noAction: 1,
            reviewRequired: 1,
            failed: 1,
            activeDeclarations: 2,
            retiredDeclarations: 2,
            attention: [
                {
                    candidate: { candidateId: "review", name: "Review", adapterSlug: null, conductingBody: null, year: null },
                    freshnessStatus: "REVIEW_REQUIRED",
                    reason: "content drift",
                    bulletinUrl: "https://example.test/review.pdf",
                    latestObservedAt: "2026-02-02T00:00:00Z",
                },
                {
                    candidate: { candidateId: "failed", name: "Failed", adapterSlug: null, conductingBody: null, year: null },
                    freshnessStatus: "FAILED",
                    reason: null,
                    bulletinUrl: null,
                    latestObservedAt: null,
                },
            ],
        });
    });

    it("returns an empty summary for empty or malformed data", () => {
        assert.deepEqual(buildOperationalSummary({ results: [] }), {
            totalCandidates: 0,
            noAction: 0,
            reviewRequired: 0,
            failed: 0,
            activeDeclarations: 0,
            retiredDeclarations: 0,
            attention: [],
        });
        assert.deepEqual(buildOperationalSummary(null).attention, []);
    });

    it("summarizes only the bounded records returned for a filtered request", () => {
        const filtered = normalizeDashboardResponse({
            limit: 1,
            total: 1,
            results: [{
                candidate: { candidateId: "failed-only", name: "Failed only" },
                freshnessStatus: "FAILED",
                bulletins: [{ declarationStatus: "retired" }],
            }],
        });
        assert.deepEqual(buildOperationalSummary(filtered), {
            totalCandidates: 1,
            noAction: 0,
            reviewRequired: 0,
            failed: 1,
            activeDeclarations: 0,
            retiredDeclarations: 1,
            attention: [{
                candidate: {
                    candidateId: "failed-only",
                    name: "Failed only",
                    adapterSlug: null,
                    conductingBody: null,
                    year: null,
                },
                freshnessStatus: "FAILED",
                reason: null,
                bulletinUrl: null,
                latestObservedAt: null,
            }],
        });
    });
});
