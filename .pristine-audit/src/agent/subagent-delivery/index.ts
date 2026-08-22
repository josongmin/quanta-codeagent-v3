/**
 * Subagent-delivery slice barrel (RFC jul-18). The canonical command contract
 * (WS1), control endpoint/port shapes (WS2), the decide/apply controller (WS3),
 * and the host target-resolver adapter.
 */

export {
  createSubagentDeliveryController,
  createSubagentSteerFinalization,
  type DeliveryMailboxPort,
  makeSteerRetentionStore,
  type PeerFormatter,
  type RetainedSteer,
  type SteerFinalizationDeps,
  type SteerRetentionStore,
  type SubagentDeliveryControllerDeps,
  type TargetResolution,
} from "./controller"
export type {
  DeliveryIdFactory,
  InterruptControlOutcome,
  PeerEnvelope,
  SteerSubmitOutcome,
  SubagentControlEndpoint,
  SubagentControlRegistry,
  SubagentDeliveryPort,
  SubagentSteerFinalizationPort,
  SubagentSteerSubmission,
  WakeControlOutcome,
} from "./ports"
export { createTargetResolver, type TargetResolverDeps } from "./target-resolver"
export {
  ALL_DELIVERY_DEGRADE_REASONS,
  ALL_DELIVERY_REJECT_REASONS,
  type DeliveryDegradeReason,
  type DeliveryRejectReason,
  type SubagentDeliveryOutcome,
  type SubagentDeliveryReceipt,
  type SubagentDeliveryRequest,
  steerRejectionToDelivery,
} from "./types"
