/**
 * JSONL-on-disk adapter for {@link PersistentSchedulerStore} (ADR-0158 Phase 1).
 *
 * Layout (mirrors shadow-odb's workspace-hash policy from ADR-0108):
 *
 *     <baseDir>/<workspaceHash>/<handleId>.jsonl
 *
 * Each line is a JSON-encoded {@link PersistedHandle} snapshot. The LAST
 * non-empty line is the current state. `save()` appends (O_APPEND-style via
 * `appendFile`) so an interrupted write at worst loses the in-flight last
 * line, leaving the prior snapshot intact — same crash-safety guarantee
 * Codex's `archived_sessions/*.jsonl` relies on.
 *
 * Plane-clean imports: `node:fs/promises` + `node:path` + `node:os` +
 * `node:crypto` + `./types`. Nothing from `@/agent/*` beyond the port.
 *
 * NO-THROW contract (matches the port):
 *   - load(unknownId)        ⇒ null (ENOENT is not an error)
 *   - parse-fail on last line ⇒ PersistenceError("parse-failed", ...)
 *   - write/mkdir-fail       ⇒ PersistenceError("io-failed", ...)
 *   - delete(unknownId)      ⇒ no-op
 *   - list: corrupt per-handle file is skipped (NOT aborted)
 */

import { createHash } from "node:crypto"
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { errMessage } from "@/shared"
import { type PersistedHandle, PersistenceError, type PersistentSchedulerStore } from "./types"

/** Length of the hex prefix used as the per-workspace directory name. Matches
 *  shadow-odb's 16-hex / 64-bit policy. */
const WORKSPACE_HASH_PREFIX_LEN = 16

/** Default workspace hasher — SHA-256 of the canonicalized path, first 16
 *  hex chars. Symmetrical to `src/storage/shadow-odb/hash.ts` so a future
 *  cross-module audit (list every workspace touched by quanta) can join on
 *  the same key. */
const defaultWorkspaceHash = (workspace: string): string => {
  if (workspace.length === 0) {
    // Empty workspace falls back to a fixed sentinel so the hasher is total.
    // Callers SHOULD pass an absolute path; an empty string only happens in
    // narrow test contexts.
    return "0".repeat(WORKSPACE_HASH_PREFIX_LEN)
  }
  const canonical =
    workspace.endsWith("/") && workspace.length > 1 ? workspace.slice(0, -1) : workspace
  const h = createHash("sha256")
  h.update(canonical, "utf8")
  return h.digest("hex").slice(0, WORKSPACE_HASH_PREFIX_LEN)
}

/** Tunables for {@link defaultJsonlSchedulerStore}. */
export interface JsonlStoreOpts {
  /** Base directory. Default `~/.quanta/scheduler/`. */
  readonly baseDir?: string
  /** Hash function for the workspace component. Default is SHA-256 ⇒ 16-hex
   *  (shadow-odb parity). Override only in tests / debugging. */
  readonly workspaceHasher?: (workspace: string) => string
}

/* ------------------------------------------------------------------ */
/* path helpers                                                        */
/* ------------------------------------------------------------------ */

const resolveBaseDir = (opts: JsonlStoreOpts | undefined): string => {
  if (opts?.baseDir !== undefined && opts.baseDir.length > 0) return opts.baseDir
  const home = homedir()
  return join(home, ".quanta", "scheduler")
}

/** Per-workspace directory for the given store config. */
const workspaceDir = (baseDir: string, hasher: (w: string) => string, workspace: string): string =>
  join(baseDir, hasher(workspace))

/** Per-handle JSONL file. Handles use `bg-<16hex>` ids; we only sanitize the
 *  trailing component (defense-in-depth against a future caller passing an
 *  id with path separators). */
const handleFile = (workspaceDirPath: string, id: string): string => {
  const sanitized = id.replace(/[\\/]/g, "_")
  return join(workspaceDirPath, `${sanitized}.jsonl`)
}

/* ------------------------------------------------------------------ */
/* JSON shape validators                                               */
/* ------------------------------------------------------------------ */

