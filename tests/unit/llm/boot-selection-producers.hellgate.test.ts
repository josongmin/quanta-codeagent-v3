import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveBenchBootSelection } from "@/apps/bench/run-main"
import { readSessionRuntimeConfig } from "@/apps/cli/repl/session-runtime-config"
import { resolveServeStdioBoot } from "@/apps/cli/serve-stdio-cmd"
import { buildProductionRuntimeFactory, resolveWebBootLLM } from "@/apps/web-daemon/runtime-factory"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import { DEFAULT_MODEL } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"

/**
 * MR-01 PRODUCER hellgate — proof that each of the FIVE composition roots that
 * used to answer "which provider + which model + is it pinned?" on its own now
 * routes through the ONE authority (`@/llm` `resolveBootSelection`).
 *
 * These drive the REAL production line for each root, never a re-spelling of
 * the precedence: `readSessionRuntimeConfig()` / `buildBaseFromArgs()` are the
 * roots themselves, and the three remaining roots resolve their boot on exactly
 * one exported line (`resolveWebBootLLM` / `resolveServeStdioBoot` /
 * `resolveBenchBootSelection`) which the surrounding root calls and nothing else
 * duplicates. Breaking any of those five lines reddens a case here (see the
 * RED-on-injection log in the campaign report).
 *
 * ── The behaviour delta each root is pinned against ──────────────────────────
 * THREE of the five silently IGNORED `QUANTA_MODEL` before this change
 * (headless `quanta -p`, `quanta web`, `quanta serve --stdio`) while the same
 * variable was authoritative in the REPL and in bench. Every "honours
 * QUANTA_MODEL" case below is therefore an INTENDED behaviour change, and each
 * carries a paired control (unset ⇒ the canonical provider default) so it can
 * never pass vacuously.
 *
 * ── Machine-independence ─────────────────────────────────────────────────────
 * MEASURED: `pickProvider(env)` prefers a ChatGPT-OAuth token on disk over
 * `OPENAI_API_KEY`, so an unpinned provider makes every assertion here depend on
 * whether the developer ran `/login`. Every case pins `QUANTA_PROVIDER=openai`
 * AND points the OAuth/prefs probe + config dir at a per-run scratch directory,
 * so the developer's real `~/.quanta` is never read or written.
 */

// ───────────────────────────── env harness ─────────────────────────────

/** Every key these roots read that could otherwise leak in from the shell. */
const DRIVEN = [
  "QUANTA_MODEL",
  "QUANTA_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "QUANTA_CONFIG_DIR",
  "QUANTA_PREFS_HOME",
  "CODEX_HOME",
  "QUANTA_MEMORY",
  "QUANTA_SUBAGENT",
  "QUANTA_INDEX",
  "QUANTA_PIPELINE",
  "QUANTA_GOAL",
] as const

const saved: Record<string, string | undefined> = {}
let scratch: string

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  scratch = mkdtempSync(join(tmpdir(), "mr01-producers-"))
  // NEVER the developer's real `~/.quanta`: the config dir, the prefs/OAuth home
  // and the Codex home all point at this run's scratch (which contains no token,
  // so the OAuth probe is cold and `QUANTA_PROVIDER` decides).
  process.env.QUANTA_CONFIG_DIR = join(scratch, "config")
  process.env.QUANTA_PREFS_HOME = join(scratch, "prefs")
  process.env.CODEX_HOME = join(scratch, "codex")
  process.env.QUANTA_PROVIDER = "openai"
  process.env.OPENAI_API_KEY = "sk-test-mr01-producers"
  process.env.QUANTA_MEMORY = "off"
  process.env.QUANTA_SUBAGENT = "0"
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(scratch, { recursive: true, force: true })
  __resetRuntimeConfig()
})

/** The env bag the two env-taking roots (web / serve) are driven with — the same
 *  hermetic shape the process-env roots get. */
