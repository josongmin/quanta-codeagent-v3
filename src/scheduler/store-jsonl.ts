/**
 * ADR-0161 Phase C — JSONL automation store (file-backed, append-only).
 *
 * Layout (mirrors shadow-odb / ADR-0158 workspace-hash policy):
 *
 *     <baseDir>/<workspaceHash>/automations.jsonl
 *
 * Each line is a JSON-encoded {@link Automation} snapshot. ALL transitions
 * (create / pause / resume / delete / error / fire) append a new line; load
 * walks the file and the LAST line per `id` wins.
 *
 * Why single file (vs ADR-0158 per-handle file):
 *   - Automations are FEWER than background subagent handles (tens vs
 *     thousands) — one file is more debuggable.
 *   - Transactional read is one `readFile` instead of N `readdir + readFile`.
 *   - last-line-per-id semantics match Codex's `automation-schedule` cache
 *     refetch.
 *
 * NO-THROW contract:
 *   - load(workspace) on ENOENT → `[]`.
 *   - load on corrupt single line → that line skipped, others survive.
 *   - delete(workspace, unknownId) → no-op (no `tombstone` line; just no
 *     longer in subsequent saves' results). To make delete observable, the
 *     port writes a sentinel line `{id, status:"deleted", ...}` which the
 *     load walker recognizes as a tombstone (last-wins).
 *   - save on EACCES → throws {@link AutomationStoreError}("io-failed").
 *
 * Plane-clean: imports `node:fs/promises` + `node:path` + `node:os` +
 * `node:crypto` + `./types`. Nothing else.
 */

import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  type Automation,
  type AutomationStatus,
  AutomationStoreError,
  type AutomationStorePort,
  type HeartbeatPolicySnapshot,
  type RRule,
  type Weekday,
} from "./types"

/** Length of the hex prefix used as the per-workspace directory name. Matches
 *  shadow-odb's 16-hex / 64-bit policy (ADR-0108 parity). */
const WORKSPACE_HASH_PREFIX_LEN = 16

/** SHA-256 of the canonicalized workspace path, first 16 hex chars. */
const defaultWorkspaceHash = (workspace: string): string => {
  if (workspace.length === 0) {
    return "0".repeat(WORKSPACE_HASH_PREFIX_LEN)
  }
  const canonical =
    workspace.endsWith("/") && workspace.length > 1 ? workspace.slice(0, -1) : workspace
  const h = createHash("sha256")
  h.update(canonical, "utf8")
  return h.digest("hex").slice(0, WORKSPACE_HASH_PREFIX_LEN)
}

export interface JsonlAutomationStoreOpts {
  /** Base directory. Default `~/.quanta/scheduler/`. */
  readonly baseDir?: string
  /** Override hasher (tests only). */
  readonly workspaceHasher?: (workspace: string) => string
  /** Override the file reader (tests inject fault-injection). Default
   *  `node:fs/promises` `readFile`. Must reject with an ENOENT-coded error
   *  when the file is absent. */
  readonly reader?: (file: string) => Promise<string>
  /** Override the appender (tests inject fault-injection). Default
   *  `node:fs/promises` `appendFile`. */
  readonly appender?: (file: string, line: string) => Promise<void>
  /** Override directory creation (tests inject). Default `node:fs/promises`
   *  `mkdir(dir, { recursive: true })`. */
  readonly mkdirer?: (dir: string) => Promise<void>
}

const FILE_NAME = "automations.jsonl"

const resolveBaseDir = (opts: JsonlAutomationStoreOpts | undefined): string => {
  if (opts?.baseDir !== undefined && opts.baseDir.length > 0) return opts.baseDir
  return join(homedir(), ".quanta", "scheduler")
}

/** Per-workspace directory for the given store config. */
const workspaceDir = (baseDir: string, hasher: (w: string) => string, workspace: string): string =>
  join(baseDir, hasher(workspace))

const automationsFile = (wsDir: string): string => join(wsDir, FILE_NAME)

// ============================================================================
// JSON validators (each null on shape mismatch — last-line walker skips)
// ============================================================================

const isStatus = (s: unknown): s is AutomationStatus =>
  s === "active" || s === "paused" || s === "deleted" || s === "error"

const parseWeekdayRaw = (raw: unknown): Weekday | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<Weekday>
  if (
    r.day !== "MO" &&
    r.day !== "TU" &&
    r.day !== "WE" &&
    r.day !== "TH" &&
    r.day !== "FR" &&
    r.day !== "SA" &&
    r.day !== "SU"
  ) {
    return undefined
  }
  if (r.nth !== undefined && typeof r.nth !== "number") return undefined
  return r.nth !== undefined ? { day: r.day, nth: r.nth } : { day: r.day }
}

/** Optional-number guard: returns `{ ok: true, value? }` distinguishing
 *  "absent" (omit from output) from "present and number" from "shape error". */
