/**
 * C1 — artifact tools (`artifact_list` / `artifact_get` / `artifact_destroy`).
 *
 * Read/manage surface over the session artifact registry (Canvas — backlog §7).
 * `register` is NOT a model-facing tool: artifacts are registered by the
 * generation tools (image_gen / office authoring) at the composition root; the
 * model lists / inspects / destroys them by id here.
 *
 * Slice posture: `@/tool` may NOT import `@/artifact` (fence), so this file
 * declares a DUCK-TYPED {@link ArtifactRegistryPort} (a structural mirror of
 * `@/artifact`'s `ArtifactRegistry`) — the composition root passes the real
 * registry, which matches structurally. NO-THROW: every path yields a typed
 * `ok:false` on failure.
 *
 * DEFAULT-OFF: these tools are registered ONLY when the composition root wires a
 * registry (`DefaultToolPorts.artifactRegistry`, gated on `QUANTA_ARTIFACT_STORE`);
 * absent ⇒ not in the menu ⇒ byte-identical (mirrors `automation_update`).
 */

import { z } from "zod"
import { sliceWholeChars } from "@/shared/slice-whole-chars"
import type { CoreToolContext, Tool, ToolEvent, ToolFailure, ToolResult } from "../types"

/** Duck-typed mirror of `@/artifact`'s `ArtifactKind` (closed). */
export type ArtifactKind = "image" | "spreadsheet" | "document" | "presentation" | "other"

/** Duck-typed mirror of `@/artifact`'s `Artifact`. */
export interface ArtifactView {
  readonly id: string
  readonly kind: ArtifactKind
  readonly path: string
  readonly mediaType: string
  readonly label?: string
  readonly createdAt: number
}

/** Spec for {@link ArtifactRegistryPort.register} — everything but the
 *  registry-owned `id` + `createdAt`. Duck-typed mirror of `@/artifact`'s
 *  `ArtifactSpec`. */
export interface ArtifactSpecInput {
  readonly kind: ArtifactKind
  readonly path: string
  readonly mediaType: string
  readonly label?: string
}

/** Duck-typed mirror of `@/artifact`'s `ArtifactRegistry`. */
export interface ArtifactRegistryPort {
  register(spec: ArtifactSpecInput): ArtifactView
  get(id: string): ArtifactView | undefined
  list(): readonly ArtifactView[]
  destroy(id: string): boolean
}

/** The preview-URL scheme — MUST match `@/artifact`'s `ARTIFACT_URL_SCHEME`
 *  (a stable wire contract; duplicated here to keep `@/tool` fence-clean). */
const ARTIFACT_URL_SCHEME = "quanta-artifact://"
const previewUrlOf = (id: string): string => `${ARTIFACT_URL_SCHEME}${id}`

const ok = (output: string): ToolResult => ({ ok: true, output })
const err = (output: string, failure: ToolFailure): ToolResult => ({
  ok: false,
  output,
  failure,
})

/** Per-field render cap (chars). A hostile / oversized `path` / `label` /
 *  `mediaType` (the registry stores them verbatim) must not explode the
 *  `list` / `get` tool output into the transcript. Truncate each rendered field
 *  to a bounded length with an explicit ellipsis marker. The id (registry-minted,
 *  short) and the preview URL are NOT truncated. */
const RENDER_FIELD_MAX = 256
const clampField = (s: string): string =>
  s.length > RENDER_FIELD_MAX ? `${sliceWholeChars(s, RENDER_FIELD_MAX)}…(${s.length})` : s

const renderArtifact = (a: ArtifactView): string => {
  const label = a.label !== undefined && a.label.length > 0 ? ` "${clampField(a.label)}"` : ""
  return `  ${a.id}${label} [${a.kind}, ${clampField(a.mediaType)}] → ${previewUrlOf(a.id)}  (${clampField(a.path)})`
}

export const artifactRegisterInputSchema = z.object({
  kind: z
    .enum(["image", "spreadsheet", "document", "presentation", "other"])
    .describe("Artifact kind."),
  path: z.string().min(1).describe("On-disk (jailed) path the artifact was written to."),
  media_type: z.string().min(1).describe('MIME type, e.g. "image/png" or "application/vnd...".'),
  label: z.string().optional().describe("Optional human label."),
})
export type ArtifactRegisterInput = z.infer<typeof artifactRegisterInputSchema>

