/**
 * `/model <id>` on the web surface — the confirmation must wait for the switch.
 *
 * The switch is applied OUT OF BAND: the `set_model` control frame is drained on
 * the loop's next control tick, and the daemon's store write is fire-and-forget
 * (its applier is sync by contract and must not throw). So the first read-back
 * after sending reports the OLD model nearly every time — and the command printed
 * that under a line reading "reading back the effective model", i.e. it told the
 * operator their switch had failed while it was landing a moment later.
 *
 * The command now POLLS the readout for a bounded window and says plainly when the
 * model still is not the effective one (an off-catalog id IS rejected server-side,
 * so that outcome is real and must be reportable).
 */
import { describe, expect, it } from "vitest"
import type { SlashCommand } from "./SlashPalette"
import { buildLlmConfigSlashCommands } from "./slash-llm-config"

const runModel = async (cmds: readonly SlashCommand[], arg: string): Promise<void> => {
  const cmd = cmds.find((c) => c.slug === "model")
  expect(cmd).toBeDefined()
  if (cmd !== undefined && (cmd.kind === "local" || cmd.kind === "readout")) await cmd.action(arg)
}

/** A readout that reports the boot model for the first `staleReads` calls and the
 *  new model afterwards — the real timing, compressed. */
const endpoint = (staleReads: number, opts?: { readonly neverApplies?: boolean }) => {
  const results: { text: string; kind: string }[] = []
  const sent: unknown[] = []
  let reads = 0
  const shown: string[] = []
  return {
    results,
    sent,
    shown,
    reads: () => reads,
    ep: {
      httpUrl: "http://localhost:9999",
      onResult: (text: string, kind: string) => results.push({ text, kind }),
      sendControlRequest: (request: unknown) => {
        sent.push(request)
        return true
      },
      showReadout: async (name: string) => {
        shown.push(name)
      },
      readReadout: async () => {
        reads += 1
        const applied = opts?.neverApplies !== true && reads > staleReads
        return `model  ${applied ? "gpt-4o" : "boot-model"}\n   boot-model\n * gpt-4o\n`
      },
      // No real timers in the test — the poll cadence is injected.
      delay: async () => undefined,
    } as never,
  }
}

describe("/model <id> confirmation waits for the out-of-band switch", () => {
  it("polls past the stale read-backs and reports success ONCE applied", async () => {
    const h = endpoint(2)
    await runModel(buildLlmConfigSlashCommands(h.ep), "gpt-4o")
    expect(h.sent).toEqual([{ kind: "set_model", model: "gpt-4o" }])
    // It did NOT accept the first (stale) answer.
    expect(h.reads()).toBeGreaterThan(1)
    // The readout is still printed, so the operator sees the live list.
    expect(h.shown).toEqual(["model"])
    // …and no "still not the effective model" complaint was emitted.
    expect(h.results.some((r) => r.text.includes("still not the effective model"))).toBe(false)
  })

  it("says so plainly when the model never becomes effective (a rejected id)", async () => {
    const h = endpoint(0, { neverApplies: true })
    await runModel(buildLlmConfigSlashCommands(h.ep), "not-on-the-catalog")
    const complaint = h.results.find((r) => r.text.includes("still not the effective model"))
    expect(complaint).toBeDefined()
    expect(complaint?.kind).toBe("err")
  })

  it("a CANDIDATE row does not count as applied (the id is listed either way)", async () => {
    // The readout lists every switchable id, so "the body contains the slug" would
    // report success immediately — for a switch that never happened.
    const h = endpoint(0, { neverApplies: true })
    await runModel(buildLlmConfigSlashCommands(h.ep), "gpt-4o")
    expect(h.results.some((r) => r.text.includes("still not the effective model"))).toBe(true)
  })

  it("no reader wired ⇒ optimistic, exactly as before (no false failure claim)", async () => {
    const results: { text: string; kind: string }[] = []
    const cmds = buildLlmConfigSlashCommands({
      httpUrl: "http://localhost:9999",
      onResult: (text: string, kind: string) => results.push({ text, kind }),
      sendControlRequest: () => true,
      showReadout: async () => undefined,
    } as never)
    await runModel(cmds, "gpt-4o")
    expect(results.some((r) => r.text.includes("still not the effective model"))).toBe(false)
  })
})
