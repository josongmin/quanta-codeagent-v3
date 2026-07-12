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
import { runMode as headlessRun } from "../../src/apps/agent/mode-presets/headless"
import { runMode as ideRun } from "../../src/apps/agent/mode-presets/ide"
import {
  MODE_REPO_RULES_POLICY,
  resolveModePresetRepoRules,
} from "../../src/apps/agent/mode-presets/system"

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

// REGRESSION-PREVENTION DRIFT GUARD (R7) — `MODE_REPO_RULES_POLICY` is a
// `Record<RunMode, …>`, so adding a new AgentMode fails to COMPILE until it is
// classified load/rule-less (no surface silently skips the security decision).
// This test closes the loop: the resolver must BEHAVE per every policy entry, so
// a mis-classification or a resolver bug can't hide. Iterating the policy keys
// means a newly-added mode is automatically exercised here too.
describe("WS4 §0 — drift guard: the resolver honors MODE_REPO_RULES_POLICY for EVERY mode", () => {
  test("every RunMode's resolver behavior matches its policy entry", async () => {
    writeFileSync(join(dir, ".git"), "")
    writeFileSync(join(dir, "AGENTS.md"), `# rules\n${SENTINEL}\n`)
    const modes = Object.keys(MODE_REPO_RULES_POLICY) as RunMode[]
    expect(modes.length).toBeGreaterThanOrEqual(6) // all AgentMode values present
    for (const mode of modes) {
      const rules = await resolveModePresetRepoRules(mode, undefined, dir)
      if (MODE_REPO_RULES_POLICY[mode] === "load") {
        expect(rules?.body ?? "", `${mode} must LOAD`).toContain(SENTINEL)
      } else {
        expect(rules, `${mode} must be RULE-LESS`).toBeUndefined()
      }
    }
  })
})

describe("WS4 R3/R4/R5 §1 — resolveModePresetRepoRules policy SSOT", () => {
  test("hermetic bench (batch) stays rule-less even with an on-disk AGENTS.md", async () => {
    expect(await resolveModePresetRepoRules("batch", undefined, dir)).toBeUndefined()
  })

  test("SECURITY: UNTRUSTED-tree modes (ci-bot / daemon) do NOT auto-load the cwd AGENTS.md", async () => {
    // ci-bot reviews an untrusted PR; daemon reviews host-created PR/webhook
    // worktrees (daemon.ts contract). A malicious tree's AGENTS.md would ride
    // into the trusted system prompt as authoritative rules ⇒ self-approve. The
    // resolver must exclude both.
    for (const mode of ["ci-bot", "daemon"] as RunMode[]) {
      expect(await resolveModePresetRepoRules(mode, undefined, dir)).toBeUndefined()
    }
  })

  test("a rules-loading mode (interactive/headless/ide) loads the cwd rules", async () => {
    for (const mode of ["interactive", "headless", "ide"] as RunMode[]) {
      const r = await resolveModePresetRepoRules(mode, undefined, dir)
      expect(r?.body ?? "").toContain(SENTINEL)
    }
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

describe("WS4 R3 §2 — each TRUSTED user-repo preset routes through the resolver", () => {
  const drivers: ReadonlyArray<{
    mode: RunMode
    run: (req: AssembleRequest) => Promise<unknown>
    extra: Partial<AssembleRequest>
  }> = [
    { mode: "headless", run: headlessRun, extra: { headless: { prompt: "go" } } },
    { mode: "ide", run: ideRun, extra: {} },
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
