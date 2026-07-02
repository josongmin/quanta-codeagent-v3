/**
 * Hellgate — auto-"Other" free-text escape (jul-03 A1, AskUserQuestion parity).
 *
 * Claude's AskUserQuestion framework auto-adds an "Other" option so the user is
 * never boxed into the model's enumerated choices. `buildCliElicitationPrompter-
 * Factory` wraps the base `cliPrompter` with this escape: every enum prompt
 * gains a trailing synthetic "Other" entry; picking it re-prompts for free text
 * and returns THAT as the answer (not the sentinel).
 *
 * Invariants:
 *   1. The rendered menu INCLUDES an "Other" affordance (discoverable).
 *   2. Picking "Other" ⇒ a free-text follow-up ⇒ the typed value is returned
 *      (escape works, sentinel never leaks as the answer).
 *   3. Picking a REAL option is byte-identical to no-escape (paired control) —
 *      the extra option does not shift the answer or corrupt indexing.
 *   4. The escape is present on the MULTI path too.
 */
import { describe, expect, test } from "bun:test"
import { buildCliElicitationPrompterFactory } from "@/apps/cli/mcp-elicitation-prompter"
import type { CliPrompterIO } from "@/mcp"

/** Scripted IO: writes accumulate; reads pop from a fixed answer script. */
const scriptedIo = (answers: string[]): { io: CliPrompterIO; written: () => string } => {
  const out: string[] = []
  const script = [...answers]
  return {
    io: {
      write: (s) => {
        out.push(s)
      },
      read: () => Promise.resolve(script.shift() ?? null),
    },
    written: () => out.join(""),
  }
}

const buildPrompter = (io: CliPrompterIO) => {
  const factory = buildCliElicitationPrompterFactory({ io, interactive: true })
  if (factory === undefined) throw new Error("expected a factory in forced-interactive mode")
  return factory("test-server")
}

describe("auto-Other free-text escape", () => {
  test("menu renders an Other affordance", async () => {
    const { io, written } = scriptedIo(["1"]) // pick first real option
    const p = buildPrompter(io)
    await p.promptEnum({ prompt: "pick", options: ["a", "b"] })
    expect(written().toLowerCase()).toContain("other")
  })

  test("picking Other ⇒ free-text follow-up ⇒ typed value returned (not the sentinel)", async () => {
    // options a,b ⇒ menu is 1.a 2.b 3.Other. Answer "3" (Other), then free text.
    const { io } = scriptedIo(["3", "my-custom-answer"])
    const p = buildPrompter(io)
    const r = await p.promptEnum({ prompt: "pick", options: ["a", "b"] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("my-custom-answer")
  })

  test("BACK-COMPAT (paired control): picking a real option is unchanged by the escape", async () => {
    const { io } = scriptedIo(["2"]) // pick "b"
    const p = buildPrompter(io)
    const r = await p.promptEnum({ prompt: "pick", options: ["a", "b"] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("b")
  })

  test("MULTI path also carries the escape ⇒ Other yields a free-typed value", async () => {
    // options a,b ⇒ 1.a 2.b 3.Other. Pick "3" then free text.
    const { io } = scriptedIo(["3", "typed-in"])
    const p = buildPrompter(io)
    const r = await p.promptMultiEnum({ prompt: "pick", options: ["a", "b"] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toContain("typed-in")
  })

  test("AUDIT R3: empty options still short-circuit to empty-enum (escape must NOT mask it)", async () => {
    // No read is scripted — if the escape added an Other option we'd hang/prompt;
    // instead the base must short-circuit BEFORE any IO.
    const { io } = scriptedIo([])
    const p = buildPrompter(io)
    const r = await p.promptEnum({
      prompt: "pick",
      options: [] as unknown as [string, ...string[]],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("empty-enum")
  })

  test("AUDIT jul-03: a caller-supplied Other sentinel is NOT double-added (de-dup guard)", async () => {
    // The menu already carries the exact sentinel label; the escape must de-dup
    // (append only when absent) so the user never sees two identical "Other" rows.
    const { io, written } = scriptedIo(["1"]) // pick first real option, just to render
    const p = buildPrompter(io)
    await p.promptEnum({
      prompt: "pick",
      options: ["a", "Other (type your own answer)"],
    })
    const menu = written()
    const occurrences = menu.split("Other (type your own answer)").length - 1
    expect(occurrences).toBe(1)
  })

  test("AUDIT R3: structured options keep the escape (label is the free-text sentinel)", async () => {
    // structured options + pick Other (index 3) ⇒ free text returned, not a struct.
    const { io } = scriptedIo(["3", "hand-typed"])
    const p = buildPrompter(io)
    const r = await p.promptEnum({
      prompt: "pick",
      options: [
        { label: "a", description: "first" },
        { label: "b", preview: "b.ts" },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("hand-typed")
  })
})
