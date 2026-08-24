/**
 * HELLGATE — is the gold-lifecycle machinery REACHABLE in production, and can it
 * become reachable WITHOUT its teardown by accident?
 *
 * `promax-gold-absence-lifecycle.test.ts` proves the executor's BEHAVIOUR: a
 * grader phase materializes the answer key, the teardown removes it, the next
 * chunk's agent phase proves the absence. Every one of those proofs is driven
 * either through the executor directly or through a SYNTHETIC family that
 * differs from ProMax in exactly one respect — it ADMITS boxes.
 *
 * That leaves a question those tests structurally cannot answer, and an
 * independent adversarial audit found the answer is "no":
 *
 *   1. `executeFamilyRemoteBootstrap` has exactly ONE non-test caller, and it
 *      hardcodes `phase: "agent"`. NOTHING in `src/` ever executes the GRADER
 *      phase, so the teardown bound to that call's `finally` never runs.
 *   2. ProMax is the only family declaring a `remoteBootstrap`, and its
 *      `admitBox` unconditionally REFUSES — so the agent-phase absence probe
 *      never fires on a shipped lane either.
 *
 * The machinery is therefore PRODUCTION-INERT. That is a defensible state (the
 * grader phase is the only thing that puts gold on a box, so a grader phase that
 * never runs leaks nothing), but it is NOT the state the module docs described,
 * and it is one `admitBox` edit away from becoming a leak.
 *
 * This file is the rail that makes the inertness impossible to forget:
 *
 *   S1  the DECLARED phase-wiring table is checked against the REAL production
 *       source bytes, so "no production caller runs the grader phase" is an
 *       observed fact, not a comment;
 *   S2  THE COHERENCE CLAUSE — for every SHIPPED family whose declared bootstrap
 *       materializes gold, `admits ⇒ the teardown phase has a production
 *       executor`. Flipping ProMax's `admitBox` to admit while the grader-phase
 *       caller is still absent turns this red;
 *   S3  the operator is TOLD, on the real `--dry-run` production path, that the
 *       declared teardown does not run — so no receipt can cite a defence that
 *       never executes;
 *   S4  the runtime drift guard behind S1 is not decorative.
 *
 * 🔴 SPEND SAFETY. Nothing here provisions, uploads or pulls. The one production
 * root driven end-to-end is `createFullRemoteBackend({ dryRun: true })`, whose
 * injected `spawn` THROWS — reaching it is itself a failure.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { DATASET_FAMILIES, type DatasetFamily } from "@/apps/bench/dataset-family-token"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import {
  assertFamilyBootstrapPhaseWiringInSync,
  bootstrapMaterializesGold,
  FAMILY_BOOTSTRAP_PHASE_WIRING,
  FAMILY_BOOTSTRAP_PHASE_WIRING_KINDS,
  type FamilyBootstrapPhaseWiring,
  FamilyBootstrapWiringError,
  familyBootstrapPhaseIsExecutedInProduction,
  familyBootstrapWiringPlanNotes,
  productionExecutedBootstrapPhases,
} from "@/apps/bench/profiles/bootstrap-phase-wiring"
import { familyPlanNotes } from "@/apps/bench/profiles/plan"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import type { DatasetFamilyProfile } from "@/apps/bench/profiles/types"
import {
  FAMILY_BOOTSTRAP_PHASES,
  type FamilyBootstrapPhase,
  type FamilyRemoteBootstrap,
} from "@/apps/bench/profiles/types"
import { createFullRemoteBackend } from "@/apps/bench/remote/full"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const SRC = join(REPO, "src")

/** The ONE module that defines the executor — excluded from the CALL scan below
 *  (a definition is not a caller) but named so a move is loud. */
const EXECUTOR_MODULE = "apps/bench/remote/box-session/family-bootstrap-exec.ts"
const EXPECTED_CALLER = "apps/bench/remote/box-session/family-box-setup.ts"
/** PMX-04 — the GRADER-phase caller. It appeared when ProMax gained an on-box
 *  grade: the grade runs inside the grader window, so the phase acquired a real
 *  production call site and the teardown bound to it now runs. */
const EXPECTED_GRADER_CALLER = "apps/bench/remote/box-session/family-box-grade.ts"
const EXECUTOR_SYMBOL = "executeFamilyRemoteBootstrap"

