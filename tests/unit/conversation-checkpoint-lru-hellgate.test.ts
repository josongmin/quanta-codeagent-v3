/**
 * ConversationCheckpointStore — lru-cache-backed hellgate (ADR-0184).
 * Parity cases: `_parity/checkpoint-parity.ts` (same 23 invariants as Map impl).
 */

import { lruConversationCheckpointStore } from "@/agent/conversation-checkpoint-lru"
import {
  registerCheckpointParitySuite,
  type CheckpointParityHarness,
} from "./_parity/checkpoint-parity"

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}

const harness: CheckpointParityHarness = {
  describeLabel: "lruConversationCheckpointStore",
  idPrefix: "LRU-",
  fresh: (maxEntries = 50) => lruConversationCheckpointStore({ maxEntries, now: tick }),
  storeAtZeroCap: () => lruConversationCheckpointStore({ maxEntries: 0, now: tick }),
  storeWithClock: (now) => lruConversationCheckpointStore({ now }),
  storeWithDefaultClock: () => lruConversationCheckpointStore(),
}

registerCheckpointParitySuite(harness)
