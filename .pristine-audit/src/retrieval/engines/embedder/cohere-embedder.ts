/**
 * Cohere embedder adapter — ADR-0261.
 *
 *   POST https://api.cohere.com/v1/embed
 *   Headers: Authorization: Bearer ${COHERE_API_KEY}
 *   Body:    { model, texts: string[], input_type: "search_document" }
 *   Resp:    { embeddings: number[][], meta?: { billed_units?: { input_tokens } } }
 */
import { err, ok, type Result } from "@/shared"
import { checkInputBytes, type FetchFn, runEmbedRequest } from "./_http"
import type { Embedder } from "./port"
import type { EmbedderCapabilities, EmbedError, EmbedResult } from "./types"

export type { FetchFn } from "./_http"

export interface CohereEmbedderOptions {
  readonly apiKey?: string | undefined
  readonly model?: string
  readonly baseURL?: string
  readonly dim?: number
  readonly batchSize?: number
  readonly maxInputBytes?: number
  readonly inputType?: "search_document" | "search_query" | "classification" | "clustering"
  readonly fetchImpl?: FetchFn
}

const DEFAULT_MODEL = "embed-english-v3.0"
const DEFAULT_BASE = "https://api.cohere.com/v1"
const DEFAULT_DIM = 1024
const DEFAULT_BATCH = 96
const DEFAULT_MAX_BYTES = 16 * 1024

interface CohereResp {
  readonly embeddings?: ReadonlyArray<readonly number[]>
  readonly meta?: { readonly billed_units?: { readonly input_tokens?: number } }
}

const decodeCohere = (parsed: CohereResp, expectedLen: number): Result<number[][], EmbedError> => {
  const emb = parsed.embeddings
  if (emb === undefined || !Array.isArray(emb) || emb.length !== expectedLen) {
    return err({ kind: "invalid-response", detail: "missing/length-mismatch embeddings[]" })
  }
  return ok(emb.map((v) => [...v]))
}

export const createCohereEmbedder = (opts: CohereEmbedderOptions): Embedder => {
  const model = opts.model ?? DEFAULT_MODEL
  const baseURL = opts.baseURL ?? DEFAULT_BASE
  const dim = opts.dim ?? DEFAULT_DIM
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  const maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_BYTES
  const inputType = opts.inputType ?? "search_document"
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const modelTag = `cohere:${model}`

  const caps: EmbedderCapabilities = { dim, maxInputBytes, batchSize, modelTag }

  return {
    async embed(
      input: string | readonly string[],
      callOpts?: { readonly signal?: AbortSignal },
    ): Promise<Result<EmbedResult, EmbedError>> {
      if (callOpts?.signal?.aborted === true) return err({ kind: "aborted" })
      const apiKey = opts.apiKey
      if (apiKey === undefined || apiKey === "") {
        return err({ kind: "missing-api-key", provider: "cohere" })
      }
      const items = typeof input === "string" ? [input] : input
      const tooLarge = checkInputBytes(items, maxInputBytes)
      if (tooLarge !== null) return err(tooLarge)
      const parsed = await runEmbedRequest<CohereResp>(
        `${baseURL}/embed`,
        { model, texts: items, input_type: inputType },
        { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        callOpts?.signal,
        fetchImpl,
      )
      if (!parsed.ok) return parsed
      const decoded = decodeCohere(parsed.value, items.length)
      if (!decoded.ok) return decoded
      const tokenCount = parsed.value.meta?.billed_units?.input_tokens
      return ok(
        tokenCount === undefined
          ? { vectors: decoded.value, modelTag }
          : { vectors: decoded.value, modelTag, tokenCount },
      )
    },
    async capabilities(): Promise<EmbedderCapabilities> {
      return caps
    },
  }
}
