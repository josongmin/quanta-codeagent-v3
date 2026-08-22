/**
 * §9.6 — Anthropic Message Batches API client core (PURE, default-OFF).
 *
 * The Batches API (`POST /v1/messages/batches`) processes Messages-API requests
 * ASYNCHRONOUSLY at 50% of standard price — up to 100K requests / 256MB per
 * batch, most complete within 1h. This is a thin, dependency-light client core:
 * create / retrieve / results / cancel, with an INJECTED `fetch` (test seam),
 * NO-THROW typed-result boundaries, and a Default-OFF posture (importing this
 * module fires no request; only an explicit call hits the network).
 *
 * We hand-roll the HTTP rather than reach for the SDK's `client.messages.batches`
 * because (a) installs are blocked in this tree, and (b) the wire contract is
 * stable spec while the SDK API churns — the same posture the otel-exporter
 * slice took. The wire shapes below are the documented Batches contract (see
 * the claude-api skill `batches.md`).
 *
 * Scope note (V1, per the lane brief): client CORE only. No polling loop, no
 * agent-tool, no host wiring — a composition root drives create→poll→results
 * itself. The shapes are intentionally minimal (only fields a caller acts on);
 * unknown fields pass through untouched on the parsed object.
 *
 * NO-THROW: every method returns `BatchResult<T>` — `{ok:true,value}` or
 * `{ok:false,error}` where the error carries the HTTP status (when the request
 * reached the server) or `undefined` (transport throw). A malformed results
 * line is SKIPPED, not fatal. No method ever throws.
 */

import { errMessage } from "@/shared"
import type { Message, ToolSchema } from "./types"

/** One request inside a batch. `params` is a Messages-API request body subset —
 *  model + max_tokens + messages are required; system/tools/etc. pass through. */
export interface BatchRequest {
  /** Caller-chosen id echoed back on the matching result (≤64 chars). */
  readonly custom_id: string
  readonly params: {
    readonly model: string
    readonly max_tokens: number
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
    readonly system?: unknown
    readonly tools?: ReadonlyArray<ToolSchema>
    // Other Messages-API fields (thinking, tool_choice, …) pass through.
    readonly [k: string]: unknown
  }
}

/** Create-batch request body. */
export interface CreateBatchInput {
  readonly requests: ReadonlyArray<BatchRequest>
}

/** Per-request count breakdown the API reports on a batch. */
export interface BatchRequestCounts {
  readonly processing: number
  readonly succeeded: number
  readonly errored: number
  readonly canceled: number
  readonly expired: number
}

/** Processing status lifecycle: `in_progress` → `ended`; `canceling` after a
 *  cancel. Kept as a string union but TOLERANT — the parser does not reject an
 *  unknown status (the server may add states). */
export type BatchProcessingStatus = "in_progress" | "canceling" | "ended" | (string & {})

/** A parsed batch object (minimal — unknown fields pass through). */
export interface MessageBatch {
  readonly id: string
  readonly processing_status: BatchProcessingStatus
  readonly request_counts: BatchRequestCounts
  readonly [k: string]: unknown
}

/** Per-request outcome inside the results JSONL. `result.type` discriminates
 *  succeeded / errored / canceled / expired (we keep the inner shape loose). */
export interface BatchResultEntry {
  readonly custom_id: string
  readonly result: {
    readonly type: "succeeded" | "errored" | "canceled" | "expired" | (string & {})
    readonly message?: Message
    readonly error?: unknown
    readonly [k: string]: unknown
  }
}

/** A no-throw typed result. */
export type BatchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BatchError }

/** Error carried by a failed {@link BatchResult}. `status` is the HTTP status
 *  when the request reached the server, or `undefined` on a transport throw. */
export interface BatchError {
  /** HTTP status, or `undefined` when `fetch` itself threw (no response). */
  readonly status?: number
  /** Human-readable summary (provider error `type`/`message` when available). */
  readonly message: string
}

