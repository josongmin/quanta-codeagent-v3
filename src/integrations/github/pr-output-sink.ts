/**
 * ADR-0313 — PR output sink with redaction + idempotency.
 *
 * Three verbs (`postComment` / `postReview` / `postReviewComment`). Every
 * outgoing body passes through {@link RedactPort.redact} BEFORE the gh API
 * call — this is the single safety invariant; the sink refuses to construct
 * when `redactPort` is missing (host misconfiguration is a boot-time error,
 * never a runtime surprise).
 *
 * Idempotency: each body is suffixed with an HTML comment
 * `<!-- quanta:idempotency=<key> -->`. When the API echoes back an existing
 * comment containing the SAME key, the sink PATCHes it instead of POSTing a
 * new one. Body bytes are capped at 65,000 (GH API limit; the marker is
 * counted within the cap so it always survives).
 *
 * **Concurrent-race resolution (post-then-reconcile)** — GitHub API has no
 * conditional-write primitive (no If-None-Match on comments), so two
 * processes that find `existing === undefined` at the same time can each
 * POST. After a POST we re-list comments with our marker; if multiple match,
 * EVERY observer applies the same deterministic rule — **smallest GH id
 * wins** — and the losers self-delete. Both processes converge to a single
 * surviving comment.
 *
 * Every method is no-throw — failures collapse to `{ ok: false, error }` so
 * a hostile network never tears down the calling adapter.
 */

import type { GhCliPort, GhCliResult } from "@/reactor"

import type { IdempotencyKey, OutputPostResult, RedactPort, ReviewVerdict } from "./types"

const COMMENT_BODY_MAX_BYTES = 65_000
const IDEMPOTENCY_MARKER_PREFIX = "<!-- quanta:idempotency="
const IDEMPOTENCY_MARKER_SUFFIX = " -->"

export interface PrOutputSink {
  postComment(input: { body: string; key: IdempotencyKey }): Promise<OutputPostResult>
  postReview(input: {
    verdict: ReviewVerdict
    body: string
    key: IdempotencyKey
  }): Promise<OutputPostResult>
  postReviewComment(input: {
    file: string
    line: number
    body: string
    key: IdempotencyKey
  }): Promise<OutputPostResult>
}

export interface PrOutputSinkOpts {
  readonly ghCliPort: GhCliPort
  readonly repoCwd: string
  readonly repoSlug: string
  readonly prNumber: number
  readonly redactPort: RedactPort
  /** Override the comment-marker prefix. Default is documented SoT
   *  `<!-- quanta:idempotency=`. Test-only knob. */
  readonly idempotencyMarkerPrefix?: string
  /** Override comment body cap (in BYTES, not characters). Default 65,000. */
  readonly bodyMaxBytes?: number
  /** When false, the sink only stamps the marker but does not query existing
   *  comments. Default true. */
  readonly hiddenMarkerEnabled?: boolean
  /** When false, the sink does NOT run the post-then-reconcile sweep that
   *  resolves concurrent-POST races. Default true. Tests opt out to
   *  isolate sequential-only behavior. */
  readonly reconcileConcurrentPosts?: boolean
  readonly signal?: AbortSignal
}

interface ExistingComment {
  readonly id: number
  readonly body: string
}

interface MarkerMatchedComment {
  readonly id: number
  readonly htmlUrl: string | undefined
}

