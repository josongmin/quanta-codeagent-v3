/**
 * JSON-RPC 2.0 envelope (ADR-0033).
 *
 * Strict zod schemas mirroring the JSON-RPC 2.0 specification (https://www.jsonrpc.org/specification)
 * plus a single Codex-inspired extension: an explicit `-timeout` response that
 * uses the implementation-defined error code -32000 and reserves a stable
 * machine-readable `data.kind === "timeout"`.
 *
 * Spec invariants enforced here:
 *   - `jsonrpc` MUST be the string literal "2.0".
 *   - Request `id` MUST be string | number | null (objects/arrays explicitly forbidden by spec §4).
 *   - Notifications MUST NOT carry an `id`.
 *   - A response MUST have either `result` or `error`, never both.
 *   - Error codes are signed 32-bit integers; -32000..-32099 are reserved for
 *     server-defined application errors.
 *
 * Validation never throws — callers go through `codec.ts` which returns
 * `Result<T, JsonRpcCodecError>`. The schemas are exported for the rare case
 * where a caller wants to do `.safeParse` directly.
 */
import { z } from "zod"

/** JSON-RPC 2.0 protocol version literal — spec §3 says this string only. */
export const JSONRPC_VERSION = "2.0" as const

/** Reserved error codes per spec §5.1. */
export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Implementation-defined server-error range starts at -32000. Codex uses
   *  exactly this code for its `-timeout` channel (see ADR-0033). */
  TIMEOUT: -32000,
} as const

/** Spec §4: id MUST be string | number | null. Objects/arrays are explicitly
 *  disallowed (and fractional numbers SHOULD NOT be used — we don't enforce
 *  fractional ban so big integers survive, see big-number test). */
export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()])
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>

/** `params` MAY be omitted; when present MUST be a structured value
 *  (array or object) per spec §4.2. */
export const JsonRpcParamsSchema = z.union([z.record(z.unknown()), z.array(z.unknown())])
export type JsonRpcParams = z.infer<typeof JsonRpcParamsSchema>

/** Strict request — `id` REQUIRED, `params` optional. */
export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: JsonRpcParamsSchema.optional(),
  })
  .strict()
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

/** Notification — `id` ABSENT (spec §4.1). Strict-mode rejects any stray id. */
export const JsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    method: z.string().min(1),
    params: JsonRpcParamsSchema.optional(),
  })
  .strict()
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>

/** Error object per spec §5.1. `data` is optional and MAY be any JSON value. */
export const JsonRpcErrorObjectSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .strict()
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>

/** Success response — has `result`, no `error`. `result` may be any JSON value
 *  (including `null`) but the KEY itself must be present, distinguishing the
 *  success branch from an envelope missing both result and error. */
export const JsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: JsonRpcIdSchema,
    result: z.unknown(),
  })
  .strict()
  .refine((v) => "result" in v, {
    message: "success response must include a `result` key",
    path: ["result"],
  })
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>

/** Error response — has `error`, no `result`. */
export const JsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: JsonRpcIdSchema,
    error: JsonRpcErrorObjectSchema,
  })
  .strict()
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>

/** Union of valid response shapes — exactly one of result / error per spec §5. */
export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
])
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>

/** Codex-style explicit timeout response — an error response whose
 *  `error.code === -32000` AND whose `error.data.kind === "timeout"`.
 *  We model it as a refined ErrorResponse so it remains valid against the
 *  generic union, but callers can use this schema to assert "this specific
 *  error MUST be a timeout". */
export const JsonRpcTimeoutResponseSchema = JsonRpcErrorResponseSchema.refine(
  (resp) =>
    resp.error.code === JSONRPC_ERROR_CODES.TIMEOUT &&
    typeof resp.error.data === "object" &&
    resp.error.data !== null &&
    !Array.isArray(resp.error.data) &&
    (resp.error.data as { kind?: unknown }).kind === "timeout",
  {
    message: "timeout response requires error.code === -32000 and error.data.kind === 'timeout'",
  },
)
export type JsonRpcTimeoutResponse = z.infer<typeof JsonRpcTimeoutResponseSchema>

/** Convenience alias re-exported by index.ts. */
export type JsonRpcError = JsonRpcErrorObject

/** Union over every legal frame on the wire (request | notification | response).
 *  Useful for receivers that demultiplex by inspecting one parsed value. */
export const JsonRpcFrameSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
])
export type JsonRpcFrame = z.infer<typeof JsonRpcFrameSchema>
