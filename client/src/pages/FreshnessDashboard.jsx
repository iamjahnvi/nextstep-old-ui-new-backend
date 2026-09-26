import { useEffect, useState } from "react";
import api from "../services/api";
import {
    formatTimestamp,
    buildOperationalSummary,
    normalizeDashboardFilters,
    normalizeDashboardResponse,
    observationSummary,
} from "./freshnessDashboardViewModel";
import "./FreshnessDashboard.css";

const INITIAL_FILTERS = { candidateId: "", limit: 5, status: "" };

function StatusBadge({ status }) {
    return (
        <span className={`freshness-status freshness-status--${String(status || "unknown").toLowerCase()}`}>
            {status || "UNKNOWN"}
        </span>
    );
}

function Observation({ label, observation }) {
    return (
        <div className="freshness-observation">
            <span className="freshness-detail-label">{label}</span>
            <strong>{observationSummary(observation)}</strong>
            {observation?.checkedAt && <span>{formatTimestamp(observation.checkedAt)}</span>}
        </div>
    );
}

function FreshnessCard({ entry }) {
    return (
        <article className="freshness-card">
            <header className="freshness-card__header">
                <div>
                    <p className="freshness-eyebrow">{entry.candidate.adapterSlug || "Unmapped adapter"}</p>
                    <h2>{entry.candidate.name}</h2>
                    <p className="freshness-muted">
                        {entry.candidate.candidateId}
                        {entry.candidate.conductingBody ? ` · ${entry.candidate.conductingBody}` : ""}
                        {entry.candidate.year ? ` · ${entry.candidate.year}` : ""}
                    </p>
                </div>
                <StatusBadge status={entry.freshnessStatus} />
            </header>

            {entry.reviewReasons?.length > 0 && (
                <section className="freshness-callout">
                    <strong>Drift / review reasons</strong>
                    <ul>
                        {entry.reviewReasons.map((reason, index) => (
                            <li key={`${reason}-${index}`}>{reason}</li>
                        ))}
                    </ul>
                </section>
            )}

            <div className="freshness-bulletins">
                {entry.bulletins.length === 0 ? (
                    <p className="freshness-muted">No declared bulletin observations are available.</p>
                ) : entry.bulletins.map((bulletin, index) => (
                    <section className="freshness-bulletin" key={bulletin.url || `bulletin-${index}`}>
                        <div className="freshness-bulletin__header">
                            {bulletin.url ? (
                                <a href={bulletin.url} target="_blank" rel="noreferrer">{bulletin.url}</a>
                            ) : (
                                <span className="freshness-muted">Bulletin URL not recorded</span>
                            )}
                            <span className={`freshness-declaration freshness-declaration--${bulletin.declarationStatus}`}>
                                {bulletin.declarationStatus || "unknown"}
                            </span>
                        </div>
                        <div className="freshness-observations">
                            <Observation label="Latest observation" observation={bulletin.latestObservation} />
                            <Observation label="Baseline" observation={bulletin.baselineObservation} />
                            <div className="freshness-observation">
                                <span className="freshness-detail-label">History</span>
                                <strong>{bulletin.historyCount} observation{bulletin.historyCount === 1 ? "" : "s"}</strong>
                                {bulletin.latestHistory?.checkedAt && (
                                    <span>Latest: {formatTimestamp(bulletin.latestHistory.checkedAt)}</span>
                                )}
                            </div>
                        </div>
                        {bulletin.reasons?.length > 0 && (
                            <p className="freshness-reason"><strong>Reason:</strong> {bulletin.reasons.join(" · ")}</p>
                        )}
                        {bulletin.linkedReview && (
                            <p className="freshness-review">
                                Linked review: <strong>{bulletin.linkedReview.stage}</strong>
                                {" · "}updated {formatTimestamp(bulletin.linkedReview.updatedAt || bulletin.linkedReview.decidedAt)}
                            </p>
                        )}
                    </section>
                ))}
            </div>
        </article>
    );
}

