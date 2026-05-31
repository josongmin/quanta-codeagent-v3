/**
 * Persistent trust-scope grant store (L3→L4 promotion of trust-scope-wire-up).
 *
 * SOTA reference (Claude Desktop `claude-desktop/main.js:103939-104225, 89827`):
 * encrypted-at-rest persistent allowlist cache with a 2h TTL and scope cascade
 * (API → cache → TTL-check). We adopt the file-backed shape (encrypted at rest
 * via OS keyring is a follow-up — the file lives under `~/.quanta` by default
 * and the path is overridable for tests / per-host installs) and the cascade
 * (exact → command-pattern → project → global, most-specific wins).
 *
 * Slice discipline (RFC §1.2 + biome boundaries):
 *   - Module lives under `@/permission`. Imports only `node:` stdlib + the
 *     in-memory `TrustScopeRegistry` interface from `./trust-scope`.
 *   - `admissibility-gate.ts` continues to type-import the registry interface
 *     only; the persistent impl is wired by the caller (apps/agent or CLI).
 *
 * Persistent-grant record shape:
 *   - `tool`         — the tool name (required).
 *   - `scope`        — the original {@link TrustScope}; `deny` records are
 *                       persisted but treated as ask-skip-negative (the gate
 *                       must NOT route around an explicit deny).
 *   - `actionKey`    — optional finer key (e.g. `bash|git status`); when set
 *                       the grant only matches an action whose key is equal.
 *   - `commandPattern` — optional leading-token sequence (e.g. `"npm,install"`,
 *                       cursor-style ClassifiedCommand `suggested_allowlist_entry`)
 *                       that matches a SHELL-equivalent action by the leading
 *                       tokens of its actionKey when no exact actionKey grant
 *                       hits. Lowercased + trimmed at store time.
 *   - `grantedAt`    — ms-since-epoch the grant landed (used for TTL).
 *   - `ttlMs`        — optional per-grant time-to-live in ms; absent ⇒ never
 *                       expires. The SOTA reference uses 2h for `project`-scoped
 *                       grants; the policy is caller-driven (we do not bake the
 *                       2h literal here so a project / CLI can pick its own).
 *
 * Project overlay:
 *   - A second `.quanta/project-grants.json` file under the project root, if
 *     it exists, overlays the user-global file. Records in the overlay are
 *     scoped to `projectKey` (the project root path) — the overlay is
 *     consulted FIRST so a project can tighten or expand the user's grants
 *     without touching the global file.
 *
 * Cascade (most-specific wins):
 *   1. exact actionKey match (project overlay first, then global)
 *   2. command-pattern leading-token match (project overlay first, then global)
 *   3. tool-only match scoped to the project key
 *   4. tool-only match in the global "*" project bucket
 *
 * Any positive scope at any layer (except `deny`) returns `hasGrant=true`.
 * A `deny` record encountered at ANY layer for the same (tool, actionKey)
 * SHORT-CIRCUITS to false BEFORE consulting weaker layers — explicit deny
 * always wins inside a layer, and within the cascade it short-circuits its
 * own layer onwards (so a deeper overlay cannot accidentally undo it).
 *
 * Atomicity & concurrency:
 *   - `grant()` / `revoke()` schedule a debounced atomic file write via the
 *     same `JsonStateFile` engine the rest of `@/permission` already uses
 *     (per-instance `.tmp.<pid>.<rand>` + `rename`).
 *   - Concurrent `grant()` writes never tear the JSON; a peer-written record
 *     is folded in via the engine's `mergeWithDisk` hook (last-write-MERGE,
 *     not -WINS).
 *
 * Failure model (preserved from the JSON-state-file engine):
 *   - Missing file ⇒ start empty.
 *   - Corrupt JSON ⇒ start empty + quarantine to `.corrupt`; no throw.
 *   - Schema-version mismatch ⇒ start empty + quarantine sidecar.
 *
 * Hydration:
 *   - `hydrate()` reads BOTH the global file and the project-overlay file (if
 *     `projectRoot` was supplied at construction time). Idempotent — second
 *     call is a no-op once the first resolves.
 *
 * TTL:
 *   - Stale grants (`now > grantedAt + ttlMs`) are filtered out at read time;
 *     they are NOT eagerly removed (the cleanup is best-effort on the next
 *     write). Each read uses the injected `now()` clock (default `Date.now`)
 *     so tests can drive deterministic TTL expiry.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import {
  createJsonStateFile,
  type JsonStateFile,
  type ParseOutcome,
  type PersistOutcome,
} from "./json-state-file"
import type {
  TrustScope,
  TrustScopeAction,
  TrustScopeGrant,
  TrustScopeRegistry,
} from "./trust-scope"

/** Per-grant persisted record. Distinct from {@link TrustScopeGrant} because
 *  it adds wall-clock anchors + the optional command-pattern surface. */
