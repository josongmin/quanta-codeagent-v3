/**
 * HELLGATE — the headless / one-shot composition root must emit BOTH halves of
 * the per-turn model switch (aug-28, findings L4 / #11).
 *
 * THE MEASURED DEFECT. `buildBaseFromArgs` (the root behind `quanta -p` and every
 * `apps/agent` mode preset) has always attached `stickyModelStore` and NEVER
 * `modelCandidates`. The loop needs both, every turn:
 *   1. `skill-gate#readStickyModelForMode` reads the store — the SAME
 *      `~/.quanta/sticky-model.json` file and the SAME `<provider>:<mode>` key
 *      the interactive CLI's `/model` writes;
 *   2. `skill-gate#resolveSkillTurnOverride` resolves that id against
 *      `config.modelCandidates` to get a PORT.
 * With (2) absent, (1) returned the operator's pick and the swap then found no
 * port and fell back to `config.llm` — the one-shot run executed the BOOT model
 * with no error, no warning, and no banner anywhere to say so.
 *
 * WHAT COUNTS AS PROOF HERE. `expect(base.modelCandidates).toBeDefined()` does
 * NOT: a slot can be present and still resolve to nothing. Every positive case
 * runs the LOOP'S OWN PAIR over the REAL base — `readStickyModelForMode` then
 * `resolveSkillTurnOverride` — and asserts the resolved port is a DIFFERENT
 * object from the boot port and carries the picked model id. That pair is the
 * exact code path a turn takes, so it cannot pass while the turn silently runs
 * the boot model.
 *
 * PAIRED CONTROLS pin the scope honestly: no pick on disk ⇒ the slot is ABSENT
 * (byte-identical default); no `--sticky-model` ⇒ the in-memory store cannot see
 * a cross-session pick, so neither half fires; another provider's pick is not
 * offered; and a pick that IS the boot model mints no second port (invariant A).
 *
 * HERMETIC: `QUANTA_CONFIG_DIR` points at a fresh temp dir per case and the
 * frozen runtime config is reset, so nothing here reads or writes the
 * developer's real `~/.quanta/sticky-model.json`; temp dirs and the search
 * wire's disposers are torn down in `afterEach`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { readStickyModelForMode, resolveSkillTurnOverride } from "@/agent/loop/skill-gate"
import { stickyModelKeyOf } from "@/agent/sticky-model"
import { type AssembleRequestPartial, buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import { OpenAIResponsesAdapter } from "@/llm/adapters/openai-responses"
import { __resetRuntimeConfig } from "@/shared"

const scratchDirs: string[] = []
const disposers: Array<() => void> = []
const savedEnv: Record<string, string | undefined> = {}

const setEnv = (key: string, value: string | undefined): void => {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch {
      // teardown is best-effort; a leaky wire must not mask an assertion
    }
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete savedEnv[k]
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  __resetRuntimeConfig()
})

/** Point the process at a fresh `~/.quanta` and pin the provider, then re-freeze
 *  the runtime config so `defaultStickyModelPath()` resolves INSIDE it. Returns
 *  the dir so a case can seed the file. */
const hermeticHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "headless-candidates-"))
  scratchDirs.push(dir)
  setEnv("QUANTA_CONFIG_DIR", dir)
  setEnv("QUANTA_PROVIDER", "openai")
  setEnv("OPENAI_API_KEY", "sk-test-not-used-no-network")
  // A pick is only meaningful once a credential can build its port; nothing in
  // this suite streams, so the key is never used on a wire.
  __resetRuntimeConfig()
  return dir
}

/** Write the sticky file exactly as the store would: `{ "<provider>:<mode>" → id }`. */
const writePick = (dir: string, key: string, modelId: string): void => {
  writeFileSync(join(dir, "sticky-model.json"), JSON.stringify({ [key]: modelId }), "utf8")
}

/** THE key the interactive CLI writes for an openai session in default posture —
 *  composed through the SSOT helper, not spelled by hand, so a key-shape change
 *  moves both surfaces together. */
const OPENAI_DEFAULT_KEY = stickyModelKeyOf({ mode: "default", provider: "openai" })

/** Build a REAL headless base through the REAL composition root. */
const buildBase = (over: Partial<AssembleRequestPartial> = {}): AgentConfig => {
  const p = { mode: "headless", dials: {}, ...over } as unknown as AssembleRequestPartial
  return buildBaseFromArgs(p, new AbortController().signal, disposers) as unknown as AgentConfig
}

