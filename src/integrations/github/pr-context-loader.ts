/**
 * ADR-0311 — PR context loader.
 *
 * Pulls 4 `gh` shapes for a given PR and synthesizes a {@link PrContext}:
 *   1. `gh pr view <n> --json title,body,baseRefName,headRefName,baseRefOid,headRefOid`
 *   2. `gh pr diff <n>` (text)
 *   3. `gh api repos/<slug>/pulls/<n>/files` (paths only)
 *   4. `gh api repos/<slug>/issues/<n>/comments?per_page=20`
 *
 * If ANY call fails (exit !== 0, JSON parse fail, throws) the loader returns
 * `undefined` — a partial PrContext is never surfaced. The caller decides
 * whether to retry or skip.
 *
 * Diff is capped at `diffMaxBytes` (default 1MB). When clamped, a trailing
 * sentinel `\n[truncated at <N> bytes]` is appended so the consumer can
 * detect truncation without re-running.
 */

import type { GhCliPort, GhCliResult } from "@/reactor"

import type { PrContext, PrContextComment } from "./types"

const DEFAULT_DIFF_MAX_BYTES = 1024 * 1024
const COMMENT_PAGE_SIZE = 20

const JSON_FIELDS_VIEW = "title,body,baseRefName,headRefName,baseRefOid,headRefOid,number"

export interface LoadPrContextOpts {
  readonly ghCliPort: GhCliPort
  readonly repoCwd: string
  readonly repoSlug: string
  readonly prNumber: number
  readonly diffMaxBytes?: number
  readonly signal?: AbortSignal
}

interface PrViewRow {
  readonly title?: string
  readonly body?: string
  readonly baseRefName?: string
  readonly headRefName?: string
  readonly baseRefOid?: string
  readonly headRefOid?: string
  readonly number?: number
}

interface PrFileRow {
  readonly filename?: string
}

interface PrCommentRow {
  readonly user?: { readonly login?: string }
  readonly body?: string
  readonly updated_at?: string
  readonly created_at?: string
}

export const loadPrContext = async (opts: LoadPrContextOpts): Promise<PrContext | undefined> => {
  const sig = opts.signal
  if (isAborted(sig)) return undefined

  const view = await loadView(opts, sig)
  if (view === undefined) return undefined
  if (isAborted(sig)) return undefined

  const diff = await loadDiff(opts, sig)
  if (diff === undefined) return undefined
  if (isAborted(sig)) return undefined

  const files = await loadFiles(opts, sig)
  if (files === undefined) return undefined
  if (isAborted(sig)) return undefined

  const comments = await loadComments(opts, sig)
  if (comments === undefined) return undefined

  const cap = opts.diffMaxBytes ?? DEFAULT_DIFF_MAX_BYTES
  const diffClamped = clampDiff(diff, cap)

  return Object.freeze({
    prNumber: opts.prNumber,
    title: view.title ?? "",
    body: view.body ?? "",
    baseSha: view.baseRefOid ?? "",
    headSha: view.headRefOid ?? "",
    baseBranch: view.baseRefName ?? "",
    headBranch: view.headRefName ?? "",
    changedFiles: Object.freeze([...files]) as readonly string[],
    diff: diffClamped,
    recentComments: Object.freeze([...comments]) as readonly PrContextComment[],
  })
}

const loadView = async (
  opts: LoadPrContextOpts,
  signal: AbortSignal | undefined,
): Promise<PrViewRow | undefined> => {
  const res = await safeRun(
    opts.ghCliPort,
    ["pr", "view", String(opts.prNumber), "--json", JSON_FIELDS_VIEW],
    opts.repoCwd,
    signal,
  )
  if (res === undefined || res.exitCode !== 0) return undefined
  return safeJsonObject<PrViewRow>(res.stdout)
}

const loadDiff = async (
  opts: LoadPrContextOpts,
  signal: AbortSignal | undefined,
): Promise<string | undefined> => {
  const res = await safeRun(
    opts.ghCliPort,
    ["pr", "diff", String(opts.prNumber)],
    opts.repoCwd,
    signal,
  )
  if (res === undefined || res.exitCode !== 0) return undefined
  return res.stdout
}

const loadFiles = async (
  opts: LoadPrContextOpts,
  signal: AbortSignal | undefined,
): Promise<readonly string[] | undefined> => {
  const path = `repos/${opts.repoSlug}/pulls/${opts.prNumber}/files`
  const res = await safeRun(opts.ghCliPort, ["api", path], opts.repoCwd, signal)
  if (res === undefined || res.exitCode !== 0) return undefined
  const rows = safeJsonArray<PrFileRow>(res.stdout)
  if (rows === undefined) return undefined
  const out: string[] = []
  for (const row of rows) {
    if (typeof row.filename === "string" && row.filename.length > 0) out.push(row.filename)
  }
  return out
}

const loadComments = async (
  opts: LoadPrContextOpts,
  signal: AbortSignal | undefined,
): Promise<readonly PrContextComment[] | undefined> => {
  const path = `repos/${opts.repoSlug}/issues/${opts.prNumber}/comments?per_page=${COMMENT_PAGE_SIZE}`
  const res = await safeRun(opts.ghCliPort, ["api", path], opts.repoCwd, signal)
  if (res === undefined || res.exitCode !== 0) return undefined
  const rows = safeJsonArray<PrCommentRow>(res.stdout)
  if (rows === undefined) return undefined
  const out: PrContextComment[] = []
  for (const row of rows) {
    const author = row.user?.login
    if (typeof author !== "string" || author.length === 0) continue
    const body = typeof row.body === "string" ? row.body : ""
    const at = row.updated_at ?? row.created_at ?? ""
    out.push(Object.freeze({ author, body, at }))
  }
  return out
}

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && signal.aborted === true

const clampDiff = (diff: string, maxBytes: number): string => {
  const buf = Buffer.from(diff, "utf8")
  if (buf.length <= maxBytes) return diff
  const head = buf.subarray(0, maxBytes).toString("utf8")
  return `${head}\n[truncated at ${maxBytes} bytes]`
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
