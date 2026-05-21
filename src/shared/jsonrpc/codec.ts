/**
 * JSON-RPC 2.0 codec — encode/decode helpers that return `Result`.
 *
 * Rules:
 *   - Decoders NEVER throw on malformed input. Bad JSON, missing fields,
 *     extra keys, wrong types — all surface as `err(...)` so the caller can
 *     decide whether to disconnect / reply with -32600 / log / retry.
 *   - Encoders throw only on PROGRAMMER errors (e.g. building a request
 *     without a method). The constructed object is then strict-validated
 *     before being serialised, so any encoder bug fails loudly in tests.
 *   - JSON.stringify is the only serialiser. We use it with default key
 *     ordering — JSON-RPC 2.0 does not require canonical key ordering, and
 *     adding it here would diverge from every existing peer (mcp, lsp,
 *     codex). Session JSONL (a separate concern) DOES canonicalise; see
 *     `src/session/envelope-encoder.ts`.
 */
import { err, ok, type Result } from "@/shared/types"
import {
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  type JsonRpcErrorObject,
  type JsonRpcErrorResponse,
  type JsonRpcFrame,
  JsonRpcFrameSchema,
  type JsonRpcId,
  type JsonRpcNotification,
  JsonRpcNotificationSchema,
  type JsonRpcParams,
  type JsonRpcRequest,
  JsonRpcRequestSchema,
  type JsonRpcResponse,
  JsonRpcResponseSchema,
  type JsonRpcSuccessResponse,
  type JsonRpcTimeoutResponse,
  JsonRpcTimeoutResponseSchema,
} from "./envelope"

/** Discriminator for codec failures so callers can branch precisely. */
export type JsonRpcCodecErrorKind =
  | "parse_json"
  | "schema_envelope"
  | "schema_request"
  | "schema_response"
  | "schema_notification"
  | "schema_timeout"
  | "version_mismatch"

export class JsonRpcCodecError extends Error {
  readonly kind: JsonRpcCodecErrorKind
  readonly issues: readonly string[]
  constructor(kind: JsonRpcCodecErrorKind, message: string, issues: readonly string[] = []) {
    super(message)
    this.name = "JsonRpcCodecError"
    this.kind = kind
    this.issues = issues
  }
}

/* ------------------------------------------------------------------ */
/* encoders                                                            */
/* ------------------------------------------------------------------ */

/** Build a request frame. Throws on programmer error (empty method). */
export const encodeRequest = (args: {
  id: JsonRpcId
  method: string
  params?: JsonRpcParams
}): string => {
  if (args.method.length === 0) {
    throw new JsonRpcCodecError(
      "schema_request",
      "encodeRequest: method must be a non-empty string",
    )
  }
  const frame: JsonRpcRequest =
    args.params === undefined
      ? { jsonrpc: JSONRPC_VERSION, id: args.id, method: args.method }
      : { jsonrpc: JSONRPC_VERSION, id: args.id, method: args.method, params: args.params }
  // Strict re-parse defends against any future drift in the constructor above.
  const check = JsonRpcRequestSchema.safeParse(frame)
  if (!check.success) {
    throw new JsonRpcCodecError(
      "schema_request",
      "encodeRequest produced an invalid request — programmer error",
      check.error.issues.map(formatIssue),
    )
  }
  return JSON.stringify(frame)
}

export const encodeNotification = (args: { method: string; params?: JsonRpcParams }): string => {
  if (args.method.length === 0) {
    throw new JsonRpcCodecError(
      "schema_notification",
      "encodeNotification: method must be a non-empty string",
    )
  }
  const frame: JsonRpcNotification =
    args.params === undefined
      ? { jsonrpc: JSONRPC_VERSION, method: args.method }
      : { jsonrpc: JSONRPC_VERSION, method: args.method, params: args.params }
  const check = JsonRpcNotificationSchema.safeParse(frame)
  if (!check.success) {
    throw new JsonRpcCodecError(
      "schema_notification",
      "encodeNotification produced an invalid notification — programmer error",
      check.error.issues.map(formatIssue),
    )
  }
  return JSON.stringify(frame)
}

export const encodeResponse = (args: { id: JsonRpcId; result: unknown }): string => {
  const frame: JsonRpcSuccessResponse = {
    jsonrpc: JSONRPC_VERSION,
    id: args.id,
    result: args.result,
  }
  // No schema check on `result: unknown` — by design any JSON-serialisable
  // value is legal. JSON.stringify on a non-serialisable value (BigInt,
  // function) throws naturally; that IS a programmer error.
  return JSON.stringify(frame)
}

