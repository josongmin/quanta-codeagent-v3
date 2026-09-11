/**
 * Session generation + tombstone fencing (SEP7-D-05).
 *
 * Snapshot files are the durable source of truth. After delete, a late
 * autosave must not resurrect the id. A legitimate recreate passes
 * `{ create: true }` which clears the tombstone and bumps generation.
 *
 * The in-memory generation rejects stale queued work in one process. The
 * durable sidecar functions below extend the same compare/admit transition
 * across processes while the caller holds the per-session flock.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { errMessage } from "@/shared"

const generations = new Map<string, number>()
const tombstones = new Set<string>()

export class StaleSessionGenerationError extends Error {
  readonly sessionId: string
  constructor(sessionId: string) {
    super(`refusing stale save for session ${sessionId} after delete`)
    this.name = "StaleSessionGenerationError"
    this.sessionId = sessionId
  }
}

export class SessionGenerationStateError extends Error {
  readonly path: string
  readonly kind: "corrupt" | "unreadable"
  constructor(path: string, kind: "corrupt" | "unreadable", cause: string) {
    super(`session generation ${kind} at ${path}: ${cause}`)
    this.name = "SessionGenerationStateError"
    this.path = path
    this.kind = kind
  }
}

interface DurableSessionGeneration {
  readonly version: 1
  readonly generation: number
  readonly deleted: boolean
}

export type DurableSessionGenerationRead =
  | { readonly kind: "ok"; readonly state: DurableSessionGeneration }
  | { readonly kind: "corrupt"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string }

const INITIAL_DURABLE_GENERATION: DurableSessionGeneration = {
  version: 1,
  generation: 0,
  deleted: false,
}

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code

export const readDurableSessionGeneration = async (
  path: string,
): Promise<DurableSessionGenerationRead> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "ok", state: INITIAL_DURABLE_GENERATION }
    return { kind: "unreadable", reason: errMessage(error) }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1 &&
      Number.isSafeInteger((parsed as { generation?: unknown }).generation) &&
      ((parsed as { generation: number }).generation ?? -1) >= 0 &&
      typeof (parsed as { deleted?: unknown }).deleted === "boolean"
    ) {
      return { kind: "ok", state: parsed as DurableSessionGeneration }
    }
    return { kind: "corrupt", reason: "invalid generation record" }
  } catch (error) {
    return { kind: "corrupt", reason: errMessage(error) }
  }
}

const requireDurableState = async (path: string): Promise<DurableSessionGeneration> => {
  const read = await readDurableSessionGeneration(path)
  if (read.kind === "ok") return read.state
  throw new SessionGenerationStateError(path, read.kind, read.reason)
}

const writeDurableState = async (path: string, state: DurableSessionGeneration): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp.${process.pid}.${crypto.randomUUID().slice(0, 8)}`
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
  try {
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

export const captureDurableSessionGeneration = async (path: string): Promise<number> =>
  (await requireDurableState(path)).generation

export const admitDurableSessionSave = async (
  id: string,
  path: string,
  captured: number,
  create: boolean,
): Promise<number> => {
  const current = await requireDurableState(path)
  if (!create && (current.deleted || current.generation !== captured)) {
    throw new StaleSessionGenerationError(id)
  }
  return current.generation
}

/** Publish a successfully-written replacement snapshot as the new generation.
 * The caller must hold the per-session flock from admission through this
 * commit. Keeping this AFTER the snapshot write means a failed/crashed create
 * leaves an existing delete tombstone authoritative. */
export const commitDurableSessionCreate = async (
  path: string,
  admittedGeneration: number,
): Promise<void> =>
  writeDurableState(path, {
    version: 1,
    generation: admittedGeneration + 1,
    deleted: false,
  })

export const markSessionDeletedDurably = async (path: string): Promise<void> => {
  const current = await requireDurableState(path)
  await writeDurableState(path, {
    version: 1,
    generation: current.generation + 1,
    deleted: true,
  })
}

export const sessionGenerationOf = (id: string): number => generations.get(id) ?? 0

export const isSessionTombstoned = (id: string): boolean => tombstones.has(id)

export const markSessionDeleted = (scopeKey: string): void => {
  tombstones.add(scopeKey)
  generations.set(scopeKey, sessionGenerationOf(scopeKey) + 1)
}

export const admitSessionSave = (
  scopeKey: string,
  captured: number,
  create: boolean,
  sessionId = scopeKey,
): void => {
  if (tombstones.has(scopeKey) && !create) {
    throw new StaleSessionGenerationError(sessionId)
  }
  if (create) {
    tombstones.delete(scopeKey)
    generations.set(scopeKey, sessionGenerationOf(scopeKey) + 1)
    return
  }
  if (sessionGenerationOf(scopeKey) !== captured) {
    throw new StaleSessionGenerationError(sessionId)
  }
}

/** Test-only: drop in-process generation state between cases. */
export const __resetSessionGenerationForTest = (): void => {
  generations.clear()
  tombstones.clear()
}