const isPersistedStatus = (s: unknown): s is PersistedHandle["status"] =>
  s === "queued" ||
  s === "running" ||
  s === "completed" ||
  s === "failed" ||
  s === "cancelled" ||
  s === "interrupted" ||
  s === "resumed"

/** The `spec` sub-record, rebuilt with only-present optional fields. Its own
 *  unit because it is a SECOND, independently-failing shape gate nested inside
 *  the handle gate: `task` is required, every other field is dropped rather
 *  than rejected when its type is wrong. Returns `undefined` on mismatch. */
const parseSpec = (raw: unknown): PersistedHandle["spec"] | undefined => {
  const specPart = raw as Partial<PersistedHandle["spec"]>
  if (typeof specPart.task !== "string") return undefined
  return {
    task: specPart.task,
    ...(typeof specPart.modelOverride === "string"
      ? { modelOverride: specPart.modelOverride }
      : {}),
    ...(typeof specPart.maxTurns === "number" ? { maxTurns: specPart.maxTurns } : {}),
    ...(typeof specPart.workspace === "string" ? { workspace: specPart.workspace } : {}),
    ...(typeof specPart.metadata === "object" && specPart.metadata !== null
      ? { metadata: specPart.metadata }
      : {}),
  }
}

/** The REQUIRED half of {@link PersistedHandle} — the six fields whose absence
 *  or wrong type makes the whole record unparseable. */
type PersistedHandleCore = Pick<
  PersistedHandle,
  "id" | "spec" | "status" | "startedAt" | "turns" | "outputSummary"
>

/** Gate + rebuild the REQUIRED fields. A unit distinct from the optional tail
 *  because the two halves have opposite failure policies: any miss here
 *  REJECTS the record, whereas a miss in the tail merely OMITS one key. */
const parseCore = (r: Partial<PersistedHandle>): PersistedHandleCore | undefined => {
  if (typeof r.id !== "string") return undefined
  if (typeof r.startedAt !== "number") return undefined
  if (typeof r.turns !== "number") return undefined
  if (typeof r.outputSummary !== "string") return undefined
  if (!isPersistedStatus(r.status)) return undefined
  if (typeof r.spec !== "object" || r.spec === null) return undefined
  const spec = parseSpec(r.spec)
  if (spec === undefined) return undefined
  return {
    id: r.id,
    spec,
    status: r.status,
    startedAt: r.startedAt,
    turns: r.turns,
    outputSummary: r.outputSummary,
  }
}

/** Reconstruct a {@link PersistedHandle} from a parsed JSON object, OMITTING
 *  absent optional fields (exactOptionalPropertyTypes). Returns `undefined`
 *  on shape mismatch; the caller treats that as a parse failure.
 *
 *  What stays here is exactly the OPTIONAL tail — each field is independently
 *  kept-or-dropped, never a reason to reject. Key order below is preserved
 *  verbatim: `save()` re-serializes with `JSON.stringify`, so the order is
 *  observable in the on-disk JSONL line. */
const parseHandle = (raw: unknown): PersistedHandle | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<PersistedHandle>
  const core = parseCore(r)
  if (core === undefined) return undefined
  return {
    id: core.id,
    spec: core.spec,
    status: core.status,
    startedAt: core.startedAt,
    turns: core.turns,
    outputSummary: core.outputSummary,
    ...(typeof r.endedAt === "number" ? { endedAt: r.endedAt } : {}),
    ...(typeof r.outputDetail === "string" ? { outputDetail: r.outputDetail } : {}),
    ...(typeof r.errorMessage === "string" ? { errorMessage: r.errorMessage } : {}),
    ...(typeof r.hostPid === "number" ? { hostPid: r.hostPid } : {}),
    ...(typeof r.workspace === "string" ? { workspace: r.workspace } : {}),
    // INV-09/INV-10 lineage depth. Only a NON-NEGATIVE INTEGER round-trips;
    // NaN / negative / fractional are treated as ABSENT (fail-closed) so a
    // corrupt depth cannot mint a shallow resumed child. Legacy records (no
    // `depth` key) parse fine — the field is simply omitted.
    ...(typeof r.depth === "number" && Number.isInteger(r.depth) && r.depth >= 0
      ? { depth: r.depth }
      : {}),
  }
}

