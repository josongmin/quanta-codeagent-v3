/** Edit-repair-loop slice barrel (ADR-0472). */
export { computeLintDelta, diagnosticKey, renderLintDelta } from "./lint-delta"
export { editRepairLoopEnabled, runRepairLoop } from "./runner"
export type {
  CheckKind,
  Diagnostic,
  DiagnosticsProvider,
  RepairAttempt,
  RepairCheck,
  RepairFailure,
  RepairIterationLog,
  RepairLoopConfig,
  RepairLoopDeps,
  RepairLoopReport,
  RepairReactorPort,
  RepairRequest,
  RepairStopReason,
} from "./types"
export { EDIT_REPAIR_LOOP_ENV } from "./types"
