/** ADR-0257 — `ai_attribution` tool registration.
 *
 *  Wraps an injected {@link AIAttributionSearch} port and exposes it as a
 *  read-only, concurrency-safe tool. Caller-wired: NOT part of `buildDefaultTools`
 *  (default-OFF), mirroring the shadow / subagent-bg / mcp-tasks pattern. A
 *  composition root opts in by calling `aiAttributionTool(port)` and adding the
 *  returned `Tool` to its registry.
 *
 *  Input contract: `{ snippet: string, minSimilarity?: number, maxResults?: number }`.
 *  The tool validates the snippet locally (empty / too-large) BEFORE invoking
 *  the port — those failures never reach the adapter. The remaining failure
 *  arms (`search-failed`, `aborted`) come back from the port and are surfaced
 *  on `ok:false` with a stable code-prefixed `output` so the model can branch.
 *
 *  Plane-clean: imports `@/shared`, `./ai-attribution`, `./factory`, `./types`.
 *  No `@/agent`, no `@/permission`, no `@/runtime`. */

import { z } from "zod"
import type { AIAttributionSearch, AttributionMatch, SearchError } from "./ai-attribution"
import { SNIPPET_MAX_BYTES } from "./ai-attribution"
import { defineTool } from "./factory"
import type { Tool, ToolEvent, ToolResult } from "./types"

export const aiAttributionInputSchema = z.object({
  snippet: z.string().describe("Code snippet to search for training-data attribution."),
  minSimilarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Drop matches with similarity below this threshold (0..1)."),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Cap the number of returned matches after sorting (1..100)."),
})
export type AiAttributionInput = z.infer<typeof aiAttributionInputSchema>

/** UTF-8 byte length — identical accounting to the port's wrapper so the tool's
 *  local pre-check and the port's defence-in-depth agree. */
const byteLength = (s: string): number => new TextEncoder().encode(s).length

/** Render one match line. Deterministic — no time, no random. */
const renderMatch = (m: AttributionMatch): string => {
  const sim = m.similarity.toFixed(4)
  const url = m.url !== undefined ? `  ${m.url}` : ""
  return `  [${sim}] ${m.license}  ${m.source}${url}`
}

const renderMatches = (matches: ReadonlyArray<AttributionMatch>): string => {
  if (matches.length === 0) return "(no matches)"
  const header = `${matches.length} match${matches.length === 1 ? "" : "es"}:`
  return [header, ...matches.map(renderMatch)].join("\n")
}

/** Map a closed {@link SearchError} to a stable `ToolResult`. Each arm starts
 *  with the `kind` literal so the model can branch on the prefix. */
const renderError = (e: SearchError): ToolResult => {
  switch (e.kind) {
    case "empty-snippet":
      return { ok: false, output: "empty-snippet: snippet must be non-empty" }
    case "snippet-too-large":
      return {
        ok: false,
        output: `snippet-too-large: snippet=${e.sizeBytes} bytes exceeds cap=${e.maxBytes} bytes`,
      }
    case "search-failed":
      return { ok: false, output: `search-failed: ${e.cause}` }
    case "aborted":
      return { ok: false, output: "aborted: request cancelled by caller" }
  }
}

/** Build the `ai_attribution` tool. The port is INJECTED — no global default,
 *  no shared singleton. Caller (composition root) constructs the adapter
 *  (`headlessStub()` in tests, BigCode/Sourcegraph/GH adapter in production)
 *  and hands it in here. */
export const aiAttributionTool = (port: AIAttributionSearch): Tool<AiAttributionInput> =>
  defineTool<AiAttributionInput>({
    name: "ai_attribution",
    description:
      "Search a code snippet for training-data attribution matches and return ranked sources " +
      "(source, license, similarity, optional URL). Read-only. Caller injects the search adapter " +
      "(BigCode / Sourcegraph / GitHub Code Search). Default-OFF: not registered unless wired.",
    inputSchema: aiAttributionInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const parsed = aiAttributionInputSchema.safeParse(input)
      if (!parsed.success) {
        yield {
          type: "result",
          result: { ok: false, output: `invalid input: ${parsed.error.message}` },
        }
        return
      }
      const args = parsed.data
      // Local fast-fail: empty / too-large — no port call.
      if (args.snippet.length === 0) {
        yield { type: "result", result: renderError({ kind: "empty-snippet" }) }
        return
      }
      const sizeBytes = byteLength(args.snippet)
      if (sizeBytes > SNIPPET_MAX_BYTES) {
        yield {
          type: "result",
          result: renderError({
            kind: "snippet-too-large",
            sizeBytes,
            maxBytes: SNIPPET_MAX_BYTES,
          }),
        }
        return
      }
      if (ctx.signal.aborted) {
        yield { type: "result", result: renderError({ kind: "aborted" }) }
        return
      }
      const portOpts: {
        signal: AbortSignal
        minSimilarity?: number
        maxResults?: number
      } = { signal: ctx.signal }
      if (args.minSimilarity !== undefined) portOpts.minSimilarity = args.minSimilarity
      if (args.maxResults !== undefined) portOpts.maxResults = args.maxResults
      const result = await port.search(args.snippet, portOpts)
      if (!result.ok) {
        yield { type: "result", result: renderError(result.error) }
        return
      }
      // Defense-in-depth: drop any out-of-range similarity from a misbehaving
      // adapter; never surface a 1.2 or -0.1 to the model.
      const sane = result.value.filter((m) => m.similarity >= 0 && m.similarity <= 1)
      yield { type: "result", result: { ok: true, output: renderMatches(sane) } }
    },
  })
