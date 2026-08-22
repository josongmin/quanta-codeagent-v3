/**
 * OpenAI embedder adapter — ADR-0261.
 *
 *   POST https://api.openai.com/v1/embeddings
 *   Headers: Authorization: Bearer ${OPENAI_API_KEY}
 *   Body:    { model, input: string | string[] }
 *   Resp:    { data: [{ embedding: number[] }], usage?: { total_tokens } }
 *
 * Transport (`fetch`) is INJECTED so the slice never imports an SDK and
 * tests stay offline. Per ADR-0159 the slice depends on `@/shared` only.
 */
import { err, ok, type Result } from "@/shared"
import { checkInputBytes, type FetchFn, runEmbedRequest } from "./_http"
import type { Embedder } from "./port"
import type { EmbedderCapabilities, EmbedError, EmbedResult } from "./types"

export type { FetchFn } from "./_http"

export interface OpenAIEmbedderOptions {
  readonly apiKey?: string | undefined
  readonly model?: string
  readonly baseURL?: string
  readonly dim?: number
  readonly batchSize?: number
  readonly maxInputBytes?: number
  readonly fetchImpl?: FetchFn
}

const DEFAULT_MODEL = "text-embedding-3-small"
const DEFAULT_BASE = "https://api.openai.com/v1"
const DEFAULT_DIM = 1536
const DEFAULT_BATCH = 96
const DEFAULT_MAX_BYTES = 8192 * 4

const inferDim = (model: string, override: number | undefined): number => {
  if (override !== undefined) return override
  if (model.endsWith("-large")) return 3072
  if (model.endsWith("-small")) return 1536
  return DEFAULT_DIM
}

interface OpenAIResp {
  readonly data?: ReadonlyArray<{ readonly embedding?: readonly number[] }>
  readonly usage?: { readonly total_tokens?: number }
}

const decodeOpenAI = (parsed: OpenAIResp, expectedLen: number): Result<number[][], EmbedError> => {
  const data = parsed.data
  if (data === undefined || !Array.isArray(data) || data.length !== expectedLen) {
    return err({ kind: "invalid-response", detail: "missing/length-mismatch data[]" })
  }
  const vectors: number[][] = []
  for (const d of data) {
    const v = d.embedding
    if (v === undefined || !Array.isArray(v)) {
      return err({ kind: "invalid-response", detail: "missing embedding" })
    }
    vectors.push([...v])
  }
  return ok(vectors)
}

export const createOpenAIEmbedder = (opts: OpenAIEmbedderOptions): Embedder => {
  const model = opts.model ?? DEFAULT_MODEL
  const baseURL = opts.baseURL ?? DEFAULT_BASE
  const dim = inferDim(model, opts.dim)
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  const maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_BYTES
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const modelTag = `openai:${model}`

  const caps: EmbedderCapabilities = { dim, maxInputBytes, batchSize, modelTag }

  return {
    async embed(
      input: string | readonly string[],
      callOpts?: { readonly signal?: AbortSignal },
    ): Promise<Result<EmbedResult, EmbedError>> {
      if (callOpts?.signal?.aborted === true) return err({ kind: "aborted" })
      const apiKey = opts.apiKey
      if (apiKey === undefined || apiKey === "") {
        return err({ kind: "missing-api-key", provider: "openai" })
      }
      const items = typeof input === "string" ? [input] : input
      const tooLarge = checkInputBytes(items, maxInputBytes)
      if (tooLarge !== null) return err(tooLarge)
      const parsed = await runEmbedRequest<OpenAIResp>(
        `${baseURL}/embeddings`,
        { model, input: items },
        { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        callOpts?.signal,
        fetchImpl,
      )
      if (!parsed.ok) return parsed
      const decoded = decodeOpenAI(parsed.value, items.length)
      if (!decoded.ok) return decoded
      const tokenCount = parsed.value.usage?.total_tokens
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