/** Locate the per-handle file under a given workspaceHash dir given just the
 *  id. Used by `load`/`delete` which receive only the id (not the workspace).
 *  Walks every workspace dir under baseDir; small N so a linear scan is fine. */
const findHandleFileAcrossWorkspaces = async (
  baseDir: string,
  id: string,
): Promise<string | undefined> => {
  let workspaceDirs: string[]
  try {
    workspaceDirs = await readdir(baseDir)
  } catch (e: unknown) {
    if ((e as { code?: string } | null)?.code === "ENOENT") return undefined
    throw new PersistenceError("io-failed", `readdir base: ${errMessage(e)}`)
  }
  for (const wsd of workspaceDirs) {
    const candidate = handleFile(join(baseDir, wsd), id)
    try {
      // Cheap existence probe via readFile — ENOENT short-circuits next iter.
      await readFile(candidate, "utf8")
      return candidate
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code
      if (code === "ENOENT") continue
      throw new PersistenceError("io-failed", `readFile probe: ${errMessage(e)}`)
    }
  }
  return undefined
}

/** Read the last non-empty line of `path`. Returns `null` on ENOENT.
 *  Other read errors throw `io-failed`; parse failure on the last line
 *  throws `parse-failed`. */
const readLatestHandle = async (path: string): Promise<PersistedHandle | null> => {
  let body: string
  try {
    body = await readFile(path, "utf8")
  } catch (e: unknown) {
    if ((e as { code?: string } | null)?.code === "ENOENT") return null
    throw new PersistenceError("io-failed", `readFile ${path}: ${errMessage(e)}`)
  }
  const lines = body.split("\n")
  // Walk backwards to skip trailing newlines / empty lines.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line === undefined) continue
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (e: unknown) {
      throw new PersistenceError(
        "parse-failed",
        `last-line JSON.parse failed in ${path}: ${errMessage(e)}`,
      )
    }
    const h = parseHandle(parsed)
    if (h === undefined) {
      throw new PersistenceError("parse-failed", `last-line shape mismatch in ${path}`)
    }
    return h
  }
  return null
}

/* ------------------------------------------------------------------ */
/* workspace-scan helpers (shared by list + prune)                      */
/* ------------------------------------------------------------------ */

/** `readdir` with the workspace-scan policy: a MISSING directory means "no
 *  handles yet", not a failure, so ENOENT ⇒ `undefined`; anything else is a
 *  real disk problem and becomes `io-failed`. `label` carries each caller's
 *  original message prefix verbatim so error strings are unchanged. */
const readdirOrAbsent = async (dir: string, label: string): Promise<string[] | undefined> => {
  try {
    return await readdir(dir)
  } catch (e: unknown) {
    if ((e as { code?: string } | null)?.code === "ENOENT") return undefined
    throw new PersistenceError("io-failed", `${label}: ${errMessage(e)}`)
  }
}

/** Latest snapshot for one handle file under the SCAN policy, where the two
 *  "nothing usable here" outcomes are indistinguishable to both callers:
 *  an EMPTY file (`readLatestHandle` ⇒ null) and a CORRUPT last line
 *  (`parse-failed`) both mean "skip this file and keep scanning". `io-failed`
 *  still bubbles so a real disk problem aborts the scan. */
const readLatestOrSkip = async (path: string): Promise<PersistedHandle | undefined> => {
  try {
    return (await readLatestHandle(path)) ?? undefined
  } catch (e: unknown) {
    // PARSE failure on one file ⇒ skip + continue (NOT abort the scan).
    if (e instanceof PersistenceError && e.code === "parse-failed") return undefined
    throw e
  }
}

/** All parseable handles in one workspace dir, newest first. */
const scanWorkspace = async (wsDir: string): Promise<PersistedHandle[]> => {
  const files = await readdirOrAbsent(wsDir, "list readdir")
  if (files === undefined) return []
  const handles: PersistedHandle[] = []
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue
    const h = await readLatestOrSkip(join(wsDir, f))
    if (h !== undefined) handles.push(h)
  }
  // Newest first.
  handles.sort((a, b) => b.startedAt - a.startedAt)
  return handles
}

