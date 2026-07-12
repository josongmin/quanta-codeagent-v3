/**
 * WS4 hell-audit R3 remediation — repo-local rules (AGENTS.md/CLAUDE.md) must
 * reach EVERY human/automation-driven preset, not just interactive. R3 found the
 * WS4 rationale ("a human driving a real repo's AGENTS.md was silently ignored")
 * applied identically to headless (`quanta -p`), ide, daemon, ci-bot — all of
 * which still ignored the repo's rules.
 *
 * Fix: one mode-keyed policy resolver `resolveModePresetRepoRules` (mirrors
 * resolveModePresetSystemPrompt) that every preset's base-builder calls. This
 * suite pins the policy SSOT AND that the presets actually route through it.
 *
 *   §1  POLICY — caller-override wins · `batch` (hermetic bench) stays rule-less ·
 *       every other mode loads from cwd.
 *   §2  WIRING — headless / ide / daemon each populate cfg.repoRules from the cwd
 *       AGENTS.md (red-on-injection: a preset that skips the resolver ⇒ RED).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig, AgentOutcome, RunMode } from "@/agent"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import type { AssembleRequest } from "../../src/apps/agent/assemble"
import { runMode as daemonRun } from "../../src/apps/agent/mode-presets/daemon"
import { runMode as headlessRun } from "../../src/apps/agent/mode-presets/headless"
import { runMode as ideRun } from "../../src/apps/agent/mode-presets/ide"
import { resolveModePresetRepoRules } from "../../src/apps/agent/mode-presets/system"

const SENTINEL = "OMO-WS4-R3-PRESET-RULE-3af1"

const fakeLlm: LLMPort = { model: "test", stream: async function* () {} } as unknown as LLMPort

const baseFor = (cwd: string): AssembleRequest["base"] => ({
  llm: fakeLlm,
  registry: new ToolRegistry(defaultTools),
  stream: { emit: () => undefined } as StreamPort,
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [],
  system: "",
  cwd,
  maxTurns: 3,
  signal: new AbortController().signal,
})

const fakeOutcome: AgentOutcome = { reason: "completed", turns: 1, messages: [] }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omo-r3-"))
  writeFileSync(join(dir, ".git"), "") // stop the walk-up here (deterministic)
  writeFileSync(join(dir, "AGENTS.md"), `# rules\n\n${SENTINEL}\n`)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("WS4 R3 §1 — resolveModePresetRepoRules policy SSOT", () => {
  test("batch stays rule-less even with an on-disk AGENTS.md", async () => {
    expect(await resolveModePresetRepoRules("batch", undefined, dir)).toBeUndefined()
  })

  test("a non-batch mode loads the cwd rules", async () => {
    const r = await resolveModePresetRepoRules("headless", undefined, dir)
    expect(r?.body ?? "").toContain(SENTINEL)
  })

  test("a caller override wins for EVERY mode (even batch)", async () => {
    const override = {
      sourcePath: "/x/CALLER",
      entrypoint: "CALLER",
      body: "OVERRIDE-BODY",
      loadedAt: 0,
    } as NonNullable<AgentConfig["repoRules"]>
    for (const mode of [
      "batch",
      "headless",
      "interactive",
      "ide",
      "daemon",
      "ci-bot",
    ] as RunMode[]) {
      expect(await resolveModePresetRepoRules(mode, override, dir)).toBe(override)
    }
  })
})

describe("WS4 R3 §2 — each human/automation preset routes through the resolver", () => {
  const drivers: ReadonlyArray<{
    mode: RunMode
    run: (req: AssembleRequest) => Promise<unknown>
    extra: Partial<AssembleRequest>
  }> = [
    { mode: "headless", run: headlessRun, extra: { headless: { prompt: "go" } } },
    { mode: "ide", run: ideRun, extra: {} },
    { mode: "daemon", run: daemonRun, extra: {} },
  ]

  for (const d of drivers) {
    test(`${d.mode} populates cfg.repoRules from the cwd AGENTS.md`, async () => {
      let cfg: AgentConfig | undefined
      await d.run({
        mode: d.mode,
        base: baseFor(dir),
        seams: {
          runAgent: async (c: AgentConfig) => {
            cfg = c
            return fakeOutcome
          },
        },
        ...d.extra,
      } as AssembleRequest)
      expect(cfg?.repoRules?.body ?? "").toContain(SENTINEL)
    })
  }
})
