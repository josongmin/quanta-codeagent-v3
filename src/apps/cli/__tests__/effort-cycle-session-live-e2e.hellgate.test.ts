/**
 * RFC-08 BUILD-1 front-door integration hellgate — the effort-cycle chord goes
 * chord → keymap handler → SAME `EffortStore` → next LLM request.
 *
 * This is NOT a unit of the pure leaf (that lives in
 * `effort-cycle.hellgate.test.ts`). It exercises the REAL host composition:
 *   1. `readCliFeatureConfig(env)` + `buildPromptUx(...)` compose `onCycleEffort`
 *      from the live slash `effort` wire + `/model` adapter (no test-only hook).
 *   2. A real `~/.quanta/keybindings.json` binds a chord to `effort-cycle`
 *      through the SAME `loadKeybindings` parser/validator production uses.
 *   3. A real `readLine` keypress dispatches the configured chord.
 *   4. The SAME `EffortStore` the callback mutated is the one the loop reads via
 *      `AgentConfig.sessionEffort = () => effortStore.get()` (mirrored here; the
 *      real wire is `src/host/runtime/internal/context-binding/base.ts`).
 *
 * Lives in `src/apps/cli/__tests__/` (the keybinding/model-command hellgate
 * family) because it imports CLI internals, which the slice-isolation fence
 * (ADR-0024) forbids from `tests/**`.
 *
 * Proven front-door effects:
 *   - `/effort high` → chord → `max` → the next-request thunk observes `max`;
 *     another chord → `default` (five-tier wrap).
 *   - a non-reasoning model (`gpt-4o`) is a `default` fixpoint under repeated
 *     presses (clamp, not a spurious tier).
 *   - a `/model` switch through the live adapter shadow is reflected: the chord
 *     uses `model.current()`, NOT the boot model.
 *   - the input buffer + submit are untouched by the chord.
 *   - `QUANTA_KEYBINDINGS` absent ⇒ `onCycleEffort` is never composed (callback
 *     count 0, byte-identical gate-OFF).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEffortStore, type EffortLevel } from "@/agent"
import { fakeModelRouting } from "../../../../tests/_support/fake-model-routing"
import { loadKeybindings } from "../keybindings/load"
import type { KeybindingMap } from "../keybindings/types"
import { type ReadLineTestIO, readLine } from "../raw-line-reader"
import { readCliFeatureConfig } from "../repl/cli-feature-config"
import { buildModelAdapter } from "../repl/ctx-adapters/model-adapter"
import { buildEffortCycleWire } from "../repl/session-loop-options"
import { buildPromptUx } from "../repl/surface-compose"
import type { EffortCycleWire } from "../repl/surface-compose/prompt-ux"

// ── fake raw-line-reader IO ─────────────────────────────────────────────────
interface KeyEvent {
  readonly name?: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly sequence?: string
}
class FakeStdin extends EventEmitter {
  readonly isTTY = false
  resume(): void {}
  pause(): void {}
  key(str: string | undefined, key: KeyEvent = {}): void {
    this.emit("keypress", str, key)
  }
}
class FakeStdout {
  chunks: string[] = []
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
}
const makeIO = (): { io: ReadLineTestIO; stdin: FakeStdin } => {
  const stdin = new FakeStdin()
  return {
    io: {
      stdin: stdin as unknown as ReadLineTestIO["stdin"],
      stdout: new FakeStdout(),
      skipKeypressSetup: true,
    },
    stdin,
  }
}

// ── temp config dir holding the real keybindings.json ───────────────────────
let cfgDir: string
const ALT_E: KeyEvent = { name: "e", meta: true, sequence: "\x1be" } // projects to `alt+e`

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "rfc08-effort-cycle-"))
})
afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true })
})

/** Load a REAL keybindings map binding `alt+e → effort-cycle` through the SAME
 *  production `loadKeybindings` parser+validator the host uses (exercising the
 *  closed-enum acceptance of `effort-cycle` + the `alt+e` normalizer). The
 *  loader's default PATH const is frozen at module import, so we pass the temp
 *  file explicitly — the parsing/validation/merge is the real production code. */
const loadChordMap = async (): Promise<KeybindingMap> => {
  const path = join(cfgDir, "keybindings.json")
  writeFileSync(path, JSON.stringify({ version: 1, bindings: { "alt+e": "effort-cycle" } }))
  const { map, warnings } = await loadKeybindings(path)
  expect(warnings).toEqual([]) // `effort-cycle` is accepted (not an "unknown action")
  return map
}

/** Build the live effort-cycle owner wire from a REAL EffortStore + REAL
 *  `/model` adapter — the SAME symbols the surface composes. Returns the wire
 *  AND the store (so the test can read the exact cell the loop's
 *  `sessionEffort` thunk would read). */
