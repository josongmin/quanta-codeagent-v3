/**
 * ADR-0311 / ADR-0312 / ADR-0313 / ADR-0314 — GitHub integration slice (Tier 0 +
 * Tier 1 scaffold). Shared type SoT consumed by every leaf in this slice.
 *
 * SLICE: `@/integrations/github` — leaf, downstream of `@/reactor` (types) and
 * `@/security` (redaction). MUST NOT import from `@/agent`, `@/tool`,
 * `@/permission`, `@/llm`, `@/apps`, `@/stream`, `@/runner`, `@/skill`.
 *
 * Every IO concern is a port (`GhCliPort`, `FsPort`, `EnvPort`, `ClockPort`,
 * `RedactPort`); concrete adapters are constructed at the composition root.
 * Tests pass canned-JSON fakes — no real subprocess, no real fs.
 */

/**
 * Closed set of GitHub event kinds we recognize on the GitHub Actions trigger
 * path (`workflow_dispatch` is included so manual runs are first-class).
 * Adding a variant is a compile-error in {@link normalizeGhEvent} — the
 * exhaustive switch refuses to compile without a matching branch.
 */
export type GhEventKind =
  | "issue_comment"
  | "pull_request_review_comment"
  | "pull_request_review"
  | "pull_request"
  | "issues"
  | "workflow_dispatch"

/** All event kinds enumerated. Mirrors `ALL_TRIGGER_REASONS` pattern. */
export const ALL_GH_EVENT_KINDS: ReadonlyArray<GhEventKind> = [
  "issue_comment",
  "pull_request_review_comment",
  "pull_request_review",
  "pull_request",
  "issues",
  "workflow_dispatch",
]

/**
 * Sender's relationship to the repo. Closed enum so a future "outside
 * collaborator" or "first-time-contributor" variant must be declared here
 * before the mention filter can authorize it.
 */
export type TrustScope = "collaborator" | "member" | "owner" | "public"

/** Sender type echoed by every GH event payload. Closed; "Bot" senders are
 *  ignored by the trigger adapter (self-loop defense). */
export type SenderType = "User" | "Bot" | "Organization"

export interface NormalizedSender {
  readonly login: string
  readonly type: SenderType
  /** Set when the payload included an `author_association` field
   *  (`COLLABORATOR`/`MEMBER`/`OWNER`/`CONTRIBUTOR`/`NONE`/...). Resolved into
   *  a closed {@link TrustScope} by the mention filter. */
  readonly isCollaborator?: boolean
  /**
   * The payload's `author_association`, verbatim, when present. `isCollaborator`
   * folds OWNER, MEMBER and COLLABORATOR into one boolean, and the mention filter
   * resolved that boolean to `collaborator` before it ever looked for the owner —
   * so `--trust-scope owner` and `member` admitted NOBODY on any real comment,
   * which always carries an association.
   */
  readonly association?: string
}

export interface NormalizedRepo {
  readonly owner: string
  readonly name: string
}

/**
 * Lossless normalization of a GitHub webhook / event-file payload. Original
 * payload is preserved as `raw: unknown` so adapters/tests can inspect
 * payload-specific fields without us pretending to model every variant.
 *
 * `deliveryId` is the dedup primary key — see `idempotency.ts`. Missing on
 * payloads that lack `GITHUB_DELIVERY` (e.g. composite events constructed by
 * us); the adapter falls back to a SHA-1 of the raw payload.
 */
export interface NormalizedGhEvent {
  readonly kind: GhEventKind
  readonly deliveryId: string
  readonly repo: NormalizedRepo
  readonly prNumber?: number
  readonly sender: NormalizedSender
  readonly body?: string
  readonly action?: string
  readonly raw: unknown
}

/**
 * Result of running {@link matchMention} against a comment / review body.
 * `command`/`args` are present iff `matched === true`. `atLine` is the 1-based
 * line index of the first matching phrase (useful for audit anchors).
 */
export interface MentionMatch {
  readonly matched: boolean
  readonly command?: string
  readonly args?: string
  readonly atLine?: number
}

/**
 * PR context bundle — built by `pr-context-loader.ts` via 4 `gh` invocations
 * (view / diff / files / comments). Every field is read-only; the loader
 * returns `undefined` if ANY required call fails (no partial PrContext shape).
 */
export interface PrContext {
  readonly prNumber: number
  readonly title: string
  readonly body: string
  readonly baseSha: string
  readonly headSha: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly changedFiles: readonly string[]
  /** Unified diff. Capped at `diffMaxBytes` (default 1MB); when capped the
   *  string ends with `\n[truncated at <N> bytes]`. */
  readonly diff: string
  readonly recentComments: readonly PrContextComment[]
}

export interface PrContextComment {
  readonly author: string
  readonly body: string
  readonly at: string
}

/** Output verb kind — closed enum so a future "check_run" variant must be
 *  explicitly added (and wired through the sink + redact + idempotency layer). */
export type OutputSinkKind = "comment" | "review" | "review_comment"

/** Verdict for a PR review (when `kind === "review"`). Mirrors GH's API
 *  vocabulary; closed. */
export type ReviewVerdict = "comment" | "approve" | "request_changes"

export interface OutputPostResult {
  readonly ok: boolean
  /** Set when the API returned a comment / review URL we can anchor to. */
  readonly url?: string
  /** Set when `ok === false` — short human-readable reason. */
  readonly error?: string
}

/**
 * Branded idempotency key. Stable per `(deliveryId, action)` tuple; embedded
 * in outgoing comment bodies as `<!-- quanta:idempotency=<key> -->` so a
 * repeat delivery edits the existing comment instead of double-posting.
 */
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" }

/** Cast helper — single SoT for stamping the brand. Not exported as a value
 *  in the barrel; only the slice itself constructs keys. */
export const asIdempotencyKey = (raw: string): IdempotencyKey => raw as IdempotencyKey

/**
 * Minimal fs port — read-only, byte-budgeted. We deliberately do not embed
 * `node:fs` directly so tests pass a Map-backed fake.
 */
export interface FsPort {
  readFile(path: string, opts?: { maxBytes?: number }): Promise<Buffer | undefined>
  stat(path: string): Promise<{ size: number } | undefined>
}

/**
 * Redaction port — wraps `redactSecrets` from `@/security`. Production binds
 * `{ redact: (text) => redactSecrets(text, { origin: "tool_result" }).text }`.
 * Existence is enforced at sink construction time so a misconfigured composition
 * root cannot silently send a raw secret to GitHub.
 */
export interface RedactPort {
  redact(text: string): string
}
