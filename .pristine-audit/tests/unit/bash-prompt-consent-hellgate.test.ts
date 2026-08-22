/**
 * ADR-0296 PROMPT mode — bash tool consent-gate wiring hellgate.
 *
 * When the effective behavior is `prompt` (via `QUANTA_BASH_AUTO_BACKGROUND=
 * prompt`), the bash tool binds `runShell`'s `confirm` gate to
 * `ctx.requestBackgroundConsent`. At the deadline it asks; APPROVE ⇒ detach into
 * the bg registry (placeholder), DECLINE ⇒ kill (legacy timeout). Absent a
 * consent requester on ctx, `prompt` degrades to plain `background` (auto-detach
 * with no prompt). Real `bash` children (POSIX only).
 *
 * Axes:
 *  1. APPROVE — consent requester invoked once with {command, elapsedMs};
 *     true ⇒ `[bash background]` placeholder + a live registry entry.
 *  2. DECLINE — false ⇒ no placeholder, legacy timeout, registry untouched.
 *  3. FALLBACK — `prompt` with NO consent requester ⇒ behaves as `background`
 *     (auto-detach, requester never called because it is absent).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBashBgRegistry, getBashBgRegistry } from "@/runtime/bash-bg-registry"
import { __resetRuntimeConfig } from "@/shared"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"

const POSIX = process.platform !== "win32"
const dir = mkdtempSync(join(tmpdir(), "bash-prompt-consent-"))

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

afterEach(async () => {
  await getBashBgRegistry()
    .killAll()
    .catch(() => {})
  __resetBashBgRegistry()
  delete process.env.QUANTA_BASH_AUTO_BACKGROUND
  __resetRuntimeConfig()
})

/** Enter PROMPT mode + reload the frozen runtimeConfig so the tool reads it. */
const promptMode = (): void => {
  process.env.QUANTA_BASH_AUTO_BACKGROUND = "prompt"
  __resetRuntimeConfig()
}

const SLOW = "printf 'started\\n'; sleep 2"

const run = async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute(input as never, ctx) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe.if(POSIX)("prompt mode — consent gate wired to ctx.requestBackgroundConsent", () => {
  test("APPROVE ⇒ detach placeholder + a live registry entry (requester called once)", async () => {
    promptMode()
    const asked: Array<{ command: string; elapsedMs: number }> = []
    const ctx: ToolContext = {
      cwd: dir,
      signal: new AbortController().signal,
      requestBackgroundConsent: async (info) => {
        asked.push(info)
        return true
      },
    }
    const result = await run({ command: SLOW, timeout_ms: 120 }, ctx)
    expect(asked.length).toBe(1)
    expect(asked[0]?.command).toContain("sleep 2")
    expect(asked[0]?.elapsedMs).toBe(120)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("[bash background]")
    expect(getBashBgRegistry().size()).toBe(1)
  })

  test("DECLINE ⇒ legacy timeout, no placeholder, registry untouched", async () => {
    promptMode()
    let asked = 0
    const ctx: ToolContext = {
      cwd: dir,
      signal: new AbortController().signal,
      requestBackgroundConsent: async () => {
        asked++
        return false
      },
    }
    const result = await run({ command: SLOW, timeout_ms: 120 }, ctx)
    expect(asked).toBe(1)
    expect(result.output).not.toContain("[bash background]")
    expect(result.output.toLowerCase()).toContain("timed out")
    expect(getBashBgRegistry().size()).toBe(0)
  })

  test("FALLBACK — prompt with NO consent requester behaves as background (auto-detach)", async () => {
    promptMode()
    const ctx: ToolContext = { cwd: dir, signal: new AbortController().signal }
    const result = await run({ command: SLOW, timeout_ms: 120 }, ctx)
    // No surface wired ⇒ detach immediately (documented degrade to background).
    expect(result.output).toContain("[bash background]")
    expect(getBashBgRegistry().size()).toBe(1)
  })

  test("consent is asked ONLY at the deadline — a fast command never prompts", async () => {
    promptMode()
    let asked = 0
    const ctx: ToolContext = {
      cwd: dir,
      signal: new AbortController().signal,
      requestBackgroundConsent: async () => {
        asked++
        return true
      },
    }
    // Completes well under the deadline ⇒ the deadline timer never fires ⇒ no prompt.
    const result = await run({ command: "printf fast-done", timeout_ms: 5000 }, ctx)
    expect(asked).toBe(0) // never asked (no deadline hit)
    expect(result.output).not.toContain("[bash background]")
    expect(result.output).toContain("fast-done")
    expect(getBashBgRegistry().size()).toBe(0)
  })
})
