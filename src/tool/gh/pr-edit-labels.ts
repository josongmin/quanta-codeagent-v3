/**
 * `gh_pr_edit_labels` — add / remove labels on a GitHub PR (RFC jun-6, C4).
 *
 * A thin, MUTATING wrapper over `gh pr edit <pr> --add-label <l> --remove-label
 * <l>`. quanta's gh tools READ labels (`gh issue view --json …,labels`) but had
 * no way to MUTATE them; adding/removing `needs-review` / `ready-to-merge` /
 * `do-not-merge` labels is a staple of CI-automation triage + merge-gating.
 *
 * SECURITY — per-label arg-injection guard. A label name is a VALUE passed
 * after a `--add-label` / `--remove-label` flag. A `-`-leading value (a label
 * literally named `--repo`, `-R/owner/evil`) would be parsed by `gh` as a FLAG
 * — the same arg-injection class `normalizeRef` defends for the positional ref.
 * `isUnsafeLabel` rejects empty strings and any `-`-leading value BEFORE argv is
 * built, and every label is pushed as a SEPARATE argv element after its flag
 * (never shell-joined / comma-joined), so commas/spaces inside a label name stay
 * literal — `Bun.spawn` argv, no shell, no re-split.
 *
 * Permission posture: `isReadOnly:()=>false`; the mode's gitWrite lever is the
 * structural gate (mirrors `gh_pr_auto_merge`). Default-OFF under the shared
 * `QUANTA_GIT_TOOLS` gate (rides the gh-tool manifest group). Closed-port DI —
 * the injected `GhRunner` is the only boundary (no clock, no randomness, no
 * network in tests).
 */
import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { normalizeRef, refRejected } from "./ref"
import { DEFAULT_TIMEOUT_MS, defaultGhRunner, type GhRunner } from "./runner"

const prEditLabelsSchema = z
  .object({
    pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
    add: z.array(z.string()).optional().describe("Label names to add"),
    remove: z.array(z.string()).optional().describe("Label names to remove"),
  })
  .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, {
    message: "at least one of add/remove must be non-empty",
  })
export type PrEditLabelsInput = z.infer<typeof prEditLabelsSchema>

/** A label name is UNSAFE iff it is empty (after trim) or `-`-leading — either
 *  would let `gh` treat the value as a flag (arg-injection). Whitespace-only is
 *  empty after trim. Same defense class as `normalizeRef` for the positional
 *  ref; rejected BEFORE the value reaches argv. */
export const isUnsafeLabel = (label: string): boolean => {
  const s = label.trim()
  if (s.length === 0) return true
  if (s.startsWith("-")) return true
  return false
}

/** Deterministic rejection envelope for an arg-injection-unsafe label. */
export const labelRejected = (label: string): string =>
  `invalid label '${label}': a label may not be empty or begin with '-' ` +
  "(a leading-dash value would be parsed as a gh flag)"

export const ghPrEditLabelsTool = (
  runner: GhRunner = defaultGhRunner,
): Tool<PrEditLabelsInput> => ({
  name: "gh_pr_edit_labels",
  description:
    "Add and/or remove labels on a GitHub PR via `gh pr edit --add-label / " +
    "--remove-label`. Write — the mode's gitWrite lever is the structural gate; " +
    "this tool just invokes `gh`. Pass `add` and/or `remove` (at least one " +
    "non-empty). Each label is a literal value (no shell, no comma-splitting).",
  inputSchema: prEditLabelsSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: PrEditLabelsInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.pr)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } }
      return
    }
    const add = input.add ?? []
    const remove = input.remove ?? []
    // Per-label arg-injection guard — reject BEFORE any flag/value reaches argv.
    const bad = [...add, ...remove].find(isUnsafeLabel)
    if (bad !== undefined) {
      yield { type: "result", result: { ok: false, output: labelRejected(bad) } }
      return
    }
    const argv = ["gh", "pr", "edit", ref]
    for (const l of add) argv.push("--add-label", l)
    for (const l of remove) argv.push("--remove-label", l)
    yield { type: "progress", message: `gh pr edit #${input.pr} (labels)` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr edit failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: r.stdout.trim() || "labels updated" } }
  },
})