const bag = (
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  QUANTA_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test-mr01-producers",
  QUANTA_PREFS_HOME: join(scratch, "prefs"),
  CODEX_HOME: join(scratch, "codex"),
  ...extra,
})

// ─────────────────── ROOT 1 — CLI `readSessionRuntimeConfig` ───────────────────

describe("MR-01 producer — apps/cli/repl/session-runtime-config", () => {
  test("QUANTA_MODEL is the boot model AND sets modelPinnedExplicitly", () => {
    process.env.QUANTA_MODEL = "mr01-cli-pin"
    const cfg = readSessionRuntimeConfig()
    expect(cfg.provider).toBe("openai")
    expect(cfg.model).toBe("mr01-cli-pin")
    expect(cfg.modelPinnedExplicitly).toBe(true)
  })

  test("PAIRED CONTROL: unset ⇒ canonical default, NOT pinned", () => {
    const cfg = readSessionRuntimeConfig()
    expect(cfg.model).toBe(DEFAULT_MODEL.openai)
    expect(cfg.modelPinnedExplicitly).toBe(false)
  })

  test("whitespace-only QUANTA_MODEL no longer boots a whitespace model id", () => {
    // The pre-MR-01 root read the model with `process.env[k] ?? fallback` and the
    // pin with a SEPARATE `.trim().length > 0`, so `QUANTA_MODEL="  "` booted a
    // port whose model id was literally `"  "` while `pinned` said false. One
    // resolution now answers both.
    process.env.QUANTA_MODEL = "   "
    const cfg = readSessionRuntimeConfig()
    expect(cfg.model).toBe(DEFAULT_MODEL.openai)
    expect(cfg.modelPinnedExplicitly).toBe(false)
  })
})

// ──────────────── ROOT 2 — headless `buildBaseFromArgs` (host layer) ────────────

describe("MR-01 producer — host/runtime/agent-arg-builder", () => {
  /** Keep the sticky-model read off the developer's home (a `/model` pick there
   *  would otherwise seed a `modelCandidates` slot) and skip the search wire's
   *  interval. Mirrors the byte-identical hellgate's seam. */
  const buildBase = () =>
    buildBaseFromArgs({ mode: "interactive", dials: {} }, undefined, undefined, {
      stickyModelPath: join(scratch, "nonexistent-sticky.json"),
    })

  test("INTENDED CHANGE: QUANTA_MODEL is now honoured on the headless root", () => {
    process.env.QUANTA_MODEL = "mr01-headless-pin"
    expect(buildBase().llm.model).toBe("mr01-headless-pin")
  })

  test("PAIRED CONTROL: unset ⇒ canonical DEFAULT_MODEL[provider]", () => {
    expect(buildBase().llm.model).toBe(DEFAULT_MODEL.openai)
  })

  test("an explicit --model still BEATS QUANTA_MODEL", () => {
    process.env.QUANTA_MODEL = "mr01-headless-env"
    const base = buildBaseFromArgs(
      { mode: "interactive", dials: {}, model: "mr01-headless-flag" },
      undefined,
      undefined,
      { stickyModelPath: join(scratch, "nonexistent-sticky.json") },
    )
    expect(base.llm.model).toBe("mr01-headless-flag")
  })

  test("an explicit --provider still beats the env/OAuth probe", () => {
    process.env.QUANTA_PROVIDER = "openai"
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-mr01"
    const base = buildBaseFromArgs(
      { mode: "interactive", dials: {}, provider: "anthropic" },
      undefined,
      undefined,
      { stickyModelPath: join(scratch, "nonexistent-sticky.json") },
    )
    expect(base.llm.provider).toBe("anthropic")
    expect(base.llm.model).toBe(DEFAULT_MODEL.anthropic)
  })
})

// ─────────────────── ROOT 3 — web daemon `resolveWebBootLLM` ───────────────────