export const encodeError = (args: {
  id: JsonRpcId
  code: number
  message: string
  data?: unknown
}): string => {
  const errObj: JsonRpcErrorObject =
    args.data === undefined
      ? { code: args.code, message: args.message }
      : { code: args.code, message: args.message, data: args.data }
  const frame: JsonRpcErrorResponse = {
    jsonrpc: JSONRPC_VERSION,
    id: args.id,
    error: errObj,
  }
  return JSON.stringify(frame)
}

/** Codex-style explicit -timeout encoding: error.code === -32000 +
 *  data.kind === "timeout". Any extra diagnostic fields go into `details`. */
export const encodeTimeout = (args: {
  id: JsonRpcId
  message?: string
  elapsedMs?: number
  details?: Record<string, unknown>
}): string => {
  const data: Record<string, unknown> = { kind: "timeout" }
  if (args.elapsedMs !== undefined) data.elapsedMs = args.elapsedMs
  if (args.details !== undefined) data.details = args.details
  return encodeError({
    id: args.id,
    code: JSONRPC_ERROR_CODES.TIMEOUT,
    message: args.message ?? "request timed out",
    data,
  })
}

/* ------------------------------------------------------------------ */
/* decoders                                                            */
/* ------------------------------------------------------------------ */

const parseJson = (input: string): Result<unknown, JsonRpcCodecError> => {
  try {
    return ok(JSON.parse(input) as unknown)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return err(new JsonRpcCodecError("parse_json", `invalid JSON: ${msg}`))
  }
}

const formatIssue = (i: { path: ReadonlyArray<string | number>; message: string }): string =>
  `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`

export const decodeFrame = (input: string): Result<JsonRpcFrame, JsonRpcCodecError> => {
  const parsed = parseJson(input)
  if (!parsed.ok) return parsed
  const v = JsonRpcFrameSchema.safeParse(parsed.value)
  if (!v.success) {
    // Version-mismatch is a distinct user-facing case so callers can decide
    // whether to drop the peer / log loudly. Detect it specifically.
    const versionIssue = v.error.issues.find(
      (i) => i.path[0] === "jsonrpc" || i.code === "invalid_literal" || i.code === "invalid_union",
    )
    const candidate = parsed.value as { jsonrpc?: unknown }
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "jsonrpc" in candidate &&
      candidate.jsonrpc !== JSONRPC_VERSION &&
      versionIssue !== undefined
    ) {
      return err(
        new JsonRpcCodecError(
          "version_mismatch",
          `jsonrpc version must be "${JSONRPC_VERSION}" (got ${JSON.stringify(candidate.jsonrpc)})`,
          v.error.issues.map(formatIssue),
        ),
      )
    }
    return err(
      new JsonRpcCodecError(
        "schema_envelope",
        "frame failed JSON-RPC envelope validation",
        v.error.issues.map(formatIssue),
      ),
    )
  }
  return ok(v.data)
}

export const decodeRequest = (input: string): Result<JsonRpcRequest, JsonRpcCodecError> => {
  const parsed = parseJson(input)
  if (!parsed.ok) return parsed
  const v = JsonRpcRequestSchema.safeParse(parsed.value)
  if (!v.success) {
    return err(
      new JsonRpcCodecError(
        "schema_request",
        "input is not a valid JSON-RPC request",
        v.error.issues.map(formatIssue),
      ),
    )
  }
  return ok(v.data)
}

export const decodeNotification = (
  input: string,
): Result<JsonRpcNotification, JsonRpcCodecError> => {
  const parsed = parseJson(input)
  if (!parsed.ok) return parsed
  const v = JsonRpcNotificationSchema.safeParse(parsed.value)
  if (!v.success) {
    return err(
      new JsonRpcCodecError(
        "schema_notification",
        "input is not a valid JSON-RPC notification",
        v.error.issues.map(formatIssue),
      ),
    )
  }
  return ok(v.data)
}

export const decodeResponse = (input: string): Result<JsonRpcResponse, JsonRpcCodecError> => {
  const parsed = parseJson(input)
  if (!parsed.ok) return parsed
  const v = JsonRpcResponseSchema.safeParse(parsed.value)
  if (!v.success) {
    return err(
      new JsonRpcCodecError(
        "schema_response",
        "input is not a valid JSON-RPC response",
        v.error.issues.map(formatIssue),
      ),
    )
  }
  return ok(v.data)
}

export const decodeTimeout = (input: string): Result<JsonRpcTimeoutResponse, JsonRpcCodecError> => {
  const parsed = parseJson(input)
  if (!parsed.ok) return parsed
  const v = JsonRpcTimeoutResponseSchema.safeParse(parsed.value)
  if (!v.success) {
    return err(
      new JsonRpcCodecError(
        "schema_timeout",
        "input is not a valid JSON-RPC timeout response",
        v.error.issues.map(formatIssue),
      ),
    )
  }
  return ok(v.data)
}
