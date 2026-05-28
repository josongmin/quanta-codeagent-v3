/**
 * `check_secrets` tool (ADR-0404).
 *
 * LLM-facing surface over the async `compositeSecretScanner` from
 * `@/security/secret-detection`. The model invokes this tool when it needs a
 * DECISION ("is this text/file safe to commit / paste / share?") that the
 * automatic sync redaction in `applyRedaction` (ADR-0078) cannot answer —
 * because that path SPLICES masks into the transcript and does NOT surface
 * findings to the LLM, by design.
 *
 * --- Why a tool and not a dispatch wire (CR — read the matching ADR) ---
 *
 * The composite scanner is **async + detection-only**: it returns a
 * `SecretFinding[]` (kind/line/column/preview/confidence/entropyBits) without
 * mutating the input string. The existing `applyRedaction` slot in
 * `dispatch.ts:739` is **sync + masking**: it expects a `(text) => string`
 * that splices replacements in place. The shapes do not align — bolting the
 * detector into that slot would either drop findings (no return channel) or
 * regress the sync redaction (latency + new failure modes). The natural seam
 * is therefore a *separate* LLM-callable tool that lets the model branch on
 * findings instead of silently rewriting bytes.
 *
 * --- Default-OFF posture ---
 *
 * The tool is registered ONLY by the tier-1 builder `buildCheckSecretsBlock`
 * (`src/agent/tier1/check-secrets.ts`) which itself gates on the env knob
 * `QUANTA_SECRET_CHECK_TOOL=on`. Absent / any other value ⇒ the tool is NOT
 * appended to `extraTools`, the model never sees it, and every existing
 * session is byte-identical. The sync secret-redaction path
 * (`src/security/redaction.ts`) is UNTOUCHED.
 *
 * --- Slice posture ---
 *
 *   - imports `@/tool` (factory + types) + `zod` + `@/security/secret-detection`.
 *   - imports `@/shared` (logger / fs jail helpers indirectly via the scanner).
 *   - does NOT import `@/agent/*`, `@/permission/*`, `@/llm/*`, etc.
 *
 * The scanner is constructed once per tool call (cheap — composite is two
 * adapter factories closing over `opts`). Errors from the scanner are caught
 * and surfaced as `ok:false` with a typed `ToolFailure` — the tool NEVER
 * throws across its boundary (RFC §6.2 no-throw contract).
 */

import { z } from "zod"
import { compositeSecretScanner, type SecretFinding } from "@/security/secret-detection"
import type { Tool } from "@/tool"
import { defineTool } from "@/tool"

/** Discriminated input: scan an in-memory string OR a file path. Exactly one
 *  must be set. Zod's `.refine` enforces the XOR at validation time so the
 *  tool body sees a structurally-valid input. */
export const checkSecretsInputSchema = z
  .object({
    text: z.string().optional(),
    file_path: z.string().optional(),
  })
  .refine((v) => (typeof v.text === "string") !== (typeof v.file_path === "string"), {
    message: "exactly one of `text` or `file_path` must be provided",
  })

export type CheckSecretsInput = z.infer<typeof checkSecretsInputSchema>

/** Structured payload mirrored on `ToolResult.structured`. `findings[]` is the
 *  canonical machine-readable view; `output` (string) renders the same data
 *  for the model's tool_result text channel. */
export interface CheckSecretsStructured {
  readonly findings: ReadonlyArray<SecretFinding>
  readonly source: "text" | "file_path"
  readonly target?: string
  readonly truncated: boolean
}

/** Single-finding renderer for the model-facing text. Stable order: kind,
 *  location, masked preview, confidence + entropy when present. */
const renderFinding = (f: SecretFinding): string => {
  const loc = f.file !== undefined ? `${f.file}:${f.line}:${f.column}` : `${f.line}:${f.column}`
  const entropyBits = f.entropyBits
  const ent = entropyBits !== undefined ? ` entropy=${entropyBits.toFixed(2)}b/c` : ""
  return `  - [${f.kind}] ${loc} preview=${f.preview} confidence=${f.confidence}${ent}`
}

/** Full multi-line render. `findings.length === 0` ⇒ explicit "clean" line so
 *  the model never has to disambiguate `"" === ok` from a parse error. */
const renderOutput = (findings: ReadonlyArray<SecretFinding>): string => {
  if (findings.length === 0) {
    return "check_secrets: 0 findings (clean)"
  }
  const header = `check_secrets: ${findings.length} finding(s)`
  return `${header}\n${findings.map(renderFinding).join("\n")}`
}

/** Build a {@link Tool} that scans `text` or `file_path`. */
export const checkSecretsTool: Tool<CheckSecretsInput, CheckSecretsStructured> = defineTool<
  CheckSecretsInput,
  CheckSecretsStructured
>({
  name: "check_secrets",
  description:
    "Scan a string or file for embedded secrets (AWS/OpenAI/Anthropic/GitHub/Google/Slack/Stripe keys, " +
    "PEM blocks, generic high-entropy tokens). Returns structured findings (kind, line, column, masked " +
    "preview, confidence) without modifying the input. " +
    "USE WHEN you must DECIDE whether text/file content is safe to commit, share, paste into a PR, " +
    "or write to disk — the automatic redaction layer masks the transcript silently, so call this when " +
    "you (the model) need to branch on the result. " +
    "DO NOT USE for routine redaction of tool output; the dispatch layer already masks secrets in " +
    "tool_result text automatically. Exactly one of `text` or `file_path` must be set.",
  inputSchema: checkSecretsInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input) {
    const scanner = compositeSecretScanner()
    try {
      let findings: SecretFinding[]
      let source: "text" | "file_path"
      let target: string | undefined
      if (typeof input.text === "string") {
        findings = await scanner.scanText(input.text)
        source = "text"
      } else if (typeof input.file_path === "string") {
        findings = await scanner.scanFile(input.file_path)
        source = "file_path"
        target = input.file_path
      } else {
        // Unreachable under the zod refine; guarded so the body is total.
        yield {
          type: "result",
          result: {
            ok: false,
            output: "check_secrets: exactly one of `text` or `file_path` must be provided",
            failure: { mode: "error", modelVisibleError: "invalid input" },
          },
        }
        return
      }
      const structured: CheckSecretsStructured = {
        findings,
        source,
        ...(target !== undefined ? { target } : {}),
        truncated: false,
      }
      yield {
        type: "result",
        result: {
          ok: true,
          output: renderOutput(findings),
          structured,
        },
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      yield {
        type: "result",
        result: {
          ok: false,
          output: `check_secrets: scan failed (${msg})`,
          failure: { mode: "error", modelVisibleError: msg },
        },
      }
    }
  },
})
