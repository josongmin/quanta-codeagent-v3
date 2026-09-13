/**
 * ADR-0249 — filesystem layer for node-repl kernel handles.
 *
 * Lives under `<quanta home>/node_repl/active_execs/` — `QUANTA_CONFIG_DIR ??
 * QUANTA_HOME ?? ~/.quanta` — (directory created on first write, mode 0700). Each kernel is a single `{id}.json` file
 * written with mode 0600 so other users on a multi-tenant host cannot
 * read the `sessionId ↔ pid` linkage — defense-in-depth on top of the
 * OS-process boundary.
 *
 * `safeId` rejects path-injection: `;`, `\n`, `..`, `/`, leading `-` /
 * `.` are stripped or collapsed. The resulting id is length-capped at 48
 * chars and never empty. A nonce suffix is appended in `mkId` so two
 * concurrent spawns with the same seed still resolve to different
 * filenames.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { quantaHomeDir } from "@/shared/quanta-home"
import type { KernelId, KernelSpec } from "./types"

/**
 * Resolve the on-disk directory.
 *
 * With no argument this is the Quanta home, like every other home-scoped store. The
 * default used to be the OS home's `.quanta`, which ignored `QUANTA_HOME` — so a
 * relocated home still wrote kernel handles into the OS home, and the test suite's
 * scratch home did not contain them (measured: the reap hellgate left handles in the
 * developer's real `node_repl/active_execs`). An explicit `home` keeps its meaning — a
 * filesystem HOME, the seam the state-store tests use.
 */
export const stateDir = (home?: string): string =>
  home === undefined
    ? join(quantaHomeDir(), "node_repl", "active_execs")
    : join(home, ".quanta", "node_repl", "active_execs")

const ID_PATTERN = /[^A-Za-z0-9._-]/g

/** Sanitise a caller-supplied id. Returns `null` if nothing survives —
 *  caller turns that into `KernelError{ kind: "invalid-id" }`. */
export const safeId = (raw: string): string | null => {
  let cleaned = raw.replace(ID_PATTERN, "-").slice(0, 48)
  cleaned = cleaned.replace(/^[-.]+/, "")
  if (cleaned.length === 0) return null
  return cleaned
}

/** Build a unique id. When the caller supplies `seed`, the nonce is
 *  appended to it; otherwise a random base id is used. */
export const mkId = (seed?: string): string | null => {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  if (seed === undefined) return `kernel-${nonce}`
  const safe = safeId(seed)
  if (safe === null) return null
  return `${safe}-${nonce}`
}

const ensureDir = (dir: string): void => {
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

const filePath = (dir: string, id: KernelId | string): string => join(dir, `${id}.json`)

/** Persist a fresh kernel spec. Mode 0600. Synchronous so a follow-up
 *  `list()` immediately sees the new entry without an await window. */
export const writeKernel = (spec: KernelSpec, home?: string): void => {
  const dir = stateDir(home)
  ensureDir(dir)
  const body = JSON.stringify(spec)
  writeFileSync(filePath(dir, spec.id), body, { mode: 0o600 })
}

/** Bump `lastUseMs` on disk after a successful exec. Idempotent: if
 *  the file vanished concurrently, this is a no-op (the orphan reaper
 *  may have run). */
export const touchKernel = (id: KernelId, lastUseMs: number, home?: string): void => {
  const dir = stateDir(home)
  const path = filePath(dir, id)
  if (!existsSync(path)) return
  let prev: KernelSpec
  try {
    prev = JSON.parse(readFileSync(path, "utf8")) as KernelSpec
  } catch {
    return
  }
  const next: KernelSpec = { ...prev, lastUseMs }
  try {
    writeFileSync(path, JSON.stringify(next), { mode: 0o600 })
  } catch {
    // best-effort — the in-memory state is canonical, disk is just a hint
  }
}

/** Remove the on-disk handle. Idempotent — missing file is fine. */
export const removeKernel = (id: KernelId, home?: string): void => {
  const dir = stateDir(home)
  const path = filePath(dir, id)
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    // best-effort
  }
}

/** Load every kernel handle on disk. Files that fail JSON parse are
 *  silently dropped (treated as corrupt orphans the caller should reap). */
export const listKernels = (home?: string): KernelSpec[] => {
  const dir = stateDir(home)
  if (!existsSync(dir)) return []
  const out: KernelSpec[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    const path = join(dir, name)
    try {
      // stat first so vanished-files don't poison the read
      statSync(path)
      const body = readFileSync(path, "utf8")
      const parsed = JSON.parse(body) as KernelSpec
      out.push(parsed)
    } catch {
      // ignore: file vanished or is unreadable
    }
  }
  return out
}
