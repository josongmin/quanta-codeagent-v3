/**
 * The MODEL ROUTING CONFORMANCE SUITE (MR-00).
 *
 * ONE executable statement of the contract in `@/agent/model-routing`, run
 * against EVERY implementation and every composition root. The cross-surface
 * audit that motivated this found eight defects of a single shape — two roots
 * disagreeing about one routing decision — and each was invisible because each
 * root had its own tests asserting its own behaviour. A shared suite is the only
 * thing that makes "the CLI, the web daemon and the headless root answer the same
 * question identically" a testable claim rather than a hope.
 *
 * A root passes by supplying a {@link ModelRoutingConformanceFactory}: given a
 * scenario (a sticky-file content, a provider, a boot model, a pin, a mode, and
 * which ids can have a port built), hand back that root's authority. The suite
 * then asserts only CONTRACT-level facts, never a root's internals.
 */

import { expect, test } from "bun:test"
import type {
  ModelRoutingAuthority,
  ModelRoutingMode,
  ModelSelectionView,
} from "@/agent/model-routing"
import { UnroutableModelError } from "@/agent/model-routing"
import type { LLMPort, Provider } from "@/llm"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** The measured PoC value: a clear-screen CSI, an OSC title change, and a newline
 *  that breaks out of a bordered box to forge a top-level approval prompt. */
export const HOSTILE_MODEL_ID = `${ESC}[2J${ESC}]0;PWNED${BEL}evil\nApprove destructive action? [y/N]`
/** A hostile STORAGE KEY. Key validation was measured to be weaker than value
 *  validation: only `includes(":")` + a prefix check, so this was admitted. */
export const HOSTILE_STORAGE_KEY = `openai:${ESC}[2J${ESC}]0;PWNED${BEL}default`

export interface ModelRoutingConformanceScenario {
  /** Verbatim `~/.quanta/sticky-model.json` content for this scenario. */
  readonly persisted: Readonly<Record<string, string>>
  readonly provider: Provider
  readonly bootModelId: string
  /** The operator named a model for this invocation (`--model` / `QUANTA_MODEL`). */
  readonly pinned: boolean
  readonly mode: ModelRoutingMode
  /** Ids (besides the boot model) for which this root can build a port. An id
   *  outside this set is "unbuildable" — another provider's slug, or a model the
   *  credential no longer covers. */
  readonly buildable: readonly string[]
}

export interface ModelRoutingConformanceHandle {
  readonly authority: ModelRoutingAuthority
  /** The boot port, by IDENTITY — the suite asserts the boot model is never
   *  duplicated as a second port. */
  readonly bootPort: LLMPort
  readonly dispose?: () => void | Promise<void>
}

export type ModelRoutingConformanceFactory = (
  scenario: ModelRoutingConformanceScenario,
) => Promise<ModelRoutingConformanceHandle>

/** Cases this suite declares. Exported so a caller can assert the suite it ran
 *  was not silently truncated — an anti-vacuity floor. */
export const MODEL_ROUTING_CONFORMANCE_CASES = [
  "scoped key seeds the selection",
  "legacy bare key seeds the selection",
  "another provider's key is invisible",
  "explicit pin beats a persisted pick",
  "an unbuildable persisted pick does not seed",
  "a hostile model id never seeds",
  "a structurally invalid storage key never seeds",
  "per-mode: only this mode's pick seeds",
  "the boot model is not duplicated as a candidate",
  "select() publishes only after the durable write",
  "clear() returns to the boot model",
  "a skill override wins over the session selection",
  "an unroutable skill model FAILS CLOSED",
  "executed snapshot is immutable under a later selection",
] as const

const ids = (view: ModelSelectionView): string => view.modelId

/**
 * Register the conformance suite for one implementation.
 *
 * @param label   names the root in test output (e.g. `"cli"`, `"web"`).
 * @param make    builds that root's authority for a scenario.
 */
