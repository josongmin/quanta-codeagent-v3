/**
 * DRIFT GUARD — the two composition paths must open the SAME capability slots.
 *
 * This repo binds an agent two ways. `assembleAgentConfig` serves the headless /
 * SDK / batch surfaces and folds the capability-wire registry. The INTERACTIVE
 * CLI never calls it: it binds through `context-binding#wireRuntimePorts`. For a
 * long time only the first path folded the registry, so the surfaces disagreed
 * about which capabilities exist — measured slot-by-slot under identical gates,
 * the CLI left `browser`, `appshot`, `diagnosticsProvider`, `promptCacheObserver`,
 * `vcsEventSink` and `sideAgentDaemons` unset while the assembler set all six,
 * and an operator who turned those gates on got nothing with no error saying why.
 * `readFileState` was a seventh and worse, because its gate is DEFAULT-ON: the
 * TOCTOU stale-read guard was inert in the shipped CLI.
 *
 * Not one existing test could see it, because each one drove ONE path.
 *
 * The expected slot set is DERIVED, never written down: fold the registry onto a
 * copy and diff the keys. A hand-written name→key table would be a second thing
 * to keep in sync, i.e. the same class of bug one level up.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { CAPABILITY_WIRES } from "@/host/runtime/agent-config-assembler"
import { foldCapabilityWires } from "@/host/runtime/capability-wire-registry"

const REPO_ROOT = join(import.meta.dir, "..", "..")

import { wireRuntimePorts } from "@/host/runtime/internal/context-binding/base"

/** Every capability gate ON, so the registry actually opens slots — a guard run
 *  with everything off would pass vacuously. */
const GATES: Record<string, string> = {
  QUANTA_BROWSER_TOOL: "1",
  QUANTA_APPSHOT: "1",
  QUANTA_OBJECTIVE_TOOLS: "1",
  QUANTA_SUBAGENT_MAILBOX: "1",
  QUANTA_PEER_MESSAGE: "1",
  QUANTA_WEB_SEARCH: "1",
  QUANTA_SUBAGENT_BG: "1",
  QUANTA_EDIT_REPAIR_LOOP: "1",
  QUANTA_SKILL_MCP: "1",
  QUANTA_PROMPT_CACHE_STATUS: "1",
  QUANTA_PASSIVE_VCS: "1",
  QUANTA_PROGRESS_SINK: "1",
  QUANTA_PII_REDACTION: "1",
  QUANTA_SIDE_AGENT: "1",
  QUANTA_WRITE_BUDGET: "1",
  QUANTA_BUDGET_LEDGER: "1",
}

const baseConfig = () =>
  ({
    llm: { model: "m", stream: async function* () {} },
    signal: new AbortController().signal,
    cwd: REPO_ROOT,
    sessionId: "parity-probe",
  }) as unknown as AgentConfig

/** The slot names the registry OPENS under `GATES`, derived by folding it. */
const registryOpenedSlots = (): readonly string[] => {
  const before = baseConfig() as unknown as Record<string, unknown>
  const after = { ...before } as unknown as AgentConfig
  foldCapabilityWires(CAPABILITY_WIRES, after, GATES)
  const rec = after as unknown as Record<string, unknown>
  return Object.keys(rec).filter((k) => rec[k] !== undefined && before[k] === undefined)
}

describe("capability wires — assembler path vs CLI path", () => {
  test("the registry opens a non-empty slot set under these gates (anti-vacuum)", () => {
    expect(registryOpenedSlots().length).toBeGreaterThan(0)
  })

  test("every slot the registry opens is ALSO opened on the CLI binding path", () => {
    const expected = registryOpenedSlots()
    const bound = wireRuntimePorts(baseConfig() as never, GATES) as unknown as Record<
      string,
      unknown
    >
    const missing = expected.filter((k) => bound[k] === undefined)
    // Named rather than counted: a failure must say WHICH capability the CLI
    // silently lacks, since that is the whole cost of this class of bug.
    expect(missing).toEqual([])
  })

  test("gates unset ⇒ the CLI path opens no capability slot it would not have had", () => {
    const before = baseConfig() as unknown as Record<string, unknown>
    const bound = wireRuntimePorts(baseConfig() as never, {}) as unknown as Record<string, unknown>
    const opened = registryOpenedSlots().filter(
      (k) => bound[k] !== undefined && before[k] === undefined,
    )
    // `readFileState` is the ONE default-ON member (its gate is a strict
    // kill-switch, not an opt-in), so it is expected here and nothing else is.
    expect(opened).toEqual(["readFileState"])
  })
})

