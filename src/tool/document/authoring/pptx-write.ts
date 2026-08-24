/**
 * `pptx_write` tool (H14 PPTX follow-up) — GENERATE a real `.pptx` deck from
 * slide data (title + body bullet lines).
 *
 * The third Office authoring tool, sibling to `xlsx_write` / `docx_write`: it
 * serializes caller-supplied slides into a valid OOXML PresentationML package
 * ({@link buildPptx}) and writes the bytes through the FS-jail chokepoint to a
 * jailed, versioned-sibling path (never a silent overwrite).
 *
 * Same posture as the other authoring tools: mutating, no-throw → typed
 * `ok:false`, default-OFF (registered only when
 * `DefaultToolPorts.officeAuthoring` is true — the SAME knob that gates
 * `xlsx_write` / `docx_write`).
 *
 * Slice posture (RFC §3.1): imports ONLY `zod`, `@/shared`, the sibling pure
 * serializer + jailed-write helper, and `../../types`. No `@/agent`, no
 * `@/permission`.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { ArtifactRegistryPort } from "../../artifact"
import type { CoreToolContext, Tool, ToolEvent, ToolResult } from "../../types"
import { OOXML_MEDIA_TYPES, registerArtifactBestEffort } from "./artifact-register"
import { resolveVersionedJailedTarget, writeJailedBytes } from "./jailed-write"
import { buildPptx, type PptxSlide, type PptxSpec } from "./pptx"

/** Caps so a runaway spec can't exhaust memory. */
export const PPTX_WRITE_MAX_SLIDES = 1000
export const PPTX_WRITE_MAX_BODY_LINES = 200

const slideSchema = z.object({
  title: z.string().optional().describe("Slide title (the slide's claim)."),
  body: z
    .array(z.string())
    .max(PPTX_WRITE_MAX_BODY_LINES)
    .optional()
    .describe("Body bullet lines — one paragraph per entry (the proof)."),
})

export const pptxWriteInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Repo-relative or jailed output path for the .pptx (e.g. decks/review.pptx)."),
  slides: z
    .array(slideSchema)
    .min(1)
    .max(PPTX_WRITE_MAX_SLIDES)
    .describe("Ordered slides, each with an optional title + optional body bullet lines."),
})
export type PptxWriteInput = z.infer<typeof pptxWriteInputSchema>

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

const toSpec = (input: PptxWriteInput): PptxSpec => ({
  slides: input.slides.map((s): PptxSlide => {
    const slide: { title?: string; body?: string[] } = {}
    if (s.title !== undefined) slide.title = s.title
    if (s.body !== undefined) slide.body = s.body
    return slide
  }),
})

/** Options for {@link makePptxWriteTool}. */
export interface PptxWriteToolOptions {
  /** C1 — when wired (default-OFF, gated on `QUANTA_ARTIFACT_STORE`), the tool
   *  best-effort registers each written deck into the session artifact registry
   *  and appends its id to the output. Absent ⇒ byte-identical. */
  readonly artifactRegistry?: ArtifactRegistryPort
}

/** Build the `pptx_write` tool. With no options this is byte-identical to the
 *  historical const export (no artifact register, no extra output). */
export const makePptxWriteTool = (options: PptxWriteToolOptions = {}): Tool<PptxWriteInput> => ({
  name: "pptx_write",
  description:
    "Generate a real .pptx (PowerPoint) deck from slide data (per-slide title + body bullet " +
    "lines) and write it to a jailed path. Pure-TS PresentationML; never overwrites — an " +
    "existing target is written to a versioned -vN sibling. Mutating.",
  inputSchema: pptxWriteInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async *execute(input: PptxWriteInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = pptxWriteInputSchema.safeParse(input)
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
      bytes = buildPptx(toSpec(parsed.data))
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: errResult(`pptx serialize failed: ${msg}`, {
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

    const slideCount = parsed.data.slides.length
    const note = target.bumped
      ? ` (target existed — wrote versioned sibling "${target.finalRelative}")`
      : ""
    // C1 — best-effort artifact registration AFTER a successful write. A throwing
    // registry never breaks the write; absent registry ⇒ no extra output.
    const registered = registerArtifactBestEffort(options.artifactRegistry, {
      kind: "presentation",
      path: target.abs,
      mediaType: OOXML_MEDIA_TYPES.pptx,
    })
    yield {
      type: "result",
      result: {
        ok: true,
        output:
          `Wrote .pptx (${bytes.length} bytes, ${slideCount} slide${slideCount === 1 ? "" : "s"}) ` +
          `to ${target.finalRelative}${note}${registered}`,
      },
    }
  },
})

/** Const export — byte-identical to the historical tool (no artifact registry). */
export const pptxWriteTool: Tool<PptxWriteInput> = makePptxWriteTool()