export const artifactListInputSchema = z.object({
  kind: z
    .enum(["image", "spreadsheet", "document", "presentation", "other"])
    .optional()
    .describe("Filter to one artifact kind; omit for all."),
})
export type ArtifactListInput = z.infer<typeof artifactListInputSchema>

export const artifactGetInputSchema = z.object({
  id: z.string().min(1).describe("Artifact id (from artifact_list)."),
})
export type ArtifactGetInput = z.infer<typeof artifactGetInputSchema>

export const artifactDestroyInputSchema = z.object({
  id: z.string().min(1).describe("Artifact id to destroy (removes the registry entry)."),
})
export type ArtifactDestroyInput = z.infer<typeof artifactDestroyInputSchema>

const makeRegisterTool = (registry: ArtifactRegistryPort): Tool<ArtifactRegisterInput> => ({
  name: "artifact_register",
  description:
    "Register a NON-code artifact you produced (an image_gen PNG, an xlsx/docx/" +
    "pptx file) into the session canvas. Returns a stable id + preview URL so you " +
    "can reference it later without pasting bytes. Mutating (adds a registry entry).",
  inputSchema: artifactRegisterInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: ArtifactRegisterInput, _ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = artifactRegisterInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    const a = registry.register({
      kind: parsed.data.kind,
      path: parsed.data.path,
      mediaType: parsed.data.media_type,
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
    })
    yield { type: "result", result: ok(`Registered artifact:\n${renderArtifact(a)}`) }
  },
})

const makeListTool = (registry: ArtifactRegistryPort): Tool<ArtifactListInput> => ({
  name: "artifact_list",
  description:
    "List session artifacts (generated images / spreadsheets / documents / " +
    "presentations) with their id, kind, media type, and preview URL. Optional `kind` filter.",
  inputSchema: artifactListInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: ArtifactListInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = artifactListInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: err("aborted", { mode: "rejected", reason: "aborted" }) }
      return
    }
    const all = registry.list()
    const items =
      parsed.data.kind !== undefined ? all.filter((a) => a.kind === parsed.data.kind) : all
    if (items.length === 0) {
      yield { type: "result", result: ok("No artifacts registered this session.") }
      return
    }
    const lines = [`Artifacts (${items.length}):`, ...items.map(renderArtifact)]
    yield { type: "result", result: ok(lines.join("\n")) }
  },
})

const makeGetTool = (registry: ArtifactRegistryPort): Tool<ArtifactGetInput> => ({
  name: "artifact_get",
  description:
    "Look up one session artifact by id; returns its kind, media type, on-disk " +
    "path, and preview URL. ok:false when the id is unknown.",
  inputSchema: artifactGetInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: ArtifactGetInput, _ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = artifactGetInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    const a = registry.get(parsed.data.id)
    if (a === undefined) {
      yield {
        type: "result",
        result: err(`unknown artifact: ${parsed.data.id}`, {
          mode: "not_found",
        }),
      }
      return
    }
    yield { type: "result", result: ok(renderArtifact(a)) }
  },
})

const makeDestroyTool = (registry: ArtifactRegistryPort): Tool<ArtifactDestroyInput> => ({
  name: "artifact_destroy",
  description:
    "Remove a session artifact from the registry by id (does NOT delete the " +
    "on-disk file). ok:false when the id is unknown.",
  inputSchema: artifactDestroyInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: ArtifactDestroyInput, _ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = artifactDestroyInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    const removed = registry.destroy(parsed.data.id)
    if (!removed) {
      yield {
        type: "result",
        result: err(`unknown artifact: ${parsed.data.id}`, {
          mode: "not_found",
        }),
      }
      return
    }
    yield { type: "result", result: ok(`Destroyed artifact ${parsed.data.id}.`) }
  },
})

/** Build the artifact register/read/manage tools over a wired registry. */
export const artifactTools = (registry: ArtifactRegistryPort): Tool[] => [
  makeRegisterTool(registry) as Tool,
  makeListTool(registry) as Tool,
  makeGetTool(registry) as Tool,
  makeDestroyTool(registry) as Tool,
]