const optionalNumber = (v: unknown): { ok: true; value?: number } | { ok: false } => {
  if (v === undefined) return { ok: true }
  if (typeof v !== "number") return { ok: false }
  return { ok: true, value: v }
}

/** Parse a byDay array — `undefined` array OK (omit), invalid weekday → fail. */
const parseByDayArray = (v: unknown): { ok: true; value?: Weekday[] } | { ok: false } => {
  if (v === undefined) return { ok: true }
  if (!Array.isArray(v)) return { ok: false }
  const parsed: Weekday[] = []
  for (const w of v) {
    const pw = parseWeekdayRaw(w)
    if (pw === undefined) return { ok: false }
    parsed.push(pw)
  }
  return { ok: true, value: parsed }
}

/** Parse a byMonthDay array — `undefined` OK, must be number array. */
const parseByMonthDayArray = (v: unknown): { ok: true; value?: number[] } | { ok: false } => {
  if (v === undefined) return { ok: true }
  if (!Array.isArray(v)) return { ok: false }
  if (v.some((d) => typeof d !== "number")) return { ok: false }
  return { ok: true, value: v as number[] }
}

const parseRRuleRaw = (raw: unknown): RRule | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<RRule>
  if (r.freq !== "DAILY" && r.freq !== "WEEKLY" && r.freq !== "MONTHLY") return undefined
  const interval = optionalNumber(r.interval)
  const count = optionalNumber(r.count)
  const until = optionalNumber(r.until)
  const byDay = parseByDayArray(r.byDay)
  const byMonthDay = parseByMonthDayArray(r.byMonthDay)
  if (!interval.ok || !count.ok || !until.ok || !byDay.ok || !byMonthDay.ok) {
    return undefined
  }
  return {
    freq: r.freq,
    ...(interval.value !== undefined ? { interval: interval.value } : {}),
    ...(count.value !== undefined ? { count: count.value } : {}),
    ...(until.value !== undefined ? { until: until.value } : {}),
    ...(byDay.value !== undefined ? { byDay: byDay.value } : {}),
    ...(byMonthDay.value !== undefined ? { byMonthDay: byMonthDay.value } : {}),
  }
}

const parseAutomation = (raw: unknown): Automation | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<Automation>
  if (typeof r.id !== "string") return undefined
  if (typeof r.title !== "string") return undefined
  if (typeof r.prompt !== "string") return undefined
  if (typeof r.modelPreference !== "string") return undefined
  if (!Array.isArray(r.modelFallbacks)) return undefined
  if (r.modelFallbacks.some((m) => typeof m !== "string")) return undefined
  if (typeof r.createdAt !== "number") return undefined
  if (typeof r.fireCount !== "number") return undefined
  if (!isStatus(r.status)) return undefined
  const rule = parseRRuleRaw(r.rule)
  if (rule === undefined) return undefined
  // Reconstruct preserving exactOptionalPropertyTypes.
  const base = {
    id: r.id,
    title: r.title,
    rule,
    prompt: r.prompt,
    status: r.status,
    modelPreference: r.modelPreference,
    modelFallbacks: r.modelFallbacks as ReadonlyArray<string>,
    createdAt: r.createdAt,
    fireCount: r.fireCount,
  }
  return {
    ...base,
    ...(typeof r.lastFiredAt === "number" ? { lastFiredAt: r.lastFiredAt } : {}),
    ...(typeof r.lastErrorMessage === "string" ? { lastErrorMessage: r.lastErrorMessage } : {}),
    ...heartbeatFields(r),
  }
}

/** H8 — reconstruct the heartbeat fields (kind/targetThreadId/inheritedPolicy)
 *  preserving exactOptional. Absent ⇒ `{}` ⇒ legacy cron byte-identical.
 *  Extracted so `parseAutomation` stays under the cognitive-complexity gate. */
const heartbeatFields = (
  r: Partial<Automation>,
): Partial<Pick<Automation, "kind" | "targetThreadId" | "inheritedPolicy">> => {
  const policy = parseInheritedPolicy(r.inheritedPolicy)
  return {
    ...(r.kind === "heartbeat" || r.kind === "cron" ? { kind: r.kind } : {}),
    ...(typeof r.targetThreadId === "string" ? { targetThreadId: r.targetThreadId } : {}),
    ...(policy !== undefined ? { inheritedPolicy: policy } : {}),
  }
}

/** Parse the H8 heartbeat posture snapshot — all three fields must be strings,
 *  else the whole snapshot is dropped (a partial posture is never inherited). */
const parseInheritedPolicy = (raw: unknown): HeartbeatPolicySnapshot | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const p = raw as Partial<HeartbeatPolicySnapshot>
  if (
    typeof p.approvalPolicy !== "string" ||
    typeof p.sandboxPolicy !== "string" ||
    typeof p.collaborationMode !== "string"
  ) {
    return undefined
  }
  return {
    approvalPolicy: p.approvalPolicy,
    sandboxPolicy: p.sandboxPolicy,
    collaborationMode: p.collaborationMode,
  }
}

