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
      yield { type: "result", result: { ok: true, output } }
    },
  }
}
