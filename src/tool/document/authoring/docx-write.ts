/**
 * `docx_write` tool (H14b) — GENERATE a real `.docx` document from paragraphs.
 *
 * Serializes caller-supplied paragraphs (headings + body paragraphs of
 * formatted runs) into a valid OOXML WordprocessingML package
 * ({@link buildDocx}) and writes the bytes through the FS-jail chokepoint to a
 * jailed, versioned-sibling path (never a silent overwrite).
 *
 * Same posture as `xlsx_write`: mutating, no-throw → typed `ok:false`,
 * default-OFF (registered only when `DefaultToolPorts.officeAuthoring`).
 *
 * Slice posture (RFC §3.1): imports ONLY `zod`, `@/shared`, the sibling pure
 * serializer + jailed-write helper, and `../../types`.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { ArtifactRegistryPort } from "../../artifact"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../../types"
import { OOXML_MEDIA_TYPES, registerArtifactBestEffort } from "./artifact-register"
import { buildDocx, type DocxParagraph, type DocxSpec } from "./docx"
import { resolveVersionedJailedTarget, writeJailedBytes } from "./jailed-write"

export const DOCX_WRITE_MAX_PARAGRAPHS = 50_000
export const DOCX_WRITE_MAX_RUNS_PER_PARAGRAPH = 1024

const runSchema = z.object({
  text: z.string().describe("Run text."),
  bold: z.boolean().optional().describe("Bold this run."),
  italic: z.boolean().optional().describe("Italicize this run."),
})

const paragraphSchema = z.union([
  z.object({
    kind: z.literal("heading"),
    level: z.number().int().min(1).max(6).describe("Heading level 1–6 (Word Heading{N} style)."),
    text: z.string().describe("Heading text."),
  }),
  z.object({
    kind: z.literal("paragraph"),
    runs: z
      .array(runSchema)
      .max(DOCX_WRITE_MAX_RUNS_PER_PARAGRAPH)
      .describe("Formatted text runs that compose the paragraph."),
  }),
])

export const docxWriteInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Repo-relative or jailed output path for the .docx (e.g. reports/summary.docx)."),
  paragraphs: z
    .array(paragraphSchema)
    .max(DOCX_WRITE_MAX_PARAGRAPHS)
    .describe("Ordered list of headings and body paragraphs."),
})
export type DocxWriteInput = z.infer<typeof docxWriteInputSchema>

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

const toSpec = (input: DocxWriteInput): DocxSpec => ({
  paragraphs: input.paragraphs.map(
    (p): DocxParagraph =>
      p.kind === "heading"
        ? { kind: "heading", level: p.level, text: p.text }
        : {
            kind: "paragraph",
            runs: p.runs.map((r) => {
              const run: { text: string; bold?: boolean; italic?: boolean } = { text: r.text }
              if (r.bold !== undefined) run.bold = r.bold
              if (r.italic !== undefined) run.italic = r.italic
              return run
            }),
          },
  ),
})

/** Options for {@link makeDocxWriteTool}. */
export interface DocxWriteToolOptions {
  /** C1 — when wired (default-OFF, gated on `QUANTA_ARTIFACT_STORE`), the tool
   *  best-effort registers each written document into the session artifact
   *  registry and appends its id to the output. Absent ⇒ byte-identical. */
  readonly artifactRegistry?: ArtifactRegistryPort
}

/** Build the `docx_write` tool. With no options this is byte-identical to the
 *  historical const export (no artifact register, no extra output). */
export const makeDocxWriteTool = (options: DocxWriteToolOptions = {}): Tool<DocxWriteInput> => ({
  name: "docx_write",
  description:
    "Generate a real .docx (Word) document from paragraphs (headings + body paragraphs of " +
    "formatted runs) and write it to a jailed path. Never overwrites: an existing target is " +
    "written to a versioned -vN sibling. Mutating.",
  inputSchema: docxWriteInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async *execute(input: DocxWriteInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = docxWriteInputSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: errResult("aborted before start") }
      return
    }

    const target = await resolveVersionedJailedTarget(ctx.cwd, parsed.data.path)
    if (target.kind === "jail_error") {
      yield {
        type: "result",
        result: errResult(`path outside cwd: ${parsed.data.path} (${target.message})`, {
          mode: "permission_denied",
          path: parsed.data.path,
          isReadonly: false,
        }),
      }
      return
    }

    let bytes: Uint8Array
    try {
      bytes = buildDocx(toSpec(parsed.data))
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: errResult(`docx serialize failed: ${msg}`, {
          mode: "error",
          modelVisibleError: msg,
        }),
      }
      return
    }

    try {
      await writeJailedBytes(target.abs, bytes)
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: errResult(`write failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }

    const paraCount = parsed.data.paragraphs.length
    const note = target.bumped
      ? ` (target existed — wrote versioned sibling "${target.finalRelative}")`
      : ""
    // C1 — best-effort artifact registration AFTER a successful write. A throwing
    // registry never breaks the write; absent registry ⇒ no extra output.
    const registered = registerArtifactBestEffort(options.artifactRegistry, {
      kind: "document",
      path: target.abs,
      mediaType: OOXML_MEDIA_TYPES.docx,
    })
    yield {
      type: "result",
      result: {
        ok: true,
        output:
          `Wrote .docx (${bytes.length} bytes, ${paraCount} paragraph${paraCount === 1 ? "" : "s"}) ` +
          `to ${target.finalRelative}${note}${registered}`,
      },
    }
  },
})

/** Const export — byte-identical to the historical tool (no artifact registry). */
export const docxWriteTool: Tool<DocxWriteInput> = makeDocxWriteTool()
