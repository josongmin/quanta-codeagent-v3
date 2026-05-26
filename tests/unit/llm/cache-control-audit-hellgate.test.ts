import { describe, expect, test } from "bun:test"
import {
  analyzePrefixStability,
  type CachePrefixSnapshot,
  sha256Hex,
} from "@/llm/cache-control-audit"

/**
 * Hellgate for ADR-0319 cache-control thread-stability audit slice.
 *
 * Codex side-steps prompt-cache invalidation by passing
 * `prompt_cache_key = thread_id` on every request
 * (codex-rs/core/src/client.rs:751) — the server keys on a per-thread
 * token, not on the prefix bytes. Anthropic offers no such handle: the
 * `cache_control: { type: "ephemeral" }` marker hashes the PREFIX BYTES
 * up to (and including) the block carrying the marker, so any drift in
 * those bytes between turns of the same thread costs us a cache miss.
 *
 * This battery proves the analyzer reports:
 *   - 1 byte content drift ⇒ unstable + position localized
 *   - cache_control marker dropped / added between turns ⇒ unstable
 *   - position vanishes between turns ⇒ `missing` finding
 *   - empty snapshot list / single batch ⇒ trivially stable
 *   - simulated date-drift (the most common real-world hazard the codebase
 *     fights with the trailing `<system-reminder>` discipline) is caught
 *     when callers mistakenly fold dynamic context into the cached prefix
 *   - multiple cache_control markers in one batch (Anthropic caps at 4 —
 *     analyzer is content-agnostic and still tracks each independently)
 *   - large content hashing stays deterministic at 100 KB (no truncation,
 *     no chunk-size bug)
 */

/** Test helper. The third argument is REQUIRED to make marker presence
 *  explicit at every call site (defaults are a known JS footgun: passing
 *  `undefined` for a defaulted optional silently re-applies the default,
 *  which would mask the very marker-drop cases we want to test). */
const snap = (
  position: string,
  content: string,
  cacheControl: "ephemeral" | undefined,
): CachePrefixSnapshot => ({
  position,
  content,
  cacheControl,
  hash: sha256Hex(content),
})