// ---------------------------------------------------------------------------
// A CALL-SITE scanner over real source bytes
// ---------------------------------------------------------------------------

interface BootstrapCallSite {
  readonly file: string
  readonly phase: string
}

const listTsFiles = (root: string): readonly string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) {
        walk(abs)
        continue
      }
      if (abs.endsWith(".ts")) out.push(abs)
    }
  }
  walk(root)
  return out
}

/**
 * ONE token: a line comment, a block comment, a quoted/template literal, or a
 * single character.
 *
 * A CALL is code, never prose. Without this tokenizer the scan reads a doc
 * comment that merely QUOTES a call as a call — and, far worse, would count a
 * commented-OUT grader call as a live production caller, which is the precise
 * false positive a reachability rail must never produce.
 *
 * Order matters: the comment alternatives come first, so a `//` that STARTS a
 * comment wins; but once a string literal has matched, a `//` INSIDE it was
 * already consumed and can never be read as a comment.
 */
const TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|[\s\S]/g

const isCommentToken = (token: string): boolean => token.startsWith("//") || token.startsWith("/*")

const blankOut = (token: string): string => token.replace(/[^\n]/g, " ")

const stripComments = (text: string): string =>
  text.replace(TOKEN, (token) => (isCommentToken(token) ? blankOut(token) : token))

/**
 * Comments AND string contents blanked — for asking "does this module refer to
 * the executor IN CODE?". Operator-facing prose that happens to name the symbol
 * (this repo's own dry-run note does) is not a caller, and must not be counted
 * as one; the quotes themselves survive so the text stays parseable.
 */
