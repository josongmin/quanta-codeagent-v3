/**
 * G1 — `appshot_verify` tool (RFC jun-6-appgen-appshot §4, Phase 1).
 *
 * Exposes the closed verify loop ({@link runAppshotLoop}) as ONE model-facing
 * tool: take a natural-language app spec → scaffold a small web app → render it
 * → screenshot it → LLM-judge against the spec → iterate (bounded) until the
 * rendering passes or the iteration cap is hit. The "render-and-look-back" cycle
 * is the load-bearing novelty (code that "looks right" as text often renders
 * broken).
 *
 * Slice posture (RFC §3.1, §9): imports `zod`, the `defineTool` factory, the
 * `@/tool` types, and its OWN `./loop` + `./port`. NO `@/browser`, `@/agent`,
 * `@/llm`, `@/artifact`. ALL effects (scaffold/render/screenshot/verify) ride
 * the injected {@link AppshotPort}; the clock is injected; the artifact sink is
 * injected. The composition root wires render/screenshot→`BrowserPort`,
 * verify→LLM-judge, scaffold→jailed-write; tests inject a fake.
 *
 * Mutating: `isReadOnly()` is FALSE (scaffold writes files; render+verify spend
 * a browser session + LLM-judge tokens). NO-THROW: the loop already maps every
 * effect throw to a typed result, and the tool wraps schema/abort the same way.
 *
 * DEFAULT-OFF: registered ONLY when the composition root passes a wired
 * `DefaultToolPorts.appshot` (gated on `QUANTA_APPSHOT`); absent ⇒ the tool is
 * NOT in the menu ⇒ byte-identical default tool set.
 */

import { z } from "zod"
import { defineTool } from "../factory"
import type { CoreToolContext, Tool, ToolEvent, ToolResult } from "../types"
import {
  APPSHOT_MAX_ITER,
  APPSHOT_MIN_ITER,
  type AppshotResult,
  clampIter,
  runAppshotLoop,
} from "./loop"
import type { AppshotArtifactSink, AppshotPort } from "./port"

/** Upper bound on the model-supplied `prompt` (chars). Defensive input cap, not
 *  a semantic limit: the prompt is a natural-language app SPEC, so even a very
 *  detailed brief is well under this; the bound only rejects a pathological
 *  multi-megabyte string before it is threaded into the scaffold adapter
 *  (zod `.max()` ⇒ a typed validation error, never a silent truncation). 32_000
 *  chars ≈ 8k tokens at the ~4 chars/token estimate this repo uses
 *  (`agent/compaction.ts`), i.e. a roomy spec budget. Named (not inline) so the
 *  basis is auditable. */
const PROMPT_MAX = 32_000
/** Default iteration cap when the model omits `max_iterations`. Conservative —
 *  enough to refine once or twice without burning tokens on a stuck judge.
 *  Within the hard `[APPSHOT_MIN_ITER, APPSHOT_MAX_ITER]` band (see loop.ts). */
const DEFAULT_ITER = 3

export const appshotVerifyInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(PROMPT_MAX)
    .describe("Natural-language spec of the web app to scaffold, render, and verify."),
  out_dir: z
    .string()
    .min(1)
    .describe(
      "Destination directory for the scaffolded app (relative to cwd, FS-jailed). " +
        "The entry file (index.html) is written here and registered as an artifact.",
    ),
  max_iterations: z
    .number()
    .int()
    .min(APPSHOT_MIN_ITER)
    .max(APPSHOT_MAX_ITER)
    .optional()
    .describe(
      `Max scaffold→render→screenshot→verify iterations (${APPSHOT_MIN_ITER}-${APPSHOT_MAX_ITER}, ` +
        `default ${DEFAULT_ITER}). The loop stops EARLY on a pass verdict; it never loops unbounded.`,
    ),
  label: z.string().optional().describe("Optional human label for the produced app artifact."),
})
export type AppshotVerifyInput = z.infer<typeof appshotVerifyInputSchema>

/** Options for {@link appshotVerifyTool}. */
export interface AppshotToolOptions {
  /** Injected verify-loop port (browser+judge+scaffold). REQUIRED — the
   *  composition root builds it from the real `BrowserPort` + LLM-judge +
   *  jailed writer; tests inject a fake. */
  readonly port: AppshotPort
  /** Injected clock — the ONLY time source (no `Date.now()` in-slice). The
   *  composition root passes `() => Date.now()`. */
  readonly now: () => number
  /** Optional artifact sink — when the artifact store is ALSO wired, the final
   *  scaffold is registered. Absent ⇒ no registration (byte-identical output). */
  readonly artifactSink?: AppshotArtifactSink
}

