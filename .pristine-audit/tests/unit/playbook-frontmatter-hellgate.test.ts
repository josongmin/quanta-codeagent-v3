/**
 * Hellgate — user-authored playbook frontmatter (ADR-0203).
 *
 * 16 cases pinning the extended frontmatter + validator + macro registry +
 * inline-trigger watcher contract. Tests cover:
 *
 *  - HELL-PB-01  default-OFF byte-identical (empty fm == legacy)
 *  - HELL-PB-02  procedure/success-criteria/forbidden-actions full parse
 *  - HELL-PB-03  malformed YAML surfaces typed error with line number
 *  - HELL-PB-04  unterminated frontmatter rejected
 *  - HELL-PB-05  wrong shapes (procedure as string, macros as list) rejected
 *  - HELL-PB-06  macro name kebab-case enforced
 *  - HELL-PB-07  forbidden-actions HARD_DENY case-insensitive substring match
 *  - HELL-PB-08  forbidden-actions empty list ⇒ default-permit
 *  - HELL-PB-09  macro registry lookup hit + miss
 *  - HELL-PB-10  expandStep handles bare ref, escape, suffix-bang, repeat
 *  - HELL-PB-11  expandProcedure aggregates missing dedup
 *  - HELL-PB-12  file > 12KB rejected (PLAYBOOK_MAX_BYTES cap)
 *  - HELL-PB-13  inline-trigger watcher debounce coalesces same-path fires
 *  - HELL-PB-14  inline-trigger glob filters paths
 *  - HELL-PB-15  inline-trigger missing root yields typed ok:false
 *  - HELL-PB-16  repo-rules port is READ-ONLY (validator verdict invariant)
 */

import { describe, expect, test } from "bun:test"
import {
  buildMacroRegistry,
  createInlineTriggerWatcher,
  createMemoryWatcher,
  evaluatePlaybookAction,
  expandProcedure,
  expandStep,
  findMarkerLine,
  inMemoryRepoRules,
  isPlaybookExtended,
  matchesGlobSubset,
  PLAYBOOK_MAX_BYTES,
  PlaybookParseError,
  parsePlaybookFrontmatter,
  repoRulesMentions,
} from "@/skill/playbook"