export interface PersistentTrustScopeRecord {
  readonly tool: string
  readonly scope: TrustScope
  readonly actionKey?: string
  readonly commandPattern?: string
  readonly grantedAt: number
  readonly ttlMs?: number
}

/** On-disk shape — versioned envelope keyed by projectKey. The `"*"` bucket
 *  holds GLOBAL (cross-project) grants; specific project keys hold
 *  project-scoped grants. */
interface PersistentTrustScopeFile {
  readonly version: 1
  readonly grants: Readonly<Record<string, ReadonlyArray<PersistentTrustScopeRecord>>>
}

const STATE_VERSION = 1
const GLOBAL_PROJECT_KEY = "*"

/** Default state file path: `~/.quanta/grants.json`. The SOTA reference uses
 *  the OS keyring; we ship a file first (encrypted-at-rest follow-up tracked
 *  in the feature catalog under future work). */
export const defaultTrustScopeStatePath = (): string => join(homedir(), ".quanta", "grants.json")

/** Default project-overlay path inside a project root. */
export const defaultProjectOverlayPath = (projectRoot: string): string =>
  join(projectRoot, ".quanta", "project-grants.json")

/** Construction options. All fields optional — the defaults match production
 *  (user `~/.quanta/grants.json` + no project overlay). */
export interface PersistentTrustScopeOptions {
  /** Override the user-global state file path. */
  filePath?: string
  /** Project root — when supplied, the registry ALSO loads/persists a
   *  project-overlay file at `defaultProjectOverlayPath(projectRoot)` (or
   *  `projectOverlayPath` when set). */
  projectRoot?: string
  /** Explicit override for the project-overlay file path. */
  projectOverlayPath?: string
  /** Injected clock for deterministic TTL tests. Default `Date.now`. */
  now?: () => number
  /** Debounce window in ms for the file flush. Default `50` — same as the
   *  `permission-store` (kept tight so a grant survives a fast-crash). */
  debounceMs?: number
}

/** Public surface beyond the in-memory `TrustScopeRegistry` — adds explicit
 *  hydration (load from disk) + revoke + snapshot for tests / CLI inspection. */
export interface PersistentTrustScopeRegistry extends TrustScopeRegistry {
  /** Read both files (global + overlay) into memory. Idempotent. MUST be
   *  awaited at session start so the gate sees the persisted grants. */
  hydrate(): Promise<void>
  /** Force-flush any pending debounced writes. Used by tests and clean
   *  process-exit paths so a grant landed during the last tick survives. */
  flush(): Promise<void>
  /** Like {@link flush} but resolves with a typed {@link PersistOutcome} so a
   *  security-sensitive caller (a CLI granting/revoking, a denial that MUST
   *  survive a restart) can DISTINGUISH "the grant is live in memory" from
   *  "the grant is durably on disk" (audit L8 M6). `durable:false` carries an
   *  opaque reason and means BOTH files OR either file failed to persist; the
   *  in-memory registry is still authoritative. */
  flushDurable(): Promise<PersistOutcome>
  /** Remove a grant. Mirrors {@link grant}'s shape. Best-effort — a record
   *  that does not exist is a no-op. */
  revoke(projectKey: string, grant: TrustScopeGrant): void
  /** Test-seam / CLI inspection. Returns a defensive snapshot of the live
   *  in-memory grants by projectKey. */
  snapshot(): Readonly<Record<string, ReadonlyArray<PersistentTrustScopeRecord>>>
}

/** Positive scopes that route through hasGrant=true. `deny` is explicit and
 *  short-circuits to false (the wire-up only treats positive scopes as
 *  ask-skip). Identical to the in-memory impl. */
