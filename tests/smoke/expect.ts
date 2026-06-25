import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { CaptureStream } from "./capture-stream"
import type { AssertionFailure, ExpectSpec, ScenarioResult } from "./types"

/**
 * Industry-SOTA assertion runner. Inputs:
 *   - `spec`     declarative expect.json contents
 *   - `capture`  buffered AgentEvents from the run
 *   - `stopReason` / `turns` from the {@link AgentOutcome}
 *   - `cwd`      tmp workspace path (for file assertions)
 *
 * Returns ZERO failures ⇒ pass; otherwise each failure has `path` (dotted
 * pointer), `expected`, `actual` for surface-friendly diffing. Failures
 * accumulate — every assertion is checked even if an earlier one failed, so a
 * single run reports the full delta in one pass.
 */
export const runAssertions = (args: {
  spec: ExpectSpec
  capture: CaptureStream
  cwd: string
  stopReason: string
  turns: number
}): AssertionFailure[] => {
  const out: AssertionFailure[] = []
  const { spec, capture, cwd, stopReason, turns } = args
  checkStopReason(out, spec, stopReason)
  checkTurns(out, spec, turns)
  checkToolCalls(out, spec, capture)
  checkFiles(out, spec, cwd)
  checkFinalText(out, spec, capture)
  checkContextRetention(out, spec, capture)
  checkBudget(out, spec, capture)
  // FLAG 1: a tier-0 scenario whose ONLY pass signal is the cached judge score
  // (a constant typed into expect.json — never inspecting the replayed output)
  // would green even if the replayed text were garbage. A judge block is allowed
  // to CONTRIBUTE, but it cannot be the only thing standing between the run and
  // green. Require at least one real, output-inspecting assertion alongside it.
  checkJudgeNotSoleGate(out, spec)
  // judge: Phase 2 — schema is honoured at parse time but execution is wired
  // in a follow-up. A `cached.score < threshold` is honoured here so already-
  // cached judge runs gate without an LLM round-trip.
  checkJudgeCached(out, spec)
  return out
}

/**
 * "Real assertion" = a teeth-bearing block that inspects the actual run/output:
 * stopReason, turns, toolCalls, files, finalText, contextRetention, or budget.
 * The cached `judge` score is explicitly NOT real (it is a hardcoded literal,
 * not derived from the replayed output). Used by {@link checkJudgeNotSoleGate}.
 */
const hasRealAssertion = (spec: ExpectSpec): boolean =>
  spec.stopReason !== undefined ||
  spec.turns?.count !== undefined ||
  spec.toolCalls !== undefined ||
  (spec.files !== undefined && spec.files.length > 0) ||
  spec.finalText !== undefined ||
  (spec.contextRetention !== undefined && spec.contextRetention.length > 0) ||
  spec.budget !== undefined

/** FLAG 1 — fail LOUD (as a config error) when a scenario declares a judge block
 *  but carries NO real assertion. Such a fixture would pass purely on the cached
 *  literal judge score, never inspecting the replayed output. */
const checkJudgeNotSoleGate = (out: AssertionFailure[], spec: ExpectSpec): void => {
  if (spec.judge === undefined) return
  if (hasRealAssertion(spec)) return
  fail(
    out,
    "judge.soleGate",
    "a real assertion (finalText/files/toolCalls/stopReason/turns/...) alongside the judge",
    "tier-0 scenario relies on cached judge alone — add a real assertion",
  )
}

const fail = (out: AssertionFailure[], path: string, expected: string, actual: string): void => {
  out.push({ path, expected, actual })
}

const checkStopReason = (out: AssertionFailure[], spec: ExpectSpec, actual: string): void => {
  if (spec.stopReason === undefined) return
  if (actual !== spec.stopReason) {
    fail(out, "stopReason", spec.stopReason, actual)
  }
}

const checkTurns = (out: AssertionFailure[], spec: ExpectSpec, actual: number): void => {
  const range = spec.turns?.count
  if (range === undefined) return
  if (range.min !== undefined && actual < range.min) {
    fail(out, "turns.count.min", `>= ${range.min}`, String(actual))
  }
  if (range.max !== undefined && actual > range.max) {
    fail(out, "turns.count.max", `<= ${range.max}`, String(actual))
  }
}

const checkRange = (
  out: AssertionFailure[],
  path: string,
  range: { min?: number; max?: number },
  actual: number,
): void => {
  if (range.min !== undefined && actual < range.min) {
    fail(out, `${path}.min`, `>= ${range.min}`, String(actual))
  }
  if (range.max !== undefined && actual > range.max) {
    fail(out, `${path}.max`, `<= ${range.max}`, String(actual))
  }
}

const checkToolCalls = (
  out: AssertionFailure[],
  spec: ExpectSpec,
  capture: CaptureStream,
): void => {
  const tc = spec.toolCalls
  if (tc === undefined) return
  const order = capture.toolCallOrder()
  const counts = capture.toolCallCounts()
  for (const t of tc.required ?? []) {
    if ((counts[t] ?? 0) === 0) fail(out, `toolCalls.required[${t}]`, ">= 1 call", "0 calls")
  }
  for (const t of tc.forbidden ?? []) {
    const n = counts[t] ?? 0
    if (n > 0) fail(out, `toolCalls.forbidden[${t}]`, "0 calls", `${n} calls`)
  }
  ;(tc.orderedPrefix ?? []).forEach((want, i) => {
    const got = order[i]
    if (got !== want) {
      fail(out, `toolCalls.orderedPrefix[${i}]`, String(want), got ?? "<missing>")
    }
  })
  for (const [t, range] of Object.entries(tc.counts ?? {})) {
    checkRange(out, `toolCalls.counts[${t}]`, range, counts[t] ?? 0)
  }
}

