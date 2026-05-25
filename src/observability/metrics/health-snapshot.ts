/**
 * ADR-0180: file-based health snapshot — JSON mirror of the
 * `observability.wired.total` gauge (ADR-0172) for operators who don't run a
 * Prometheus stack. The snapshot is a versioned envelope written atomically
 * (tmp + rename) to `${os.homedir()}/.quanta/health.json` by default, or any
 * caller-supplied absolute path.
 *
 * SOTA reference (cited in ADR-0180):
 * - Kubernetes pod `liveness` probe `exec.command: ["cat","~/.quanta/health.json"]`
 *   + `jq` — file-based health surfaces are universal (no HTTP server, no port
 *   management, no scrape config).
 * - systemd `notify` socket — same shape: a tiny well-known file describing
 *   "am I up, what is wired" without any in-process server.
 *
 * No SOTA agent (Claude Desktop / Cursor / Codex) writes a file-based health
 * surface; all three rely on Sentry events or IPC RPC. quanta first.
 *
 * Plane-clean: imports ONLY this module's sibling type + Node stdlib. No
 * `@/agent`, `@/llm`, `@/permission`, `@/tool` — health-snapshot is a primitive,
 * not a collaborator of any domain.
 *
 * Default-OFF: nothing writes by default. The helper (observability-helper.ts)
 * gains an opt-in `healthSnapshotPath` opt; when absent, no snapshot is built
 * or written and runtime is byte-identical to ADR-0172 baseline.
 */

