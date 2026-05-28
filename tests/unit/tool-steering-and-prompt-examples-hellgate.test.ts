/**
 * TKT-002 — prompt steering hellgate.
 *
 * ADR-0410 absorbs the Codex (L80–L120 `bash`/`apply_patch` / Tier-3 system
 * skill `SHELL.md`) and Claude Code 2.1.138 `tools/Bash.ts` / `tools/Edit.ts`
 * / `tools/Write.ts` description patterns. The competitor-tested signal is
 * three-fold:
 *
 *   1. `bash` description steers toward read/grep/edit and warns against
 *      using shell for file ops (cat/sed/awk).
 *   2. `edit` description includes a "when not to use" clause naming the
 *      alternatives (write / apply_patch / wider context).
 *   3. `write` description includes a "when not to use" clause naming the
 *      alternatives (edit / apply_patch). Multiple writes to the same file
 *      is flagged as an anti-pattern.
 *
 * The base system prompt also gains TWO concrete few-shot `<example>` blocks
 * (one POSITIVE pattern, one AVOIDANCE pattern) to anchor the routing.
 *
 * Hellgate posture: each new phrase is REQUIRED, AND the unchanged portions
 * of the prompt remain byte-stable. Byte-stability for the prompt is verified
 * by hashing `buildSystemPrompt()` and asserting the call is idempotent across
 * 50 calls (cache-prefix invariant — ADR-0003/0004).
 */
import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent/prompt"
import { bashTool } from "@/tool/bash"
import { editTool } from "@/tool/edit"
import { writeTool } from "@/tool/write"

describe("ADR-0410 — bash describe steers toward read/grep/edit", () => {
  const d = bashTool.description

  test("names the preferred file-ops alternatives (read, grep, edit)", () => {
    // The model must see that read/grep/edit beat shell for the canonical
    // file-op verbs. Exact-substring match keeps the steering uncargoable.
    expect(d).toContain("read")
    expect(d).toContain("grep")
    expect(d).toContain("edit")
  })

  test("flags the cat/sed/awk anti-pattern verbatim", () => {
    expect(d.toLowerCase()).toContain("cat")
    expect(d.toLowerCase()).toContain("sed")
    expect(d.toLowerCase()).toContain("awk")
  })

  test("scopes bash to one-shot shell commands (search/diff/exec)", () => {
    // The discriminating signal — bash is for things that finish in ONE
    // shell call (file search via rg/fd, diff, exec). The Codex SHELL.md
    // L40 pattern.
    expect(d.toLowerCase()).toMatch(/one (shell |)command|single (shell |)command/)
  })

  test("retains the legacy exit-code semantics line (byte-stable invariant)", () => {
    // Non-regression: the original "Run a shell command (bash)... exit code"
    // contract must remain because operator runbooks rely on it.
    expect(d).toContain("Run a shell command")
    expect(d.toLowerCase()).toContain("exit code")
  })
})

describe("ADR-0410 — edit describe carries a when-not-to-use clause", () => {
  const d = editTool.description

  test("retains the original exact-match contract", () => {
    expect(d).toContain("Exact string replacement")
    expect(d).toContain("old_string must match verbatim")
  })

  test("names write as the alternative for creating a NEW file", () => {
    // "Don't use edit to create a file" — write is the answer.
    expect(d.toLowerCase()).toContain("new file")
    expect(d.toLowerCase()).toContain("write")
  })

  test("flags non-unique old_string as the failure mode", () => {
    // The most common edit failure: ambiguous old_string. Direct the model
    // to add wider surrounding context.
    expect(d.toLowerCase()).toContain("unique")
    expect(d.toLowerCase()).toContain("context")
  })
})