/** Safe JSON parse — returns `undefined` on failure (caller skips). */
const safeParse = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** Walk a JSONL file's contents and build the last-wins per-id map. Corrupt
 *  lines silently skipped. */
const buildLatestMap = (text: string): Map<string, Automation> => {
  const out = new Map<string, Automation>()
  const lines = text.split("\n")
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const parsed = safeParse(line)
    if (parsed === undefined) continue
    const a = parseAutomation(parsed)
    if (a === undefined) continue
    out.set(a.id, a)
  }
  return out
}

/** Filter out `deleted` automations from the final list — they are tombstones
 *  the caller (load) does NOT surface. The tombstone line still wins in
 *  buildLatestMap so a subsequent re-create would need a different id (the
 *  caller MUST allocate a fresh id for a re-create scenario). */
const dropDeleted = (m: ReadonlyMap<string, Automation>): ReadonlyArray<Automation> => {
  const out: Automation[] = []
  for (const a of m.values()) {
    if (a.status !== "deleted") out.push(a)
  }
  return out
}

// ============================================================================
// Public factory
// ============================================================================

/**
 * File-backed JSONL automation store. Crash-safe (append-only), workspace-
 * isolated (sha256-prefix dir), corrupt-line-resilient.
 */
export const defaultJsonlAutomationStore = (
  opts?: JsonlAutomationStoreOpts,
): AutomationStorePort => {
  const baseDir = resolveBaseDir(opts)
  const hasher = opts?.workspaceHasher ?? defaultWorkspaceHash
  const readImpl = opts?.reader ?? ((file: string) => readFile(file, "utf8"))
  const appendImpl =
    opts?.appender ?? ((file: string, line: string) => appendFile(file, line, "utf8"))
  const mkdirImpl =
    opts?.mkdirer ?? (async (dir: string) => void (await mkdir(dir, { recursive: true })))

  const ensureDir = async (workspace: string): Promise<string> => {
    const dir = workspaceDir(baseDir, hasher, workspace)
    try {
      await mkdirImpl(dir)
    } catch (e) {
      throw new AutomationStoreError("io-failed", `mkdir failed: ${stringifyError(e)}`)
    }
    return dir
  }

  return {
    async load(workspace) {
      const dir = workspaceDir(baseDir, hasher, workspace)
      const file = automationsFile(dir)
      let text: string
      try {
        text = await readImpl(file)
      } catch (e) {
        if (isEnoent(e)) return [] // genuinely absent ⇒ empty (no false fault)
        // T10 M9 — a non-ENOENT read fault (EACCES / partial-IO) is a
        // FIRST-CLASS error, NOT an empty list. Collapsing it to `[]` makes a
        // permission/disk fault indistinguishable from "no automations" and
        // silently stops every automation from firing. Surface it so the
        // runtime can observe + sink it.
        throw new AutomationStoreError("io-failed", `load failed: ${stringifyError(e)}`)
      }
      const map = buildLatestMap(text)
      return dropDeleted(map)
    },

    async save(workspace, automation) {
      const dir = await ensureDir(workspace)
      const file = automationsFile(dir)
      const line = `${JSON.stringify(automation)}\n`
      try {
        await appendImpl(file, line)
      } catch (e) {
        throw new AutomationStoreError("io-failed", `append failed: ${stringifyError(e)}`)
      }
    },

    async delete(workspace, id) {
      const dir = await ensureDir(workspace)
      const file = automationsFile(dir)
      // Tombstone — `status: "deleted"`. Last-wins semantics make this work.
      // Need to preserve the previous record shape (rule, prompt, ...) so the
      // parser accepts the line; we read the current load, find the matching
      // record, copy + mark deleted. If absent, no-op (idempotent).
      let text: string
      try {
        text = await readImpl(file)
      } catch (e) {
        if (isEnoent(e)) return // unknown id, file doesn't exist
        // T10 M9 — a read fault is first-class (same reasoning as load()).
        throw new AutomationStoreError("io-failed", `delete read failed: ${stringifyError(e)}`)
      }
      const map = buildLatestMap(text)
      const found = map.get(id)
      if (found === undefined) return
      const tombstone: Automation = { ...found, status: "deleted" }
      try {
        await appendImpl(file, `${JSON.stringify(tombstone)}\n`)
      } catch (e) {
        // T10 M9 — a swallowed tombstone makes the caller believe the
        // automation is gone while it keeps firing every tick. Surface it.
        throw new AutomationStoreError("io-failed", `delete tombstone failed: ${stringifyError(e)}`)
      }
    },
  }
}

// ============================================================================
// helpers
// ============================================================================

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT"

const stringifyError = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "unknown"
