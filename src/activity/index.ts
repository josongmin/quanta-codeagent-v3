/**
 * Agent Activity Spine — public barrel (jun-15 P0-a).
 *
 * The canonical model + pure reducer + derived projections + producer adapters.
 * Surfaces (CLI `/activity`, Web Mission Control, embedded) consume `materialize`
 * + `projectFleet`/`projectTree`; host wiring feeds `reduceActivity` with events
 * from the producers. Pure-of-I/O leaf: imports only its own files + node types.
 */

export {
  type FleetRowLike,
  fleetRowToActivity,
  fleetRowToItemStream,
  fleetToActivity,
  fleetToItemStream,
  pumpFleetRowsToItemStream,
} from "./producers/fleet"
export {
  type SideAgentSnapshotLike,
  type SideAgentStatusLike,
  sideAgentsToActivity,
  sideAgentToActivity,
} from "./producers/side-agent"
export {
  type WorkflowEventLike,
  type WorkflowToActivityOpts,
  workflowCloseActivity,
  workflowToActivity,
} from "./producers/workflow"
export {
  type WorktreeOpenOpts,
  type WorktreeSettledKind,
  type WorktreeStep,
  type WorktreeStepOutcome,
  worktreeOpenActivity,
  worktreeOpNodeId,
  worktreeSettleActivity,
  worktreeStepId,
  worktreeStepOpen,
  worktreeStepSettle,
} from "./producers/worktree"
export {
  INDETERMINATE,
  mergeProgress,
  type Progress,
  progressEquals,
  toProgress,
} from "./progress"
export {
  type ActivityTreeNode,
  type FleetRow,
  projectFleet,
  projectTree,
} from "./project"
export { formatAge, type RenderActivityOpts, renderActivity } from "./render"
export {
  type ActivityState,
  emptyActivityState,
  materialize,
  reduceActivity,
  reduceAll,
} from "./spine"
export {
  type ActivityStore,
  createActivityStore,
  createWorkflowSink,
  seedStoreFromSnapshot,
  type WorkflowSink,
  type WorkflowSinkOpts,
} from "./store"
export {
  type ActivityChange,
  type ActivityListener,
  type ActivitySeqSource,
  type ActivitySnapshotReader,
  type ActivitySubscription,
  createActivitySubscription,
  type RawActivitySource,
  type SubscribeOptions,
} from "./subscription"
export type {
  ActivityAggregate,
  ActivityEvent,
  ActivityKind,
  ActivityNode,
  ActivitySnapshot,
  ActivityStatus,
  AgentActivityEvent,
  NodeInit,
  NodeProgressEvent,
  OperationCorrelation,
  Stuck,
  StuckReason,
} from "./types"