const stripCommentsAndStrings = (text: string): string =>
  text.replace(TOKEN, (token) => {
    if (isCommentToken(token)) return blankOut(token)
    if (token.length < 2 || !/^["'`]/.test(token)) return token
    return `${token[0]}${blankOut(token.slice(1, -1))}${token[token.length - 1]}`
  })

/** Index of the `}` closing the `{` at `open`, or the end of the text. */
const matchingBraceEnd = (text: string, open: number): number => {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1
    else if (text[i] === "}") {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return text.length - 1
}

/**
 * Extract every `executeFamilyRemoteBootstrap({ … })` call in `text` together
 * with the `phase:` literal it passes.
 *
 * A call whose phase is NOT a literal THROWS rather than being skipped: a
 * scanner that silently ignores what it cannot parse would report "no grader
 * caller" for a caller that passes `phase` through a variable, which is exactly
 * the blindness this rail exists to prevent.
 */
const scanBootstrapCalls = (file: string, source: string): readonly BootstrapCallSite[] => {
  const text = stripComments(source)
  const out: BootstrapCallSite[] = []
  const call = /executeFamilyRemoteBootstrap\s*\(\s*\{/g
  let match = call.exec(text)
  while (match !== null) {
    const open = match.index + match[0].length - 1
    const body = text.slice(open, matchingBraceEnd(text, open) + 1)
    const phase = /\bphase\s*:\s*"(agent|grader|teardown)"/.exec(body)
    if (phase === null) {
      throw new Error(
        `${file}: an executeFamilyRemoteBootstrap call passes a NON-LITERAL phase — this rail ` +
          `cannot classify it, and refusing is the only honest answer: ${body.slice(0, 120)}`,
      )
    }
    out.push({ file, phase: phase[1] ?? "" })
    match = call.exec(text)
  }
  return out
}

/** Every PRODUCTION (non-test) call site under `src/`. */
const productionCallSites = (): readonly BootstrapCallSite[] => {
  const out: BootstrapCallSite[] = []
  for (const abs of listTsFiles(SRC)) {
    const rel = relative(SRC, abs)
    if (rel.endsWith(".test.ts")) continue
    out.push(...scanBootstrapCalls(rel, readFileSync(abs, "utf8")))
  }
  return out
}

// ---------------------------------------------------------------------------
// S1 — the declared table IS what the source does
// ---------------------------------------------------------------------------

describe("S1 — the phase-wiring table is checked against real production bytes", () => {
  test("the scanner is not blind: it FINDS grader/teardown calls where they exist", () => {
    // PAIRED CONTROL. Everything below is an absence claim ("no production
    // caller runs the grader phase"), and an absence claim from a scanner that
    // cannot see is worth nothing. The lifecycle hellgate drives the grader
    // phase directly, so the same extractor must find it there.
    const lifecycle = join(
      REPO,
      "tests/unit/apps/bench/promax/promax-gold-absence-lifecycle.test.ts",
    )
    const found = scanBootstrapCalls("lifecycle", readFileSync(lifecycle, "utf8"))
    expect(found.length).toBeGreaterThanOrEqual(3)
    expect(new Set(found.map((c) => c.phase))).toEqual(new Set(["agent", "grader"]))
  })

  test("the scanner counts CODE only — a commented-out grader call is not a caller", () => {
    // Both directions on one snippet, so "the stripper works" cannot mean "the
    // stripper ate everything".
    const live = `await executeFamilyRemoteBootstrap({ bootstrap, phase: "grader", ssh, log })`
    expect(scanBootstrapCalls("live", live).map((c) => c.phase)).toEqual(["grader"])
    expect(scanBootstrapCalls("commented", `// ${live}`)).toEqual([])
    expect(scanBootstrapCalls("blocked", `/*\n${live}\n*/`)).toEqual([])
    // …and a `//` inside a STRING must not blind the rest of the line.
    expect(
      scanBootstrapCalls("stringy", `const u = "https://x"; ${live}`).map((c) => c.phase),
    ).toEqual(["grader"])
    // The CODE-ONLY variant used by the alias scan: prose that merely names the
    // symbol is not a mention, but a real reference is.
    expect(stripCommentsAndStrings(`const s = "${EXECUTOR_SYMBOL} is unwired"`)).not.toContain(
      EXECUTOR_SYMBOL,
    )
    expect(stripCommentsAndStrings(`const run = ${EXECUTOR_SYMBOL}`)).toContain(EXECUTOR_SYMBOL)
  })

  test("NO ALIAS ESCAPE — only the KNOWN production modules even MENTION the executor", () => {
    // The call scan matches `executeFamilyRemoteBootstrap({`, so a caller that
    // aliased or re-exported the binding (`const run = executeFamilyRemoteBootstrap`)
    // would slip past it. Aliasing requires an import, and an import mentions
    // the name — so pinning the mention set closes that hole without pretending
    // this rail is a type-aware analysis.
    const mentions = listTsFiles(SRC)
      .filter((abs) => !abs.endsWith(".test.ts"))
      .filter((abs) => stripCommentsAndStrings(readFileSync(abs, "utf8")).includes(EXECUTOR_SYMBOL))
      .map((abs) => relative(SRC, abs))
      .sort()
    expect(mentions).toEqual([EXECUTOR_MODULE, EXPECTED_CALLER, EXPECTED_GRADER_CALLER].sort())
  })

  test("KNOWN-ITEM FLOOR — the scan finds the real agent caller, exactly once", () => {
    const calls = productionCallSites()
    expect(calls.filter((c) => c.file === EXPECTED_CALLER && c.phase === "agent")).toHaveLength(1)
    // …and the executor really is defined where the table says, so a move that
    // silently orphaned this rail is red rather than green-by-absence.
    expect(readFileSync(join(SRC, EXECUTOR_MODULE), "utf8")).toContain(
      "export const executeFamilyRemoteBootstrap",
    )
  })

  test("BOTH DIRECTIONS — declared `executed` phases == observed production phases", () => {
    const observed = new Set(productionCallSites().map((c) => c.phase))
    const declared = new Set<string>(productionExecutedBootstrapPhases())
    // Direction 1: nothing is declared executed that production does not run.
    // Direction 2: nothing production runs is left undeclared.
    expect([...declared].sort()).toEqual([...observed].sort())
    // NON-VACUOUS — two empty sets are also equal.
    expect(declared.size).toBeGreaterThan(0)
  })

  test("the table classifies the WHOLE phase union, and does not collapse to one answer", () => {
    expect(Object.keys(FAMILY_BOOTSTRAP_PHASE_WIRING).sort()).toEqual(
      [...FAMILY_BOOTSTRAP_PHASES].sort(),
    )
    const kinds = new Set(
      Object.values(FAMILY_BOOTSTRAP_PHASE_WIRING).map((w: FamilyBootstrapPhaseWiring) => w.kind),
    )
    // Every verdict is a member of the closed kind set…
    for (const kind of kinds) {
      expect(FAMILY_BOOTSTRAP_PHASE_WIRING_KINDS as readonly string[]).toContain(kind)
    }
    // …and a table where every phase got the SAME verdict would prove nothing.
    expect(kinds.size).toBeGreaterThanOrEqual(2)
  })

  test("`teardown` is BOUND to `grader` — its reachability is derived, never stated", () => {
    expect(FAMILY_BOOTSTRAP_PHASE_WIRING.teardown).toEqual({ kind: "bound-to", phase: "grader" })
    // THE DURABLE CLAIM, whatever the grader's wiring becomes: a teardown is
    // reachable exactly when the phase it rides is. Asserted through the
    // predicate over the FULL union, not one literal.
    const executed = Object.fromEntries(
      FAMILY_BOOTSTRAP_PHASES.map((phase) => [
        phase,
        familyBootstrapPhaseIsExecutedInProduction(phase),
      ]),
    )
    expect(executed.teardown).toBe(executed.grader)
    expect(Object.keys(executed).sort()).toEqual([...FAMILY_BOOTSTRAP_PHASES].sort())
    // BOTH ANSWERS of the derivation are exercised on explicit tables, so this
    // is not a single-value narrowing that would pass on a constant `false`.
    const wired: Record<FamilyBootstrapPhase, FamilyBootstrapPhaseWiring> = {
      agent: { kind: "executed", callSite: "x" },
      grader: { kind: "executed", callSite: "y" },
      teardown: { kind: "bound-to", phase: "grader" },
    }
    expect(familyBootstrapPhaseIsExecutedInProduction("teardown", wired)).toBe(true)
    expect(
      familyBootstrapPhaseIsExecutedInProduction("teardown", {
        ...wired,
        grader: { kind: "unwired", owner: "o", why: "w" },
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S2 — THE COHERENCE CLAUSE
// ---------------------------------------------------------------------------

/** The four possible states of a family that materializes gold on a box. */
const LANE_STATES = ["inert", "closed-but-wired", "live", "ADMITS-WITHOUT-A-TEARDOWN"] as const
type LaneState = (typeof LANE_STATES)[number]

const classifyLane = (input: {
  readonly admits: boolean
  readonly teardownExecuted: boolean
}): LaneState => {
  if (input.admits) return input.teardownExecuted ? "live" : "ADMITS-WITHOUT-A-TEARDOWN"
  return input.teardownExecuted ? "closed-but-wired" : "inert"
}

/** Does this profile's admission gate let a box through? Takes the PROFILE (not
 *  a family name) so the probe itself can be paired-controlled against a
 *  deliberately refusing profile. */
const admitsProfile = (profile: Pick<DatasetFamilyProfile, "admitBox">): boolean => {
  try {
    profile.admitBox({ log: () => {} })
    return true
  } catch {
    return false
  }
}

const admits = (family: DatasetFamily): boolean =>
  admitsProfile(resolveDatasetFamilyProfile(family))

const declaredBootstrap = (family: DatasetFamily): FamilyRemoteBootstrap | undefined =>
  familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: family, env: {} }))

describe("S2 — a shipped family cannot start admitting boxes without its teardown", () => {
  test("the classifier is exhaustive — all FOUR combinations are distinct", () => {
    const seen = new Set<LaneState>()
    for (const a of [false, true]) {
      for (const t of [false, true]) seen.add(classifyLane({ admits: a, teardownExecuted: t }))
    }
    expect([...seen].sort()).toEqual([...LANE_STATES].sort())
  })

  test("KNOWN-ITEM FLOOR — exactly one shipped family materializes gold on a box", () => {
    const goldFamilies = DATASET_FAMILIES.filter((family) => {
      const bootstrap = declaredBootstrap(family)
      return bootstrap !== undefined && bootstrapMaterializesGold(bootstrap)
    })
    expect([...goldFamilies]).toEqual(["promax"])
    // …and it really does declare gold-bearing grader work plus a teardown, so
    // the clause below is about something.
    const promax = declaredBootstrap("promax")
    expect(
      promax?.commands.filter((c) => c.phase === "grader" && c.goldBearing).length ?? 0,
    ).toBeGreaterThan(0)
    expect(promax?.commands.filter((c) => c.phase === "teardown").length ?? 0).toBeGreaterThan(0)
  })

  test("🔴 THE CLAUSE — admits ⇒ the teardown phase has a production executor", () => {
    const teardownExecuted = familyBootstrapPhaseIsExecutedInProduction("teardown")
    for (const family of DATASET_FAMILIES) {
      const bootstrap = declaredBootstrap(family)
      if (bootstrap === undefined || !bootstrapMaterializesGold(bootstrap)) continue
      const state = classifyLane({ admits: admits(family), teardownExecuted })
      expect(
        state,
        `${family} admits boxes and materializes answer-key bytes in its grader phase, but NO ` +
          'production caller executes phase="grader" — so the declared teardown never runs and ' +
          "the key survives into the next chunk's agent phase. Wire a grader-phase caller (and " +
          "record it in FAMILY_BOOTSTRAP_PHASE_WIRING) before letting this family admit a box.",
      ).not.toBe("ADMITS-WITHOUT-A-TEARDOWN")
    }
  })

  test("PAIRED CONTROL — `admits()` reports BOTH answers, so the clause can fire", () => {
    // Durable: a probe that always answered `false` would make the clause
    // unfalsifiable. Verified admits; a refusing profile reads as refusing.
    expect(admits("verified")).toBe(true)
    expect(
      admitsProfile({
        admitBox: () => {
          throw new Error("refused")
        },
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TODAY'S STATE — the only assertions a legitimate PMX-04 landing must update
// ---------------------------------------------------------------------------

describe("TODAY'S STATE — the lane is LIVE", () => {
  // Everything above is a durable clause: it stayed green through this change.
  // These are the deliberate state pins, updated HERE together with
  // FAMILY_BOOTSTRAP_PHASE_WIRING — and nowhere else.
  //
  // PMX-04 gave the GRADER phase a production caller: ProMax grades on the box
  // with its own pinned evaluator, and that grade runs inside the grader window
  // (`runFamilyBoxGrade` → `whileMaterialized`). The teardown bound to that call
  // therefore runs too — which is exactly what the S2 clause above requires
  // before a gold-materializing family may admit a box. With that satisfied,
  // admission opened, and the lane is LIVE.

  test("the grader phase now HAS a production caller, and the teardown runs with it", () => {
    // The WHOLE tree, not just the declared table.
    expect(
      productionCallSites()
        .map((c) => `${c.file}:${c.phase}`)
        .sort(),
    ).toEqual(
      [
        `${EXPECTED_CALLER}:agent`,
        // PMX-04 — the grade module ALSO drives the AGENT phase, once per chunk,
        // to re-prove the box is free of the answer key before that chunk's agent
        // runs. The provision-time and warm-attach probes cover only the first
        // chunk on a box; a pool worker runs many through one live session.
        `${EXPECTED_GRADER_CALLER}:agent`,
        `${EXPECTED_GRADER_CALLER}:grader`,
      ].sort(),
    )
    expect([...productionExecutedBootstrapPhases()].sort()).toEqual(["agent", "grader"])
    expect(familyBootstrapPhaseIsExecutedInProduction("grader")).toBe(true)
    // `bound-to` resolves through its host: the teardown has no call site of its
    // own, and that is the point — it cannot be forgotten because it is not
    // separately invocable.
    expect(FAMILY_BOOTSTRAP_PHASE_WIRING.teardown.kind).toBe("bound-to")
    expect(familyBootstrapPhaseIsExecutedInProduction("teardown")).toBe(true)
  })

  test("`unwired` is no longer claimed by any phase — and the kind still exists to be claimed", () => {
    const kinds = new Set(
      Object.values(FAMILY_BOOTSTRAP_PHASE_WIRING).map((w: FamilyBootstrapPhaseWiring) => w.kind),
    )
    // Two kinds in use today. It was three while the grader was unwired; that
    // assertion is updated rather than relaxed, so the table cannot quietly
    // collapse to a single kind without this going red.
    expect([...kinds].sort()).toEqual(["bound-to", "executed"])
    // …and `unwired` is still a member of the closed union, so a future phase
    // CAN be honestly marked as such.
    expect([...FAMILY_BOOTSTRAP_PHASE_WIRING_KINDS]).toContain("unwired")
  })

  test("promax is `live` — it admits boxes AND its teardown has a production executor", () => {
    expect(
      classifyLane({
        admits: admits("promax"),
        teardownExecuted: familyBootstrapPhaseIsExecutedInProduction("teardown"),
      }),
    ).toBe("live")
  })

  test("the inertness note is GONE, because the claim it made is no longer true", () => {
    // It said the declared teardown does not run. It does now, so emitting it
    // would be a receipt citing a defence that had stopped being absent.
    expect(
      familyPlanNotes(resolveBenchRunConfig({ argvFamily: "promax", env: {} })).filter((n) =>
        n.includes(NOTE_MARK),
      ),
    ).toHaveLength(0)
    // PAIRED CONTROL: the emitter is not simply dead — given a table that still
    // calls a phase unwired, it speaks up.
    expect(
      familyBootstrapWiringPlanNotes(declaredBootstrap("promax"), {
        agent: { kind: "executed", callSite: "x" },
        grader: { kind: "unwired", owner: "PMX-04", why: "hypothetical" },
        teardown: { kind: "bound-to", phase: "grader" },
      }).filter((n) => n.includes(NOTE_MARK)),
    ).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// S3 — the operator is told, on the real dry-run production path
// ---------------------------------------------------------------------------

const dryRunPlanFor = async (family: DatasetFamily | undefined): Promise<readonly string[]> => {
  const result = await createFullRemoteBackend({
    repoDir: "/repo",
    authJson: "{}",
    datasetPath: "/does/not/exist.jsonl",
    dryRun: true,
    ...(family !== undefined ? { swebenchDatasetFamily: family } : {}),
    spawn: () => {
      throw new Error("SPEND GUARD: a dry-run must never spawn a process")
    },
    onLog: () => {},
  }).run()
  return result.plan ?? []
}

const NOTE_MARK = "NOT-EXECUTED-IN-PRODUCTION"

/** Is ANY phase of the gold lifecycle currently unreached in production? The
 *  note exists if and only if this is true, so the rail tracks reality instead
 *  of pinning a sentence. */
const lifecycleHasUnreachedPhase = (): boolean =>
  FAMILY_BOOTSTRAP_PHASES.some((phase) => !familyBootstrapPhaseIsExecutedInProduction(phase))

describe("S3 — the dry-run plan states the inertness instead of implying a live defence", () => {
  test("DEFAULT PATH — a promax dry-run says, iff it is true, that the teardown does NOT run", async () => {
    const plan = (await dryRunPlanFor("promax")).join("\n")
    expect(plan.includes(NOTE_MARK)).toBe(lifecycleHasUnreachedPhase())
    if (!lifecycleHasUnreachedPhase()) return
    // It must name WHAT is not executed and WHAT that costs, not just wave.
    expect(plan).toContain("grader")
    expect(plan).toContain("teardown")
    expect(plan).toMatch(/PMX-04/)
  })

  test("PAIRED CONTROL — verified's plan is untouched (no note, byte-identical)", async () => {
    const plan = (await dryRunPlanFor(undefined)).join("\n")
    expect(plan).toContain("dataset-family=verified")
    expect(plan).not.toContain(NOTE_MARK)
  })

  test("the note comes from the SHARED callee both dry-run roots use, and only for promax", () => {
    // `remote/full.ts` and `commands/pool.ts` both call `familyPlanNotes`, so
    // proving it there proves it for the pool root too.
    const promax = familyPlanNotes(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
    expect(promax.filter((n) => n.includes(NOTE_MARK))).toHaveLength(
      lifecycleHasUnreachedPhase() ? 1 : 0,
    )
    for (const family of DATASET_FAMILIES) {
      if (family === "promax") continue
      const notes = familyPlanNotes(resolveBenchRunConfig({ argvFamily: family, env: {} }))
      expect(
        notes.filter((n) => n.includes(NOTE_MARK)),
        `${family} grew the note`,
      ).toEqual([])
    }
  })

  test("the note is derived from the BOOTSTRAP and the TABLE, not from the word `promax`", () => {
    const promax = declaredBootstrap("promax")
    if (promax === undefined) throw new Error("promax must declare a remote bootstrap")
    // Driven against an EXPLICIT unwired table so this stays a test of the
    // derivation rather than of today's production state.
    const unwired: Record<FamilyBootstrapPhase, FamilyBootstrapPhaseWiring> = {
      agent: { kind: "executed", callSite: "x" },
      grader: { kind: "unwired", owner: "OWNER-X", why: "not written" },
      teardown: { kind: "bound-to", phase: "grader" },
    }
    // A family with no gold to materialize gets nothing…
    const plain: FamilyRemoteBootstrap = {
      family: "verified",
      graderWorkers: 1,
      planNotes: [],
      commands: [
        { step: "s", phase: "grader", goldBearing: false, argv: ["true"], purpose: "control" },
      ],
    }
    expect(familyBootstrapWiringPlanNotes(plain, unwired)).toEqual([])
    expect(familyBootstrapWiringPlanNotes(undefined, unwired)).toEqual([])
    // …while the same shape carrying gold does, under ITS OWN family name.
    const renamed: FamilyRemoteBootstrap = { ...promax, family: "live" }
    const notes = familyBootstrapWiringPlanNotes(renamed, unwired)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("live")
    expect(notes[0]).toContain(NOTE_MARK)
    expect(notes[0]).toContain("OWNER-X")
    // …and it counts the teardown commands that will not run.
    const teardowns = promax.commands.filter((c) => c.phase === "teardown").length
    expect(notes[0]).toContain(String(teardowns))
    // PAIRED CONTROL — a FULLY WIRED table produces no note at all, so the note
    // tracks reachability rather than the presence of gold.
    expect(
      familyBootstrapWiringPlanNotes(renamed, {
        ...unwired,
        grader: { kind: "executed", callSite: "y" },
      }),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// S4 — the runtime drift guard behind S1
// ---------------------------------------------------------------------------

/** Build a table with one entry replaced, without touching the real one. */
const withPhase = (
  phase: FamilyBootstrapPhase,
  wiring: FamilyBootstrapPhaseWiring,
): Record<FamilyBootstrapPhase, FamilyBootstrapPhaseWiring> => ({
  ...FAMILY_BOOTSTRAP_PHASE_WIRING,
  [phase]: wiring,
})

describe("S4 — the wiring drift guard is not decorative", () => {
  test("the REAL table passes", () => {
    expect(() => assertFamilyBootstrapPhaseWiringInSync()).not.toThrow()
  })

  test("WIRING PROOF — the executor CALLS the guard, in code, not in a comment", () => {
    // A guard nobody invokes is the exact defect class this whole file exists to
    // report, so it must not be reintroduced by the fix. The call is inside
    // `executeFamilyRemoteBootstrap`, ahead of the `undefined` early return, so
    // it runs for every family on every remote box setup.
    const code = stripComments(readFileSync(join(SRC, EXECUTOR_MODULE), "utf8"))
    const calls = code.match(/assertFamilyBootstrapPhaseWiringInSync\s*\(/g) ?? []
    expect(calls).toHaveLength(1)
    const at = code.indexOf("assertFamilyBootstrapPhaseWiringInSync(")
    const entry = code.indexOf("export const executeFamilyRemoteBootstrap")
    const earlyReturn = code.indexOf("if (bootstrap === undefined) return 0")
    expect(entry).toBeGreaterThanOrEqual(0)
    expect(earlyReturn).toBeGreaterThan(entry)
    expect(at).toBeGreaterThan(entry)
    expect(at).toBeLessThan(earlyReturn)
  })

  test("a `bound-to` pointing at a phase that is itself bound-to is REFUSED (no cycles)", () => {
    expect(() =>
      assertFamilyBootstrapPhaseWiringInSync(
        withPhase("grader", { kind: "bound-to", phase: "teardown" }),
      ),
    ).toThrow(FamilyBootstrapWiringError)
  })

  test("a table where NOTHING is executed is REFUSED (the executor would be dead code)", () => {
    // Built explicitly rather than from the real table, so the claim does not
    // depend on which phases production happens to wire today.
    expect(() =>
      assertFamilyBootstrapPhaseWiringInSync({
        agent: { kind: "unwired", owner: "nobody", why: "removed" },
        grader: { kind: "unwired", owner: "nobody", why: "removed" },
        teardown: { kind: "bound-to", phase: "grader" },
      }),
    ).toThrow(/no production caller executes ANY/)
  })

  test("a phase left unclassified is REFUSED, by name", () => {
    const partial = { ...FAMILY_BOOTSTRAP_PHASE_WIRING } as Record<
      string,
      FamilyBootstrapPhaseWiring
    >
    delete partial.grader
    expect(() =>
      assertFamilyBootstrapPhaseWiringInSync(
        partial as Record<FamilyBootstrapPhase, FamilyBootstrapPhaseWiring>,
      ),
    ).toThrow(/grader/)
  })
})
