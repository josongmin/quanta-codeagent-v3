/**
 * Provider-agnostic durable remote-store layer. Consumers (bench spot-resume,
 * trace artifacts, …) import FROM here; this slice imports nothing from
 * `apps/` or `llm/` — the dependency arrow points one way.
 */
export type { RemoteBackend } from "./backend"
export {
  isResumeEligible,
  type ResumeReceipt,
  type ResumeSecurityReceipt,
  readReceipt,
  sameResumeSecurity,
  writeReceipt,
} from "./resume-receipt"
export {
  makeDefaultRunAws,
  type RunAws,
  type RunAwsResult,
  type S3BackendOptions,
  s3Backend,
} from "./s3-backend"
export { type SegmentStore, segmentStore } from "./segment-store"
