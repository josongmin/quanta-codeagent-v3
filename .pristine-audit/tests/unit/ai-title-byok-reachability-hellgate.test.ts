/**
 * ★ REACHABILITY (e2e) — jun-6: the two host-deferred LLM-composition seams are
 * now CONFIG-REACHABLE through the CLI composition root (`apps/cli/internal`).
 *
 * The leaf + loop-fire of BOTH features were already sealed:
 *   - ai-session-title: `createAutoTitlePort` + the loop turn-1 fire
 *     (`AgentConfig.autoTitlePort` in `runSessionStartSequence`).
 *   - BYOK: `resolveVendorApiKey` + `buildLLMWithByokCore`.
 * The ONLY gap was that nobody at the composition root BUILT the auto-title port
 * / awaited the BYOK mint. This battery drives the REAL composition-root entries
 * (`buildAutoTitlePort`, `buildLLMWithByok`) and proves:
 *
 *   AUTO-TITLE — knob-on + cheap-model ⇒ the root BUILDS the port AND a fired
 *     `maybeTitle` titles the session via the real `renameSession` adapter (over
 *     a fake cheap LLM at the leaf, writing to a temp session store). knob-off ⇒
 *     NO port built (the loop branch is dead — byte-identical). model-missing ⇒
 *     still NO port (the cost gate: never the expensive main model).
 *
 *   BYOK — knob-on + helper ⇒ the minted key reaches `createLLM` as
 *     `opts.apiKey` (it OVERRIDES the env key). helper-empty (configured but the
 *     mint stdout is "") ⇒ the H7 guard THROWS rather than clobbering the env key
 *     with "". knob-off ⇒ NO mint (the env key is built byte-identically).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, ShellExecResult, StreamEvent, StreamInput } from "@/llm"
import { AnthropicAdapter } from "@/llm"
import { loadSessionById, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { buildAutoTitlePort, buildLLMWithByok } from "../../src/apps/cli/internal"

// ────────────────────────────── env scaffolding ───────────────────────────────

const ENV_KEYS = [
  "QUANTA_SESSION_AUTO_TITLE",
  "QUANTA_SESSION_TITLE_MODEL",
  "QUANTA_API_KEY_HELPER",
  "QUANTA_API_KEY_HELPER_TTL_MS",
  "QUANTA_API_KEY_HELPER_LEGACY_VENDOR",
  "QUANTA_LLM_CREDENTIAL_TRUSTED",
  "QUANTA_LLM_TRANSPORT",
  "QUANTA_SESSIONS_DIR",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const

const saved = new Map<string, string | undefined>()
const tmpDirs: string[] = []

/** Mint an isolated, self-cleaning session store under the OS temp dir (never
 *  the repo cwd) and point `QUANTA_SESSIONS_DIR` at it. */
const tmpSessionsDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-title-reach-"))
  tmpDirs.push(dir)
  process.env.QUANTA_SESSIONS_DIR = dir
  return dir
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k])
    delete process.env[k]
  }
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetRuntimeConfig()
})

const pin = (): void => {
  __resetRuntimeConfig()
}

// ────────────────────────────── fakes ─────────────────────────────────────────

/** A cheap title LLM that yields a fixed title once. */
class TitleLLM implements LLMPort {
  calls = 0
  constructor(private readonly title: string) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "text_delta", delta: this.title }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const ok = (stdout: string): ShellExecResult => ({ stdout, stderr: "", exitCode: 0 })

/** Reach the Anthropic SDK client's public `apiKey` field to prove the minted
 *  key (or env key) is what the adapter was built with. */
const adapterApiKey = (adapter: unknown): string | undefined =>
  (adapter as { client?: { apiKey?: string } }).client?.apiKey

/** Poll the on-disk title until it changes from `seed` (the fire-and-forget
 *  titler runs on a detached promise; the fake LLM yields synchronously so this
 *  resolves within a few microtasks). */
const waitForTitle = async (id: string, seed: string, budgetMs = 1000): Promise<string> => {
  const start = Date.now()
  for (;;) {
    const cur = (await loadSessionById(id))?.meta.title
    if (cur !== undefined && cur !== seed) return cur
    if (Date.now() - start > budgetMs) return cur ?? "<gone>"
    await new Promise((r) => setTimeout(r, 5))
  }
}

const seedSession = async (id: string, title: string): Promise<void> => {
  await saveSessionById(
    {
      id,
      title,
      cwd: process.cwd(),
      createdAt: 0,
      lastTouched: 0,
      archived: false,
    },
    { reason: "test", turns: 0, messages: [] },
  )
}

// ════════════════════════════ AUTO-TITLE reachability ═════════════════════════

