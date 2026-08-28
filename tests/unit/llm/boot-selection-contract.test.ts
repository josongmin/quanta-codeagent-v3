import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BootSelection,
  type BootSelectionInput,
  DEFAULT_MODEL,
  resolveBootSelection,
} from "@/llm"

/**
 * MR-01 CONTRACT hellgate for `resolveBootSelection` — the ONE authority five
 * composition roots now share for "which provider + which model does this
 * session boot on, and did the operator pin it?".
 *
 * ── Machine-independence (this is load-bearing, not boilerplate) ─────────────
 * MEASURED: `pickProvider(env)` prefers a ChatGPT-OAuth token ON DISK over
 * `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, so on a developer box that has run
 * `/login` a test that leaves the provider to the probe silently asserts
 * `chatgpt-oauth` and would flip on CI. Every case here therefore either pins
 * the provider (`QUANTA_PROVIDER` / `providerArg`) or points the probe at a
 * HERMETIC scratch home whose logged-in / logged-out state THIS FILE created.
 * Nothing reads the developer's real `~/.quanta` or `~/.codex`
 * (`QUANTA_PREFS_HOME` + `CODEX_HOME` are set in every env bag below).
 */

// ─────────────────────────── hermetic probe homes ───────────────────────────

let scratch: string
/** A home the OAuth probe sees as LOGGED IN (`auth/chatgpt.json` exists). */
let loggedInHome: string
/** A home the OAuth probe sees as LOGGED OUT (exists, empty). */
let loggedOutHome: string
/** A `CODEX_HOME` with no `auth.json` — keeps the SECOND probe candidate cold. */
let coldCodexHome: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "mr01-boot-selection-"))
  loggedInHome = join(scratch, "logged-in")
  loggedOutHome = join(scratch, "logged-out")
  coldCodexHome = join(scratch, "codex-cold")
  mkdirSync(join(loggedInHome, "auth"), { recursive: true })
  writeFileSync(join(loggedInHome, "auth", "chatgpt.json"), "{}")
  mkdirSync(loggedOutHome, { recursive: true })
  mkdirSync(coldCodexHome, { recursive: true })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Base env bag: the probe is pointed at the LOGGED-OUT scratch home and both
 *  vendor keys are absent, so `pickProvider` lands on its `anthropic` floor
 *  unless a case says otherwise. */
const bag = (
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  QUANTA_PREFS_HOME: loggedOutHome,
  CODEX_HOME: coldCodexHome,
  ...extra,
})

// ───────────────────────────── the contract table ────────────────────────────

interface Case {
  readonly name: string
  readonly input: () => BootSelectionInput
  readonly expect: (sel: BootSelection) => void
}

