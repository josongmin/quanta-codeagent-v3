import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSessionRuntimeConfig } from "@/apps/cli/repl/session-runtime-config"
import { resolveServeStdioBoot } from "@/apps/cli/serve-stdio-cmd"
import { DEFAULT_MODEL } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"

/**
 * MR-01 PRODUCER hellgate — the two `apps/cli`-slice composition roots.
 *
 * Sibling of `tests/unit/llm/boot-selection-producers.hellgate.test.ts`, which
 * covers the other three roots (headless / web / bench). The split is forced by
 * biome's ADR-0024 slice isolation: only tests under `tests/unit/apps/cli/**`
 * may import `@/apps/cli/**` internals.
 *
 * Both roots must now answer "which provider + which model + is it pinned?"
 * through the ONE authority (`@/llm` `resolveBootSelection`):
 *   - `readSessionRuntimeConfig()` (interactive / one-shot REPL) used to read
 *     `QUANTA_MODEL` TWICE with different spellings — once as the boot model
 *     (`process.env[k] ?? fallback`, so `""` booted an empty model id) and once
 *     as the pin (`.trim().length > 0`). One resolution now answers both.
 *   - `serve --stdio` treated `--model` as an ABSOLUTE pin and IGNORED
 *     `QUANTA_MODEL` entirely; it is now the documented middle rung. That is an
 *     INTENDED behaviour change; `--model` still wins, so no existing
 *     invocation moves.
 *
 * MACHINE-INDEPENDENCE: `pickProvider` prefers an on-disk ChatGPT-OAuth token
 * over `OPENAI_API_KEY` (measured), so every case pins `QUANTA_PROVIDER=openai`
 * and points the OAuth/prefs probe + config dir at a per-run scratch directory.
 * The developer's real `~/.quanta` is never read or written.
 */

/** Every key these roots read that could otherwise leak in from the shell. */
const DRIVEN = [
  "QUANTA_MODEL",
  "QUANTA_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "QUANTA_CONFIG_DIR",
  "QUANTA_PREFS_HOME",
  "CODEX_HOME",
] as const

const saved: Record<string, string | undefined> = {}
let scratch: string

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  scratch = mkdtempSync(join(tmpdir(), "mr01-cli-producers-"))
  process.env.QUANTA_CONFIG_DIR = join(scratch, "config")
  process.env.QUANTA_PREFS_HOME = join(scratch, "prefs")
  process.env.CODEX_HOME = join(scratch, "codex")
  process.env.QUANTA_PROVIDER = "openai"
  process.env.OPENAI_API_KEY = "sk-test-mr01-cli-producers"
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

/** The hermetic env bag `resolveServeStdioBoot` is driven with. */
const bag = (
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  QUANTA_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test-mr01-cli-producers",
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