import {
  mkdir as fsMkdir,
  rename as fsRename,
  writeFile as fsWriteFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

import { QuantaError } from "@/shared"

import type { ObservabilityBag } from "./observability-helper"

/** One slice's wiring state for the snapshot file. */
export interface SliceHealth {
  readonly slice: keyof ObservabilityBag
  readonly wired: boolean
  /** "wired" / "missing" / "skipped intentionally". Always present so jq
   *  one-liners don't need to handle absent keys. */
  readonly note: "wired" | "missing" | "skipped intentionally"
}

/** Full snapshot. Wire-stable shape; versioned for forward compatibility. */
export interface HealthSnapshot {
  readonly version: 1
  /** Epoch ms when the snapshot was built (NOT when it was written — the build
   *  side is the deterministic point for tests). */
  readonly writtenAt: number
  readonly quantaVersion: string
  readonly slices: ReadonlyArray<SliceHealth>
  /** Summary for jq one-liners. */
  readonly summary: {
    readonly wiredCount: number
    readonly totalCount: number
    /** wiredCount / totalCount; 0 when totalCount is 0 (defensive — totalCount
     *  is always 7 today, but we don't want NaN to leak into operator JSON). */
    readonly completenessRatio: number
  }
}

/** Closed 1-arm error code union (room to grow). */
export type HealthSnapshotErrorCode = "write-failed"

export class HealthSnapshotError extends QuantaError {
  readonly errorCode: HealthSnapshotErrorCode
  constructor(code: HealthSnapshotErrorCode, message: string) {
    super(`health-snapshot:${code}`, message)
    this.errorCode = code
  }
}

export interface HealthSnapshotBuildOpts {
  /** Slices intentionally absent from the bag: snapshot keeps `wired=false`
   *  but surfaces operator intent as `note="skipped intentionally"`. */
  readonly skippedExpected?: ReadonlySet<keyof ObservabilityBag>
  /** Caller version. Default reads from `process.env.QUANTA_VERSION` || "unknown". */
  readonly quantaVersion?: string
  /** Test seam — inject clock (epoch ms). Default `Date.now`. */
  readonly now?: () => number
}

interface HealthSnapshotFsOps {
  readonly mkdir: typeof fsMkdir
  readonly writeFile: typeof fsWriteFile
  readonly rename: typeof fsRename
}

export interface HealthSnapshotWriteOpts {
  /** Where to write. Relative paths are anchored to `${os.homedir()}/.quanta/`.
   *  Absolute paths are used verbatim. Default `${os.homedir()}/.quanta/health.json`. */
  readonly path?: string
  /** Test seam — inject writer. Default `node:fs/promises.writeFile` +
   *  `rename`. When provided, the helper still calls it with the atomic
   *  tmp+rename pattern semantics (write tmp first, then rename).
   *  Implementations receive the FINAL path (not the tmp path) and the
   *  full JSON string. */
  readonly writeFile?: (path: string, content: string) => Promise<void>
  /** Test seam for low-level atomic I/O. Lets hellgates deterministically
   *  observe tmp-path allocation and overlap behavior without patching
   *  `node:fs/promises`. Production leaves this unset. */
  readonly fsOps?: Partial<HealthSnapshotFsOps>
}

export type HealthSnapshotOpts = HealthSnapshotBuildOpts & HealthSnapshotWriteOpts

/** Stable ordered enumeration of every `ObservabilityBag` key. Hand-maintained;
 *  drift between this tuple and `ObservabilityBag` is caught by the wired-gauge
 *  hellgate (key-set equality test). Keeping a private copy here avoids a
 *  helper-helper circular import (observability-helper.ts can extend its own
 *  opts to call buildHealthSnapshot without us pulling that file's runtime
 *  exports back in). */
const ALL_BAG_KEYS: ReadonlyArray<keyof ObservabilityBag> = [
  "llmProvider",
  "scheduler",
  "shadowOdb",
  "planQueue",
  "budgetLedger",
  "lspClient",
  "tools",
] as const

const resolveQuantaVersion = (override?: string): string => {
  if (override !== undefined && override !== "") return override
  // Slice invariant (ADR-0144): no process.env in @/observability.
  // Caller passes override at composition root.
  return "unknown"
}

/** Build the snapshot from an InstrumentedBag (or any bag-shaped object where
 *  the absence of a slice is signalled by `undefined`). Pure — no I/O, no
 *  clock access unless `opts.now` is omitted. */
export const buildHealthSnapshot = (
  bag: { readonly [K in keyof ObservabilityBag]: ObservabilityBag[K] | undefined },
  opts?: HealthSnapshotBuildOpts,
): HealthSnapshot => {
  const now = opts?.now ?? Date.now
  const expected = opts?.skippedExpected
  const slices: ReadonlyArray<SliceHealth> = ALL_BAG_KEYS.map((k) => {
    const wired = bag[k] !== undefined
    if (wired) return { slice: k, wired: true, note: "wired" } as const
    if (expected?.has(k) === true) {
      return { slice: k, wired: false, note: "skipped intentionally" } as const
    }
    return { slice: k, wired: false, note: "missing" } as const
  })
  const wiredCount = slices.filter((s) => s.wired).length
  const totalCount = slices.length
  const completenessRatio = totalCount > 0 ? wiredCount / totalCount : 0
  return {
    version: 1,
    writtenAt: now(),
    quantaVersion: resolveQuantaVersion(opts?.quantaVersion),
    slices,
    summary: { wiredCount, totalCount, completenessRatio },
  }
}

/** Default snapshot path = `${os.homedir()}/.quanta/health.json`. Exposed so
 *  the helper (and operator docs) can refer to one canonical location. */
export const defaultHealthSnapshotPath = (): string => join(homedir(), ".quanta", "health.json")

const resolveSnapshotPath = (raw?: string): string => {
  if (raw === undefined || raw === "") return defaultHealthSnapshotPath()
  if (isAbsolute(raw)) return raw
  return join(homedir(), ".quanta", raw)
}

/** Stable JSON serializer — fixed key order so two snapshots with the same
 *  content (and same injected clock) produce byte-identical bytes. JSON.stringify
 *  preserves object literal key order in V8/JSC, but we build the object with
 *  a fixed property sequence to make the guarantee explicit. */
const serializeSnapshot = (snap: HealthSnapshot): string => {
  // 2-space indent matches operator-friendly `jq .` output style; trailing
  // newline so `cat | wc -l` is human-sensible.
  return `${JSON.stringify(snap, null, 2)}\n`
}

let nextAtomicWriteOrdinal = 0

const nextHealthSnapshotTmpPath = (finalPath: string): string => {
  const ordinal = nextAtomicWriteOrdinal
  nextAtomicWriteOrdinal += 1
  return `${finalPath}.tmp.${process.pid}.${ordinal}`
}

const resolveFsOps = (overrides?: Partial<HealthSnapshotFsOps>): HealthSnapshotFsOps => ({
  mkdir: overrides?.mkdir ?? fsMkdir,
  writeFile: overrides?.writeFile ?? fsWriteFile,
  rename: overrides?.rename ?? fsRename,
})

/** Write the snapshot atomically (tmp + rename). Returns the final path on
 *  success, throws `HealthSnapshotError("write-failed", ...)` on any I/O error
 *  bubbling from the underlying writer/rename. Directory is created if absent
 *  (recursive mkdir — no-op when present). Default writer allocates a unique
 *  tmp path per emit so concurrent writers in the same process never share a
 *  single `${final}.tmp.${pid}` scratch file. */
export const writeHealthSnapshot = async (
  snapshot: HealthSnapshot,
  opts?: HealthSnapshotWriteOpts,
): Promise<string> => {
  const finalPath = resolveSnapshotPath(opts?.path)
  const content = serializeSnapshot(snapshot)
  try {
    if (opts?.writeFile !== undefined) {
      // Injected writer: still semantically atomic from the registry's point
      // of view — caller passes a writer that handles its own atomicity (the
      // test seam mostly captures call order; production never injects).
      await opts.writeFile(finalPath, content)
      return finalPath
    }
    const fsOps = resolveFsOps(opts?.fsOps)
    await fsOps.mkdir(dirname(finalPath), { recursive: true })
    const tmpPath = nextHealthSnapshotTmpPath(finalPath)
    await fsOps.writeFile(tmpPath, content, "utf8")
    await fsOps.rename(tmpPath, finalPath)
    return finalPath
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new HealthSnapshotError("write-failed", `failed to write ${finalPath}: ${msg}`)
  }
}
