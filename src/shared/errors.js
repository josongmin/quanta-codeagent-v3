/**
 * ── Project error-handling convention ──────────────────────────────────────
 *
 * THROW (via the {@link QuantaError} hierarchy below) for exceptional /
 * programmer errors and unrecoverable faults — the agent, LLM and permission
 * slices follow this. RETURN `Result<T, E>` (`src/shared/types`) for EXPECTED
 * domain failures — tool-execution outcomes and input validation — which is
 * why the tool slice is Result-shaped. The split is by design; do not
 * mass-convert one to the other.
 *
 * Classify an external / SDK error EXACTLY ONCE, at the boundary
 * (e.g. {@link LLMError.fromSdkError}), into a discriminated `.kind`.
 * Downstream policy code branches on `.kind` (and `.statusCode`) — it must
 * NEVER re-parse `error.message` to recover meaning the boundary already
 * captured.
 * ───────────────────────────────────────────────────────────────────────────
 */
/** Base error carrying a stable machine-readable code. */
export class QuantaError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = new.target.name;
        this.code = code;
    }
}
/** Tool failed during execution (input was valid, runtime failed). */
export class ToolExecutionError extends QuantaError {
    constructor(message, options) {
        super("tool_execution", message, options);
    }
}
/** Tool input failed schema validation. */
export class ToolInputError extends QuantaError {
    constructor(message) {
        super("tool_input", message);
    }
}
/** Action blocked by the permission policy. */
export class PermissionDeniedError extends QuantaError {
    constructor(message) {
        super("permission_denied", message);
    }
}
/** LLM provider failed (network, auth, rate limit, malformed response).
 *
 *  Always carries a {@link LLMErrorKind}. Adapters MUST construct via
 *  {@link LLMError.fromSdkError} so the SDK-specific status/error-code
 *  extraction happens in ONE place and downstream policy never has to
 *  re-classify. */
export class LLMError extends QuantaError {
    kind;
    statusCode;
    providerCode;
    provider;
    constructor(message, options) {
        super("llm", message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.kind = options?.kind ?? "unknown";
        if (options?.statusCode !== undefined)
            this.statusCode = options.statusCode;
        if (options?.providerCode !== undefined)
            this.providerCode = options.providerCode;
        if (options?.provider !== undefined)
            this.provider = options.provider;
    }
    /** Classify an arbitrary SDK-thrown error into a typed LLMError. This is
     *  the ONLY place that touches SDK-specific shape. Subsequent retry /
     *  fallback policy MUST branch off the returned `kind`/`statusCode`,
     *  NEVER off the `message` string. */
    static fromSdkError(provider, e, prefix) {
        if (e instanceof LLMError)
            return e;
        const message = errMessage(e);
        const statusCode = extractStatus(e);
        const providerCode = extractProviderCode(e);
        const kind = classify(statusCode, e, message);
        const head = prefix ?? `${provider} request failed`;
        return new LLMError(`${head}: ${message}`, {
            cause: e,
            kind,
            ...(statusCode !== undefined ? { statusCode } : {}),
            ...(providerCode !== undefined ? { providerCode } : {}),
            provider,
        });
    }
}
const extractStatus = (e) => {
    if (typeof e !== "object" || e === null)
        return undefined;
    const direct = e.status;
    if (typeof direct === "number")
        return direct;
    // OpenAI/Anthropic SDKs sometimes nest under `.response.status` on http errors.
    const resp = e.response;
    const nested = resp?.status;
    return typeof nested === "number" ? nested : undefined;
};
const extractProviderCode = (e) => {
    if (typeof e !== "object" || e === null)
        return undefined;
    const err = e.error;
    if (err !== undefined && err !== null && typeof err.type === "string")
        return err.type;
    const code = e.code;
    if (typeof code === "string")
        return code;
    const type = e.type;
    if (typeof type === "string")
        return type;
    return undefined;
};
/** Marker substrings used ONLY as a last-resort tag when no `status` field is
 *  present (Node transport errors carry these as `code`/`errno`, not status).
 *  These are intentionally distinct from the prior `FALLBACK_MARKERS`: they
 *  do NOT classify provider-overload (that requires a real 529 / 429), only
 *  transport-layer "did not reach the server" cases. */
const NETWORK_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
]);
const isAbortError = (e) => {
    if (typeof e !== "object" || e === null)
        return false;
    const name = e.name;
    if (name === "AbortError" || name === "TimeoutError")
        return true;
    return false;
};
const classify = (status, e, _msg) => {
    if (isAbortError(e))
        return "aborted";
    if (status === 529)
        return "overloaded";
    if (status === 429)
        return "rate_limit";
    if (status === 401 || status === 403)
        return "auth";
    if (status === 404)
        return "not_found";
    if (status === 400 || status === 422)
        return "bad_request";
    if (status !== undefined && status >= 500 && status < 600)
        return "server_error";
    if (status !== undefined)
        return "unknown";
    // No status — last-resort transport detection via Node's `code` field.
    // This branch DOES NOT match on message text (the bug class we're killing).
    if (typeof e === "object" && e !== null) {
        const errnoCode = e.code;
        if (typeof errnoCode === "string" && NETWORK_CODES.has(errnoCode))
            return "network";
    }
    return "unknown";
};
export const toError = (e) => e instanceof Error ? e : new Error(typeof e === "string" ? e : JSON.stringify(e));
/**
 * Extract a message string from any thrown value with EXACTLY the semantics
 * of the inline `e instanceof Error ? e.message : String(e)` pattern (which
 * was duplicated across 18+ files). Distinct from {@link toError}, which
 * constructs an Error and JSON-stringifies non-Error / non-string bodies
 * (a richer log policy that produces `'{"k":1}'` instead of
 * `"[object Object]"`); kept separate so the legacy call sites stay
 * byte-identical when they switch to this helper.
 *
 * IMPORTANT — do NOT change the body to `errMessage(e)` (e.g. by an over-eager
 * find/replace pass). That re-introduces the infinite recursion that ate the
 * `e instanceof Error ? e.message : String(e)` literal during the 2026-05-23
 * mass migration. The `tests/unit/errors.test.ts` "regression: does NOT
 * recurse on itself" case will hang every consumer if it does.
 */
export const errMessage = (e) => e instanceof Error ? e.message : String(e);
