/**
 * ★ HELLGATE (MR-02 final) — the loop asks ONE owner, and the legacy slots are a
 * construction detail rather than a second code path.
 *
 * The turn path used to read three slots in three functions
 * (`readStickyModelForMode`, `resolveActiveModelId`, `resolveSkillTurnOverride`),
 * each re-deriving the `<provider>:<mode>` key, the precedence and the port
 * lookup. Three copies of a key rule is exactly how the write key and the read key
 * drifted apart one layer up, so the loop now goes through
 * `modelRoutingFor(config)`.
 *
 * Two claims, and BOTH matter:
 *   1. a wired `modelRouting` is what the loop obeys — including when it disagrees
 *      with the legacy slots (proof it is not merely tolerated alongside them);
 *   2. a host that wired only the legacy slots still works, through the shim, with
 *      the SAME precedence — so this is one implementation, not two.
 *
 * RED-on-injection: make `modelRoutingFor` ignore `config.modelRouting` ⇒ case 1
 * reds; break the shim's `peek` key ⇒ cases 3/4 red.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { effectiveModelOf } from "@/agent/effective-model"
import { readStickyModelForMode, resolveSkillTurnOverride } from "@/agent/loop/skill-gate"
import { modelRoutingFor } from "@/agent/model-routing"
import { inMemoryStickyModelStore, stickyModelKeyOf } from "@/agent/sticky-model"
import type { LLMPort } from "@/llm"
import { fakeModelRouting } from "../../_support/fake-model-routing"

const port = (model: string): LLMPort => ({ model, provider: "openai" }) as unknown as LLMPort
const BOOT = port("boot-model")
const PICKED = port("gpt-4o")
const OTHER = port("o3")

describe("MR-02 final · the loop reads ONE owner", () => {
  test("1. a wired `modelRouting` WINS over the legacy slots", async () => {
    // The authority says `o3`; the legacy store says `gpt-4o`. If the loop still
    // consulted the slots directly — or merely preferred them — this would resolve
    // to gpt-4o. It must obey the owner.
    const { routing } = fakeModelRouting({ bootModelId: "boot-model", ids: ["boot-model", "o3"] })
    await routing.select("o3")
    const cfg = {
      llm: BOOT,
      modelRouting: routing,
      stickyModelStore: {
        store: inMemoryStickyModelStore({
          [stickyModelKeyOf({ mode: "default", provider: "openai" })]: "gpt-4o",
        }),
        provider: "openai",
      },
      modelCandidates: [
        { id: "gpt-4o", port: PICKED },
        { id: "o3", port: OTHER },
      ],
    } as unknown as AgentConfig

    expect(await readStickyModelForMode(cfg)).toBe("o3")
    expect(effectiveModelOf(cfg)).toBe("o3")
    const resolved = resolveSkillTurnOverride(cfg, undefined, await readStickyModelForMode(cfg))
    expect(resolved.llm).toBe(OTHER)
  })

  test("2. the authority is MEMOIZED per config — a revision is stable across reads", () => {
    // A shim minted per call would hand out a fresh `revision` each time, making
    // "did the selection change?" unanswerable for anything comparing snapshots.
    const cfg = { llm: BOOT } as unknown as AgentConfig
    expect(modelRoutingFor(cfg)).toBe(modelRoutingFor(cfg))
  })

  test("3. LEGACY-ONLY host: the shim resolves the pick through the same precedence", async () => {
    const cfg = {
      llm: BOOT,
      stickyModelStore: {
        store: inMemoryStickyModelStore({
          [stickyModelKeyOf({ mode: "default", provider: "openai" })]: "gpt-4o",
        }),
        provider: "openai",
      },
      modelCandidates: [{ id: "gpt-4o", port: PICKED }],
    } as unknown as AgentConfig

    expect(await readStickyModelForMode(cfg)).toBe("gpt-4o")
    expect(resolveSkillTurnOverride(cfg, undefined, "gpt-4o").llm).toBe(PICKED)
    // …and a SKILL override still out-ranks the session selection.
    const snap = await modelRoutingFor(cfg).resolveRequest({ skillModel: "boot-model" })
    expect(snap.source).toBe("skill")
    expect(snap.port).toBe(BOOT)
  })

  test("4. LEGACY-ONLY host: a selection with NO candidate degrades, it does not throw", async () => {
    // The long-standing advisory behaviour for a bare-store host. Fail-closed is
    // for an explicit SKILL requirement only — killing these turns would be a
    // regression dressed as a fix.
    const cfg = {
      llm: BOOT,
      stickyModelStore: {
        store: inMemoryStickyModelStore({
          [stickyModelKeyOf({ mode: "default", provider: "openai" })]: "vanished",
        }),
        provider: "openai",
      },
      modelCandidates: [],
    } as unknown as AgentConfig
    const snap = await modelRoutingFor(cfg).resolveRequest({})
    expect(snap.port).toBe(BOOT)
    expect(snap.source).toBe("boot")
  })

  test("5. paired control — no slots at all ⇒ the boot port, byte-identical", async () => {
    const cfg = { llm: BOOT } as unknown as AgentConfig
    expect(await readStickyModelForMode(cfg)).toBeUndefined()
    expect(resolveSkillTurnOverride(cfg, undefined, undefined).llm).toBe(BOOT)
    expect(effectiveModelOf(cfg)).toBe("boot-model")
  })
})
