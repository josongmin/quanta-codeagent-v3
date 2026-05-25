/**
 * ADR-0260 — ripgrep (rg --json) shell-out adapter with grep fallback.
 *
 * Adapter contract:
 *   - Spawns `rg --json --fixed-strings -e <query> <root>` rooted at the
 *     caller-supplied corpus directory.
 *   - `--fixed-strings` makes the query a LITERAL match — regex meta
 *     (`.`, `*`, `+`, `?`, brackets, etc.) need no escaping at the
 *     caller. Phrase / regex / boolean DSL is out of scope for this round.
 *   - Each `--json` event is a single-line JSON object; the adapter
 *     parses the line stream and emits one `LexicalHit` per file with
 *     `score = matchCount`.
 *
 * Degrade order: `rg` → `grep` → `Err({ kind: "no-search-binary" })`.
 * The first `index` call records the chosen binary; if `rg` was missing
 * the result carries `degradeReason: "rg-missing"` so observability can
 * log the fallback once. Subsequent calls reuse the cached choice
 * (no re-probe).
 *
 * The spawner is INJECTED (`RipgrepSpawner`) so tests substitute a
 * deterministic spawner without invoking subprocesses. The bare factory
 * wires a `Bun.spawn`-backed default — same idiom as
 * `shell-snapshot/bun-spawner.ts`.
 */

import { err, ok, type Result } from "@/shared"
import type { LexicalDoc, LexicalIndexResult, LexicalQueryOptions, LexicalSearch } from "./port"
import type { LexicalDegradeReason, LexicalError, LexicalHit } from "./types"

export interface RipgrepSpawnResult {
  readonly code: number
  readonly stdout: string
}

export interface RipgrepSpawnOptions {
  readonly signal?: AbortSignal
}

/** Injected spawner so tests can drive the adapter without subprocesses.
 *  Throws an `ENOENT`-shaped error (with `code === "ENOENT"`) when the
 *  binary is not on PATH — same shape as `Bun.spawn` on a missing
 *  command. */
export interface RipgrepSpawner {
  run(
    binary: "rg" | "grep",
    argv: ReadonlyArray<string>,
    opts: RipgrepSpawnOptions,
  ): Promise<RipgrepSpawnResult>
}

export interface RipgrepLexicalSearchOptions {
  /** Corpus root directory passed to `rg` / `grep` as the search path. */
  readonly root: string
  /** Spawner — REQUIRED so the adapter stays testable. Production
   *  callers wire `createBunRipgrepSpawner()` from the barrel. */
  readonly spawner: RipgrepSpawner
}

interface BinaryChoice {
  readonly binary: "rg" | "grep"
  readonly degradeReason?: LexicalDegradeReason
}

/** Production spawner over `Bun.spawn`. Keeps argv structured (no shell),
 *  mirrors the injected test seam, and lets missing binaries surface as the
 *  native ENOENT throw the adapter already understands. */
export const createBunRipgrepSpawner = (): RipgrepSpawner => ({
  async run(binary, argv, opts) {
    const proc = Bun.spawn([binary, ...argv], {
      stdout: "pipe",
      stderr: "ignore",
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { code, stdout }
  },
})

const isENOENT = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false
  const rec = e as { code?: unknown; message?: unknown }
  if (rec.code === "ENOENT") return true
  if (typeof rec.message === "string" && rec.message.includes("ENOENT")) return true
  return false
}

const detailOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const trimSnippet = (raw: unknown): string => {
  if (typeof raw !== "string") return ""
  return raw.replace(/\s+/g, " ").trim()
}

interface ParsedRgMatch {
  readonly path: string
  readonly snippet: string
  readonly lineNumber?: string
}

const parseRgMatchLine = (line: string): Result<ParsedRgMatch | null, LexicalError> => {
  let evt: unknown
  try {
    evt = JSON.parse(line)
  } catch (e) {
    return err({ kind: "parse-failed", binary: "rg", detail: detailOf(e) })
  }
  if (typeof evt !== "object" || evt === null) return ok(null)
  const rec = evt as { type?: unknown; data?: unknown }
  if (rec.type !== "match") return ok(null)
  const data = rec.data as {
    path?: { text?: unknown }
    lines?: { text?: unknown }
    line_number?: unknown
  } | null
  const pathText = data?.path?.text
  if (typeof pathText !== "string" || pathText.length === 0) return ok(null)
  const lineNumber =
    typeof data?.line_number === "number" && Number.isFinite(data.line_number)
      ? String(data.line_number)
      : undefined
  return ok({
    path: pathText,
    snippet: trimSnippet(data?.lines?.text),
    ...(lineNumber !== undefined ? { lineNumber } : {}),
  })
}

const mergeRgMatch = (
  prev: { count: number; text: string; metadata?: Readonly<Record<string, string>> } | undefined,
  next: ParsedRgMatch,
): { count: number; text: string; metadata?: Readonly<Record<string, string>> } => {
  if (prev !== undefined) {
    return {
      count: prev.count + 1,
      text: prev.text !== "" ? prev.text : next.snippet,
      ...(prev.metadata !== undefined ? { metadata: prev.metadata } : {}),
    }
  }
  return {
    count: 1,
    text: next.snippet,
    metadata:
      next.lineNumber === undefined
        ? { path: next.path }
        : { path: next.path, startLine: next.lineNumber, endLine: next.lineNumber },
  }
}

/** Parse `rg --json` stdout. Each non-empty line is a JSON object; we
 *  accumulate `type:"match"` events per file path and emit one hit per
 *  file with `score = matchCount`. Malformed lines produce a
 *  `parse-failed` error — we do not silently skip them, because that
 *  hides ripgrep / our-parser version mismatches. */
const parseRgJson = (stdout: string): Result<ReadonlyArray<LexicalHit>, LexicalError> => {
  const counts = new Map<
    string,
    { count: number; text: string; metadata?: Readonly<Record<string, string>> }
  >()
  const lines = stdout.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parsed = parseRgMatchLine(trimmed)
    if (!parsed.ok) return parsed
    if (parsed.value === null) continue
    counts.set(parsed.value.path, mergeRgMatch(counts.get(parsed.value.path), parsed.value))
  }
  const hits: LexicalHit[] = []
  for (const [id, hit] of counts) {
    hits.push({
      id,
      score: hit.count,
      text: hit.text,
      ...(hit.metadata !== undefined ? { metadata: hit.metadata } : {}),
    })
  }
  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)))
  return ok(hits)
}