describe("MR-01 producer — apps/web-daemon/runtime-factory", () => {
  test("INTENDED CHANGE: QUANTA_MODEL is now honoured by `quanta web`", () => {
    const boot = resolveWebBootLLM(bag({ QUANTA_MODEL: "mr01-web-pin" }))
    expect(boot.model).toBe("mr01-web-pin")
    // The PORT — not just the returned string — carries it: the old root passed
    // an EMPTY options bag to `tryCreateLLM`, so the adapter booted the default.
    expect(boot.llm.model).toBe("mr01-web-pin")
  })

  test("PAIRED CONTROL: unset ⇒ canonical default on the port", () => {
    const boot = resolveWebBootLLM(bag())
    expect(boot.model).toBe(DEFAULT_MODEL.openai)
    expect(boot.llm.model).toBe(DEFAULT_MODEL.openai)
  })

  test("WIRING: buildProductionRuntimeFactory boots through resolveWebBootLLM", () => {
    // Drive the REAL production factory. With the provider pinned to one whose
    // key is absent, the ONLY code path that can produce this message is
    // `resolveWebBootLLM` — so the factory demonstrably calls it rather than
    // resolving a boot of its own.
    delete process.env.OPENAI_API_KEY
    process.env.QUANTA_PROVIDER = "openai"
    expect(() => buildProductionRuntimeFactory()).toThrow(
      /web-daemon: LLM provider "openai" not configured/,
    )
  })
})

// ───────────────── ROOT 4 — `serve --stdio` `resolveServeStdioBoot` ─────────────

describe("MR-01 producer — apps/cli/serve-stdio-cmd", () => {
  test("INTENDED CHANGE: QUANTA_MODEL is now honoured by `serve --stdio`", () => {
    const boot = resolveServeStdioBoot(bag({ QUANTA_MODEL: "mr01-serve-pin" }), {
      model: undefined,
    })
    expect(boot.modelId).toBe("mr01-serve-pin")
    expect(boot.source).toBe("env")
    expect(boot.pinned).toBe(true)
  })

  test("PRESERVED: --model still wins over QUANTA_MODEL (no existing invocation moves)", () => {
    const boot = resolveServeStdioBoot(bag({ QUANTA_MODEL: "mr01-serve-env" }), {
      model: "mr01-serve-flag",
    })
    expect(boot.modelId).toBe("mr01-serve-flag")
    expect(boot.source).toBe("flag")
  })

  test("PAIRED CONTROL: neither ⇒ canonical DEFAULT_MODEL[provider]", () => {
    const boot = resolveServeStdioBoot(bag(), { model: undefined })
    expect(boot.modelId).toBe(DEFAULT_MODEL.openai)
    expect(boot.pinned).toBe(false)
  })
})

// ───────────────────── ROOT 5 — bench `resolveBenchBootSelection` ───────────────

describe("MR-01 producer — apps/bench/run-main", () => {
  const withArgv = <T>(argv: readonly string[], fn: () => T): T => {
    const prev = process.argv
    process.argv = ["bun", "bench", ...argv]
    try {
      return fn()
    } finally {
      process.argv = prev
    }
  }

  test("PRESERVED: --model > QUANTA_MODEL > default (the hand-rolled chain's order)", () => {
    process.env.QUANTA_MODEL = "mr01-bench-env"
    expect(withArgv(["--model", "mr01-bench-flag"], resolveBenchBootSelection).modelId).toBe(
      "mr01-bench-flag",
    )
    expect(withArgv([], resolveBenchBootSelection).modelId).toBe("mr01-bench-env")
    delete process.env.QUANTA_MODEL
    expect(withArgv([], resolveBenchBootSelection).modelId).toBe(DEFAULT_MODEL.openai)
  })

  test("TIGHTENED: an empty `--model ''` is UNSET, not a literal empty model id", () => {
    process.env.QUANTA_MODEL = "mr01-bench-env"
    const boot = withArgv(["--model", ""], resolveBenchBootSelection)
    expect(boot.modelId).toBe("mr01-bench-env")
    expect(boot.source).toBe("env")
  })
})
