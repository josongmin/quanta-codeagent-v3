/**
 * `yaml_read` tool (ADR-0137, Part 1) — read + parse a YAML 1.2 file via the
 * pure-TS `yaml` library (eemeli/yaml). Surfaces the parsed document as
 * indented JSON so the agent sees a single canonical structured-data shape
 * regardless of which document format the file is in.
 *
 * Slice posture (RFC §3.1; mirrors `csv-read.ts` / `ndjson-read.ts`):
 *   - Imports ONLY: `zod`, `node:path`, `node:fs/promises`, `Bun.file`,
 *     `yaml` (new dep), `../types`. NO `@/agent`, `@/permission`, `@/storage`,
 *     `@/llm` (text format — no DocumentBlock / ImageBlock).
 *   - No-throw: every failure mode (schema, abort, path-escape, ENOENT,
 *     symlink leaf, read failure, YAML parse failure) yields a typed
 *     `ok:false` `ToolResult`.
 *   - exactOptionalPropertyTypes-clean: `maxKeys` is spelled `| undefined`
 *     via `.optional()` so the zod parse output is assignable.
 *
 * Security (mirrors ADR-0126 `read_image`):
 *   - Repo-relative paths resolved against `ctx.cwd`; `..` traversal rejected.
 *   - Absolute paths pass through (explicit user consent — same posture as
 *     `git_diff` / `csv_read`).
 *   - Leaf-symlink reject via `lstat().isSymbolicLink()`.
 *   - Output capped at 50_000 chars; key-count capped via `maxKeys` (default
 *     200, ceiling 5000). YAML → JSON expansion can multiply key counts via
 *     anchor / merge-key expansion; the cap is on the OUTPUT key surface, not
 *     the source.
 *
 * Parser choice: `yaml@2.x` is ~50KB pure-TS, zero transitive concerns. We
 * call `parse(content, { strict: false })` so duplicate keys (a YAML 1.1 wart)
 * surface as a "last wins" merge rather than throwing — the agent surface
 * tolerates real-world configs that the lib's strict mode would reject.
 */

import { lstat } from "node:fs/promises"
import { parse, YAMLParseError } from "yaml"
import { z } from "zod"
import { errMessage } from "@/shared"
import { FsJailError } from "@/storage"
import { resolveJailedDoc } from "../_shared/resolve-jailed-doc"
import type { CoreToolContext, Tool, ToolEvent, ToolResult } from "../types"
export const YAML_READ_DEFAULT_MAX_KEYS = 200
export const YAML_READ_MAX_KEYS_CEILING = 5000
export const YAML_READ_MAX_OUTPUT = 50_000

export const yamlReadInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the YAML file"),
  maxKeys: z
    .number()
    .int()
    .positive()
    .max(YAML_READ_MAX_KEYS_CEILING)
    .optional()
    .describe(
      `Max output object keys to render (default ${YAML_READ_DEFAULT_MAX_KEYS}, ceiling ${YAML_READ_MAX_KEYS_CEILING})`,
    ),
})
export type YamlReadInput = z.infer<typeof yamlReadInputSchema>

const truncate = (s: string): string => {
  if (s.length <= YAML_READ_MAX_OUTPUT) return s
  return `${s.slice(0, YAML_READ_MAX_OUTPUT)}\n… (truncated, ${s.length - YAML_READ_MAX_OUTPUT} more chars)`
}

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Recursive key counter for the cap. Strings / numbers / booleans / null
 *  count as 1; arrays sum their element counts; plain objects sum their key
 *  count + each value's count. Stops counting AT the ceiling — does not
 *  walk further once the cap is reached (defense against deeply nested
 *  pathological inputs). */
const countKeys = (v: unknown, budget: number): number => {
  if (budget <= 0) return 0
  if (v === null || typeof v !== "object") return 1
  if (Array.isArray(v)) {
    let total = 0
    for (const el of v) {
      if (total >= budget) return total
      total += countKeys(el, budget - total)
    }
    return total
  }
  const obj = v as Record<string, unknown>
  let total = 0
  for (const k of Object.keys(obj)) {
    if (total >= budget) return total
    total += 1
    total += countKeys(obj[k], budget - total)
  }
  return total
}

/** Pre-flight (schema parse + abort + path resolve via unified FS jail).
 *  Path safety is delegated to {@link resolveJailedDoc} (Slice S7) — see
 *  `src/tool/_shared/resolve-jailed-doc.ts` for rationale. The catch-and-
 *  translate preserves the historical "path outside cwd: …" message + typed
 *  `permission_denied` failure so existing hellgate tests stay green. */