describe("ADR-0319 cache-control-audit hellgate", () => {
  test("HELL-CCA-01 — identical prefix across 5 batches ⇒ stable, no findings", () => {
    const base = snap("system[0]", "You are a helpful assistant.", "ephemeral")
    const memory = snap("system[1]:session_ctx", "tools=read,write,grep", "ephemeral")
    const batches = Array.from({ length: 5 }, () => [base, memory])
    const report = analyzePrefixStability(batches)
    expect(report.stable).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.totalBatches).toBe(5)
    expect(report.totalPositions).toBe(2)
    expect(report.perPosition.every((p) => p.stable)).toBe(true)
  })

  test("HELL-CCA-02 — 1 byte content drift ⇒ unstable + position reported + samples", () => {
    const stable = snap("system[0]", "You are a helpful assistant.", "ephemeral")
    const drifted = snap("system[1]:project_md", "rules: do not edit\n", "ephemeral")
    const driftedV2 = snap("system[1]:project_md", "rules: do not edit.\n", "ephemeral") // trailing punct
    const report = analyzePrefixStability([
      [stable, drifted],
      [stable, driftedV2],
    ])
    expect(report.stable).toBe(false)
    const content = report.findings.find((f) => f.kind === "content")
    expect(content).toBeDefined()
    expect(content?.position).toBe("system[1]:project_md")
    expect(content?.firstIndex).toBe(0)
    expect(content?.secondIndex).toBe(1)
    expect(content?.firstSample).toBe("rules: do not edit\n")
    expect(content?.secondSample).toBe("rules: do not edit.\n")
    // The other position stays stable + reported as such.
    const p0 = report.perPosition.find((p) => p.position === "system[0]")
    const p1 = report.perPosition.find((p) => p.position === "system[1]:project_md")
    expect(p0?.stable).toBe(true)
    expect(p1?.stable).toBe(false)
  })

  test("HELL-CCA-03 — cache_control marker dropped on a later turn ⇒ `marker` finding", () => {
    const text = "static base prompt"
    const withMarker = snap("system[0]", text, "ephemeral")
    const withoutMarker = snap("system[0]", text, undefined)
    const report = analyzePrefixStability([[withMarker], [withMarker], [withoutMarker]])
    expect(report.stable).toBe(false)
    const marker = report.findings.find((f) => f.kind === "marker")
    expect(marker).toBeDefined()
    expect(marker?.firstIndex).toBe(0)
    expect(marker?.secondIndex).toBe(2)
    // Hash stayed equal ⇒ no `content` finding.
    expect(report.findings.some((f) => f.kind === "content")).toBe(false)
    const p = report.perPosition[0]
    expect(p?.anyMarker).toBe(true)
    expect(p?.missingMarker).toBe(true)
  })

  test("HELL-CCA-04 — empty batches ⇒ trivially stable (totalBatches=0)", () => {
    const report = analyzePrefixStability([])
    expect(report.stable).toBe(true)
    expect(report.totalBatches).toBe(0)
    expect(report.totalPositions).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.perPosition).toEqual([])
  })

  test("HELL-CCA-05 — simulated date drift (Today's date line folded into cached prefix) ⇒ caught", () => {
    // Anti-pattern: a caller mistakenly stamps the date into the cached
    // system block instead of routing it through the per-turn user-side
    // <system-reminder>. The analyzer should localize the drift to the
    // exact section so the operator can move the date OUT of the prefix.
    const day1 = snap("system[0]", "You are quanta.\nToday's date is 2026-05-27.", "ephemeral")
    const day2 = snap("system[0]", "You are quanta.\nToday's date is 2026-05-28.", "ephemeral")
    const report = analyzePrefixStability([[day1], [day1], [day2]])
    expect(report.stable).toBe(false)
    const finding = report.findings.find((f) => f.kind === "content")
    expect(finding).toBeDefined()
    expect(finding?.position).toBe("system[0]")
    // Sample carries the actual offending text so the operator can SEE
    // what drifted without running the test in a debugger.
    expect(finding?.firstSample).toContain("2026-05-27")
    expect(finding?.secondSample).toContain("2026-05-28")
  })

  test("HELL-CCA-06 — 4 cache_control breakpoints (Anthropic cap) all tracked independently", () => {
    // Realistic 4-section preset shape from `prompt-sections.ts`:
    //   base + project_md + session_ctx + user_append, each cache:true.
    const positions: ReadonlyArray<readonly CachePrefixSnapshot[]> = [
      [
        snap("base", "BASE", "ephemeral"),
        snap("project_md", "PROJ", "ephemeral"),
        snap("session_ctx", "SESSION", "ephemeral"),
        snap("user_append", "USER", "ephemeral"),
      ],
      [
        snap("base", "BASE", "ephemeral"),
        snap("project_md", "PROJ", "ephemeral"),
        snap("session_ctx", "SESSION", "ephemeral"),
        snap("user_append", "USER", "ephemeral"),
      ],
      [
        snap("base", "BASE", "ephemeral"),
        snap("project_md", "PROJ", "ephemeral"),
        snap("session_ctx", "SESSION-DRIFT", "ephemeral"), // only one drifts
        snap("user_append", "USER", "ephemeral"),
      ],
    ]
    const report = analyzePrefixStability(positions)
    expect(report.stable).toBe(false)
    expect(report.totalPositions).toBe(4)
    const drifted = report.perPosition.filter((p) => !p.stable)
    expect(drifted).toHaveLength(1)
    expect(drifted[0]?.position).toBe("session_ctx")
    // The other 3 stay stable — drift is per-breakpoint, not cascade.
    expect(report.perPosition.filter((p) => p.stable)).toHaveLength(3)
  })

  test("HELL-CCA-07 — sha256 deterministic on 100 KB content (no chunk-size leak)", () => {
    const big = "x".repeat(100 * 1024)
    const a = snap("system[0]", big, "ephemeral")
    const b = snap("system[0]", big, "ephemeral")
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toHaveLength(64)
    // Validate against a one-shot hash to prove the helper is stable.
    expect(a.hash).toBe(sha256Hex(big))
    const report = analyzePrefixStability([[a], [b], [a]])
    expect(report.stable).toBe(true)
    expect(report.findings).toEqual([])
  })

  test("HELL-CCA-08 — missing position between turns ⇒ `missing` finding", () => {
    // A breakpoint declared in turn 0 and turn 1 but dropped in turn 2.
    // This is a real hazard for the sectioned preset: if `repoRules` is
    // present on turn 0 but the caller stops passing it on turn 2, the
    // `project_md` section vanishes and the prefix collapses to 1
    // section — every breakpoint to its right would shift.
    const base = snap("base", "BASE", "ephemeral")
    const proj = snap("project_md", "PROJ", "ephemeral")
    const report = analyzePrefixStability([[base, proj], [base, proj], [base]])
    expect(report.stable).toBe(false)
    const missing = report.findings.find((f) => f.kind === "missing")
    expect(missing).toBeDefined()
    expect(missing?.position).toBe("project_md")
    expect(missing?.secondIndex).toBe(2)
    // base is still in every batch ⇒ stable on its row.
    const baseRow = report.perPosition.find((p) => p.position === "base")
    expect(baseRow?.stable).toBe(true)
  })

  test("HELL-CCA-09 — single batch ⇒ trivially stable + perPosition populated", () => {
    const report = analyzePrefixStability([
      [snap("base", "BASE", "ephemeral"), snap("project_md", "PROJ", undefined)],
    ])
    expect(report.stable).toBe(true)
    expect(report.totalBatches).toBe(1)
    expect(report.totalPositions).toBe(2)
    expect(report.findings).toEqual([])
    // Single-batch case still surfaces marker/missingMarker so the
    // operator can audit a one-shot capture for marker hygiene.
    const baseRow = report.perPosition.find((p) => p.position === "base")
    const projRow = report.perPosition.find((p) => p.position === "project_md")
    expect(baseRow?.anyMarker).toBe(true)
    expect(projRow?.anyMarker).toBe(false)
    expect(projRow?.missingMarker).toBe(true)
  })
})
