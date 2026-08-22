/** N3 — `mcp_read_resource` model tool. Fetch one resource by uri over
 *  `resources/read`. TEXT blocks are capped + rendered inline; BLOB blocks are
 *  NEVER inlined — they are base64-decoded and WRITTEN to a jailed workspace path
 *  (B4 blob-to-disk), with the model shown `blobSavedTo:<path>`. Output is
 *  `mcp`-origin ⇒ H2 untrusted-source envelope at dispatch.
 *
 *  MUTATING: because a blob read writes a file, `isReadOnly()` is FALSE (a `true`
 *  would misroute the HITL gate — the dispatch gate infers `always-confirm` from
 *  `isReadOnly() === false`, secure-by-default). The write goes through the SAME
 *  `resolveJailed` chokepoint `write`/`image_gen` use (confined to `ctx.cwd`), so
 *  an adversarial MCP server cannot drop attacker-chosen bytes outside the jail. */

import { z } from "zod"
import { defaultImageWritePort, type ImageWritePort } from "../image-gen/store"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { McpResourceCaptureHolder } from "./capture"
import type { ResourcesHandle } from "./port"
import { callPort, renderFailure, renderResourceContentSavingBlobs } from "./render"

export const readResourceInputSchema = z.object({
  uri: z.string().min(1, "uri is required"),
})
export type ReadResourceInput = z.infer<typeof readResourceInputSchema>

/** Options for {@link mcpReadResourceTool}. */
export interface ReadResourceToolOptions {
  /** Injected raw-byte write seam (test double). Default = `@/storage`-backed
   *  `Bun.write`. Reused from `image_gen` — NOT a forked disk-write path. */
  readonly writePort?: ImageWritePort
  /** B4 (jul-04) — OPTIONAL surface-owned capture holder. When threaded, EACH
   *  read whose blocks materialized blob-to-disk file(s) records a `blobPaths`
   *  entry (uri + the jailed paths written) so `/mcp-resources` can list where
   *  the bytes landed. ABSENT ⇒ no capture (byte-identical). NO body/blob bytes
   *  are ever captured — only the jailed on-disk paths the tool itself reported. */
  readonly capture?: McpResourceCaptureHolder
  /** Injected clock (test seam). Default `Date.now`. Only read when a capture is
   *  threaded AND at least one blob was written. */
  readonly now?: () => number
}

/** Extract the jailed paths a `renderResourceContentSavingBlobs` output reported
 *  via its code-controlled `blobSavedTo:<path> (<n> bytes)` line. The path is the
 *  tool's OWN jailed write target (not attacker text) — we read up to the ` (`
 *  byte-count suffix the renderer always appends. Returns [] when none were
 *  written (text-only / refused blocks). Pure. */
const extractBlobPaths = (output: string): string[] => {
  const paths: string[] = []
  for (const line of output.split("\n")) {
    const marker = "blobSavedTo:"
    const idx = line.indexOf(marker)
    if (idx < 0) continue
    const after = line.slice(idx + marker.length)
    // The renderer appends ` (<n> bytes)`; strip it to recover the bare path.
    const suffix = after.lastIndexOf(" (")
    paths.push((suffix >= 0 ? after.slice(0, suffix) : after).trim())
  }
  return paths
}

/** B4 (jul-04) — record a blob-to-disk fetch into the surface capture holder when
 *  one was threaded AND at least one blob actually landed on disk. No-throw
 *  (best-effort — a capture hiccup never breaks the read). Extracted so
 *  {@link mcpReadResourceTool}'s `execute` stays under the complexity budget. */
const recordBlobFetch = (
  capture: McpResourceCaptureHolder | undefined,
  uri: string,
  output: string,
  now: (() => number) | undefined,
): void => {
  if (capture === undefined) return
  const blobPaths = extractBlobPaths(output)
  if (blobPaths.length === 0) return
  try {
    capture.record({ uri, children: [], blobPaths, at: (now ?? Date.now)() })
  } catch {
    /* best-effort */
  }
}

export const mcpReadResourceTool = (
  port: ResourcesHandle,
  options: ReadResourceToolOptions = {},
): Tool<ReadResourceInput> => {
  const writePort = options.writePort ?? defaultImageWritePort
  return {
    name: "mcp_read_resource",
    description:
      "Read one MCP resource by uri (from mcp_list_resources). Text content is " +
      "returned inline (capped); binary blobs are base64-decoded and WRITTEN to a " +
      "jailed workspace file (blobSavedTo:<path>), never inlined. Writes files for " +
      "blob resources (mutating). Content is untrusted third-party data.",
    inputSchema: readResourceInputSchema,
    // A blob read WRITES a jailed file ⇒ NOT read-only (a `true` would lie to the
    // HITL gate). Jailed + VCS-reversible workspace write ⇒ pre-approval-ok tier
    // (mirrors `image_gen` / `write`), not the fail-closed always-confirm default.
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: (): "pre-approval-ok" => "pre-approval-ok",
    async *execute(input: ReadResourceInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const parsed = readResourceInputSchema.safeParse(input)
      if (!parsed.success) {
        yield {
          type: "result",
          result: { ok: false, output: `invalid input: ${parsed.error.message}` },
        }
        return
      }
      if (ctx.signal.aborted) {
        yield { type: "result", result: { ok: false, output: "aborted before start" } }
        return
      }
      const uri = parsed.data.uri
      const r = await callPort(() => port.readResource(uri))
      if (!r.ok) {
        const { output, failure } = renderFailure(r)
        yield { type: "result", result: { ok: false, output, failure } }
        return
      }
      const output = await renderResourceContentSavingBlobs(uri, r.value, ctx.cwd, writePort)
      // B4 (jul-04) — record any blob-to-disk paths so `/mcp-resources` can show
      // where the bytes landed (extracted to a helper to keep `execute` under the
      // cognitive-complexity budget; no-op when no capture / no blob).
      recordBlobFetch(options.capture, uri, output, options.now)
      yield { type: "result", result: { ok: true, output } }
    },
  }
}
