/**
 * WS4 (jul-12 OmO absorption) — interactive preset repo-rules wiring hellgate.
 *
 * GAP (self-audit 04 §4, prompt/tool-surface = 74): repo-local rules
 * (AGENTS.md / CLAUDE.md) are loaded by `loadRepoRules` and the whole
 * downstream render is wired (`context-assembler.ts:418` → `prompt.ts:644`
 * renderRepoRulesBlock → four-section project_md), yet the INTERACTIVE preset
 * never populated `cfg.repoRules`. So a repo's AGENTS.md reached bench prompts
 * but NEVER the interactive model prompt — the surface a human actually drives.
 *
 * This slice fills exactly one seam: `buildInteractiveBase` now
 * `await loadRepoRules(cwd)` and sets `base.repoRules`. Everything downstream
 * already exists; this proves the value now flows through it.
 *
 * Contract pinned here:
 *   §1  WIRING (red-on-injection) — interactive cfg.repoRules is populated from
 *       the cwd's AGENTS.md. Remove the wire ⇒ this goes RED.
 *   §2  CONTROL — a cwd with NO repo-rule file leaves repoRules undefined
 *       (byte-identical preservation for rule-less repos / the absent case the
 *       AgentConfig.repoRules doc guarantees).
 *   §3  PROPAGATION + DEFANG — the loaded rules reach the assembled system
 *       prompt (buildTurnContext, the real caller path) AND a forged
 *       `</system-reminder>` inside the rules body is defanged (`<\/…>`), never
 *       emitted as a genuine boundary the model would obey.
 *
 * Boundary discipline: loadRepoRules' own walk-up/symlink-reject semantics stay
 * covered by `repo-rules.test.ts` / `repo-rules-tree-hellgate.test.ts`; the
 * escape helper by `prompt-escape-hellgate.test.ts`. This file only asserts the
 * NEW wiring + that it lands in the render it claims to.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { AssembleRequest } from "../../src/apps/agent/assemble"
import { runMode as runInteractiveMode } from "../../src/apps/agent/mode-presets/interactive"

const SENTINEL = "OMO-WS4-REPO-RULE-SENTINEL-9c3f"

// Inert LLM — the runAgent seam captures cfg before any stream() is reached.
const inertLLM: LLMPort & { readonly model: string } = {
  model: "gpt-5",
  // biome-ignore lint/correctness/useYield: never invoked (seam captures cfg first)
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream() call")
  },
}

const baseFor = (
  cwd: string,
  over: Partial<AssembleRequest["base"]> = {},
): AssembleRequest["base"] => ({
  llm: inertLLM,
  registry: {
    register: () => undefined,
    get: () => undefined,
    list: () => [],
  } as unknown as AgentConfig["registry"],
  stream: { emit: () => undefined },
  permission: { mode: "default" },
  messages: [],
  system: "test",
  cwd,
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId: "sess-ws4",
  ...over,
})

/** Drive the REAL interactive assembly path (runMode → stubBase →
 *  buildInteractiveBase → assembleAgentConfig) and hand back the assembled cfg
 *  via the runAgent seam. */
const captureInteractiveCfg = async (
  cwd: string,
  over: Partial<AssembleRequest["base"]> = {},
): Promise<AgentConfig> => {
  let captured: AgentConfig | undefined
  const result = await runInteractiveMode({
    mode: "interactive",
    base: baseFor(cwd, over),
    seams: {
      runAgent: async (cfg) => {
        captured = cfg
        // Minimal AgentOutcome stub — exitCode path only needs a reason.
        // biome-ignore lint/suspicious/noExplicitAny: outcome shape stub
        return { reason: "completed", messages: [], turns: 0 } as any
      },
    },
  })
  expect(result.exitCode).toBe(0)
  if (captured === undefined) throw new Error("runAgent seam did not capture a cfg")
  return captured
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omo-ws4-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("WS4 §1 — interactive cfg.repoRules is populated from the cwd AGENTS.md", () => {
  test("AGENTS.md content lands in cfg.repoRules.body (red-on-injection: unwired ⇒ undefined)", async () => {
    // `.git` marker stops loadRepoRules' walk-up AT this dir, so the test is
    // deterministic regardless of any AGENTS.md that may exist in tmpdir's
    // ancestors (the break condition is `.git`, not `.gitkeep`).
    writeFileSync(join(dir, ".git"), "")
    writeFileSync(join(dir, "AGENTS.md"), `# Project rules\n\n${SENTINEL}\n`)
    const cfg = await captureInteractiveCfg(dir)
    expect(cfg.repoRules).toBeDefined()
    expect(cfg.repoRules?.body ?? "").toContain(SENTINEL)
  })
})

describe("WS4 §2 — control: no repo-rule file ⇒ repoRules stays undefined", () => {
  test("a rule-less cwd leaves cfg.repoRules undefined (absent-case byte-identical)", async () => {
    // `.git` stops the walk-up here so an ancestor's AGENTS.md can't leak in and
    // make this control assertion flaky.
    writeFileSync(join(dir, ".git"), "")
    const cfg = await captureInteractiveCfg(dir)
    expect(cfg.repoRules).toBeUndefined()
  })
})

// hell-audit remediation §3 — the caller-override branch (`req.base.repoRules ??
// loadRepoRules`). A host that already loaded rules (or wants to suppress them)
// passes them on the base; that value MUST win over a cwd scan. Previously only
// the load side was pinned, so a mutation to `loadRepoRules(cwd)` (dropping the
// override) went unnoticed. Red-on-injection: drop `req.base.repoRules ??` ⇒ the
// cwd AGENTS.md leaks in and the override sentinel is lost.
describe("WS4 §3 — a caller-supplied base.repoRules overrides the cwd scan", () => {
  test("req.base.repoRules wins over an on-disk AGENTS.md (override, not merge)", async () => {
    writeFileSync(join(dir, ".git"), "")
    writeFileSync(join(dir, "AGENTS.md"), `# on-disk\n\n${SENTINEL}-ON-DISK\n`)
    const override = {
      sourcePath: join(dir, "CALLER"),
      entrypoint: "CALLER",
      body: `${SENTINEL}-OVERRIDE`,
      loadedAt: 0,
    }
    const cfg = await captureInteractiveCfg(dir, {
      repoRules: override as NonNullable<AgentConfig["repoRules"]>,
    })
    expect(cfg.repoRules?.body).toBe(`${SENTINEL}-OVERRIDE`)
    // The on-disk file was NOT scanned/merged in.
    expect(cfg.repoRules?.body ?? "").not.toContain("ON-DISK")
  })
})
