/** ADR-0470 (jun-04) — MCP sampling slice (inbound `sampling/createMessage`). */

export { headlessSamplingRejecter } from "./headless-rejecter"
export {
  isSamplingMethod,
  MCP_SAMPLING_METHOD,
  routeSampling,
  SAMPLING_DECLINED_CODE,
  type SamplingResponse,
} from "./inbound-router"
export type {
  CreateMessageRequest,
  CreateMessageResult,
  SamplingDeclineReason,
  SamplingHandlerPort,
  SamplingMessage,
  SamplingOutcome,
} from "./port"