const POSITIVE_SCOPES: ReadonlySet<TrustScope> = new Set<TrustScope>([
  "always_allow",
  "project",
  "workspace",
  "session",
  "once_only",
])

/** Lowercase + trim a candidate command-pattern. Empty / non-string ⇒ null.
 *  Tokens are separated by commas; whitespace is squeezed. */
const normalizePattern = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0) return null
  return trimmed
}

/** Split a pattern OR an actionKey into ordered command tokens. Splits on the
 *  first `|` (the actionKey `tool|cmd` shape) — we only match against the
 *  command portion — then on whitespace + commas. */
const tokenize = (text: string): readonly string[] => {
  const idx = text.indexOf("|")
  const command = idx >= 0 ? text.slice(idx + 1) : text
  return command
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length > 0)
}

/** Does `record.commandPattern`'s leading-token sequence prefix-match the
 *  action's `actionKey` tokens? Pure. Empty pattern OR no actionKey ⇒ false. */
const patternMatchesAction = (pattern: string, action: TrustScopeAction): boolean => {
  if (action.actionKey === undefined) return false
  const patternTokens = tokenize(pattern)
  if (patternTokens.length === 0) return false
  const actionTokens = tokenize(action.actionKey)
  if (actionTokens.length < patternTokens.length) return false
  for (let i = 0; i < patternTokens.length; i += 1) {
    if (actionTokens[i] !== patternTokens[i]) return false
  }
  return true
}

/** A record is stale when `grantedAt + ttlMs <= now`. No ttlMs ⇒ never stale. */
const isStale = (record: PersistentTrustScopeRecord, now: number): boolean => {
  if (record.ttlMs === undefined) return false
  return now >= record.grantedAt + record.ttlMs
}

/** True when `record` matches the lookup `action` (tool name + optional
 *  actionKey AND not-stale). Pattern matching is checked separately by the
 *  cascade. */
const recordMatches = (
  record: PersistentTrustScopeRecord,
  action: TrustScopeAction,
  now: number,
): boolean => {
  if (record.tool !== action.tool) return false
  if (record.actionKey !== undefined && record.actionKey !== action.actionKey) return false
  if (isStale(record, now)) return false
  return true
}

/** Lift a `raw` parsed item into a clean record, or null if a required field
 *  is missing / malformed. Pure; extracted so `parseFile` stays under the
 *  complexity cap. */
const liftRecord = (item: unknown): PersistentTrustScopeRecord | null => {
  if (item === null || typeof item !== "object") return null
  const r = item as Record<string, unknown>
  if (typeof r.tool !== "string" || r.tool.length === 0) return null
  if (typeof r.scope !== "string") return null
  if (typeof r.grantedAt !== "number" || !Number.isFinite(r.grantedAt)) return null
  const record: PersistentTrustScopeRecord = {
    tool: r.tool,
    scope: r.scope as TrustScope,
    grantedAt: r.grantedAt,
    ...(typeof r.actionKey === "string" ? { actionKey: r.actionKey } : {}),
    ...(typeof r.ttlMs === "number" && Number.isFinite(r.ttlMs) ? { ttlMs: r.ttlMs } : {}),
  }
  if (typeof r.commandPattern === "string") {
    const p = normalizePattern(r.commandPattern)
    if (p !== null) return { ...record, commandPattern: p }
  }
  return record
}

/** Lift a single bucket into clean records, skipping malformed entries. */
const liftBucket = (list: unknown): PersistentTrustScopeRecord[] => {
  if (!Array.isArray(list)) return []
  const out: PersistentTrustScopeRecord[] = []
  for (const item of list) {
    const rec = liftRecord(item)
    if (rec !== null) out.push(rec)
  }
  return out
}

/** Validate a parsed file payload — versioned + structurally well-formed.
 *  Records with missing required fields are dropped (NOT errored) so a
 *  partial corruption does not wipe everything. */