export const createPrOutputSink = (opts: PrOutputSinkOpts): PrOutputSink => {
  // Boot-time invariant — a missing redact port is a host misconfiguration.
  // We throw HERE so a failed wire never produces a sink that leaks secrets.
  if (opts.redactPort === undefined || opts.redactPort === null) {
    throw new Error("createPrOutputSink: redactPort is mandatory (boot-time)")
  }
  if (typeof opts.redactPort.redact !== "function") {
    throw new Error("createPrOutputSink: redactPort.redact must be a function")
  }
  const cap = Math.max(256, opts.bodyMaxBytes ?? COMMENT_BODY_MAX_BYTES)
  const prefix = opts.idempotencyMarkerPrefix ?? IDEMPOTENCY_MARKER_PREFIX
  const hiddenMarkerEnabled = opts.hiddenMarkerEnabled ?? true
  const reconcileEnabled = opts.reconcileConcurrentPosts ?? true

  const prepareBody = (body: string, key: IdempotencyKey): string => {
    const redacted = opts.redactPort.redact(body)
    const marker = `${prefix}${key}${IDEMPOTENCY_MARKER_SUFFIX}`
    return clampWithMarker(redacted, marker, cap)
  }

  return {
    async postComment({ body, key }): Promise<OutputPostResult> {
      const prepared = prepareBody(body, key)
      if (hiddenMarkerEnabled) {
        const existing = await findExistingComment(opts, key, prefix, opts.signal)
        if (existing !== undefined) {
          return await patchComment(opts, existing.id, prepared, opts.signal)
        }
      }
      const posted = await postNewComment(opts, prepared, opts.signal)
      if (!posted.ok || !reconcileEnabled || !hiddenMarkerEnabled) return posted
      return await reconcileAfterPost(opts, key, prefix, posted, opts.signal)
    },
    async postReview({ verdict, body, key }): Promise<OutputPostResult> {
      const prepared = prepareBody(body, key)
      return await postReview(opts, verdict, prepared, opts.signal)
    },
    async postReviewComment({ file, line, body, key }): Promise<OutputPostResult> {
      const prepared = prepareBody(body, key)
      return await postReviewComment(opts, file, line, prepared, opts.signal)
    },
  }
}

/**
 * Clamp `body+marker` to `maxBytes`. The marker is appended UNCONDITIONALLY
 * (it's the dedup primary key) — the body is what gets trimmed.
 */
const clampWithMarker = (body: string, marker: string, maxBytes: number): string => {
  const markerBuf = Buffer.from(`\n${marker}`, "utf8")
  if (markerBuf.length >= maxBytes) return marker // pathological — just the marker
  const bodyBudget = maxBytes - markerBuf.length
  const bodyBuf = Buffer.from(body, "utf8")
  if (bodyBuf.length <= bodyBudget) return `${body}\n${marker}`
  // Trim respecting utf-8 — Buffer.subarray + .toString may produce a broken
  // surrogate on the boundary. We accept that and append an ellipsis. Reserve
  // the 3 bytes "…" occupies in UTF-8 so the final string stays within cap.
  const ELLIPSIS_BYTES = 3
  const trimBudget = Math.max(0, bodyBudget - ELLIPSIS_BYTES)
  const trimmed = bodyBuf.subarray(0, trimBudget).toString("utf8")
  return `${trimmed}…\n${marker}`
}

const findExistingComment = async (
  opts: PrOutputSinkOpts,
  key: IdempotencyKey,
  prefix: string,
  signal: AbortSignal | undefined,
): Promise<ExistingComment | undefined> => {
  const path = `repos/${opts.repoSlug}/issues/${opts.prNumber}/comments?per_page=100`
  const res = await safeRun(opts.ghCliPort, ["api", path], opts.repoCwd, signal)
  if (res === undefined || res.exitCode !== 0) return undefined
  const rows = safeJsonArray<{ id?: number; body?: string }>(res.stdout)
  if (rows === undefined) return undefined
  const needle = `${prefix}${key}${IDEMPOTENCY_MARKER_SUFFIX}`
  for (const row of rows) {
    if (typeof row.id !== "number" || row.id <= 0) continue
    if (typeof row.body !== "string") continue
    if (row.body.includes(needle)) return { id: row.id, body: row.body }
  }
  return undefined
}

