/**
 * `@/shared/jsonrpc` — standalone JSON-RPC 2.0 envelope + Codex-style channel triple.
 *
 * Integration with existing `src/mcp/jsonrpc.ts` and `src/lsp/adapters/jsonrpc.ts`
 * is INTENTIONALLY deferred (ADR-0033 §대안). Those files are concurrently
 * in-flight on main and a single later ADR will migrate them in one diff.
 */

export type {
  ChannelKind,
  ChannelTriple,
} from "./channel-naming"
export { channelTriple, parseChannelBase, parseChannelKind } from "./channel-naming"

export type { JsonRpcCodecErrorKind } from "./codec"
export {
  decodeFrame,
  decodeNotification,
  decodeRequest,
  decodeResponse,
  decodeTimeout,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  encodeTimeout,
  JsonRpcCodecError,
} from "./codec"
export type { RequestId, RequestIdGenerator } from "./correlation"
export { brandRequestId, createRequestIdGenerator, nextRequestId } from "./correlation"
export type {
  JsonRpcError,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcFrame,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcParams,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcTimeoutResponse,
} from "./envelope"
export {
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JsonRpcErrorObjectSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcFrameSchema,
  JsonRpcIdSchema,
  JsonRpcNotificationSchema,
  JsonRpcParamsSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  JsonRpcSuccessResponseSchema,
  JsonRpcTimeoutResponseSchema,
} from "./envelope"
