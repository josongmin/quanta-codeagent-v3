/**
 * Provider-agnostic durable remote-store layer. Consumers (bench spot-resume,
 * trace artifacts, …) import FROM here; this slice imports nothing from
 * `apps/` or `llm/` — the dependency arrow points one way.
 */
export type { RemoteBackend } from "./backend"
export { type SegmentStore, segmentStore } from "./segment-store"
export {
  isResumeEligible,
  readReceipt,
  type ResumeReceipt,
  writeReceipt,
} from "./resume-receipt"
export { type RunAwsResult, type S3BackendOptions, s3Backend } from "./s3-backend"