describe("reachability · ai-session-title — composition root builds + fires the port", () => {
  test("knob-on + cheap model ⇒ port built AND maybeTitle titles the session (real renameSession)", async () => {
    tmpSessionsDir()
    process.env.QUANTA_SESSION_AUTO_TITLE = "1"
    process.env.QUANTA_SESSION_TITLE_MODEL = "claude-haiku-cheap"
    pin()
    const id = "sess-reach-1"
    await seedSession(id, "Untitled 2026-06-06 00:00")

    const llm = new TitleLLM("Build A Web Server")
    const port = buildAutoTitlePort("anthropic", new AbortController().signal, llm)
    expect(port).toBeDefined() // ← the gap this slice closes: the root BUILDS it

    port?.maybeTitle(id, "build me a tiny web server please")
    const title = await waitForTitle(id, "Untitled 2026-06-06 00:00")
    expect(title).toBe("Build A Web Server")
    expect(llm.calls).toBe(1)
  })

  test("knob-OFF ⇒ NO port built (loop branch dead, byte-identical)", () => {
    process.env.QUANTA_SESSION_TITLE_MODEL = "claude-haiku-cheap" // model present…
    pin()
    // …but the gate is off ⇒ inert.
    expect(
      buildAutoTitlePort("anthropic", new AbortController().signal, new TitleLLM("x")),
    ).toBeUndefined()
  })

  test("knob-on but NO cheap model ⇒ still NO port (cost gate: never the main model)", () => {
    process.env.QUANTA_SESSION_AUTO_TITLE = "1"
    // QUANTA_SESSION_TITLE_MODEL deliberately unset.
    pin()
    // No `seamLlm` ⇒ the builder must consult the env model; absent ⇒ undefined.
    expect(buildAutoTitlePort("anthropic", new AbortController().signal)).toBeUndefined()
  })

  test("knob-on + cheap model but a HUMAN already renamed ⇒ not clobbered", async () => {
    tmpSessionsDir()
    process.env.QUANTA_SESSION_AUTO_TITLE = "1"
    process.env.QUANTA_SESSION_TITLE_MODEL = "claude-haiku-cheap"
    pin()
    const id = "sess-reach-human"
    await seedSession(id, "My Important Refactor") // NOT a placeholder

    const llm = new TitleLLM("Auto Generated Name")
    const port = buildAutoTitlePort("anthropic", new AbortController().signal, llm)
    port?.maybeTitle(id, "first prompt")
    // Give the detached promise time to run + (not) write.
    await new Promise((r) => setTimeout(r, 50))
    expect((await loadSessionById(id))?.meta.title).toBe("My Important Refactor")
  })
})

// ════════════════════════════ BYOK reachability ═══════════════════════════════

describe("reachability · BYOK — composition root awaits the mint before createLLM", () => {
  test("knob-on + helper ⇒ minted key reaches createLLM as opts.apiKey (OVERRIDES env)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-should-be-overridden"
    process.env.QUANTA_API_KEY_HELPER = "mint"
    process.env.QUANTA_API_KEY_HELPER_LEGACY_VENDOR = "1"
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "1"
    pin()
    const calls: string[] = []
    const shellExec = async (cmd: string): Promise<ShellExecResult> => {
      calls.push(cmd)
      return ok("sk-minted-123")
    }
    const llm = await buildLLMWithByok("anthropic", "claude-sonnet-4-6", {
      shellExec,
      now: () => 0,
    })
    expect(llm).toBeInstanceOf(AnthropicAdapter)
    expect(adapterApiKey(llm)).toBe("sk-minted-123") // minted, not the env key
    expect(calls).toEqual(["mint"]) // the mint shell DID run (reachable)
  })

  test("helper-EMPTY (mint stdout '') ⇒ THROWS (env key NOT clobbered with '')", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-key"
    process.env.QUANTA_API_KEY_HELPER = "mint"
    process.env.QUANTA_API_KEY_HELPER_LEGACY_VENDOR = "1"
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "1"
    pin()
    const shellExec = async (): Promise<ShellExecResult> => ok("") // empty mint
    await expect(buildLLMWithByok("anthropic", "m", { shellExec, now: () => 0 })).rejects.toThrow()
  })

  test("knob-OFF ⇒ NO mint, env key built byte-identically (shell never runs)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-key"
    process.env.QUANTA_API_KEY_HELPER = "mint"
    // QUANTA_API_KEY_HELPER_LEGACY_VENDOR deliberately unset ⇒ gate off.
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "1"
    pin()
    const calls: string[] = []
    const shellExec = async (cmd: string): Promise<ShellExecResult> => {
      calls.push(cmd)
      return ok("sk-minted-should-not-be-used")
    }
    const llm = await buildLLMWithByok("anthropic", "claude-sonnet-4-6", {
      shellExec,
      now: () => 0,
    })
    expect(llm).toBeInstanceOf(AnthropicAdapter)
    expect(adapterApiKey(llm)).toBe("sk-env-key") // env key, untouched
    expect(calls).toEqual([]) // mint NEVER consulted (default-OFF byte-identical)
  })

  test("untrusted (no QUANTA_LLM_CREDENTIAL_TRUSTED) ⇒ fail-closed, env key NOT clobbered", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-key"
    process.env.QUANTA_API_KEY_HELPER = "mint"
    process.env.QUANTA_API_KEY_HELPER_LEGACY_VENDOR = "1"
    // QUANTA_LLM_CREDENTIAL_TRUSTED unset ⇒ the source declines (fail-closed).
    pin()
    const calls: string[] = []
    const shellExec = async (cmd: string): Promise<ShellExecResult> => {
      calls.push(cmd)
      return ok("sk-minted")
    }
    // Untrusted ⇒ mintApiKey throws `untrusted` (no silent run, no clobber).
    await expect(buildLLMWithByok("anthropic", "m", { shellExec, now: () => 0 })).rejects.toThrow()
    expect(calls).toEqual([]) // the shell never ran (fail-closed)
  })
})
