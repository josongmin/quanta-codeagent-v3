/** `@/tool/ci-finding` — structured CI-investigation finding slice (§7.3). */
export {
  type CiFinding,
  type CiFindingCategory,
  type CiFindingConfidence,
  type CiFindingInput as CiFindingRecordInput,
  type CiFindingStore,
  type CiFindingStoreOpts,
  createCiFindingStore,
  renderFinding,
  renderFindings,
} from "./store"
export { type CiFindingInput, ciFindingSchema, ciFindingTool } from "./tool"