const err = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Render the loop result into the model-facing `output` string. */
const renderResult = (result: AppshotResult): string => {
  const lines: string[] = []
  const n = result.iterations.length
  lines.push(`appshot: ${result.outcome} after ${n} iteration${n === 1 ? "" : "s"}.`)
  if (result.entryUrl !== undefined) lines.push(`entry: ${result.entryUrl}`)
  if (result.artifactId !== undefined) {
    lines.push(`artifact: ${result.artifactId} (quanta-artifact://${result.artifactId})`)
  }
  if (result.lastVerdict !== undefined) {
    lines.push(
      `verdict: ${result.lastVerdict.pass ? "PASS" : "FAIL"} — ${result.lastVerdict.notes}`,
    )
  }
  if (result.error !== undefined) lines.push(`error: ${result.error.kind}`)
  return lines.join("\n")
}

/** Map the loop outcome to a ToolResult. `pass`/`exhausted` are reported as
 *  `ok:true` (the loop COMPLETED — exhaustion is a real, surfaced verdict, not a
 *  tool failure); `failed` (an effect error: Chrome down, jail escape, abort) AND
 *  `refused` (a fail-closed pre-flight/contract refusal: browser/judge
 *  unavailable, or an unverified pass) are BOTH `ok:false` with a typed failure so
 *  the model can never read a refusal/failure as a passing verdict. A refusal is
 *  `mode:"rejected"` (nothing was attempted-and-broke), a failure `mode:"error"`. */
const toToolResult = (result: AppshotResult): ToolResult => {
  const output = renderResult(result)
  if (result.outcome === "refused") {
    const e = result.error
    return err(output, {
      mode: "rejected",
      reason: e !== undefined ? e.kind : "appshot_refused",
    })
  }
  if (result.outcome === "failed") {
    const e = result.error
    return err(output, {
      mode: "error",
      modelVisibleError: e !== undefined ? e.kind : "appshot_failed",
    })
  }
  return { ok: true, output }
}

/** Build the `appshot_verify` tool over an injected port + clock + sink. */
export const appshotVerifyTool = (options: AppshotToolOptions): Tool<AppshotVerifyInput> => {
  const { port, now, artifactSink } = options

  return defineTool<AppshotVerifyInput>({
    name: "appshot_verify",
    description:
      "Scaffold a small web app from a natural-language spec, render it in the headless " +
      "browser, screenshot it, and LLM-judge the rendering against the spec — iterating " +
      "(bounded) until it passes or the cap is hit. WRITES files (mutating) and spends a " +
      "browser session + judge tokens. The produced app is registered as an artifact " +
      "(quanta-artifact://<id>). The loop NEVER runs unbounded and stops early on a pass.",
    inputSchema: appshotVerifyInputSchema,
    isReadOnly: () => false,
    // Scaffolds files + drives a shared browser session; never concurrency-safe.
    isConcurrencySafe: () => false,
    // Scaffolding into a jailed workspace dir is a contained, VCS-reversible
    // mutation — pre-approval covers it (mirrors `write` / `image_gen`).
    hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

    async *execute(input: AppshotVerifyInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
      const parsed = appshotVerifyInputSchema.safeParse(input)
      if (!parsed.success) {
        yield { type: "result", result: err(`invalid input: ${parsed.error.message}`) }
        return
      }
      if (ctx.signal.aborted) {
        yield {
          type: "result",
          result: err("aborted before start", { mode: "rejected", reason: "aborted" }),
        }
        return
      }
      const data = parsed.data
      const result = await runAppshotLoop(
        { port, now, ...(artifactSink !== undefined ? { artifactSink } : {}) },
        {
          prompt: data.prompt,
          outDir: data.out_dir,
          maxIter: clampIter(data.max_iterations ?? DEFAULT_ITER),
          ...(data.label !== undefined ? { label: data.label } : {}),
          signal: ctx.signal,
        },
      )
      yield { type: "result", result: toToolResult(result) }
    },
  })
}
