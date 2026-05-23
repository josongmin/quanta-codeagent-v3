import pkg from "../../package.json" with { type: "json" };
/**
 * Trajectory schema v1 — the schema registry key (RFC-0002 §5.2).
 *
 * Lives in `@/shared` because `@/stream` must import it and slice isolation
 * forbids `@/stream → @/observability` (RFC §6). The append-only JSONL
 * trajectory is the single source of truth; metrics/probe derive from it.
 */
export const TRAJECTORY_SCHEMA = "quanta.trajectory.v1";
/**
 * Redaction policy id stamped onto every event (single scrub source).
 *
 * Kept at `secrets.v1` despite the S1 value/key-set expansion: this id is
 * consumed only SYMBOLICALLY (no version-branch reads it — `trajectory.test`
 * only asserts it is a stable non-empty string; nothing dispatches on its
 * value). Per the prior W2 decision the id is a stable label, not a scrub
 * version number, so widening the regex sets is NOT a breaking schema change
 * and must not churn the id. Bump only if a consumer ever branches on it.
 */
export const REDACTION_POLICY = "secrets.v1";
const TRAJECTORY_KINDS = new Set([
    "session_start",
    "session_end",
    "turn_start",
    "llm_request",
    "llm_usage",
    "assistant_text",
    "tool_call",
    "tool_progress",
    "tool_result",
    "recovery",
    "patch_generated",
    "patch_applied",
    "patch_rejected",
    "sandbox",
    "verify",
    "error",
    "observability_degraded",
]);
// --- Redaction (secrets.v1) ----------------------------------------------
const REDACTED = "***REDACTED***";
/**
 * Object keys whose value is always a secret regardless of content.
 *
 * Two complementary patterns (RFC-0002 §3 원칙6 — "비밀 누출 0, 게이트"):
 *
 *  1. {@link SECRET_KEY_SUFFIX_RE} — separator-anchored *suffixes*
 *     (`*_KEY` / `*_TOKEN` / `*_SECRET` / …). Catches `OPENAI_API_KEY`,
 *     `GITHUB_TOKEN`, etc. Kept verbatim so existing matches never regress.
 *
 *  2. {@link SECRET_KEY_EXACT_RE} — closes the *bare-key* gap: a key that
 *     IS a secret name (e.g. `{ token: "plainish" }`) whose value does not
 *     itself look secret. Whole-key anchored (`^…$`) and separator-tolerant
 *     so `api_key`/`api-key`/`apiKey` all match — but `inputTokens`,
 *     `outputTokens`, `cacheReadTokens`, `tokenCount`, `tokensUsed`,
 *     `tokenizer`, `refreshedAt` do NOT (RFC §5.3 cost re-derivation).
 */