const patchComment = async (
  opts: PrOutputSinkOpts,
  commentId: number,
  body: string,
  signal: AbortSignal | undefined,
): Promise<OutputPostResult> => {
  const path = `repos/${opts.repoSlug}/issues/comments/${commentId}`
  const res = await safeRun(
    opts.ghCliPort,
    ["api", "--method", "PATCH", path, "-f", `body=${body}`],
    opts.repoCwd,
    signal,
  )
  return parseResult(res)
}

const postNewComment = async (
  opts: PrOutputSinkOpts,
  body: string,
  signal: AbortSignal | undefined,
): Promise<OutputPostResult> => {
  const path = `repos/${opts.repoSlug}/issues/${opts.prNumber}/comments`
  const res = await safeRun(
    opts.ghCliPort,
    ["api", "--method", "POST", path, "-f", `body=${body}`],
    opts.repoCwd,
    signal,
  )
  return parseResult(res)
}

const postReview = async (
  opts: PrOutputSinkOpts,
  verdict: ReviewVerdict,
  body: string,
  signal: AbortSignal | undefined,
): Promise<OutputPostResult> => {
  const event =
    verdict === "approve"
      ? "APPROVE"
      : verdict === "request_changes"
        ? "REQUEST_CHANGES"
        : "COMMENT"
  const path = `repos/${opts.repoSlug}/pulls/${opts.prNumber}/reviews`
  const res = await safeRun(
    opts.ghCliPort,
    ["api", "--method", "POST", path, "-f", `event=${event}`, "-f", `body=${body}`],
    opts.repoCwd,
    signal,
  )
  return parseResult(res)
}

const postReviewComment = async (
  opts: PrOutputSinkOpts,
  file: string,
  line: number,
  body: string,
  signal: AbortSignal | undefined,
): Promise<OutputPostResult> => {
  const path = `repos/${opts.repoSlug}/pulls/${opts.prNumber}/comments`
  const lineArg = `line=${line}`
  const res = await safeRun(
    opts.ghCliPort,
    [
      "api",
      "--method",
      "POST",
      path,
      "-f",
      `body=${body}`,
      "-f",
      `path=${file}`,
      "-f",
      lineArg,
      "-f",
      "side=RIGHT",
    ],
    opts.repoCwd,
    signal,
  )
  return parseResult(res)
}

/**
 * Post-then-reconcile race resolver.
 *
 * Called immediately after a successful POST. Re-lists comments matching our
 * marker; if multiple match (a concurrent POST raced ours), EVERY observer
 * applies the same deterministic rule — `smallest GH comment.id wins` —
 * and the losers self-delete. Both processes converge to one survivor.
 *
 * Best-effort throughout: list failure / parse failure / delete 404 collapse
 * to the original POST result (so a hostile network can't tear down a
 * legitimately-posted comment).
 */
const reconcileAfterPost = async (
  opts: PrOutputSinkOpts,
  key: IdempotencyKey,
  prefix: string,
  posted: OutputPostResult,
  signal: AbortSignal | undefined,
): Promise<OutputPostResult> => {
  const myId = parseCommentIdFromUrl(posted.url)
  if (myId === undefined) return posted // can't reason about race; trust POST result
  const matches = await findAllCommentsWithMarker(opts, key, prefix, signal)
  if (matches.length <= 1) return posted // no race — we're alone
  const sorted = [...matches].sort((a, b) => a.id - b.id)
  const winner = sorted[0]
  if (winner === undefined) return posted
  if (winner.id === myId) {
    // I'm the winner. Best-effort delete the losers.
    for (let i = 1; i < sorted.length; i++) {
      const loser = sorted[i]
      if (loser !== undefined) await safeDeleteComment(opts, loser.id, signal)
    }
    // Return the CANONICAL URL from the listing so EVERY observer (winner +
    // losers alike) sees the same `url` string for the surviving comment.
    // If the listing didn't carry an html_url, fall back to the POST result.
    return Object.freeze({
      ok: true,
      ...(typeof winner.htmlUrl === "string" && winner.htmlUrl.length > 0
        ? { url: winner.htmlUrl }
        : typeof posted.url === "string"
          ? { url: posted.url }
          : {}),
    })
  }
  // Someone else won. Best-effort delete mine; return winner's URL so the
  // caller sees a single stable anchor for the surviving comment.
  await safeDeleteComment(opts, myId, signal)
  return Object.freeze({
    ok: true,
    ...(typeof winner.htmlUrl === "string" && winner.htmlUrl.length > 0
      ? { url: winner.htmlUrl }
      : {}),
  })
}

