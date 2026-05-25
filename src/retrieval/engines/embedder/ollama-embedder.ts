/**
 * Ollama local-fallback embedder adapter — ADR-0261.
 *
 *   POST http://localhost:11434/api/embeddings
 *   Body:  { model, prompt: string }    // Ollama is one-prompt-per-call
 *   Resp:  { embedding: number[] }
 *
 * Ollama does not expose an API key — `missing-api-key` is NEVER returned
 * here. Batch input is handled by iterating sequentially — matches
 * Ollama's one-prompt contract.
 */
import { err, ok, type Result } from "@/shared"
import { checkInputBytes, type FetchFn, runEmbedRequest } from "./_http"
import type { Embedder } from "./port"
import type { EmbedderCapabilities, EmbedError, EmbedResult } from "./types"

export type { FetchFn } from "./_http"

export interface OllamaEmbedderOptions {
  readonly model?: string
  readonly baseURL?: string
  readonly dim?: number
  readonly batchSize?: number
  readonly maxInputBytes?: number
  readonly fetchImpl?: FetchFn
}

const DEFAULT_MODEL = "nomic-embed-text"
const DEFAULT_BASE = "http://localhost:11434"
const DEFAULT_DIM = 768
const DEFAULT_BATCH = 1
const DEFAULT_MAX_BYTES = 32 * 1024

interface OllamaResp {
  readonly embedding?: readonly number[]
}

export const createOllamaEmbedder = (opts: OllamaEmbedderOptions = {}): Embedder => {
  const model = opts.model ?? DEFAULT_MODEL
  const baseURL = opts.baseURL ?? DEFAULT_BASE
  const dim = opts.dim ?? DEFAULT_DIM
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  const maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_BYTES
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const modelTag = `ollama:${model}`

  const caps: EmbedderCapabilities = { dim, maxInputBytes, batchSize, modelTag }

  const callOne = async (
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<readonly number[], EmbedError>> => {
    const parsed = await runEmbedRequest<OllamaResp>(
      `${baseURL}/api/embeddings`,
      { model, prompt },
      { "content-type": "application/json" },
      signal,
      fetchImpl,
    )
    if (!parsed.ok) return parsed
    const emb = parsed.value.embedding
    if (emb === undefined || !Array.isArray(emb)) {
      return err({ kind: "invalid-response", detail: "missing embedding" })
    }
    return ok([...emb])
  }

  return {
    async embed(
      input: string | readonly string[],
      callOpts?: { readonly signal?: AbortSignal },
    ): Promise<Result<EmbedResult, EmbedError>> {
      if (callOpts?.signal?.aborted === true) return err({ kind: "aborted" })
      const items = typeof input === "string" ? [input] : input
      const tooLarge = checkInputBytes(items, maxInputBytes)
      if (tooLarge !== null) return err(tooLarge)
      const vectors: number[][] = []
      for (const s of items) {
        const r = await callOne(s, callOpts?.signal)
        if (!r.ok) return r
        vectors.push([...r.value])
      }
      return ok({ vectors, modelTag })
    },
    async capabilities(): Promise<EmbedderCapabilities> {
      return caps
    },
  }
}
