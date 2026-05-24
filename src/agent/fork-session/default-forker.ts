/**
 * Default `SessionForker` impl (ADR-0201).
 *
 * Adapts a `ConversationCheckpointStore` (ADR-0124, with the `cloneSnapshot` /
 * `lineageOf` extensions) into the `SessionForker` port. Mints a fresh session
 * id via `crypto.randomUUID()` (v4), reuses the parent's FROZEN messages
 * array (no copy), and records the lineage in both the store's internal
 * lineage map AND the sibling `Lineage` tracker (so a cycle attempt is
 * rejected up-front and the chain walk is cheap).
 *
 * Plane-clean: imports `node:crypto`, `@/shared`, `@/agent/conversation-checkpoint`,
 * and sibling files only — NOT `@/agent/loop` / `@/agent/dispatch`.
 */

import { randomUUID } from "node:crypto"
import { err, ok, type Result } from "@/shared"
import type { ConversationCheckpointStore } from "../conversation-checkpoint"
import { defaultLineage, type Lineage } from "./lineage"
import type { SessionForker } from "./port"
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