describe("playbook frontmatter hellgate (ADR-0203)", () => {
  test("HELL-PB-01: empty frontmatter parses byte-identical to legacy (default-OFF)", () => {
    const noFm = parsePlaybookFrontmatter("# just markdown\n\nbody only")
    expect(noFm.ok).toBe(true)
    if (!noFm.ok) throw new Error("unreachable")
    expect(noFm.value).toEqual({})
    expect(isPlaybookExtended(noFm.value)).toBe(false)

    // A frontmatter that ONLY declares legacy-style fields the parser
    // doesn't recognize is also byte-identical (unknown keys ignored).
    const legacyOnly = parsePlaybookFrontmatter(
      `---
name: my-skill
description: legacy
---

body`,
    )
    expect(legacyOnly.ok).toBe(true)
    if (!legacyOnly.ok) throw new Error("unreachable")
    expect(legacyOnly.value).toEqual({})
    expect(isPlaybookExtended(legacyOnly.value)).toBe(false)
  })

  test("HELL-PB-02: full 4-field + trigger parse", () => {
    const src = `---
name: deploy-staging
description: ship a build to the staging env
procedure:
  - "build the bundle"
  - "run smoke suite"
  - "ship to staging"
success-criteria:
  - "smoke suite passes"
  - "rollout health green for 5m"
forbidden-actions:
  - "push to prod"
  - "rm -rf"
macros:
  abort: "stop and report"
  retry: "rerun the last step"
trigger:
  comment-marker: "QUANTA!"
  watch-glob: "**/*.{ts,py}"
---

body here`
    const r = parsePlaybookFrontmatter(src)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.procedure).toEqual(["build the bundle", "run smoke suite", "ship to staging"])
    expect(r.value.successCriteria).toEqual(["smoke suite passes", "rollout health green for 5m"])
    expect(r.value.forbiddenActions).toEqual(["push to prod", "rm -rf"])
    expect(r.value.macros).toEqual([
      { name: "abort", expansion: "stop and report" },
      { name: "retry", expansion: "rerun the last step" },
    ])
    expect(r.value.trigger).toEqual({
      commentMarker: "QUANTA!",
      watchGlob: "**/*.{ts,py}",
    })
    expect(isPlaybookExtended(r.value)).toBe(true)
  })

  test("HELL-PB-03: malformed yaml surfaces typed error with line number", () => {
    const src = `---
procedure:
  - "step 1"
   bad indent: oops
---

body`
    const r = parsePlaybookFrontmatter(src)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error).toBeInstanceOf(PlaybookParseError)
    expect(r.error.line).toBeGreaterThan(0)
  })

  test("HELL-PB-04: unterminated frontmatter rejected", () => {
    const src = `---
procedure:
  - step

body without closing fence`
    const r = parsePlaybookFrontmatter(src)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.message).toContain("unterminated")
  })

  test("HELL-PB-05: wrong shapes rejected (procedure-as-string, macros-as-list, trigger-as-string)", () => {
    const procStr = parsePlaybookFrontmatter(`---
procedure: "not a list"
---

body`)
    expect(procStr.ok).toBe(false)
    if (procStr.ok) throw new Error("unreachable")
    expect(procStr.error.message).toContain("procedure")

    const macrosList = parsePlaybookFrontmatter(`---
macros:
  - abort
  - retry
---

body`)
    expect(macrosList.ok).toBe(false)

    const triggerStr = parsePlaybookFrontmatter(`---
trigger: "just a marker"
---

body`)
    expect(triggerStr.ok).toBe(false)

    const triggerNoMarker = parsePlaybookFrontmatter(`---
trigger:
  watch-glob: "**/*.ts"
---

body`)
    expect(triggerNoMarker.ok).toBe(false)
    if (triggerNoMarker.ok) throw new Error("unreachable")
    expect(triggerNoMarker.error.message).toContain("comment-marker")

    const triggerNoGlob = parsePlaybookFrontmatter(`---
trigger:
  comment-marker: "X!"
---

body`)
    expect(triggerNoGlob.ok).toBe(false)
    if (triggerNoGlob.ok) throw new Error("unreachable")
    expect(triggerNoGlob.error.message).toContain("watch-glob")
  })

  test("HELL-PB-06: macro name kebab-case enforced (Underscore, Caps, leading-dash rejected)", () => {
    for (const bad of ["My_Macro", "Abort", "-leading-dash", "trailing space", "with.dot"]) {
      const r = parsePlaybookFrontmatter(`---
macros:
  ${JSON.stringify(bad)}: "stop and report"
---

body`)
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error(`should have rejected '${bad}'`)
      expect(r.error.message).toMatch(/macro name|kebab-case|mapping/)
    }
  })

  test("HELL-PB-07: forbidden-actions HARD_DENY case-insensitive substring match", () => {
    const fm = {
      forbiddenActions: ["push to prod", "rm -rf"],
    }
    const v1 = evaluatePlaybookAction(fm, 'Bash("git push to PROD --force")')
    expect(v1.ok).toBe(false)
    if (v1.ok) throw new Error("unreachable")
    expect(v1.reason.forbidden).toBe("push to prod")
    expect(v1.reason.matchedIn).toContain("PROD")

    const v2 = evaluatePlaybookAction(fm, 'Bash("rm -rf /tmp/foo")')
    expect(v2.ok).toBe(false)

    // First-hit short-circuit — only one needle matched.
    const v3 = evaluatePlaybookAction(fm, "git push to prod and rm -rf")
    expect(v3.ok).toBe(false)
    if (v3.ok) throw new Error("unreachable")
    expect(v3.reason.forbidden).toBe("push to prod")
  })

  test("HELL-PB-08: empty/undefined forbidden-actions ⇒ default-permit", () => {
    expect(evaluatePlaybookAction({}, "anything").ok).toBe(true)
    expect(evaluatePlaybookAction({ forbiddenActions: [] }, "anything").ok).toBe(true)
    // Mix of empty + real needles: empty needles skipped, real needles still fire.
    const v = evaluatePlaybookAction({ forbiddenActions: ["", "deploy"] }, "do deploy now")
    expect(v.ok).toBe(false)
    if (v.ok) throw new Error("unreachable")
    expect(v.reason.forbidden).toBe("deploy")
  })

  test("HELL-PB-09: macro registry lookup hit + miss", () => {
    const registry = buildMacroRegistry([
      { name: "abort", expansion: "stop and report" },
      { name: "retry", expansion: "rerun the last step" },
    ])
    expect(registry.size()).toBe(2)
    expect(registry.has("abort")).toBe(true)
    expect(registry.has("nope")).toBe(false)

    const hit = registry.lookup("abort")
    expect(hit.ok).toBe(true)
    if (!hit.ok) throw new Error("unreachable")
    expect(hit.expansion).toBe("stop and report")

    const miss = registry.lookup("nope")
    expect(miss.ok).toBe(false)
    if (miss.ok) throw new Error("unreachable")
    expect(miss.reason).toBe("not-found")
    expect(miss.name).toBe("nope")

    const empty = buildMacroRegistry(undefined)
    expect(empty.size()).toBe(0)
    expect(empty.lookup("anything").ok).toBe(false)
  })

  test("HELL-PB-10: expandStep handles bare ref, escape, suffix-bang, repeat", () => {
    const registry = buildMacroRegistry([
      { name: "abort", expansion: "STOP" },
      { name: "retry", expansion: "AGAIN" },
    ])

    // Bare ref + resolved
    const a = expandStep("On error, !abort and notify.", registry)
    expect(a.text).toBe("On error, STOP and notify.")
    expect(a.resolved).toEqual(["abort"])
    expect(a.missing).toEqual([])

    // Escape preserves literal
    const b = expandStep("Do not \\!abort the pipeline.", registry)
    expect(b.text).toBe("Do not !abort the pipeline.")
    expect(b.resolved).toEqual([])
    expect(b.missing).toEqual([])

    // Suffix-bang is NOT a macro
    const c = expandStep("foo!retry", registry)
    expect(c.text).toBe("foo!retry")
    expect(c.resolved).toEqual([])

    // Repeat de-duped in `resolved`
    const d = expandStep("!abort or !abort again", registry)
    expect(d.text).toBe("STOP or STOP again")
    expect(d.resolved).toEqual(["abort"])

    // Missing ref left verbatim + recorded
    const e = expandStep("!nope and !abort", registry)
    expect(e.text).toBe("!nope and STOP")
    expect(e.missing).toEqual(["nope"])
    expect(e.resolved).toEqual(["abort"])
  })

  test("HELL-PB-11: expandProcedure aggregates missing macros across steps (deduped)", () => {
    const registry = buildMacroRegistry([{ name: "ok", expansion: "GOOD" }])
    const out = expandProcedure(
      ["step1 !ok", "step2 !nope", "step3 !ok and !nope and !missing"],
      registry,
    )
    expect(out.steps).toHaveLength(3)
    expect(out.steps[0]?.text).toBe("step1 GOOD")
    expect(out.steps[1]?.text).toBe("step2 !nope")
    expect(out.steps[2]?.text).toBe("step3 GOOD and !nope and !missing")
    expect(out.missing).toEqual(["nope", "missing"])

    // Empty procedure: empty result
    const empty = expandProcedure([], registry)
    expect(empty.steps).toEqual([])
    expect(empty.missing).toEqual([])

    const undefProc = expandProcedure(undefined, registry)
    expect(undefProc.steps).toEqual([])
    expect(undefProc.missing).toEqual([])
  })

  test("HELL-PB-12: file > PLAYBOOK_MAX_BYTES rejected with typed error", () => {
    const tooBig = "x".repeat(PLAYBOOK_MAX_BYTES + 1)
    const r = parsePlaybookFrontmatter(tooBig)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.message).toContain("playbook cap")
    expect(r.error.line).toBe(1)

    // Just at the cap: parser proceeds (the rest fails because the giant
    // string is not valid yaml — but the cap itself is not what tripped).
    const atCap = "x".repeat(PLAYBOOK_MAX_BYTES)
    const r2 = parsePlaybookFrontmatter(atCap)
    expect(r2.ok).toBe(true) // no fence ⇒ treated as body-only
  })

  test("HELL-PB-13: memory watcher debounce coalesces same-path fires", () => {
    let clock = 1_000_000
    const tick = (ms: number): void => {
      clock += ms
    }
    const fires: string[] = []
    const mw = createMemoryWatcher(() => clock)
    const start = mw.start({
      playbookId: "deploy-staging",
      root: "/whatever",
      trigger: { commentMarker: "AI!", watchGlob: "**/*.ts" },
      onFire: (f) => fires.push(`${f.path}@L${f.line}`),
      debounceMs: 250,
    })
    expect(start.ok).toBe(true)
    if (!start.ok) throw new Error("unreachable")
    expect(mw.active()).toBe(1)

    expect(mw.fire("src/foo.ts", "// fix this AI!\nconst x = 1\n")).toBe(true)
    // Within debounce ⇒ ignored
    tick(50)
    expect(mw.fire("src/foo.ts", "// fix this AI!\nupdated\n")).toBe(false)
    // After debounce ⇒ refires
    tick(300)
    expect(mw.fire("src/foo.ts", "// AI! still here\n")).toBe(true)
    expect(fires).toHaveLength(2)
    expect(fires[0]).toBe("src/foo.ts@L1")
    expect(fires[1]).toBe("src/foo.ts@L1")

    // Different path is independent of the debounce timer
    expect(mw.fire("src/bar.ts", "AI!")).toBe(true)
    expect(fires).toHaveLength(3)

    // Stop ⇒ no further fires
    start.handle.stop()
    expect(start.handle.isStopped()).toBe(true)
    expect(mw.active()).toBe(0)
    expect(mw.fire("src/baz.ts", "AI!")).toBe(false)
  })

  test("HELL-PB-14: inline-trigger glob filters out non-matching paths", () => {
    expect(matchesGlobSubset("src/foo.ts", "**/*.ts")).toBe(true)
    expect(matchesGlobSubset("src/foo.py", "**/*.ts")).toBe(false)
    expect(matchesGlobSubset("src/foo.ts", "**/*.{ts,py}")).toBe(true)
    expect(matchesGlobSubset("src/foo.py", "**/*.{ts,py}")).toBe(true)
    expect(matchesGlobSubset("src/foo.md", "**/*.{ts,py}")).toBe(false)
    expect(matchesGlobSubset("README.md", "*.md")).toBe(true)
    expect(matchesGlobSubset("docs/README.md", "*.md")).toBe(false)

    // findMarkerLine: 1-based, empty marker rejected
    expect(findMarkerLine("hello AI!\nworld", "AI!")).toBe(1)
    expect(findMarkerLine("hello\nworld AI!", "AI!")).toBe(2)
    expect(findMarkerLine("nothing here", "AI!")).toBe(-1)
    expect(findMarkerLine("hello", "")).toBe(-1)
  })

  test("HELL-PB-15: real fs watcher rejects missing/non-dir root with typed reason", () => {
    const w = createInlineTriggerWatcher()
    const missing = w.start({
      playbookId: "x",
      root: "/this/path/does/not/exist/abc123",
      trigger: { commentMarker: "AI!", watchGlob: "**/*" },
      onFire: () => {},
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error("unreachable")
    expect(missing.reason).toBe("root-not-found")

    // A regular file (not a directory) ⇒ root-not-dir
    const filePath = `${import.meta.dir}/playbook-frontmatter-hellgate.test.ts`
    const notDir = w.start({
      playbookId: "x",
      root: filePath,
      trigger: { commentMarker: "AI!", watchGlob: "**/*" },
      onFire: () => {},
    })
    expect(notDir.ok).toBe(false)
    if (notDir.ok) throw new Error("unreachable")
    expect(notDir.reason).toBe("root-not-dir")
  })

  test("HELL-PB-16: repo-rules read-only — validator verdict does NOT change", () => {
    const reader = inMemoryRepoRules("# Repo rules\nDo NOT push to prod under any circumstances.\n")
    // Verdict is determined by the playbook's forbidden-actions; the repo
    // rules port is consulted ONLY by the cross-check helper.
    const fm = { forbiddenActions: ["push to prod"] }
    const v = evaluatePlaybookAction(fm, "git push to prod", reader)
    expect(v.ok).toBe(false)
    if (v.ok) throw new Error("unreachable")
    expect(v.reason.forbidden).toBe("push to prod")

    // Cross-check helper is independent from the verdict.
    expect(repoRulesMentions(reader, "push to prod")).toBe(true)
    expect(repoRulesMentions(reader, "format the disk")).toBe(false)
    expect(repoRulesMentions(undefined, "anything")).toBe(false)
    expect(repoRulesMentions(inMemoryRepoRules(undefined), "anything")).toBe(false)

    // Per the read-only invariant: even if repo-rules MENTION an action,
    // the playbook's empty forbidden list still permits.
    const permissive = { forbiddenActions: [] }
    expect(evaluatePlaybookAction(permissive, "git push to prod", reader).ok).toBe(true)
  })
})