const parseFile = (raw: unknown): ParseOutcome<PersistentTrustScopeFile> => {
  if (raw === null || typeof raw !== "object") {
    return { kind: "shape-invalid", reason: "expected object" }
  }
  const obj = raw as { version?: unknown; grants?: unknown }
  if (obj.version === undefined) {
    return { kind: "shape-invalid", reason: "missing 'version' key" }
  }
  if (obj.version !== STATE_VERSION) {
    return {
      kind: "version-mismatch",
      foundVersion: typeof obj.version === "number" ? obj.version : String(obj.version),
    }
  }
  if (obj.grants === null || typeof obj.grants !== "object") {
    return { kind: "shape-invalid", reason: "expected 'grants' object" }
  }
  const cleanedGrants: Record<string, PersistentTrustScopeRecord[]> = {}
  for (const [project, list] of Object.entries(obj.grants as Record<string, unknown>)) {
    const bucket = liftBucket(list)
    if (bucket.length > 0) cleanedGrants[project] = bucket
  }
  return {
    kind: "ok",
    state: { version: STATE_VERSION, grants: cleanedGrants },
  }
}

/** Canonical record-comparator for stable bucket ordering. Pure; extracted so
 *  `serializeFile` stays under the complexity cap. */
const compareRecords = (a: PersistentTrustScopeRecord, b: PersistentTrustScopeRecord): number => {
  if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1
  const ak = a.actionKey ?? ""
  const bk = b.actionKey ?? ""
  if (ak !== bk) return ak < bk ? -1 : 1
  const ap = a.commandPattern ?? ""
  const bp = b.commandPattern ?? ""
  if (ap !== bp) return ap < bp ? -1 : 1
  return a.grantedAt - b.grantedAt
}

/** Serialize the live state with canonical key ordering so structurally-equal
 *  payloads are byte-identical (helps with file diffing and write-skip). */
const serializeFile = (state: PersistentTrustScopeFile): string => {
  const orderedProjects = Object.keys(state.grants).sort()
  const ordered: Record<string, PersistentTrustScopeRecord[]> = {}
  for (const project of orderedProjects) {
    ordered[project] = [...(state.grants[project] ?? [])].sort(compareRecords)
  }
  return `${JSON.stringify({ version: STATE_VERSION, grants: ordered }, null, 2)}\n`
}

/** 3-way merge: peer-added records survive ours; locally-revoked records stay
 *  revoked. We use grantedAt+tool+actionKey+pattern as the identity key. */
const mergeFiles = (args: {
  onDisk: PersistentTrustScopeFile | null
  inMemory: PersistentTrustScopeFile
  baseline: PersistentTrustScopeFile | null
}): PersistentTrustScopeFile => {
  if (args.onDisk === null) return args.inMemory
  // Single-process identity law: when onDisk deep-equals baseline, return inMemory verbatim.
  if (args.baseline !== null && serializeFile(args.onDisk) === serializeFile(args.baseline)) {
    return args.inMemory
  }
  const out: Record<string, PersistentTrustScopeRecord[]> = {}
  const projects = new Set<string>([
    ...Object.keys(args.onDisk.grants),
    ...Object.keys(args.inMemory.grants),
  ])
  const recordId = (r: PersistentTrustScopeRecord): string =>
    `${r.tool}|${r.actionKey ?? ""}|${r.commandPattern ?? ""}|${r.grantedAt}`
  for (const project of projects) {
    const diskBucket = args.onDisk.grants[project] ?? []
    const memBucket = args.inMemory.grants[project] ?? []
    const baselineBucket = args.baseline?.grants[project] ?? []
    const baselineIds = new Set(baselineBucket.map(recordId))
    const memIds = new Set(memBucket.map(recordId))
    const merged: PersistentTrustScopeRecord[] = [...memBucket]
    for (const r of diskBucket) {
      const id = recordId(r)
      // Peer-added (in disk, not in our baseline, not currently in mem) ⇒ adopt.
      if (!baselineIds.has(id) && !memIds.has(id)) merged.push(r)
    }
    if (merged.length > 0) out[project] = merged
  }
  return { version: STATE_VERSION, grants: out }
}

/** Compose two file states — overlay wins on identical (project, recordId).
 *  Used to fold the project overlay over the global file in read-only memory.
 *  Both inputs are left untouched. */
const overlayFiles = (
  base: PersistentTrustScopeFile,
  overlay: PersistentTrustScopeFile,
): PersistentTrustScopeFile => {
  const out: Record<string, PersistentTrustScopeRecord[]> = {}
  for (const [project, list] of Object.entries(base.grants)) {
    out[project] = [...list]
  }
  for (const [project, list] of Object.entries(overlay.grants)) {
    const existing = out[project]
    out[project] = existing ? [...existing, ...list] : [...list]
  }
  return { version: STATE_VERSION, grants: out }
}

