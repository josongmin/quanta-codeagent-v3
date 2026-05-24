/**
 * SessionForker port (ADR-0201).
 *
 * Closed-port DI seam. The default-impl in `./default-forker.ts` adapts a
 * `ConversationCheckpointStore` (ADR-0124) into this surface; future
 * test-doubles satisfy the port without reaching into the slice internals.
 *
 * Plane-clean: imports only `@/shared` for `Result` + sibling types. No
 * `@/agent/loop`, no `@/agent/dispatch`.
 */

import type { Result } from "@/shared"
import type { ForkError, ForkedSessionHandle } from "./types"

export interface SessionForker {
  /** Fork a new session from the snapshot recorded under `checkpointId`. The
   *  snapshot is reused verbatim (immutable, shared) and registered under a
   *  freshly-minted `sessionId` (UUID v4). Lineage is recorded so the parent
   *  can be recovered via `ConversationCheckpointStore.lineageOf`. */
  fork(checkpointId: string): Result<ForkedSessionHandle, ForkError>
}