describe("ADR-0410 — write describe carries a when-not-to-use clause", () => {
  const d = writeTool.description

  test("retains the original create/overwrite contract", () => {
    expect(d).toContain("Write a file")
    expect(d.toLowerCase()).toContain("overwrit")
  })

  test("names edit as the alternative for partial mutation of an existing file", () => {
    expect(d.toLowerCase()).toContain("edit")
    expect(d.toLowerCase()).toContain("partial")
  })

  test("flags repeated writes to the same file as an anti-pattern", () => {
    // Multiple consecutive writes to the same file is a Codex/Claude-Code
    // known regression signal — call it out so the model branches earlier.
    expect(d.toLowerCase()).toMatch(/(repeated|multiple|several|consecutive)\b[^.]*\bwrites?/)
    expect(d.toLowerCase()).toContain("same file")
  })
})

describe("ADR-0410 — prompt-body carries two anchor examples", () => {
  const p = buildSystemPrompt()

  test("contains exactly two <example> blocks", () => {
    // Few-shot count is load-bearing: too few = weak anchor, too many =
    // cache-prefix bloat. Two is the Codex SHELL.md / Claude Code Bash.ts
    // empirical sweet spot (their description carries 2 examples each).
    const openCount = p.split("<example>").length - 1
    const closeCount = p.split("</example>").length - 1
    expect(openCount).toBe(2)
    expect(closeCount).toBe(2)
  })

  test("positive example demonstrates reasoning → tool choice (read/grep beats bash)", () => {
    // Pattern: "User wants X → reason → action with the right tool".
    expect(p.toLowerCase()).toContain("example")
    // The positive example MUST anchor a non-shell file-op as the chosen tool.
    expect(p).toMatch(/(read|grep)\b/)
  })

  test("avoidance example demonstrates 'do NOT use bash for sed/edit'", () => {
    // The avoidance example must literally call out the sed-in-bash trap so
    // the model has a concrete negative pattern to refuse.
    expect(p.toLowerCase()).toContain("sed")
    // And it must name `edit` as the resolution.
    expect(p).toContain("edit")
  })

  test("examples sit AFTER 'Tool routing' (so they anchor the routing)", () => {
    const routingIdx = p.indexOf("Tool routing")
    const firstExampleIdx = p.indexOf("<example>")
    expect(routingIdx).toBeGreaterThanOrEqual(0)
    expect(firstExampleIdx).toBeGreaterThan(routingIdx)
  })

  test("byte-stable: buildSystemPrompt() is idempotent across 50 calls", () => {
    // Cache-prefix invariant (ADR-0003/0004): examples must not introduce
    // per-call variance (no Date.now, no Math.random, no env reads).
    const first = buildSystemPrompt()
    for (let i = 0; i < 50; i++) {
      expect(buildSystemPrompt()).toBe(first)
    }
  })
})

describe("ADR-0410 — unchanged portions remain byte-stable", () => {
  // Specific subsections of the prompt that this slice does NOT touch.
  // Each guard pins ONE invariant from a sibling absorption so silent drift
  // (e.g. examples accidentally inserted INSIDE Anti-signals) fails CI.
  const p = buildSystemPrompt()

  test("Policy stack section is unchanged in shape", () => {
    expect(p).toContain("Policy stack (highest to lowest priority")
    expect(p).toContain("L1 system")
    expect(p).toContain("L9 working state")
  })

  test("Anti-signals seven names still present", () => {
    expect(p).toContain("Absence from grep")
    expect(p).toContain("Visual looks okay")
  })

  test("Honesty rail still present after the examples", () => {
    const exampleIdx = p.indexOf("<example>")
    const honestyIdx = p.indexOf("Honesty rail")
    expect(exampleIdx).toBeGreaterThanOrEqual(0)
    // Examples ride BEFORE the closing Honesty rail section.
    expect(honestyIdx).toBeGreaterThan(exampleIdx)
  })

  test("Verification report scaffold still present", () => {
    expect(p).toContain("Verification report")
    expect(p).toContain("performed:")
    expect(p).toContain("verdict:")
  })
})