/** Layer tag carried alongside a winning record so the caller knows which
 *  state bucket to consume from on a once_only hit. */
type LayerTag = "overlay" | "global"
type WinningHit = { record: PersistentTrustScopeRecord; layer: LayerTag }

/** Scan one bucket for the first record whose `actionKey` matches `action`.
 *  Pure. A `deny` record short-circuits to a "winning" deny so the cascade can
 *  observe and abort BEFORE moving on. */
const scanExact = (
  bucket: ReadonlyArray<PersistentTrustScopeRecord>,
  layer: LayerTag,
  action: TrustScopeAction,
  clock: number,
): WinningHit | null => {
  for (const r of bucket) {
    if (r.actionKey === undefined) continue
    if (!recordMatches(r, action, clock)) continue
    if (r.scope === "deny") return { record: r, layer }
    if (POSITIVE_SCOPES.has(r.scope)) return { record: r, layer }
  }
  return null
}

/** Scan one bucket for the first record whose `commandPattern` prefix-matches
 *  the action's actionKey tokens. */
const scanPattern = (
  bucket: ReadonlyArray<PersistentTrustScopeRecord>,
  layer: LayerTag,
  action: TrustScopeAction,
  clock: number,
): WinningHit | null => {
  for (const r of bucket) {
    if (r.commandPattern === undefined) continue
    if (r.tool !== action.tool) continue
    if (isStale(r, clock)) continue
    if (!patternMatchesAction(r.commandPattern, action)) continue
    if (r.scope === "deny") return { record: r, layer }
    if (POSITIVE_SCOPES.has(r.scope)) return { record: r, layer }
  }
  return null
}

/** Scan one bucket for the first tool-only record (no actionKey, no pattern). */
const scanToolOnly = (
  bucket: ReadonlyArray<PersistentTrustScopeRecord>,
  layer: LayerTag,
  action: TrustScopeAction,
  clock: number,
): WinningHit | null => {
  for (const r of bucket) {
    if (r.actionKey !== undefined) continue
    if (r.commandPattern !== undefined) continue
    if (r.tool !== action.tool) continue
    if (isStale(r, clock)) continue
    if (r.scope === "deny") return { record: r, layer }
    if (POSITIVE_SCOPES.has(r.scope)) return { record: r, layer }
  }
  return null
}

/** Pure cascade — overlay → global-project → global-star, in that order, for
 *  each of exact / pattern / tool-only. Most-specific match wins. */
const findWinningIn = (args: {
  overlayBucket: ReadonlyArray<PersistentTrustScopeRecord>
  globalProjectBucket: ReadonlyArray<PersistentTrustScopeRecord>
  globalStarBucket: ReadonlyArray<PersistentTrustScopeRecord>
  action: TrustScopeAction
  clock: number
}): WinningHit | null => {
  const { overlayBucket, globalProjectBucket, globalStarBucket, action, clock } = args
  const exact =
    scanExact(overlayBucket, "overlay", action, clock) ??
    scanExact(globalProjectBucket, "global", action, clock) ??
    scanExact(globalStarBucket, "global", action, clock)
  if (exact) return exact
  const pattern =
    scanPattern(overlayBucket, "overlay", action, clock) ??
    scanPattern(globalProjectBucket, "global", action, clock) ??
    scanPattern(globalStarBucket, "global", action, clock)
  if (pattern) return pattern
  return (
    scanToolOnly(overlayBucket, "overlay", action, clock) ??
    scanToolOnly(globalProjectBucket, "global", action, clock) ??
    scanToolOnly(globalStarBucket, "global", action, clock)
  )
}

/**
 * Create the persistent registry. Wire it into the gate via
 * `config.trustScope = { registry, projectKey }`.
 */