const SECRET_KEY_SUFFIX_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|AUTHORIZATION|SECRET)/i;
/** Separator between words in a compound secret key: `_`, `-`, or none. */
const SEP = "[_-]?";
/** Whole-key (boundary-anchored) names that are always secrets when bare. */
const SECRET_KEY_EXACT_RE = new RegExp(`^(?:${[
    "token",
    "secret",
    "password",
    "passwd",
    `cred${SEP}ential`,
    `cred${SEP}entials`,
    `api${SEP}key`,
    `access${SEP}token`,
    `refresh${SEP}token`,
    `auth${SEP}token`,
    `client${SEP}secret`,
    `private${SEP}key`,
    `secret${SEP}key`,
    "authorization",
    // Bare-key gap closures (S1): exact names that ARE secrets but whose value
    // need not look secret. Still whole-key anchored so `inputTokens` etc. are
    // unaffected. `x-api-key` reduces to `api${SEP}key` only with a leading
    // `x`, so it is listed explicitly; the rest are header/DSN/conn names.
    `x${SEP}api${SEP}key`,
    "cookie",
    `set${SEP}cookie`,
    `database${SEP}url`,
    `connection${SEP}string`,
    `session${SEP}key`,
    `private${SEP}key${SEP}pem`,
    "dsn",
].join("|")})$`, "i");
const isSecretKey = (key) => SECRET_KEY_SUFFIX_RE.test(key) || SECRET_KEY_EXACT_RE.test(key);
/** Substring patterns that mark a string value as secret. */
const SECRET_VALUE_RES = [
    /\bBearer\s+\S+/i,
    // OpenAI legacy `sk-…`, Anthropic `sk-ant-api03-…`, OpenAI project/service
    // `sk-proj-…`/`sk-svcacct-…` — all start `sk-` so the broadened `sk-[\w-]`
    // class (now allowing `-`) subsumes every variant.
    /\bsk-[A-Za-z0-9_-]{8,}/,
    /\bghp_[A-Za-z0-9]{8,}/,
    // Fine-grained GitHub PAT + the OAuth/app/server/user token families.
    /\bgithub_pat_[A-Za-z0-9_]{8,}/,
    /\bgh[opsu]_[A-Za-z0-9]{8,}/,
    // Slack bot/user tokens.
    /\bxox[bpars]-[A-Za-z0-9-]{8,}/,
    // GitLab personal access token.
    /\bglpat-[A-Za-z0-9_-]{8,}/,
    // Google API key.
    /\bAIza[A-Za-z0-9_-]{20,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    // JWT: three base64url segments separated by dots.
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    // URL-embedded credentials: `scheme://user:password@host`.
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
    /(API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET)/i,
];
const isSecretString = (s) => SECRET_VALUE_RES.some((re) => re.test(s));
const redactString = (s) => (isSecretString(s) ? REDACTED : s);
const redactEntry = (key, value) => isSecretKey(key) ? REDACTED : redactValue(value);
/**
 * Deep-walk a value, masking secrets to `"***REDACTED***"`. Single source of
 * truth for redaction (RFC §3.6) — the recorder reuses this verbatim. Masks:
 * raw API keys, Bearer tokens, GitHub/AWS keys, PEM blocks, and any object
 * key flagged by {@link isSecretKey} (suffix OR bare-name). Ordinary fields
 * — including `inputTokens`/`outputTokens`/`cacheReadTokens` — pass through.
 */
export const redactValue = (v) => {
    if (typeof v === "string")
        return redactString(v);
    if (Array.isArray(v))
        return v.map(redactValue);
    if (v !== null && typeof v === "object") {
        const out = {};
        for (const [key, value] of Object.entries(v)) {
            out[key] = redactEntry(key, value);
        }
        return out;
    }
    return v;
};
const PRODUCER = { name: "quanta", version: pkg.version };
const buildOptional = (opts) => ({
    ...(opts.monotonicNs !== undefined ? { monotonicNs: opts.monotonicNs } : {}),
    ...(opts.spanId !== undefined ? { spanId: opts.spanId } : {}),
    ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : {}),
    ...(opts.pricingVersion !== undefined ? { pricingVersion: opts.pricingVersion } : {}),
});
/**
 * Pure factory: stamps schema/v/producer/redaction defaults and returns a
 * fully-formed {@link TrajectoryEvent}. Producer version is read from
 * `package.json`; `gitSha` is intentionally left undefined (no shelling out).
 * `data` is scrubbed via {@link redactValue} unless `opts.skipRedaction`.
 */
export const makeEvent = (seq, kind, ctx, data, opts = {}) => {
    const applied = opts.redactionApplied ?? !opts.skipRedaction;
    const scrubbed = opts.skipRedaction ? data : redactValue(data);
    return {
        schema: TRAJECTORY_SCHEMA,
        v: 1,
        seq,
        ts: opts.ts ?? Date.now(),
        ctx,
        producer: PRODUCER,
        redaction: { policy: REDACTION_POLICY, applied },
        kind,
        data: scrubbed,
        ...buildOptional(opts),
    };
};
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const hasValidRedaction = (x) => isObject(x.redaction) &&
    typeof x.redaction.policy === "string" &&
    typeof x.redaction.applied === "boolean";
const hasValidProducer = (x) => isObject(x.producer) &&
    typeof x.producer.name === "string" &&
    typeof x.producer.version === "string";
/**
 * Structural, strict validator for the probe's forward-compat boundary.
 * Enforces the schema literal, `v === 1`, all required fields, a known
 * `kind`, and well-formed `producer`/`redaction`/`ctx`/`data`.
 */
export const isTrajectoryEvent = (x) => {
    if (!isObject(x))
        return false;
    if (x.schema !== TRAJECTORY_SCHEMA)
        return false;
    if (x.v !== 1)
        return false;
    if (typeof x.seq !== "number")
        return false;
    if (typeof x.ts !== "number")
        return false;
    if (typeof x.ctx?.runId !== "string")
        return false;
    if (typeof x.kind !== "string" || !TRAJECTORY_KINDS.has(x.kind))
        return false;
    if (!isObject(x.data))
        return false;
    if (!hasValidProducer(x))
        return false;
    return hasValidRedaction(x);
};