const liveWire = (
  bootModel: string,
  candidateIds: readonly string[],
): {
  wire: EffortCycleWire
  store: ReturnType<typeof createEffortStore>
  adapter: ReturnType<typeof buildModelAdapter>
} => {
  const store = createEffortStore()
  const adapter = buildModelAdapter({
    routing: fakeModelRouting({ bootModelId: bootModel, ids: candidateIds }).routing,
    bootModel,
    currentMode: () => "default",
    candidateIds: () => candidateIds,
  })
  const wire: EffortCycleWire = {
    currentModel: () => adapter.current(),
    effortSupport: (id) => adapter.effortSupport(id),
    // Mirror the slash `effort` wire: get/set over the SAME store the loop reads.
    effort: { get: () => store.get(), set: (level: EffortLevel) => store.set(level) },
  }
  return { wire, store, adapter }
}

/** Compose the REAL prompt-UX (onCycleEffort included iff KEYBINDINGS on + wire
 *  present), returning the reader ux opts. This is the production composition
 *  root for the effort-cycle callback. */
const composeUx = async (env: NodeJS.ProcessEnv, wire: EffortCycleWire | undefined) => {
  const featureCfg = readCliFeatureConfig(env, false, false)
  return buildPromptUx(featureCfg, cfgDir, env, undefined, undefined, wire)
}

/** Drive one or more configured `alt+e` presses through a real `readLine`,
 *  wiring the production-composed `onCycleEffort` + a REAL loaded keybinding
 *  map, typing `seed` first. Returns the submitted line. When `map`/`hook` are
 *  absent the reader runs the gate-OFF path. */
const pressChord = async (args: {
  readonly map?: KeybindingMap | undefined
  readonly hook?: (() => void) | undefined
  readonly presses: number
  readonly seed?: string | undefined
}): Promise<string> => {
  const { io, stdin } = makeIO()
  const p = readLine(
    {
      prompt: "› ",
      ...(args.map !== undefined ? { keybindings: args.map } : {}),
      ...(args.hook !== undefined ? { onCycleEffort: args.hook } : {}),
    },
    io,
  )
  for (const ch of args.seed ?? "") stdin.key(ch, { name: ch, sequence: ch })
  for (let i = 0; i < args.presses; i++) stdin.key(undefined, ALT_E)
  stdin.key(undefined, { name: "return" })
  return p
}

