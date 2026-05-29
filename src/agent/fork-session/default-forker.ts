/**
 * Default `SessionForker` impl (ADR-0201) + `defaultForker` (ADR-0226).
 *
 * Two factories live here:
 *
 *   - `defaultSessionForker` (ADR-0201) — adapts a
 *     `ConversationCheckpointStore` into the base sync `SessionForker`.
 *     Mints UUID-v4 session ids, reuses the parent's frozen messages
 *     array, records lineage.
 *
 *   - `defaultForker` (ADR-0226) — adapts the base + a `ParentLinkStore`
 *     + an optional `ShadowOdbLike` adapter + a branch-id minter into the
 *     richer `ForkSessionPort`. Honours an injected `AbortSignal`,
 *     accepts an optional `branchName`, writes a `fork-tag` snapshot to
 *     the shadow ODB (when wired), and returns `Err("fork-not-configured")`
 *     when invoked without a base forker.
 *
 * Plane-clean: imports `node:crypto`, `@/shared`, `@/agent/conversation-checkpoint`,
 * and sibling files only — NOT `@/agent/loop` / `@/agent/dispatch` / direct
 * `@/storage/shadow-odb`. The shadow ODB is consumed through a tiny
 * structural `ShadowOdbLike` interface so this slice does not import the
 * concrete storage layer.
 */

import { randomUUID } from "node:crypto"
import { err, errMessage, ok, type Result } from "@/shared"
import type { ConversationCheckpointStore } from "../conversation-checkpoint"
import { defaultBranchIdMinter, isWellFormedBranchId } from "./branch-id"
import { defaultLineage, type Lineage } from "./lineage"
import { defaultParentLinkStore, type ParentLinkStore } from "./parent-link"
import type { BranchInfo, ForkInput, ForkResult, ForkSessionPort, SessionForker } from "./port"
import type { ForkError, ForkedSessionHandle } from "./types"

export interface DefaultSessionForkerOpts {
  /** Injected clock used for `forkedAt`. Default `Date.now`. */
  readonly now?: () => number
  /** Override the UUID minter (tests inject a counter). Default `crypto.randomUUID`. */
  readonly mintSessionId?: () => string
  /** Caller-supplied lineage tracker. When omitted, a fresh `defaultLineage`
   *  is constructed (sharing the same clock). */
  readonly lineage?: Lineage
}

export const defaultSessionForker = (
  store: ConversationCheckpointStore,
  opts?: DefaultSessionForkerOpts,
): SessionForker => {
  const now = opts?.now ?? Date.now
  const mintSessionId = opts?.mintSessionId ?? (() => randomUUID())
  const lineage = opts?.lineage ?? defaultLineage(opts?.now !== undefined ? { now } : {})

  return {
    fork(checkpointId): Result<ForkedSessionHandle, ForkError> {
      const parentMessages = store.restore(checkpointId)
      if (parentMessages === null) {
        return err({
          code: "checkpoint-not-found",
          message: `no snapshot recorded under '${checkpointId}'`,
        })
      }
      const sessionId = mintSessionId()
      // Guard against the extreme-edge case where the minted id collides with
      // an existing snapshot key (the cloneSnapshot policy is no-overwrite).
      const cloned = store.cloneSnapshot(checkpointId, sessionId)
      if (!cloned) {
        return err({
          code: "duplicate-id",
          message: `minted session id '${sessionId}' already exists in the snapshot store`,
        })
      }
      const attached = lineage.attach(sessionId, checkpointId)
      if (!attached.ok) return err(attached.error)
      const handle: ForkedSessionHandle = {
        sessionId,
        parentSessionId: checkpointId,
        parentCheckpointId: checkpointId,
        forkedAt: now(),
        messages: parentMessages,
      }
      return ok(handle)
    },
  }
}

/* ============================================================
 * ADR-0226 — defaultForker (richer ForkSessionPort impl)
 * ============================================================ */

/** Tiny structural mirror of the parts of `@/storage/shadow-odb.ShadowOdb`
 *  the fork slice needs. By keeping this LOCAL we avoid importing the
 *  concrete storage layer here (slice isolation) — the composition root
 *  passes the real `ShadowOdb` and TypeScript's structural typing makes
 *  it satisfy this shape. */
export interface ShadowOdbLike {
  /** Best-effort: record a snapshot of the workspace under a fork-tag ref.
   *  The real `ShadowOdb.registerHead` does the same primary action
   *  (record current worktree) but does NOT take a tag name; we wrap
   *  that with a try/catch and surface failures as
   *  `Err("shadow-odb-failed")`. When this method is undefined / throws,
   *  the fork still proceeds — shadow tagging is BEST-EFFORT, never
   *  required for correctness. */
  readonly registerHead?: (workspaceRoot: string) => Promise<string>
}

/** Options for `defaultForker`. All fields optional — when nothing is
 *  passed and `base` is absent, the resulting port returns
 *  `Err("fork-not-configured")` for every `fork()`. */