export interface MessageBatchesClientOpts {
  /** API key sent as `x-api-key`. */
  readonly apiKey: string
  /** API base URL. Default `https://api.anthropic.com`. Trailing slash stripped. */
  readonly baseUrl?: string
  /** `fetch` implementation. Default = global `fetch`. Test seam. */
  readonly fetch?: typeof fetch
  /** `anthropic-version` header. Default `2023-06-01`. */
  readonly anthropicVersion?: string
  /** Extra headers merged onto every request (e.g. an `anthropic-beta`). */
  readonly headers?: Readonly<Record<string, string>>
}

export interface MessageBatchesClient {
  /** Create a batch. POST `/v1/messages/batches`. */
  create(input: CreateBatchInput): Promise<BatchResult<MessageBatch>>
  /** Retrieve a batch by id. GET `/v1/messages/batches/{id}`. */
  retrieve(batchId: string): Promise<BatchResult<MessageBatch>>
  /** Fetch + parse the results JSONL. GET `/v1/messages/batches/{id}/results`.
   *  Malformed lines are SKIPPED (no-throw). */
  results(batchId: string): Promise<BatchResult<BatchResultEntry[]>>
  /** Request cancellation. POST `/v1/messages/batches/{id}/cancel`. */
  cancel(batchId: string): Promise<BatchResult<MessageBatch>>
}

const DEFAULT_BASE = "https://api.anthropic.com"
const DEFAULT_VERSION = "2023-06-01"
const BATCHES_PATH = "/v1/messages/batches"

/** Extract a provider error label from a response body (best-effort). */
const errorLabel = (body: string, status: number): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } }
    const type = parsed.error?.type
    const msg = parsed.error?.message
    if (type !== undefined || msg !== undefined) {
      return `${type ?? "error"}: ${msg ?? ""}`.trim()
    }
  } catch {
    // body not JSON — fall through to the status label
  }
  return `HTTP ${status}`
}

/** Parse a results JSONL body, skipping blank and malformed lines (no-throw). */
const parseResultsJsonl = (body: string): BatchResultEntry[] => {
  const out: BatchResultEntry[] = []
  for (const raw of body.split("\n")) {
    const line = raw.trim()
    if (line === "") continue
    try {
      out.push(JSON.parse(line) as BatchResultEntry)
    } catch {
      // skip a malformed line; a single bad record must not drop the batch
    }
  }
  return out
}

export const createMessageBatchesClient = (
  opts: MessageBatchesClientOpts,
): MessageBatchesClient => {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch)
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "")
  const version = opts.anthropicVersion ?? DEFAULT_VERSION

  const headers = (): Record<string, string> => ({
    "x-api-key": opts.apiKey,
    "anthropic-version": version,
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  })

  /** One request → typed BatchResult<T>. No-throw: every failure path returns
   *  `{ok:false}`. `parse` maps a 2xx body string to T. */
  const request = async <T>(
    method: "GET" | "POST",
    path: string,
    parse: (body: string) => T,
    body?: unknown,
  ): Promise<BatchResult<T>> => {
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      // transport throw — no response, status undefined.
      return { ok: false, error: { message: errMessage(e) } }
    }
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      return { ok: false, error: { status: res.status, message: errMessage(e) } }
    }
    if (!res.ok) {
      return { ok: false, error: { status: res.status, message: errorLabel(text, res.status) } }
    }
    try {
      return { ok: true, value: parse(text) }
    } catch (e) {
      // a 2xx body that does not parse to T — surface as a no-throw error.
      return { ok: false, error: { status: res.status, message: `parse: ${errMessage(e)}` } }
    }
  }

  const parseBatch = (body: string): MessageBatch => JSON.parse(body) as MessageBatch

  return {
    create(input) {
      return request("POST", BATCHES_PATH, parseBatch, input)
    },
    retrieve(batchId) {
      return request("GET", `${BATCHES_PATH}/${encodeURIComponent(batchId)}`, parseBatch)
    },
    results(batchId) {
      return request(
        "GET",
        `${BATCHES_PATH}/${encodeURIComponent(batchId)}/results`,
        parseResultsJsonl,
      )
    },
    cancel(batchId) {
      return request("POST", `${BATCHES_PATH}/${encodeURIComponent(batchId)}/cancel`, parseBatch)
    },
  }
}