export const createPersistentTrustScopeRegistry = (
  opts: PersistentTrustScopeOptions = {},
): PersistentTrustScopeRegistry => {
  const now = opts.now ?? Date.now
  const debounceMs = opts.debounceMs ?? 50

  // Live state — the gate / hasGrant reads from this. Synthesized from
  // (global file load) ∪ (project overlay load); writes go to the right file
  // based on the projectKey at grant() time.
  let globalState: PersistentTrustScopeFile = { version: STATE_VERSION, grants: {} }
  let overlayState: PersistentTrustScopeFile = { version: STATE_VERSION, grants: {} }

  const globalFile: JsonStateFile<PersistentTrustScopeFile> = createJsonStateFile({
    filePath: opts.filePath ?? defaultTrustScopeStatePath(),
    debounceMs,
    emptyState: () => ({ version: STATE_VERSION, grants: {} }),
    serialize: serializeFile,
    parse: parseFile,
    stateVersion: STATE_VERSION,
    mergeWithDisk: mergeFiles,
  })

  // Project overlay — only constructed when projectRoot is supplied.
  const overlayPath =
    opts.projectOverlayPath !== undefined
      ? opts.projectOverlayPath
      : opts.projectRoot !== undefined
        ? defaultProjectOverlayPath(opts.projectRoot)
        : null
  const overlayFile: JsonStateFile<PersistentTrustScopeFile> | null =
    overlayPath !== null
      ? createJsonStateFile({
          filePath: overlayPath,
          debounceMs,
          emptyState: () => ({ version: STATE_VERSION, grants: {} }),
          serialize: serializeFile,
          parse: parseFile,
          stateVersion: STATE_VERSION,
          mergeWithDisk: mergeFiles,
        })
      : null

  // Convenience — the effective lookup state is overlay ∪ global. We do NOT
  // cache the union; the input arrays are tiny so recomputing on each lookup
  // is cheaper than maintaining a derived cache + cache-invalidate dance.
  const lookupState = (): PersistentTrustScopeFile => overlayFiles(globalState, overlayState)

  /** Lookup helper used by hasGrant. Delegates to the pure {@link findWinningIn}
   *  with the live state snapshots so the factory's complexity stays bounded. */
  const findWinning = (projectKey: string, action: TrustScopeAction): WinningHit | null =>
    findWinningIn({
      overlayBucket: overlayState.grants[projectKey] ?? [],
      globalProjectBucket: globalState.grants[projectKey] ?? [],
      globalStarBucket: globalState.grants[GLOBAL_PROJECT_KEY] ?? [],
      action,
      clock: now(),
    })

  /** Once-only consumption helper — removes the winning record from the layer
   *  it was found in, then schedules a debounced flush so the consumption
   *  durably survives a crash. Centralized so the call site stays a single
   *  guard. */
  const consumeOnceOnly = (projectKey: string, win: WinningHit): void => {
    if (win.layer === "overlay") {
      overlayState = removeRecord(overlayState, projectKey, win.record)
      if (overlayFile !== null) overlayFile.flushDebounced(() => overlayState)
      return
    }
    globalState = removeRecord(globalState, projectKey, win.record)
    globalFile.flushDebounced(() => globalState)
  }

  /** Remove the FIRST matching record in a layer. Returns true iff a record
   *  was actually removed; flush is scheduled on the layer's file. */
  const removeFirstFrom = (
    layer: LayerTag,
    projectKey: string,
    pred: (r: PersistentTrustScopeRecord) => boolean,
  ): boolean => {
    const state = layer === "overlay" ? overlayState : globalState
    const list = state.grants[projectKey] ?? []
    const idx = list.findIndex(pred)
    if (idx < 0) return false
    if (layer === "overlay") {
      overlayState = removeAt(overlayState, projectKey, idx)
      if (overlayFile !== null) overlayFile.flushDebounced(() => overlayState)
    } else {
      globalState = removeAt(globalState, projectKey, idx)
      globalFile.flushDebounced(() => globalState)
    }
    return true
  }

  const doHydrate = async (): Promise<void> => {
    await globalFile.load((s) => {
      globalState = s
    })
    if (overlayFile !== null) {
      await overlayFile.load((s) => {
        overlayState = s
      })
    }
  }

  const doFlush = async (): Promise<void> => {
    await globalFile.flush(() => globalState)
    if (overlayFile !== null) await overlayFile.flush(() => overlayState)
  }

  const doFlushDurable = async (): Promise<PersistOutcome> => {
    const globalOutcome = await globalFile.flushDurable(() => globalState)
    const overlayOutcome =
      overlayFile !== null
        ? await overlayFile.flushDurable(() => overlayState)
        : ({ durable: true } as PersistOutcome)
    // Durable only when BOTH files persisted. Surface the first failure reason
    // so the caller has something actionable (opaque, not a stack trace).
    if (!globalOutcome.durable) return globalOutcome
    if (!overlayOutcome.durable) return overlayOutcome
    return { durable: true }
  }

  const doHasGrant = (projectKey: string, action: TrustScopeAction): boolean => {
    const win = findWinning(projectKey, action)
    if (win === null) return false
    if (win.record.scope === "deny") return false
    if (!POSITIVE_SCOPES.has(win.record.scope)) return false
    if (win.record.scope === "once_only") consumeOnceOnly(projectKey, win)
    return true
  }

  const doConsume = (projectKey: string, action: TrustScopeAction): void => {
    const pred = (r: PersistentTrustScopeRecord): boolean =>
      r.scope === "once_only" && recordMatches(r, action, now())
    if (removeFirstFrom("overlay", projectKey, pred)) return
    removeFirstFrom("global", projectKey, pred)
  }

  const doGrant = (projectKey: string, grant: TrustScopeGrant): void => {
    const record: PersistentTrustScopeRecord = {
      tool: grant.tool,
      scope: grant.scope,
      grantedAt: now(),
      ...(grant.actionKey !== undefined ? { actionKey: grant.actionKey } : {}),
    }
    // Project-keyed grants land in the overlay when one exists; otherwise
    // they go to the global file under their projectKey.
    if (overlayFile !== null && projectKey !== GLOBAL_PROJECT_KEY) {
      overlayState = appendRecord(overlayState, projectKey, record)
      overlayFile.flushDebounced(() => overlayState)
      return
    }
    globalState = appendRecord(globalState, projectKey, record)
    globalFile.flushDebounced(() => globalState)
  }

  const doRevoke = (projectKey: string, target: TrustScopeGrant): void => {
    const matches = (r: PersistentTrustScopeRecord): boolean =>
      r.tool === target.tool &&
      r.scope === target.scope &&
      (target.actionKey === undefined
        ? r.actionKey === undefined
        : r.actionKey === target.actionKey)
    if (removeFirstFrom("overlay", projectKey, matches)) return
    removeFirstFrom("global", projectKey, matches)
  }

  return {
    hydrate: doHydrate,
    flush: doFlush,
    flushDurable: doFlushDurable,
    hasGrant: doHasGrant,
    consume: doConsume,
    grant: doGrant,
    revoke: doRevoke,
    snapshot: (): Readonly<Record<string, ReadonlyArray<PersistentTrustScopeRecord>>> =>
      lookupState().grants,
  }
}