/**
 * The parity test above proves the CLI's binding path opens the same slots the
 * assembler does. It cannot prove a THIRD path does — and a third path is
 * exactly how this defect was born: someone bound a runtime without folding the
 * registry, every unit test kept passing, and the product lost a DEFAULT-ON
 * safety control.
 *
 * So this half pins the seam itself. `createRuntimeContextBinding` is the one
 * function that turns a base into the object the loop dispatches tools through,
 * so every call to it must hand over a base that went through
 * `wireRuntimePorts` (which folds the registry) — or be listed here with a
 * reason. Source-level on purpose: a new binding path is a new CALL, and no
 * runtime assertion sees a call that a future author has not written yet.
 *
 * KNOWN LIMITS, stated so nobody reads more assurance into this than it gives:
 *
 *   - It watches ONE seam. A future path that builds an `AgentConfig` and hands
 *     it to the loop without `createRuntimeContextBinding` is invisible here.
 *     The parity test above is the behavioural half and has the same bound.
 *   - A base wired earlier and passed by variable reads as UNWIRED, so it fails
 *     until someone justifies it. That direction is deliberate: a false alarm
 *     costs a comment, a missed one costs a silent capability loss.
 *   - The allowlist is text, so a genuinely unwired call could be silenced by
 *     pasting an allowlisted fragment into it. Every allowlist has this floor;
 *     the entry has to carry a reason, which is what review reads.
 */
describe("capability wires — no binding path may skip the fold", () => {
  const BIND_FILE = join(REPO_ROOT, "src/host/runtime/internal/context-binding.ts")

  /** Call sites that legitimately pass an ALREADY-wired base. The key is the
   *  distinguishing source fragment of the `base:` expression. */
  const REBIND_ALLOWLIST: Record<string, string> = {
    "...normalizedState.base":
      "Re-bind of an already-normalized base during a control-op patch: the slots were opened when that state was first bound, and re-wiring would mint a SECOND ReadFileState for one session (the child-local-state bug in reverse).",
  }

  /** Index of the `}` closing the `{` at `open`, or -1 when unbalanced. */
  const closingBrace = (src: string, open: number): number => {
    let depth = 0
    for (let i = open; i < src.length; i++) {
      const ch = src[i]
      if (ch === "{") depth++
      else if (ch === "}" && --depth === 0) return i
    }
    return -1
  }

  /** The argument object of each `createRuntimeContextBinding({...})` call,
   *  delimited by BRACE MATCHING rather than by a fixed character window — a
   *  window is a magic number that silently starts lying the moment a call is
   *  reformatted or a longer expression is passed. */
  const bindCallArgs = (src: string): readonly string[] => {
    const out: string[] = []
    const needle = "createRuntimeContextBinding({"
    let from = 0
    for (;;) {
      const at = src.indexOf(needle, from)
      if (at === -1) break
      const end = closingBrace(src, at + needle.length - 1)
      // An unbalanced literal means the scan lost the thread; surface it rather
      // than silently skipping a call site (which would read as "all wired").
      expect(end).toBeGreaterThan(at)
      out.push(src.slice(at, end + 1))
      from = end
    }
    return out
  }

  test("R1 the fold reaches BOTH sanctioned entry points", async () => {
    const asm = await Bun.file(join(REPO_ROOT, "src/host/runtime/agent-config-assembler.ts")).text()
    const cli = await Bun.file(
      join(REPO_ROOT, "src/host/runtime/internal/context-binding/base.ts"),
    ).text()
    expect(asm).toContain("foldCapabilityWires(")
    expect(cli).toContain("foldCapabilityWires(")
  })

  test("R2 every createRuntimeContextBinding call wires its base (or is justified)", async () => {
    const src = await Bun.file(BIND_FILE).text()
    const calls = bindCallArgs(src)
    expect(calls.length).toBeGreaterThan(0)
    const unwired = calls.filter((c) => {
      if (c.includes("wireRuntimePorts(")) return false
      return !Object.keys(REBIND_ALLOWLIST).some((k) => c.includes(k))
    })
    // Reported as the offending source window so a failure names WHICH call.
    expect(unwired).toEqual([])
  })
})