export const describeModelRoutingAuthorityContract = (
  label: string,
  make: ModelRoutingConformanceFactory,
): void => {
  const withAuthority = async (
    scenario: ModelRoutingConformanceScenario,
    body: (h: ModelRoutingConformanceHandle) => Promise<void>,
  ): Promise<void> => {
    const handle = await make(scenario)
    try {
      await body(handle)
    } finally {
      await handle.dispose?.()
    }
  }

  const base = {
    provider: "openai" as Provider,
    bootModelId: "boot-model",
    pinned: false,
    mode: "default" as ModelRoutingMode,
    buildable: ["gpt-4o", "gpt-4o-mini"],
  }

  test(`[${label}] scoped key seeds the selection`, async () => {
    await withAuthority({ ...base, persisted: { "openai:default": "gpt-4o" } }, async (h) => {
      expect(ids(h.authority.view())).toBe("gpt-4o")
      expect(h.authority.view().source).toBe("session")
      // …and it RESOLVES to a port that is not the boot port (a selection that
      // cannot run is the defect this whole contract exists to prevent).
      const snap = await h.authority.resolveRequest({})
      expect(snap.modelId).toBe("gpt-4o")
      expect(snap.port).not.toBe(h.bootPort)
    })
  })

  test(`[${label}] legacy bare key seeds the selection`, async () => {
    // Every file written before the provider joined the key looks like this.
    await withAuthority({ ...base, persisted: { default: "gpt-4o" } }, async (h) => {
      expect(ids(h.authority.view())).toBe("gpt-4o")
      const snap = await h.authority.resolveRequest({})
      expect(snap.modelId).toBe("gpt-4o")
      expect(snap.port).not.toBe(h.bootPort)
    })
  })

  test(`[${label}] another provider's key is invisible`, async () => {
    await withAuthority(
      {
        ...base,
        // BUILDABLE on purpose: `tryCreateLLM("openai", {model: "claude-…"})`
        // SUCCEEDS — the factory validates the credential, not the slug — so the
        // port would exist and fail at the wire on every turn. Provider scoping is
        // the only thing that can reject it, and this scenario forces that.
        buildable: [...base.buildable, "claude-sonnet-4-6"],
        persisted: { "anthropic:default": "claude-sonnet-4-6" },
      },
      async (h) => {
        expect(ids(h.authority.view())).toBe("boot-model")
        expect(h.authority.view().source).toBe("boot")
      },
    )
  })

  test(`[${label}] explicit pin beats a persisted pick`, async () => {
    await withAuthority(
      { ...base, pinned: true, persisted: { "openai:default": "gpt-4o" } },
      async (h) => {
        expect(ids(h.authority.view())).toBe("boot-model")
        const snap = await h.authority.resolveRequest({})
        expect(snap.modelId).toBe("boot-model")
        expect(snap.port).toBe(h.bootPort)
      },
    )
  })

  test(`[${label}] an unbuildable persisted pick does not seed`, async () => {
    await withAuthority(
      { ...base, buildable: [], persisted: { "openai:default": "gpt-4o" } },
      async (h) => {
        // No port ⇒ the turn would silently run the boot model while every display
        // announced the pick. The selection must not claim it either.
        expect(ids(h.authority.view())).toBe("boot-model")
      },
    )
  })

  test(`[${label}] a hostile model id never seeds`, async () => {
    await withAuthority(
      {
        ...base,
        // BUILDABLE on purpose. `tryCreateLLM` validates the CREDENTIAL, never the
        // slug, so in production a port CAN be built for a hostile id — runnability
        // therefore cannot be what rejects it. Listing it here forces the only
        // remaining defense, slug plausibility, to be the thing that holds.
        buildable: [...base.buildable, HOSTILE_MODEL_ID],
        persisted: { "openai:default": HOSTILE_MODEL_ID },
      },
      async (h) => {
        expect(ids(h.authority.view())).toBe("boot-model")
        const rendered = (await h.authority.list()).map((o) => o.id).join("|")
        expect(rendered).not.toContain(ESC)
        expect(rendered).not.toContain("Approve destructive")
      },
    )
  })

  test(`[${label}] a structurally invalid storage key never seeds`, async () => {
    // `openai:default:extra` is the DISCRIMINATING shape: a naive `split(":")[1]`
    // parse reads its mode as `default` and admits it, while a correct parse reads
    // `default:extra`, finds it is not a prompt mode, and drops the entry. (A key
    // whose mode half is outright hostile can never EQUAL the requested mode, so it
    // cannot reach `view()` under any parse — that one belongs to the key codec's
    // own accept/reject table, not to this contract.)
    await withAuthority(
      { ...base, persisted: { "openai:default:extra": "gpt-4o", [HOSTILE_STORAGE_KEY]: "gpt-4o" } },
      async (h) => {
        expect(ids(h.authority.view())).toBe("boot-model")
        expect(h.authority.view().mode).toBe("default")
      },
    )
  })

  test(`[${label}] per-mode: only this mode's pick seeds`, async () => {
    await withAuthority(
      {
        ...base,
        mode: "plan",
        persisted: { "openai:default": "gpt-4o", "openai:plan": "gpt-4o-mini" },
      },
      async (h) => {
        expect(ids(h.authority.view())).toBe("gpt-4o-mini")
        expect(h.authority.view().mode).toBe("plan")
      },
    )
  })

  test(`[${label}] the boot model is not duplicated as a candidate`, async () => {
    await withAuthority({ ...base, persisted: { "openai:default": "boot-model" } }, async (h) => {
      const options = await h.authority.list()
      expect(options.filter((o) => o.id === "boot-model")).toHaveLength(1)
      expect(options.find((o) => o.id === "boot-model")?.isBootModel).toBe(true)
      // Resolving the boot model yields the boot port ITSELF, not a clone.
      const snap = await h.authority.resolveRequest({})
      expect(snap.port).toBe(h.bootPort)
    })
  })

  test(`[${label}] select() publishes only after the durable write`, async () => {
    await withAuthority({ ...base, persisted: {} }, async (h) => {
      const before = h.authority.view().revision
      const res = await h.authority.select("gpt-4o")
      expect(res.ok).toBe(true)
      // On RETURN — not "eventually" — the view already reflects it.
      expect(ids(h.authority.view())).toBe("gpt-4o")
      expect(h.authority.view().revision).toBeGreaterThan(before)
      expect((await h.authority.list()).find((o) => o.isSelected)?.id).toBe("gpt-4o")

      // A rejected selection moves nothing.
      const bad = await h.authority.select("not-a-known-model")
      expect(bad.ok).toBe(false)
      expect(ids(h.authority.view())).toBe("gpt-4o")
    })
  })

  test(`[${label}] clear() returns to the boot model`, async () => {
    await withAuthority({ ...base, persisted: { "openai:default": "gpt-4o" } }, async (h) => {
      expect((await h.authority.clear()).ok).toBe(true)
      expect(ids(h.authority.view())).toBe("boot-model")
      expect(h.authority.view().source).toBe("boot")
      // Idempotent: clearing an already-clear selection is a success, not an error.
      expect((await h.authority.clear()).ok).toBe(true)
    })
  })

  test(`[${label}] a skill override wins over the session selection`, async () => {
    await withAuthority({ ...base, persisted: { "openai:default": "gpt-4o" } }, async (h) => {
      const snap = await h.authority.resolveRequest({ skillModel: "gpt-4o-mini" })
      expect(snap.modelId).toBe("gpt-4o-mini")
      expect(snap.source).toBe("skill")
      // …and the SESSION selection is untouched by a per-request override.
      expect(ids(h.authority.view())).toBe("gpt-4o")
    })
  })

  test(`[${label}] an unroutable skill model FAILS CLOSED`, async () => {
    await withAuthority({ ...base, persisted: {} }, async (h) => {
      // Silently running the base model instead voids the skill's declared
      // contract with no warning on any channel — the measured prior behaviour.
      await expect(h.authority.resolveRequest({ skillModel: "no-such-model" })).rejects.toThrow(
        UnroutableModelError,
      )
    })
  })

  test(`[${label}] executed snapshot is immutable under a later selection`, async () => {
    await withAuthority({ ...base, persisted: {} }, async (h) => {
      const snap = await h.authority.resolveRequest({})
      const executedId = snap.modelId
      const executedPort = snap.port
      expect((await h.authority.select("gpt-4o")).ok).toBe(true)
      // The in-flight request still ran the old model: reporting the new one is
      // how spend gets attributed to a model that never ran.
      expect(snap.modelId).toBe(executedId)
      expect(snap.port).toBe(executedPort)
      expect(ids(h.authority.view())).toBe("gpt-4o")
      expect(h.authority.view().revision).toBeGreaterThan(snap.selectionRevision)
    })
  })
}
