/**
 * Knobs bootstrap helper — argv parsing + closed-port assembly contract.
 *
 * `parseCliKnobsFromArgv` is unit-tested directly. `bootstrapKnobs` is
 * exercised against a tmpdir config file (test seam: `configPath`) so the
 * test never touches the real `~/.quanta/knobs.json`.
 *
 * Registry caveat: the bootstrap module side-effect-imports all 12 knob
 * records, which call `registerKnob`. Bun's preload + module-cache mean these
 * side-effects run ONCE per process. Other test files may call
 * `__resetRegistry()` which empties the singleton — to keep this suite
 * independent we run a single `beforeAll` that imports `knobs-bootstrap`
 * fresh (already in cache) and then assert the registry has knobs. Tests
 * that need the registry empty are flagged explicitly.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allKnobs, asAnyKnob, knobsForSurface, registerKnob } from "@/runner/knobs"
import { advisorKnob } from "@/runner/knobs/knobs/advisor"
import { closeoutGuardKnob } from "@/runner/knobs/knobs/closeout-guard"
import { hooksKnob } from "@/runner/knobs/knobs/hooks"
import { personaKnob } from "@/runner/knobs/knobs/persona"
import { workingStateKnob } from "@/runner/knobs/knobs/working-state"
import { bootstrapKnobs, parseCliKnobsFromArgv } from "../../../src/apps/cli/knobs-bootstrap"

let dir = ""

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "knobs-boot-"))
  // Re-register EVERY CLI-surface knob this suite asserts on, in case a sibling
  // suite's `__resetRegistry()` wiped the singleton (cached re-imports do not
  // re-fire registerKnob). Guarded per-knob so we never trigger a collision
  // throw. Keeps the `knobsForSurface('cli')` membership assertion below
  // order-independent in the full single-process suite run. (Previously only
  // advisor was guarded → the other four flaked when a reset preceded this file.)
  for (const k of [closeoutGuardKnob, hooksKnob, personaKnob, workingStateKnob, advisorKnob]) {
    if (!allKnobs().has(k.id)) registerKnob(asAnyKnob(k))
  }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("parseCliKnobsFromArgv", () => {
  test("empty argv ⇒ {}", () => {
    expect(parseCliKnobsFromArgv([])).toEqual({})
  })

  test("single --knob id=val pair", () => {
    expect(parseCliKnobsFromArgv(["--knob", "persona=pragmatic"])).toEqual({
      persona: "pragmatic",
    })
  })

  test("multiple --knob pairs accumulate", () => {
    expect(
      parseCliKnobsFromArgv(["--knob", "persona=friendly", "--knob", "working-state=1"]),
    ).toEqual({ persona: "friendly", "working-state": "1" })
  })

  test("--knob without `=` is silently skipped (no spurious key)", () => {
    expect(parseCliKnobsFromArgv(["--knob", "missing-equals"])).toEqual({})
  })

  test("trailing --knob with no operand is skipped", () => {
    expect(parseCliKnobsFromArgv(["--knob"])).toEqual({})
  })

  test("interleaved non-knob args are ignored", () => {
    expect(
      parseCliKnobsFromArgv(["foo", "--bar", "--knob", "persona=pragmatic", "baz", "--other"]),
    ).toEqual({ persona: "pragmatic" })
  })

  test("value may contain `=` (only the first one splits)", () => {
    expect(parseCliKnobsFromArgv(["--knob", "k=a=b=c"])).toEqual({ k: "a=b=c" })
  })

  test("empty key (`=val`) is silently dropped", () => {
    expect(parseCliKnobsFromArgv(["--knob", "=oops"])).toEqual({})
  })

  test("later --knob beats earlier for same key", () => {
    expect(
      parseCliKnobsFromArgv(["--knob", "persona=friendly", "--knob", "persona=pragmatic"]),
    ).toEqual({ persona: "pragmatic" })
  })
})

describe("bootstrapKnobs — registry side-effect + closed-port resolve", () => {
  test("the knob files registered at least once (side-effect import)", () => {
    // The bootstrap module's static `import "@/runner/knobs/knobs/*"` lines
    // are what populate the registry. We don't assert a strict count because
    // other suites may have called `__resetRegistry`; we only assert that the
    // bootstrap import side-effect populated SOMETHING.
    expect(allKnobs().size).toBeGreaterThan(0)
  })

  test("knobsForSurface('cli') includes at least the CLI knobs (incl. ADR-0429 advisor)", () => {
    const cli = knobsForSurface("cli")
    // CLI surface set per the framework: closeout-guard, hooks, persona,
    // working-state + advisor (ADR-0429). (skills / must-pass / lsp exclude cli
    // on purpose.) We assert membership inclusively — additional cli knobs ok.
    for (const id of ["closeout-guard", "hooks", "persona", "working-state", "advisor"]) {
      expect(cli.has(id)).toBe(true)
    }
  })

  test("bootstrapKnobs returns resolve seam that re-reads sessionOverrides", async () => {
    const configPath = join(dir, "knobs-1.json")
    const result = await bootstrapKnobs({
      argv: [],
      env: {} as NodeJS.ProcessEnv,
      surface: "cli",
      configPath,
    })
    // Mutate the bag, then re-resolve — the new value should appear.
    result.sessionOverrides.persona = "pragmatic"
    const after = result.resolve()
    expect(after.get("persona")?.value).toBe("pragmatic")
    expect(after.get("persona")?.source).toBe("session")
  })

  test("bootstrapKnobs CLI args beat env vars (closed-port layering)", async () => {
    const configPath = join(dir, "knobs-2.json")
    const result = await bootstrapKnobs({
      argv: ["--knob", "persona=friendly"],
      env: { QUANTA_PERSONA: "pragmatic" } as NodeJS.ProcessEnv,
      surface: "cli",
      configPath,
    })
    expect(result.values.get("persona")?.value).toBe("friendly")
    expect(result.values.get("persona")?.source).toBe("cli")
  })

  test("bootstrapKnobs reads ~/.quanta/knobs.json via injected configPath", async () => {
    const configPath = join(dir, "knobs-3.json")
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        user_defaults: { persona: "friendly" },
        last_saved: new Date().toISOString(),
      }),
      "utf8",
    )
    const result = await bootstrapKnobs({
      argv: [],
      env: {} as NodeJS.ProcessEnv,
      surface: "cli",
      configPath,
    })
    expect(result.values.get("persona")?.value).toBe("friendly")
    expect(result.values.get("persona")?.source).toBe("config-file")
  })

  test("bootstrapKnobs save() writes sessionOverrides to configPath", async () => {
    const configPath = join(dir, "knobs-4.json")
    const result = await bootstrapKnobs({
      argv: [],
      env: {} as NodeJS.ProcessEnv,
      surface: "cli",
      configPath,
    })
    result.sessionOverrides.persona = "pragmatic"
    result.sessionOverrides["working-state"] = "1"
    await result.save()
    const raw = await readFile(configPath, "utf8")
    const obj = JSON.parse(raw) as { user_defaults: Record<string, string>; version: number }
    expect(obj.version).toBe(1)
    expect(obj.user_defaults).toEqual({ persona: "pragmatic", "working-state": "1" })
  })

  test("QUANTA_KNOBS_PRESET env applies as lowest layer above default", async () => {
    const configPath = join(dir, "knobs-5.json")
    const result = await bootstrapKnobs({
      argv: [],
      env: {
        QUANTA_KNOBS_PRESET: "hint-only",
      } as NodeJS.ProcessEnv,
      // hint-only is `{ "issue-hint": "1" }` and issue-hint is bench-only,
      // so on bench surface we should see it.
      surface: "bench",
      configPath,
    })
    expect(result.values.get("issue-hint")?.source).toBe("preset")
  })

  test("unknown preset name silently drops (no throw, no values)", async () => {
    const configPath = join(dir, "knobs-6.json")
    const result = await bootstrapKnobs({
      argv: [],
      env: { QUANTA_KNOBS_PRESET: "nonsense-xyz" } as NodeJS.ProcessEnv,
      surface: "cli",
      configPath,
    })
    // The resolver silently drops unknown presets — no throw, no values for
    // knobs that would only have come from the preset.
    expect(result.values.size).toBe(0)
  })
})
