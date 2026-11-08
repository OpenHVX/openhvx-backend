const positiveNumber = (raw: string | undefined, fallback: number) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const AGENT_STALE_MS = positiveNumber(
    process.env.AGENT_STALE_MS,
    5 * 60 * 1000
);

// Election may deliberately use a stricter threshold, but defaults to the
// same shared definition used by status, metrics and task responses.
export const AGENT_ELECTION_FRESHNESS_SEC = positiveNumber(
    process.env.AGENT_FRESHNESS_SEC,
    AGENT_STALE_MS / 1000
);