export interface DefaultForkerOpts {
  /** The base sync `SessionForker` (typically produced by
   *  `defaultSessionForker`). When absent, every `fork()` call surfaces
   *  `Err("fork-not-configured")` so a default-OFF composition root
   *  produces a typed-error port (NOT a silently-succeeding fake). */
  readonly base?: SessionForker
  /** Parent-link metadata store. Defaults to a fresh
   *  `defaultParentLinkStore()`. */
  readonly links?: ParentLinkStore
  /** Shadow ODB adapter for fork-tag writes. Optional — when absent,
   *  the fork still proceeds; the tag is simply not written. */
  readonly shadowOdb?: ShadowOdbLike
  /** Workspace root passed to `shadowOdb.registerHead`. Required when
   *  `shadowOdb` is wired; ignored otherwise. Tests pass a tmpdir;
   *  production wires the CLI cwd. */
  readonly workspaceRoot?: string
  /** Branch-id minter. Defaults to `defaultBranchIdMinter()`. */
  readonly mintBranchId?: () => string
  /** Injected clock used for `forkedAt`. Default `Date.now`. */
  readonly now?: () => number
}

/** Pre-flight: refuses if base missing / branchName malformed / signal aborted. */
const preFlight = (input: ForkInput, base: SessionForker | undefined): ForkError | null => {
  if (base === undefined) {
    return {
      code: "fork-not-configured",
      message:
        "fork-session: no base SessionForker wired. " +
        "Construct via `defaultForker({ base: defaultSessionForker(store) })`.",
    }
  }
  if (input.branchName !== undefined && !isWellFormedBranchId(input.branchName)) {
    return {
      code: "invalid-branch-name",
      message:
        `fork-session: branchName '${input.branchName}' is not URL-safe ` +
        `(allowed: A-Z, a-z, 0-9, -, _; max 64 chars; no '..').`,
    }
  }
  if (input.signal !== undefined && input.signal.aborted === true) {
    return { code: "aborted", message: "fork-session: aborted before start" }
  }
  return null
}

/** Build the `ParentLink` payload from a fork handle + optional name. */
const linkFromHandle = (
  handle: ForkedSessionHandle,
  forkedAt: number,
  branchName: string | undefined,
): import("./parent-link").ParentLink => {
  const base = {
    childSessionId: handle.sessionId,
    parentSessionId: handle.parentSessionId,
    branchPoint: handle.parentCheckpointId,
    forkedAt,
  }
  return branchName !== undefined ? { ...base, branchName } : base
}

/** Build the public `ForkResult` payload. */
const buildResult = (
  handle: ForkedSessionHandle,
  branchId: string,
  forkedAt: number,
  branchName: string | undefined,
): ForkResult => {
  const base = {
    newSessionId: handle.sessionId,
    parentSessionId: handle.parentSessionId,
    branchPoint: handle.parentCheckpointId,
    branchId,
    forkedAt,
    messages: handle.messages,
  }
  return branchName !== undefined ? { ...base, branchName } : base
}

/** Best-effort shadow ODB tag write. */
const tagShadow = async (
  shadowOdb: ShadowOdbLike | undefined,
  workspaceRoot: string | undefined,
): Promise<ForkError | null> => {
  if (shadowOdb?.registerHead === undefined) return null
  if (typeof workspaceRoot !== "string") return null
  try {
    await shadowOdb.registerHead(workspaceRoot)
    return null
  } catch (e) {
    const msg = errMessage(e)
    return {
      code: "shadow-odb-failed",
      message: `fork-session: shadow ODB tag failed (session forked, link recorded): ${msg}`,
    }
  }
}

export const defaultForker = (opts?: DefaultForkerOpts): ForkSessionPort => {
  const base = opts?.base
  const links = opts?.links ?? defaultParentLinkStore()
  const shadowOdb = opts?.shadowOdb
  const workspaceRoot = opts?.workspaceRoot
  const mintBranchId = opts?.mintBranchId ?? defaultBranchIdMinter()
  const now = opts?.now ?? Date.now

  return {
    async fork(input: ForkInput): Promise<Result<ForkResult, ForkError>> {
      const pre = preFlight(input, base)
      if (pre !== null) return err(pre)
      // `base` is provably defined past `preFlight` (which covers the undefined arm).
      const baseForker = base as SessionForker

      const baseResult = baseForker.fork(input.fromCheckpointRef)
      if (!baseResult.ok) return err(baseResult.error)
      const handle = baseResult.value

      // Re-check abort AFTER base — signal may have flipped while inside.
      const signal = input.signal
      if (signal !== undefined && signal.aborted === true) {
        return err({ code: "aborted", message: "fork-session: aborted before link record" })
      }

      const branchId = mintBranchId()
      const forkedAt = now()

      // Record link BEFORE shadow ODB tag — a tag failure must NOT roll back
      // the link (new session is still usable, only the tag is missing).
      links.record(linkFromHandle(handle, forkedAt, input.branchName))

      const tagErr = await tagShadow(shadowOdb, workspaceRoot)
      if (tagErr !== null) return err(tagErr)

      return ok(buildResult(handle, branchId, forkedAt, input.branchName))
    },

    listBranches(input) {
      const sid = input.sessionId
      if (typeof sid !== "string" || sid.length === 0) return []
      const children = links.listChildren(sid)
      // BranchInfo is structurally identical to ParentLink — direct return.
      return children as ReadonlyArray<BranchInfo>
    },

    resolveParent(input) {
      const sid = input.sessionId
      if (typeof sid !== "string" || sid.length === 0) return null
      const link = links.getByChild(sid)
      return link === null ? null : link.parentSessionId
    },
  }
}
