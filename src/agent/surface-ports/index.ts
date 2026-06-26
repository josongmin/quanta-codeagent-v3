/** Barrel for the surface-owned port contracts (ADR-0224 / ADR-0225).
 *  See `./port` for why these live in `@/agent` rather than `apps/cli`. */
export type {
  ComposerEditPort,
  PlanEditPort,
  TextInbox,
  TextInboxAddResult,
  TextInboxEntry,
} from "./port"
