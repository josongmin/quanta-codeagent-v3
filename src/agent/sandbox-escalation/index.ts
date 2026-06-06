/**
 * RFC jun-6 — sandbox-block → escalation-retry loop (default-OFF, security-
 * careful). The OS-sandbox block discriminant (`@/runtime/os-sandbox`
 * `classifySandboxDenial`) feeds the EXISTING post-denial 3-step re-approval
 * machine (ADR-0046) to offer a user-gated unsandboxed re-run of the byte-same
 * argv, capped per turn. Escalation NEVER auto-grants.
 */
export {
  createSandboxEscalationCap,
  DEFAULT_SANDBOX_ESCALATION_MAX,
  type EscalationAdmission,
  type EscalationCapKey,
  type SandboxEscalationCap,
} from "./cap"
export {
  type EscalationAuditEntry,
  type EscalationRequest,
  type EscalationRiskContext,
  type GateDecision,
  type RiskPresentation,
  runSandboxEscalation,
  type SandboxEscalationDeps,
  type SandboxEscalationOutcome,
  seedSandboxBlockDenial,
  type UnsandboxedRerunResult,
} from "./orchestrator"