describe("headless composition root — the model switch's second half", () => {
  test("PRODUCER: a persisted pick reaches the base as BOTH a store and a candidate PORT", async () => {
    const dir = hermeticHome()
    writePick(dir, OPENAI_DEFAULT_KEY, "gpt-4o")

    const base = buildBase({ stickyModel: true })

    // Half 1 — the store the loop reads every turn.
    expect(base.stickyModelStore).toBeDefined()
    // Half 2 — the id→port list the swap resolves against.
    expect(base.modelCandidates?.map((c) => c.id)).toEqual(["gpt-4o"])

    // THE PROOF: the loop's own pair, over the real base.
    const picked = await readStickyModelForMode(base)
    expect(picked).toBe("gpt-4o")
    const resolved = resolveSkillTurnOverride(base, undefined, picked)
    expect(resolved.llm).not.toBe(base.llm)
    expect(resolved.llm.model).toBe("gpt-4o")
    expect(base.llm.model).not.toBe("gpt-4o")
  })

  test("INVARIANT B: the swapped port is DECORATED, not the bare adapter", () => {
    const dir = hermeticHome()
    writePick(dir, OPENAI_DEFAULT_KEY, "gpt-4o")

    const base = buildBase({ stickyModel: true })
    const port = base.modelCandidates?.[0]?.port

    // A candidate must be the WRAPPED port (bounded retry + empty-stream breaker
    // + progress heartbeat), so it must NOT be an adapter instance itself.
    expect(port instanceof OpenAIResponsesAdapter).toBe(false)
    expect(port?.model).toBe("gpt-4o")
    // MR-E5 — this line used to read `expect(base.llm instanceof
    // OpenAIResponsesAdapter).toBe(true)`, pinning the ASYMMETRY that was the
    // defect: on this same root a SWAPPED model was decorated while the BOOT
    // model ran bare, so a transient 429 was a hard turn failure on `quanta -p`.
    // The boot port is decorated now too; both halves carry the same net.
    expect(base.llm instanceof OpenAIResponsesAdapter).toBe(false)
    // NON-VACUITY: `OpenAIResponsesAdapter` is still the class a BARE port on
    // this provider would be, so the two `false`s above are real negatives and
    // not an import that stopped matching anything.
    expect(
      new OpenAIResponsesAdapter({ apiKey: "sk-test-invariant-b", model: "gpt-4o" }) instanceof
        OpenAIResponsesAdapter,
    ).toBe(true)
  })

  test("CONTROL: no pick on disk ⇒ the slot is ABSENT (byte-identical default)", async () => {
    hermeticHome()

    const base = buildBase({ stickyModel: true })

    expect("modelCandidates" in base).toBe(false)
    expect(await readStickyModelForMode(base)).toBeUndefined()
    expect(resolveSkillTurnOverride(base, undefined, undefined).llm).toBe(base.llm)
  })

  test("CONTROL: without --sticky-model the in-memory store sees no cross-session pick", async () => {
    const dir = hermeticHome()
    writePick(dir, OPENAI_DEFAULT_KEY, "gpt-4o")

    const base = buildBase() // no stickyModel ⇒ in-memory store

    expect(base.stickyModelStore).toBeDefined()
    expect("modelCandidates" in base).toBe(false)
    // Neither half fires — the run legitimately executes the boot model.
    expect(await readStickyModelForMode(base)).toBeUndefined()
  })

  test("CONTROL: another PROVIDER's pick is not offered (the key carries the provider)", async () => {
    const dir = hermeticHome()
    writePick(
      dir,
      stickyModelKeyOf({ mode: "default", provider: "anthropic" }),
      "claude-sonnet-4-6",
    )

    const base = buildBase({ stickyModel: true })

    expect("modelCandidates" in base).toBe(false)
    expect(await readStickyModelForMode(base)).toBeUndefined()
  })

  test("INVARIANT A: a pick that IS the boot model mints no second port", async () => {
    const dir = hermeticHome()
    const bootModel = buildBase().llm.model
    expect(typeof bootModel).toBe("string")
    writePick(dir, OPENAI_DEFAULT_KEY, String(bootModel))

    const base = buildBase({ stickyModel: true })

    // No candidate: the swap MISSES and falls through to `config.llm`, which is
    // the real, fully-composed session port for exactly this model.
    expect("modelCandidates" in base).toBe(false)
    const picked = await readStickyModelForMode(base)
    expect(picked).toBe(String(bootModel))
    expect(resolveSkillTurnOverride(base, undefined, picked).llm).toBe(base.llm)
  })

  test("a SKILL-declared model resolves too (the same candidate list serves both)", async () => {
    const dir = hermeticHome()
    writePick(dir, OPENAI_DEFAULT_KEY, "gpt-4o")

    const base = buildBase({ stickyModel: true })
    // `override.model` takes precedence over the sticky id and resolves through
    // the SAME `modelCandidates` list.
    const resolved = resolveSkillTurnOverride(base, { model: "gpt-4o" }, undefined)
    expect(resolved.llm).not.toBe(base.llm)
    expect(resolved.llm.model).toBe("gpt-4o")
  })
})