describe("effort-cycle — live session front door", () => {
  test("F1 — /effort high → chord → max → next-request thunk reads max; another → default (wrap)", async () => {
    const env: NodeJS.ProcessEnv = { QUANTA_KEYBINDINGS: "1", QUANTA_CONFIG_DIR: cfgDir }
    const map = await loadChordMap()
    const { wire, store } = liveWire("gpt-5", ["gpt-5"]) // five-tier reasoning model
    const ux = await composeUx(env, wire)
    expect(ux.onCycleEffort).toBeDefined() // composed through the real host path
    const hook = ux.onCycleEffort

    // The loop reads effort via `AgentConfig.sessionEffort = () => store.get()`.
    const nextRequestEffort = (): EffortLevel => store.get()

    // Operator sets high via the SAME store the slash /effort wire owns.
    store.set("high")
    await pressChord({ map, hook, presses: 1 })
    expect(store.get()).toBe("max") // high → max
    expect(nextRequestEffort()).toBe("max") // the next LLM request observes it

    await pressChord({ map, hook, presses: 1 })
    expect(nextRequestEffort()).toBe("default") // max → default (five-tier wrap)
  })

  test("F2 — non-reasoning model (gpt-4o) is a default fixpoint under repeated presses", async () => {
    const env: NodeJS.ProcessEnv = { QUANTA_KEYBINDINGS: "1", QUANTA_CONFIG_DIR: cfgDir }
    const map = await loadChordMap()
    const { wire, store } = liveWire("gpt-4o", ["gpt-4o"]) // non-reasoning
    const ux = await composeUx(env, wire)
    const hook = ux.onCycleEffort
    // Even starting from an incoherent high, the FIRST press clamps to default,
    // and every subsequent press stays default (never emits an unsupported tier).
    store.set("high")
    await pressChord({ map, hook, presses: 1 })
    expect(store.get()).toBe("default")
    await pressChord({ map, hook, presses: 3 })
    expect(store.get()).toBe("default")
  })

  test("F3 — a /model switch is reflected: the chord uses the LIVE adapter current(), not boot", async () => {
    const env: NodeJS.ProcessEnv = { QUANTA_KEYBINDINGS: "1", QUANTA_CONFIG_DIR: cfgDir }
    const map = await loadChordMap()
    // Boot on a non-reasoning model; a real /model set switches the adapter
    // shadow to a five-tier reasoning model.
    const { wire, store, adapter } = liveWire("gpt-4o", ["gpt-4o", "gpt-5"])
    const ux = await composeUx(env, wire)
    const hook = ux.onCycleEffort

    // Before the switch: gpt-4o is a default fixpoint.
    store.set("high")
    await pressChord({ map, hook, presses: 1 })
    expect(store.get()).toBe("default")

    // Switch model through the live adapter (the /model set path updates the
    // per-mode sync shadow current() reads).
    const outcome = await adapter.set("gpt-5")
    expect(outcome).toBe("ok")
    expect(adapter.current()).toBe("gpt-5") // shadow moved

    // Now the chord cycles the FIVE tiers of the switched model (proving the
    // callback read current()=gpt-5, not boot gpt-4o).
    await pressChord({ map, hook, presses: 1 })
    expect(store.get()).toBe("low") // default → low (five-tier)
    await pressChord({ map, hook, presses: 4 })
    expect(store.get()).toBe("default") // low→medium→high→max→default (wrap)
  })

  test("F4 — the chord never submits or alters the draft buffer", async () => {
    const env: NodeJS.ProcessEnv = { QUANTA_KEYBINDINGS: "1", QUANTA_CONFIG_DIR: cfgDir }
    const map = await loadChordMap()
    const { wire, store } = liveWire("gpt-5", ["gpt-5"])
    const ux = await composeUx(env, wire)
    const hook = ux.onCycleEffort
    store.set("low")
    // Type "hello", press the chord twice mid-line, submit.
    const submitted = await pressChord({ map, hook, presses: 2, seed: "hello" })
    expect(submitted).toBe("hello") // buffer preserved, chord did not submit early
    // low → medium → high after two presses (state DID change — not a no-op).
    expect(store.get()).toBe("high")
  })

  // ── Production wire projection (the REAL buildEffortCycleWire) ────────────
  // The F1–F4 cases build their own wire; these pin the PRODUCTION projection
  // that session-loop-options uses (live model source + SSOT effortSupport +
  // effort slot), so a regression that reads boot/stale model or a second table
  // goes red here.
  test("W1 — absent effort slot ⇒ wire undefined (a surface without /effort cannot cycle)", () => {
    expect(buildEffortCycleWire({ source: () => "gpt-5" }, undefined)).toBeUndefined()
  })

  test("W2 — wire reads the LIVE model source (not a boot-frozen snapshot)", () => {
    let liveModel = "gpt-4o" // starts non-reasoning
    const store = createEffortStore()
    const slot = {
      get: () => store.get(),
      set: (l: EffortLevel) => store.set(l),
      levels: ["default", "low", "medium", "high", "max"] as readonly EffortLevel[],
      budgetTokens: () => undefined,
    }
    const wire = buildEffortCycleWire({ source: () => liveModel }, slot)
    expect(wire).toBeDefined()
    // Before a switch: gpt-4o is non-reasoning ⇒ support has only "default".
    expect(wire?.currentModel()).toBe("gpt-4o")
    expect(wire?.effortSupport(wire.currentModel())?.reasoning).toBe(false)
    // Switch the LIVE source (mirrors a /model set re-pointing current()).
    liveModel = "gpt-5"
    // The wire re-reads the source each call — proving it is NOT boot-frozen.
    expect(wire?.currentModel()).toBe("gpt-5")
    expect(wire?.effortSupport(wire.currentModel())?.reasoning).toBe(true)
    // And the effort slot round-trips through the SAME store (get/set delegate).
    wire?.effort.set("high")
    expect(store.get()).toBe("high")
    expect(wire?.effort.get()).toBe("high")
  })

  test("F5 — gate OFF (QUANTA_KEYBINDINGS absent) ⇒ onCycleEffort never composed (callback 0)", async () => {
    // NO QUANTA_KEYBINDINGS: the wire is present but the host must NOT compose
    // the callback (byte-identical gate-OFF).
    const env: NodeJS.ProcessEnv = { QUANTA_CONFIG_DIR: cfgDir }
    const { wire, store } = liveWire("gpt-5", ["gpt-5"])
    const ux = await composeUx(env, wire)
    expect(ux.onCycleEffort).toBeUndefined() // callback count is structurally 0
    expect(ux.keybindings).toBeUndefined() // no remap layer at all

    // Even with a chord map still present, a press through the HOOKLESS reader
    // leaves the store untouched (the consume side is the callback, and gate-OFF
    // never composes it). The bound chord is consumed but inert; no early submit.
    const map = await loadChordMap()
    store.set("medium")
    const submitted = await pressChord({ map, presses: 2, seed: "x" })
    expect(submitted).toBe("x")
    expect(store.get()).toBe("medium") // never cycled
  })
})
