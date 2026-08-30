/**
 * RFC jun-6 C4 hellgate — `gh_pr_edit_labels`.
 *
 * Closed-port (injected GhRunner). Adversarial / edge cases pin the argv
 * contract + the per-label arg-injection guard:
 *   - add/remove build the exact `gh pr edit … --add-label … --remove-label …`
 *     argv (each label a SEPARATE element; comma/space inside a name stays
 *     literal — no shell, no re-split).
 *   - a `-`-leading / empty / whitespace label is REJECTED before argv (no flag
 *     injection); the runner is never called.
 *   - a `-`-leading PR ref is rejected (normalizeRef).
 *   - the schema rejects an empty (no add/remove) call.
 *   - a gh non-zero exit surfaces stderr (sliced), never throws.
 *   - no env leak: the default runner is fenced by scrubEnv (asserted via the
 *     gh runner allowlist module).
 */
import { describe, expect, test } from "bun:test"
import { type GhRunner, ghPrEditLabelsTool } from "@/tool/gh"
import type { ToolEvent } from "@/tool/types"

const okGh = (stdout: string) => ({ code: 0, stdout, stderr: "" })
const failGh = (stderr: string) => ({ code: 1, stdout: "", stderr })

const captureCalls = (
  reply: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): GhRunner & { argv: string[][] } => {
  const argv: string[][] = []
  return Object.assign(
    async (a: string[], _cwd: string, _t: number) => {
      argv.push([...a])
      return reply(a)
    },
    { argv },
  ) as GhRunner & { argv: string[][] }
}

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const events: ToolEvent[] = []
  for await (const ev of it) events.push(ev)
  return events
}

const resultOf = (events: ToolEvent[]): { ok: boolean; output: string } | undefined => {
  const r = events.find((e) => e.type === "result")
  if (r && r.type === "result") return r.result as { ok: boolean; output: string }
  return undefined
}

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal })

describe("gh_pr_edit_labels (hellgate)", () => {
  test("HELL-1: add + remove build the exact argv (each label a separate element)", async () => {
    const runner = captureCalls(async () => okGh("labels updated"))
    await drain(
      ghPrEditLabelsTool(runner).execute({ pr: 7, add: ["a", "b"], remove: ["c"] }, ctx()),
    )
    expect(runner.argv[0]).toEqual([
      "gh",
      "pr",
      "edit",
      "7",
      "--add-label",
      "a",
      "--add-label",
      "b",
      "--remove-label",
      "c",
    ])
  })

  test("HELL-2: add-only argv has no --remove-label", async () => {
    const runner = captureCalls(async () => okGh(""))
    await drain(ghPrEditLabelsTool(runner).execute({ pr: 1, add: ["needs-review"] }, ctx()))
    expect(runner.argv[0]).toEqual(["gh", "pr", "edit", "1", "--add-label", "needs-review"])
    expect(runner.argv[0]).not.toContain("--remove-label")
  })

  test("HELL-3: remove-only argv has no --add-label", async () => {
    const runner = captureCalls(async () => okGh(""))
    await drain(ghPrEditLabelsTool(runner).execute({ pr: 1, remove: ["do-not-merge"] }, ctx()))
    expect(runner.argv[0]).toEqual(["gh", "pr", "edit", "1", "--remove-label", "do-not-merge"])
    expect(runner.argv[0]).not.toContain("--add-label")
  })

  test("HELL-4: a label with comma/space stays ONE literal argv element (no re-split)", async () => {
    const runner = captureCalls(async () => okGh(""))
    await drain(ghPrEditLabelsTool(runner).execute({ pr: 1, add: ["needs review, urgent"] }, ctx()))
    // ONE element after the flag — never split on the comma into two labels.
    expect(runner.argv[0]).toEqual(["gh", "pr", "edit", "1", "--add-label", "needs review, urgent"])
  })

  test("HELL-5: a `--`-leading label is REJECTED (no flag injection), runner not called", async () => {
    const runner = captureCalls(async () => okGh(""))
    const events = await drain(
      ghPrEditLabelsTool(runner).execute({ pr: 1, add: ["--repo"] }, ctx()),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("invalid label")
    expect(runner.argv.length).toBe(0)
  })

  test("HELL-6: a `-`-leading label in `remove` is REJECTED (no flag injection)", async () => {
    const runner = captureCalls(async () => okGh(""))
    const events = await drain(
      ghPrEditLabelsTool(runner).execute({ pr: 1, remove: ["-R/owner/evil"] }, ctx()),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("invalid label")
    expect(runner.argv.length).toBe(0)
  })

  test("HELL-7: an empty / whitespace-only label is REJECTED, runner not called", async () => {
    const runnerEmpty = captureCalls(async () => okGh(""))
    const e1 = await drain(ghPrEditLabelsTool(runnerEmpty).execute({ pr: 1, add: [""] }, ctx()))
    expect(resultOf(e1)?.ok).toBe(false)
    expect(runnerEmpty.argv.length).toBe(0)

    const runnerWs = captureCalls(async () => okGh(""))
    const e2 = await drain(ghPrEditLabelsTool(runnerWs).execute({ pr: 1, add: ["   "] }, ctx()))
    expect(resultOf(e2)?.ok).toBe(false)
    expect(runnerWs.argv.length).toBe(0)
  })

  test("HELL-8: ONE unsafe label among safe ones rejects the WHOLE call (no partial argv)", async () => {
    const runner = captureCalls(async () => okGh(""))
    const events = await drain(
      ghPrEditLabelsTool(runner).execute(
        { pr: 1, add: ["good", "--bad"], remove: ["alsogood"] },
        ctx(),
      ),
    )
    expect(resultOf(events)?.ok).toBe(false)
    // The good labels must NOT have reached argv either — fail-closed.
    expect(runner.argv.length).toBe(0)
  })

  test("HELL-9: a `-`-leading PR ref is rejected (normalizeRef), runner not called", async () => {
    const runner = captureCalls(async () => okGh(""))
    const events = await drain(
      ghPrEditLabelsTool(runner).execute({ pr: "--web", add: ["x"] }, ctx()),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("invalid PR identifier")
    expect(runner.argv.length).toBe(0)
  })

  test("HELL-10: empty input (no add/remove) is rejected by the schema", () => {
    const tool = ghPrEditLabelsTool(captureCalls(async () => okGh("")))
    expect(tool.inputSchema.safeParse({ pr: 1 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ pr: 1, add: [], remove: [] }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ pr: 1, add: ["x"] }).success).toBe(true)
  })

  test("HELL-11: gh non-zero exit surfaces stderr (sliced), never throws", async () => {
    const runner = captureCalls(async () => failGh("could not add label 'nope': not found"))
    const events = await drain(ghPrEditLabelsTool(runner).execute({ pr: 1, add: ["nope"] }, ctx()))
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("gh pr edit failed")
    expect(resultOf(events)?.output).toContain("not found")
  })

  test("HELL-12: success with empty stdout yields a default message", async () => {
    const runner = captureCalls(async () => okGh(""))
    const events = await drain(ghPrEditLabelsTool(runner).execute({ pr: 1, add: ["x"] }, ctx()))
    expect(resultOf(events)?.ok).toBe(true)
    expect(resultOf(events)?.output).toBe("labels updated")
  })

  test("HELL-13: the tool is declared mutating (isReadOnly false, not concurrency-safe)", () => {
    const tool = ghPrEditLabelsTool(captureCalls(async () => okGh("")))
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe({ pr: 1, add: ["x"] })).toBe(false)
  })

  test("HELL-14: env fence — the gh runner allowlist excludes provider keys", async () => {
    // The default runner scrubs env to CI_ENV_ALLOWLIST (@/shared SSOT); assert provider
    // keys are NOT in that allowlist (the structural fence the runner applies).
    const mod = await import("@/runtime")
    const scrubbed = mod.scrubEnv(["PATH", "GH_TOKEN"])
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