/** Parse `https://github.com/o/r/pull/N#issuecomment-XXXX` → XXXX. */
const COMMENT_ID_REGEX = /issuecomment-(\d+)/
const parseCommentIdFromUrl = (url: string | undefined): number | undefined => {
  if (typeof url !== "string") return undefined
  const m = COMMENT_ID_REGEX.exec(url)
  if (m === null || m[1] === undefined) return undefined
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** List ALL comments containing our marker (used by reconcile + future audit
 *  hooks). Errors → empty array (no-throw). */
const findAllCommentsWithMarker = async (
  opts: PrOutputSinkOpts,
  key: IdempotencyKey,
  prefix: string,
  signal: AbortSignal | undefined,
): Promise<readonly MarkerMatchedComment[]> => {
  const path = `repos/${opts.repoSlug}/issues/${opts.prNumber}/comments?per_page=100`
  const res = await safeRun(opts.ghCliPort, ["api", path], opts.repoCwd, signal)
  if (res === undefined || res.exitCode !== 0) return []
  const rows = safeJsonArray<{ id?: number; body?: string; html_url?: string }>(res.stdout)
  if (rows === undefined) return []
  const needle = `${prefix}${key}${IDEMPOTENCY_MARKER_SUFFIX}`
  const out: MarkerMatchedComment[] = []
  for (const row of rows) {
    if (typeof row.id !== "number" || row.id <= 0) continue
    if (typeof row.body !== "string") continue
    if (!row.body.includes(needle)) continue
    out.push(
      Object.freeze({
        id: row.id,
        htmlUrl: typeof row.html_url === "string" ? row.html_url : undefined,
      }),
    )
  }
  return out
}

/** Best-effort DELETE; 404 / 410 / network errors are silently absorbed
 *  because the goal is convergence, not strict success. */
const safeDeleteComment = async (
  opts: PrOutputSinkOpts,
  commentId: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const path = `repos/${opts.repoSlug}/issues/comments/${commentId}`
  await safeRun(opts.ghCliPort, ["api", "--method", "DELETE", path], opts.repoCwd, signal)
}

const parseResult = (res: GhCliResult | undefined): OutputPostResult => {
  if (res === undefined) return Object.freeze({ ok: false, error: "gh-spawn-failed" })
  if (res.exitCode !== 0) {
    return Object.freeze({
      ok: false,
      error: `gh-exit-${res.exitCode}: ${truncateErr(res.stderr)}`,
    })
  }
  const parsed = safeJsonObject<{ html_url?: string; url?: string }>(res.stdout)
  const url = parsed?.html_url ?? parsed?.url
  if (typeof url === "string" && url.length > 0) {
    return Object.freeze({ ok: true, url })
  }
  return Object.freeze({ ok: true })
}

const truncateErr = (stderr: string): string => {
  const oneLine = stderr.replace(/\s+/g, " ").trim()
  return oneLine.length > 240 ? `${oneLine.slice(0, 239)}…` : oneLine
}

const safeRun = async (
  port: GhCliPort,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<GhCliResult | undefined> => {
  try {
    return await port.run(args, cwd, signal)
  } catch {
    return undefined
  }
}

const safeJsonObject = <T>(raw: string): T | undefined => {
  try {
    const v = JSON.parse(raw) as unknown
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined
    return v as T
  } catch {
    return undefined
  }
}

const safeJsonArray = <T>(raw: string): readonly T[] | undefined => {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as readonly T[]) : undefined
  } catch {
    return undefined
  }
}