const checkLinesAdded = (
  out: AssertionFailure[],
  cwd: string,
  f: NonNullable<ExpectSpec["files"]>[number],
  body: string,
): void => {
  if (f.linesAdded === undefined) return
  // Count the delta vs the seed snapshot. Missing seed ⇒ skip (cannot infer).
  const seedPath = join(cwd, ".seed-snapshot", f.path)
  if (!existsSync(seedPath)) return
  const before = readFileSync(seedPath, "utf8").split("\n").length
  const added = Math.max(0, body.split("\n").length - before)
  checkRange(out, `files[${f.path}].linesAdded`, f.linesAdded, added)
}

const checkOneFile = (
  out: AssertionFailure[],
  cwd: string,
  f: NonNullable<ExpectSpec["files"]>[number],
): void => {
  const full = join(cwd, f.path)
  const exists = existsSync(full)
  if (f.absent === true) {
    if (exists) fail(out, `files[${f.path}].absent`, "must not exist", "exists")
    return
  }
  if (!exists) {
    fail(out, `files[${f.path}]`, "exists", "missing")
    return
  }
  const body = readFileSync(full, "utf8")
  for (const needle of f.contains ?? []) {
    if (!body.includes(needle)) {
      fail(out, `files[${f.path}].contains`, `contains ${JSON.stringify(needle)}`, "absent")
    }
  }
  for (const needle of f.notContains ?? []) {
    if (body.includes(needle)) {
      fail(out, `files[${f.path}].notContains`, `absent ${JSON.stringify(needle)}`, "found")
    }
  }
  checkLinesAdded(out, cwd, f, body)
}

const checkFiles = (out: AssertionFailure[], spec: ExpectSpec, cwd: string): void => {
  for (const f of spec.files ?? []) checkOneFile(out, cwd, f)
}

const checkFinalText = (
  out: AssertionFailure[],
  spec: ExpectSpec,
  capture: CaptureStream,
): void => {
  const t = spec.finalText
  if (t === undefined) return
  const text = capture.assistantText()
  for (const needle of t.contains ?? []) {
    if (!text.includes(needle)) {
      fail(out, "finalText.contains", `contains ${JSON.stringify(needle)}`, "absent")
    }
  }
  if (
    t.containsAny !== undefined &&
    t.containsAny.length > 0 &&
    !t.containsAny.some((n) => text.includes(n))
  ) {
    fail(out, "finalText.containsAny", `any of ${JSON.stringify(t.containsAny)}`, "none matched")
  }
  for (const needle of t.notContains ?? []) {
    if (text.includes(needle)) {
      fail(out, "finalText.notContains", `absent ${JSON.stringify(needle)}`, "found")
    }
  }
  checkRegex(out, t.regex, text)
}

const checkRegex = (out: AssertionFailure[], pattern: string | undefined, text: string): void => {
  if (pattern === undefined) return
  try {
    if (!new RegExp(pattern).test(text)) {
      fail(out, "finalText.regex", `match /${pattern}/`, "no match")
    }
  } catch (e) {
    fail(out, "finalText.regex", "valid regex", String(e))
  }
}

const checkContextRetention = (
  out: AssertionFailure[],
  spec: ExpectSpec,
  capture: CaptureStream,
): void => {
  if (spec.contextRetention === undefined) return
  const runs = capture.assistantTextByRun()
  for (const c of spec.contextRetention) {
    const runText = runs[c.inRun]
    if (runText === undefined) {
      fail(
        out,
        `contextRetention[inRun=${c.inRun}]`,
        `run ${c.inRun} present`,
        `only ${runs.length} runs`,
      )
      continue
    }
    for (const needle of c.assistantTranscriptContains) {
      if (!runText.includes(needle)) {
        fail(
          out,
          `contextRetention[inRun=${c.inRun}].contains`,
          `mentions ${JSON.stringify(needle)}`,
          "absent",
        )
      }
    }
  }
}

const checkBudget = (out: AssertionFailure[], spec: ExpectSpec, capture: CaptureStream): void => {
  const b = spec.budget
  if (b === undefined) return
  if (b.tokensInput?.max !== undefined) {
    const totalIn = capture.totalUsage().inputTokens
    if (totalIn > b.tokensInput.max) {
      fail(out, "budget.tokensInput.max", `<= ${b.tokensInput.max}`, String(totalIn))
    }
  }
  if (b.tokensOutput?.max !== undefined) {
    const totalOut = capture.totalUsage().outputTokens
    if (totalOut > b.tokensOutput.max) {
      fail(out, "budget.tokensOutput.max", `<= ${b.tokensOutput.max}`, String(totalOut))
    }
  }
  // wallSeconds.max is checked at the runner site (it owns the clock).
}

const checkJudgeCached = (out: AssertionFailure[], spec: ExpectSpec): void => {
  const j = spec.judge
  if (j === undefined || j.cached === undefined) return
  if (j.cached.score < j.threshold) {
    fail(
      out,
      "judge",
      `score >= ${j.threshold}`,
      `cached score=${j.cached.score} rationale=${JSON.stringify(j.cached.rationale)}`,
    )
  }
}

export const formatResult = (r: ScenarioResult): string => {
  const tag = r.status === "passed" ? "PASS" : r.status === "failed" ? "FAIL" : "SKIP"
  const head = `[${tag}] ${r.meta.id}  (${r.meta.depth}, ${r.durationMs}ms)`
  if (r.status === "skipped") return `${head}  — ${r.skipReason ?? "no reason"}`
  if (r.status === "passed") return head
  const body = r.failures
    .map((f) => `    ${f.path}\n      expected: ${f.expected}\n      actual:   ${f.actual}`)
    .join("\n")
  return `${head}\n${body}`
}