/** Parse `grep -F -r -c` stdout. Format per line is `<path>:<count>`;
 *  `count` is a non-negative integer. A line that doesn't match the
 *  shape is skipped silently — grep emits diagnostic lines on stderr
 *  (which we don't capture), so anything on stdout that does not parse
 *  is treated as "no match for this path". */
const parseGrepCounts = (stdout: string): Result<ReadonlyArray<LexicalHit>, LexicalError> => {
  const hits: LexicalHit[] = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const sep = trimmed.lastIndexOf(":")
    if (sep === -1) continue
    const path = trimmed.slice(0, sep)
    const countStr = trimmed.slice(sep + 1)
    const count = Number.parseInt(countStr, 10)
    if (!Number.isFinite(count) || count <= 0) continue
    hits.push({ id: path, score: count, text: "", metadata: { path } })
  }
  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)))
  return ok(hits)
}

/** Pre-spawn checks for `query`. Returns a `Result` to short-circuit
 *  on aborted-signal / empty query, or `null` to proceed. Lifted out
 *  of the factory so cognitive complexity stays under the project cap. */
const preflightQuery = (
  q: string,
  signal: AbortSignal | undefined,
  choice: BinaryChoice | null,
): Result<ReadonlyArray<LexicalHit>, LexicalError> | null => {
  if (signal?.aborted === true) {
    const aborted: LexicalError = choice
      ? { kind: "aborted", binary: choice.binary }
      : { kind: "aborted" }
    return err(aborted)
  }
  if (q.trim().length === 0) {
    return err({ kind: "invalid-query", raw: q, reason: "empty" })
  }
  return null
}

/** Post-spawn parse + top-k slice. */
const finishQuery = (
  choice: BinaryChoice,
  result: RipgrepSpawnResult,
  k: number,
): Result<ReadonlyArray<LexicalHit>, LexicalError> => {
  // rg / grep both exit 1 when no matches found — NOT an error.
  if (result.code !== 0 && result.code !== 1) {
    return err({ kind: "spawn-failed", binary: choice.binary, detail: `exit ${result.code}` })
  }
  const parsed =
    choice.binary === "rg" ? parseRgJson(result.stdout) : parseGrepCounts(result.stdout)
  if (!parsed.ok) return parsed
  return ok(parsed.value.slice(0, k))
}

/** Closed-arm outcome of a single spawn attempt. Lifted out of the
 *  factory so cognitive complexity stays under the project cap. */
type TryOutcome =
  | { readonly tag: "ok"; readonly result: RipgrepSpawnResult }
  | { readonly tag: "missing" }
  | { readonly tag: "fail"; readonly error: LexicalError }

const tryBinary = async (
  spawner: RipgrepSpawner,
  binary: "rg" | "grep",
  argv: ReadonlyArray<string>,
  spawnOpts: RipgrepSpawnOptions,
  signal: AbortSignal | undefined,
): Promise<TryOutcome> => {
  try {
    const result = await spawner.run(binary, argv, spawnOpts)
    return { tag: "ok", result }
  } catch (e) {
    if (isENOENT(e)) return { tag: "missing" }
    if (signal?.aborted === true) {
      return { tag: "fail", error: { kind: "aborted", binary } }
    }
    return { tag: "fail", error: { kind: "spawn-failed", binary, detail: detailOf(e) } }
  }
}