// ─── Pure state-bucket helpers (no IO) ───────────────────────────────────────

const appendRecord = (
  state: PersistentTrustScopeFile,
  projectKey: string,
  record: PersistentTrustScopeRecord,
): PersistentTrustScopeFile => {
  const grants: Record<string, PersistentTrustScopeRecord[]> = {}
  for (const [k, v] of Object.entries(state.grants)) {
    grants[k] = [...v]
  }
  const bucket = grants[projectKey] ?? []
  bucket.push(record)
  grants[projectKey] = bucket
  return { version: STATE_VERSION, grants }
}

const removeAt = (
  state: PersistentTrustScopeFile,
  projectKey: string,
  idx: number,
): PersistentTrustScopeFile => {
  const grants: Record<string, PersistentTrustScopeRecord[]> = {}
  for (const [k, v] of Object.entries(state.grants)) {
    grants[k] = [...v]
  }
  const bucket = grants[projectKey] ?? []
  bucket.splice(idx, 1)
  if (bucket.length === 0) delete grants[projectKey]
  else grants[projectKey] = bucket
  return { version: STATE_VERSION, grants }
}

const removeRecord = (
  state: PersistentTrustScopeFile,
  projectKey: string,
  target: PersistentTrustScopeRecord,
): PersistentTrustScopeFile => {
  const bucket = state.grants[projectKey] ?? []
  const idx = bucket.indexOf(target)
  if (idx < 0) return state
  return removeAt(state, projectKey, idx)
}