function OperationalSummary({ summary }) {
    const metrics = [
        ["Candidates", summary.totalCandidates],
        ["NO_ACTION", summary.noAction],
        ["REVIEW_REQUIRED", summary.reviewRequired],
        ["FAILED", summary.failed],
        ["Active declarations", summary.activeDeclarations],
        ["Retired declarations", summary.retiredDeclarations],
    ];

    return (
        <>
            <section className="freshness-summary" aria-label="Operational summary">
                {metrics.map(([label, value]) => (
                    <div className="freshness-summary__metric" key={label}>
                        <strong>{value}</strong>
                        <span>{label}</span>
                    </div>
                ))}
            </section>
            {summary.attention.length > 0 && (
                <section className="freshness-attention" aria-label="Freshness attention">
                    <div className="freshness-attention__header">
                        <div>
                            <p className="freshness-eyebrow">Operator attention</p>
                            <h2>Review required or failed</h2>
                        </div>
                        <span>{summary.attention.length} record{summary.attention.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="freshness-attention__list">
                        {summary.attention.map((item, index) => (
                            <article className="freshness-attention__item" key={`${item.candidate.candidateId || "unknown"}-${index}`}>
                                <div>
                                    <strong>{item.candidate.name}</strong>
                                    <span className="freshness-muted">{item.candidate.candidateId || "Candidate ID not recorded"}</span>
                                </div>
                                <StatusBadge status={item.freshnessStatus} />
                                <span>{item.reason || "Reason not recorded"}</span>
                                {item.bulletinUrl ? (
                                    <a href={item.bulletinUrl} target="_blank" rel="noreferrer">{item.bulletinUrl}</a>
                                ) : (
                                    <span className="freshness-muted">Bulletin URL not recorded</span>
                                )}
                                <span>{item.latestObservedAt ? formatTimestamp(item.latestObservedAt) : "Latest observation not recorded"}</span>
                            </article>
                        ))}
                    </div>
                </section>
            )}
        </>
    );
}

function FreshnessDashboard() {
    const [filters, setFilters] = useState(INITIAL_FILTERS);
    const [dashboard, setDashboard] = useState({ limit: 0, total: 0, results: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const summary = buildOperationalSummary(dashboard);

    useEffect(() => {
        let active = true;
        const loadDashboard = async () => {
            setLoading(true);
            setError("");
            try {
                const response = await api.get("scraper/freshness", {
                    params: normalizeDashboardFilters(filters),
                });
                if (active) setDashboard(normalizeDashboardResponse(response.data));
            } catch (requestError) {
                if (active) {
                    setError(requestError.response?.data?.message || "Unable to load freshness data.");
                    setDashboard({ limit: 0, total: 0, results: [] });
                }
            } finally {
                if (active) setLoading(false);
            }
        };
        loadDashboard();
        return () => { active = false; };
    }, [filters]);

    function updateFilter(event) {
        const { name, value } = event.target;
        setFilters((current) => ({ ...current, [name]: name === "limit" ? Number(value) : value }));
    }

    return (
        <main className="freshness-page">
            <header className="freshness-page__header">
                <div>
                    <p className="freshness-eyebrow">Operator view · read-only</p>
                    <h1>Freshness surveillance</h1>
                    <p className="freshness-muted">
                        Existing observations only. This view does not probe sources or change scraper state.
                    </p>
                </div>
                <div className="freshness-count">
                    <strong>{dashboard.total}</strong>
                    <span>candidate{dashboard.total === 1 ? "" : "s"}</span>
                </div>
            </header>

            <form className="freshness-filters" onSubmit={(event) => event.preventDefault()}>
                <label>
                    Candidate ID
                    <input name="candidateId" value={filters.candidateId} onChange={updateFilter} placeholder="Optional candidate ID" />
                </label>
                <label>
                    Status
                    <select name="status" value={filters.status} onChange={updateFilter}>
                        <option value="">All statuses</option>
                        <option value="NO_ACTION">NO_ACTION</option>
                        <option value="REVIEW_REQUIRED">REVIEW_REQUIRED</option>
                        <option value="FAILED">FAILED</option>
                    </select>
                </label>
                <label>
                    Limit
                    <input name="limit" type="number" min="1" max="5" value={filters.limit} onChange={updateFilter} />
                </label>
            </form>

            {loading && <p className="freshness-state">Loading freshness observations…</p>}
            {!loading && error && <p className="freshness-state freshness-state--error">{error}</p>}
            {!loading && !error && dashboard.results.length === 0 && (
                <p className="freshness-state">No candidates match the selected filters.</p>
            )}
            {!loading && !error && dashboard.results.length > 0 && (
                <>
                    <OperationalSummary summary={summary} />
                    <div className="freshness-list">
                        {dashboard.results.map((entry, index) => (
                            <FreshnessCard key={entry.candidate.candidateId || `candidate-${index}`} entry={entry} />
                        ))}
                    </div>
                </>
            )}
        </main>
    );
}

export default FreshnessDashboard;