/** Use the cached binary choice — returns degraded-to-no-binary on
 *  mid-call disappearance, propagates spawn failures, otherwise emits
 *  the (choice, result) pair the caller parses. */
const runWithCached = async (
  spawner: RipgrepSpawner,
  cached: BinaryChoice,
  rgArgv: ReadonlyArray<string>,
  grepArgv: ReadonlyArray<string>,
  spawnOpts: RipgrepSpawnOptions,
  signal: AbortSignal | undefined,
): Promise<Result<{ choice: BinaryChoice; result: RipgrepSpawnResult }, LexicalError>> => {
  const argv = cached.binary === "rg" ? rgArgv : grepArgv
  const r = await tryBinary(spawner, cached.binary, argv, spawnOpts, signal)
  if (r.tag === "ok") return ok({ choice: cached, result: r.result })
  if (r.tag === "fail") return err(r.error)
  return err({ kind: "no-search-binary", detail: `${cached.binary} vanished mid-call` })
}

export const createRipgrepLexicalSearch = (opts: RipgrepLexicalSearchOptions): LexicalSearch => {
  const { root, spawner } = opts
  let docCount = 0
  let choice: BinaryChoice | null = null

  /** Resolve which binary to use, with degrade. Idempotent + cached.
   *  Runs the actual user argv on whichever binary survives — single
   *  spawn (no separate probe). Returns the choice + stdout for the
   *  caller to parse. */
  const runWithDegrade = async (
    rgArgv: ReadonlyArray<string>,
    grepArgv: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
  ): Promise<Result<{ choice: BinaryChoice; result: RipgrepSpawnResult }, LexicalError>> => {
    const spawnOpts: RipgrepSpawnOptions = signal ? { signal } : {}
    if (choice !== null) {
      return runWithCached(spawner, choice, rgArgv, grepArgv, spawnOpts, signal)
    }
    // First call — probe rg, then grep.
    const rg = await tryBinary(spawner, "rg", rgArgv, spawnOpts, signal)
    if (rg.tag === "ok") {
      choice = { binary: "rg" }
      return ok({ choice, result: rg.result })
    }
    if (rg.tag === "fail") return err(rg.error)
    const grep = await tryBinary(spawner, "grep", grepArgv, spawnOpts, signal)
    if (grep.tag === "ok") {
      choice = { binary: "grep", degradeReason: "rg-missing" }
      return ok({ choice, result: grep.result })
    }
    if (grep.tag === "fail") return err(grep.error)
    return err({ kind: "no-search-binary", detail: "rg + grep both missing on PATH" })
  }

  return {
    async index(
      docs: ReadonlyArray<LexicalDoc>,
    ): Promise<Result<LexicalIndexResult, LexicalError>> {
      docCount = docs.length
      // We do NOT spawn at index time when we already know the choice —
      // the corpus root is what `query` searches and there is nothing
      // to install. But we surface `degradeReason` on the FIRST index
      // call once we DO discover the choice via a query. Until then
      // `degradeReason` is omitted; observability simply sees it the
      // first query.
      if (choice === null) {
        // Probe-only call so the caller sees `degradeReason` on
        // `index` (per ADR-0260). We use a harmless argv.
        const probe = await runWithDegrade(["--version"], ["--version"], undefined)
        if (!probe.ok) return probe
        const c = probe.value.choice
        const result: LexicalIndexResult = c.degradeReason
          ? { docs: docCount, tokens: 0, degradeReason: c.degradeReason }
          : { docs: docCount, tokens: 0 }
        return ok(result)
      }
      const result: LexicalIndexResult = choice.degradeReason
        ? { docs: docCount, tokens: 0, degradeReason: choice.degradeReason }
        : { docs: docCount, tokens: 0 }
      return ok(result)
    },

    async query(
      q: string,
      k: number,
      queryOpts?: LexicalQueryOptions,
    ): Promise<Result<ReadonlyArray<LexicalHit>, LexicalError>> {
      const signal = queryOpts?.signal
      const preflight = preflightQuery(q, signal, choice)
      if (preflight !== null) return preflight
      if (k <= 0) return ok([])
      const trimmed = q.trim()
      const run = await runWithDegrade(
        ["--json", "--fixed-strings", "-e", trimmed, root],
        ["-F", "-r", "-c", "-e", trimmed, root],
        signal,
      )
      if (!run.ok) return run
      return finishQuery(run.value.choice, run.value.result, k)
    },

    clear(): void {
      docCount = 0
      // We DO NOT clear `choice`: the binary on PATH does not change
      // between calls, and re-probing on every clear() is wasteful.
    },

    size(): number {
      return docCount
    },
  }
}