const preflight = (
  input: YamlReadInput,
  ctx: CoreToolContext,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; abs: string; visiblePath: string } => {
  const parsed = yamlReadInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "fail", result: errResult(`invalid input: ${parsed.error.message}`) }
  }
  if (ctx.signal.aborted) {
    return { kind: "fail", result: errResult("aborted before start") }
  }
  let abs: string
  try {
    abs = resolveJailedDoc(ctx.cwd, parsed.data.path, "yaml")
  } catch (e) {
    if (e instanceof FsJailError) {
      return {
        kind: "fail",
        result: errResult(`path outside cwd: ${parsed.data.path}`, {
          mode: "permission_denied",
          path: parsed.data.path,
          isReadonly: true,
        }),
      }
    }
    throw e
  }
  return { kind: "ok", abs, visiblePath: parsed.data.path }
}

const statPhase = async (
  abs: string,
  visiblePath: string,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok" }> => {
  try {
    const stat = await lstat(abs)
    if (stat.isSymbolicLink()) {
      return {
        kind: "fail",
        result: errResult(`symlink not allowed: ${visiblePath}`, {
          mode: "permission_denied",
          path: visiblePath,
          isReadonly: true,
        }),
      }
    }
    if (!stat.isFile()) {
      return {
        kind: "fail",
        result: errResult(`not a regular file: ${visiblePath}`, {
          mode: "not_found",
          path: visiblePath,
        }),
      }
    }
    return { kind: "ok" }
  } catch (e) {
    const msg = errMessage(e)
    const isEnoent =
      typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT"
    return {
      kind: "fail",
      result: errResult(
        isEnoent ? `File not found: ${visiblePath}` : `lstat failed: ${msg}`,
        isEnoent
          ? { mode: "not_found", path: visiblePath }
          : { mode: "error", modelVisibleError: msg },
      ),
    }
  }
}

/** YAML parse phase. Maps `YAMLParseError` to a typed `ok:false` with the
 *  library's line/column carried in `output`. Other throws (programmer bug,
 *  not domain failure) surface as a generic `error`. */
const parsePhase = (
  text: string,
  visiblePath: string,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; doc: unknown } => {
  try {
    const doc = parse(text, { strict: false }) as unknown
    return { kind: "ok", doc }
  } catch (e) {
    if (e instanceof YAMLParseError) {
      const pos = e.linePos?.[0]
      const where = pos ? ` (line ${pos.line}, column ${pos.col})` : ""
      return {
        kind: "fail",
        result: errResult(`YAML parse failed${where}: ${e.message}`, {
          mode: "error",
          modelVisibleError: "yaml_parse_failed",
        }),
      }
    }
    const msg = errMessage(e)
    return {
      kind: "fail",
      result: errResult(`YAML parse failed (${visiblePath}): ${msg}`, {
        mode: "error",
        modelVisibleError: msg,
      }),
    }
  }
}

const renderResult = (visiblePath: string, doc: unknown, maxKeys: number): string => {
  const keyCount = countKeys(doc, maxKeys + 1) // +1 so we can detect "at cap"
  const overCap = keyCount > maxKeys
  const json = JSON.stringify(doc, null, 2)
  const header = `YAML: ${visiblePath} (${keyCount > maxKeys ? `>${maxKeys}` : keyCount} keys)`
  const body = overCap
    ? `${json.slice(0, YAML_READ_MAX_OUTPUT)}\n… (truncated at maxKeys=${maxKeys}; raise maxKeys to see full document)`
    : json
  return truncate(`${header}\n${body}`)
}

export const yamlReadTool: Tool<YamlReadInput> = {
  name: "yaml_read",
  description:
    "Read and parse a YAML 1.2 file. Returns the document as indented JSON " +
    "(YAML anchors / merge keys are expanded). Read-only.",
  inputSchema: yamlReadInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: YamlReadInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const pre = preflight(input, ctx)
    if (pre.kind === "fail") {
      yield { type: "result", result: pre.result }
      return
    }
    const statOut = await statPhase(pre.abs, pre.visiblePath)
    if (statOut.kind === "fail") {
      yield { type: "result", result: statOut.result }
      return
    }
    let text: string
    try {
      text = await Bun.file(pre.abs).text()
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: errResult(`read failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }
    const parsed = parsePhase(text, pre.visiblePath)
    if (parsed.kind === "fail") {
      yield { type: "result", result: parsed.result }
      return
    }
    const parsedInput = yamlReadInputSchema.parse(input)
    const maxKeys = parsedInput.maxKeys ?? YAML_READ_DEFAULT_MAX_KEYS
    yield {
      type: "result",
      result: {
        ok: true,
        output: renderResult(pre.visiblePath, parsed.doc, maxKeys),
      },
    }
  },
}