/** Delete one pruned file, mapping any failure to the prune-specific
 *  `io-failed` message. Separate unit so the scan loop stays flat. */
const removePruned = async (path: string): Promise<void> => {
  try {
    await rm(path, { force: true })
  } catch (e: unknown) {
    throw new PersistenceError("io-failed", `prune rm ${path}: ${errMessage(e)}`)
  }
}

/** Delete terminal handles whose end time is strictly before `cutoff`.
 *
 *  The comparison is deliberately `endedAt < cutoff` rather than its negation:
 *  `endedAt` comes from untrusted JSON and can be NaN, for which BOTH `<` and
 *  `>=` are false — an inverted `continue` guard would flip a NaN record from
 *  never-pruned to always-pruned. */
const sweepWorkspace = async (wsDir: string, cutoff: number): Promise<number> => {
  const files = await readdirOrAbsent(wsDir, "prune readdir")
  if (files === undefined) return 0
  let removed = 0
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue
    const path = join(wsDir, f)
    const h = await readLatestOrSkip(path)
    if (h === undefined) continue
    if (h.status === "running") continue // never prune live handles
    const endedAt = h.endedAt ?? h.startedAt
    if (endedAt < cutoff) {
      await removePruned(path)
      removed += 1
    }
  }
  return removed
}

/* ------------------------------------------------------------------ */
/* factory                                                             */
/* ------------------------------------------------------------------ */

export const defaultJsonlSchedulerStore = (opts?: JsonlStoreOpts): PersistentSchedulerStore => {
  const baseDir = resolveBaseDir(opts)
  const hasher = opts?.workspaceHasher ?? defaultWorkspaceHash

  /** Per-handle file path, resolved via the saved spec.workspace OR the
   *  caller-passed workspace. Save() always knows the workspace from the
   *  handle itself; load/delete walk all workspace dirs. */
  const fileForSave = (handle: PersistedHandle): string => {
    // Prefer the handle's workspace; fall back to "" sentinel.
    const ws = handle.workspace ?? handle.spec.workspace ?? ""
    const wsDir = workspaceDir(baseDir, hasher, ws)
    return handleFile(wsDir, handle.id)
  }

  return {
    async save(handle) {
      const target = fileForSave(handle)
      try {
        // mkdir -p the workspace dir on first write.
        const dir = target.slice(0, target.lastIndexOf("/"))
        await mkdir(dir, { recursive: true })
        // appendFile is a single open(O_APPEND)+write+close — crash at any
        // point either commits the full line (POSIX append atomicity for
        // writes <= PIPE_BUF) or leaves the file with the prior contents.
        // We always terminate the line with `\n` so a torn write of the
        // final newline is recoverable by the load-walker skipping
        // unterminated tail.
        const line = `${JSON.stringify(handle)}\n`
        await appendFile(target, line, "utf8")
      } catch (e: unknown) {
        if (e instanceof PersistenceError) throw e
        throw new PersistenceError("io-failed", `save ${handle.id}: ${errMessage(e)}`)
      }
    },

    async load(id) {
      try {
        const path = await findHandleFileAcrossWorkspaces(baseDir, id)
        if (path === undefined) return null
        return await readLatestHandle(path)
      } catch (e: unknown) {
        if (e instanceof PersistenceError) throw e
        throw new PersistenceError("io-failed", `load ${id}: ${errMessage(e)}`)
      }
    },

    async list(workspace) {
      return await scanWorkspace(workspaceDir(baseDir, hasher, workspace))
    },

    async delete(id) {
      try {
        const path = await findHandleFileAcrossWorkspaces(baseDir, id)
        if (path === undefined) return
        await rm(path, { force: true })
      } catch (e: unknown) {
        if (e instanceof PersistenceError) throw e
        throw new PersistenceError("io-failed", `delete ${id}: ${errMessage(e)}`)
      }
    },

    async prune(workspace, maxAgeMs) {
      const wsDir = workspaceDir(baseDir, hasher, workspace)
      // Clock is read BEFORE the directory scan, as before — a slow scan must
      // not move the cutoff under itself.
      const cutoff = Date.now() - Math.max(0, maxAgeMs)
      return await sweepWorkspace(wsDir, cutoff)
    },
  }
}