const CASES: readonly Case[] = [
  {
    name: "flag + env both set ⇒ the FLAG wins, pinned, source=flag",
    input: () => ({
      env: bag({ QUANTA_PROVIDER: "openai", QUANTA_MODEL: "from-env" }),
      modelArg: "from-flag",
    }),
    expect: (s) => {
      expect(s.modelId).toBe("from-flag")
      expect(s.source).toBe("flag")
      expect(s.pinned).toBe(true)
      expect(s.provider).toBe("openai")
    },
  },
  {
    name: "env only ⇒ QUANTA_MODEL wins, pinned, source=env",
    input: () => ({ env: bag({ QUANTA_PROVIDER: "openai", QUANTA_MODEL: "from-env" }) }),
    expect: (s) => {
      expect(s.modelId).toBe("from-env")
      expect(s.source).toBe("env")
      expect(s.pinned).toBe(true)
    },
  },
  {
    name: "neither ⇒ canonical DEFAULT_MODEL[provider], NOT pinned, source=default",
    input: () => ({ env: bag({ QUANTA_PROVIDER: "openai" }) }),
    expect: (s) => {
      // Sourced from the table, never a hand-copied slug — a bumped default
      // must not need an edit here.
      expect(s.modelId).toBe(DEFAULT_MODEL.openai)
      expect(s.source).toBe("default")
      expect(s.pinned).toBe(false)
    },
  },
  {
    name: "default is per-PROVIDER (anthropic pin ⇒ anthropic's default slug)",
    input: () => ({ env: bag({ QUANTA_PROVIDER: "anthropic" }) }),
    expect: (s) => {
      expect(s.provider).toBe("anthropic")
      expect(s.modelId).toBe(DEFAULT_MODEL.anthropic)
      expect(DEFAULT_MODEL.anthropic).not.toBe(DEFAULT_MODEL.openai)
    },
  },
  {
    name: "explicit providerArg BEATS the OAuth/home probe (logged-in home)",
    input: () => ({ env: bag({ QUANTA_PREFS_HOME: loggedInHome }), providerArg: "anthropic" }),
    expect: (s) => {
      expect(s.provider).toBe("anthropic")
      expect(s.modelId).toBe(DEFAULT_MODEL.anthropic)
    },
  },
  {
    name: "providerArg also beats an ANTHROPIC_API_KEY already in the env",
    input: () => ({
      env: bag({ ANTHROPIC_API_KEY: "sk-ant-probe" }),
      providerArg: "openai",
    }),
    expect: (s) => expect(s.provider).toBe("openai"),
  },
  {
    name: "UNKNOWN providerArg falls through to the probe (registry-validated)",
    input: () => ({
      env: bag({ QUANTA_PREFS_HOME: loggedInHome }),
      providerArg: "not-a-registered-provider",
    }),
    expect: (s) => expect(s.provider).toBe("chatgpt-oauth"),
  },
  {
    name: 'empty-string QUANTA_MODEL is UNSET ⇒ default, not a "" model id',
    input: () => ({ env: bag({ QUANTA_PROVIDER: "openai", QUANTA_MODEL: "" }) }),
    expect: (s) => {
      expect(s.modelId).toBe(DEFAULT_MODEL.openai)
      expect(s.source).toBe("default")
      expect(s.pinned).toBe(false)
    },
  },
  {
    name: "whitespace-only QUANTA_MODEL is UNSET ⇒ default, not pinned",
    input: () => ({ env: bag({ QUANTA_PROVIDER: "openai", QUANTA_MODEL: "   " }) }),
    expect: (s) => {
      expect(s.modelId).toBe(DEFAULT_MODEL.openai)
      expect(s.source).toBe("default")
      expect(s.pinned).toBe(false)
    },
  },
  {
    name: "empty-string modelArg is UNSET ⇒ QUANTA_MODEL takes over (source=env)",
    input: () => ({
      env: bag({ QUANTA_PROVIDER: "openai", QUANTA_MODEL: "from-env" }),
      modelArg: "  ",
    }),
    expect: (s) => {
      expect(s.modelId).toBe("from-env")
      expect(s.source).toBe("env")
      expect(s.pinned).toBe(true)
    },
  },
  {
    name: "surrounding whitespace is TRIMMED off a real model id",
    input: () => ({ env: bag({ QUANTA_PROVIDER: "openai", QUANTA_MODEL: "  gpt-x  " }) }),
    expect: (s) => expect(s.modelId).toBe("gpt-x"),
  },
  {
    name: "whitespace-only providerArg is UNSET ⇒ env QUANTA_PROVIDER still wins",
    input: () => ({ env: bag({ QUANTA_PROVIDER: "openai" }), providerArg: "   " }),
    expect: (s) => expect(s.provider).toBe("openai"),
  },
]

describe("MR-01 resolveBootSelection — contract", () => {
  for (const c of CASES) {
    test(c.name, () => {
      c.expect(resolveBootSelection(c.input()))
    })
  }

  test("PAIRED CONTROL: without providerArg the SAME logged-in home probes chatgpt-oauth", () => {
    // Proves the "explicit providerArg beats the probe" case above is not
    // vacuous: the identical env, minus the flag, resolves differently.
    const probed = resolveBootSelection({ env: bag({ QUANTA_PREFS_HOME: loggedInHome }) })
    expect(probed.provider).toBe("chatgpt-oauth")
    const flagged = resolveBootSelection({
      env: bag({ QUANTA_PREFS_HOME: loggedInHome }),
      providerArg: "anthropic",
    })
    expect(flagged.provider).toBe("anthropic")
  })

  test("PAIRED CONTROL: the logged-OUT scratch home does NOT probe chatgpt-oauth", () => {
    // Proves the hermetic home is really hermetic — if this machine's real
    // `~/.quanta` were leaking in, this would be `chatgpt-oauth`.
    expect(resolveBootSelection({ env: bag() }).provider).toBe("anthropic")
  })

  test("the resolved model id is never empty or whitespace, for every case", () => {
    for (const c of CASES) {
      const sel = resolveBootSelection(c.input())
      expect(sel.modelId.trim().length).toBeGreaterThan(0)
      expect(sel.modelId).toBe(sel.modelId.trim())
    }
  })

  test("pinned is TRUE exactly when source is flag|env (closed mapping)", () => {
    for (const c of CASES) {
      const sel = resolveBootSelection(c.input())
      expect(sel.pinned).toBe(sel.source !== "default")
    }
  })
})
