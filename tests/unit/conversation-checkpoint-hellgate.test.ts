/**
 * ConversationCheckpointStore — Map-backed hellgate (ADR-0124).
 * Parity cases: `_parity/checkpoint-parity.ts`.
 */

import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
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
  describeLabel: "ConversationCheckpointStore",
  idPrefix: "HELL-",
  fresh: (maxEntries = 50) => defaultConversationCheckpointStore({ maxEntries, now: tick }),
  storeAtZeroCap: () => defaultConversationCheckpointStore({ maxEntries: 0, now: tick }),
  storeWithClock: (now) => defaultConversationCheckpointStore({ now }),
  storeWithDefaultClock: () => defaultConversationCheckpointStore(),
}

registerCheckpointParitySuite(harness)
