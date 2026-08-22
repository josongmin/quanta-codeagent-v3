/**
 * HELLGATE — dataset-family AUTHORITY rails (aug-22 audit repair).
 *
 * Four load-bearing invariants, all proven BEHAVIORALLY (no source-text regex
 * scan is the primary rail here — the previous scan-only rail could not go red
 * for the actual violation it was named after):
 *
 *  HIGH-1  The typed resolved config is the SOLE in-process authority. Running
 *          the real bench composition root (`runMain`) with an argv family
 *          selector must NOT mutate the ambient `process.env` — env is a WIRE
 *          for a real subprocess/SSH child, never a channel between two
 *          functions in one process.
 *  HIGH-2  Same rail, injection-proof: any in-process ambient write (literal
 *          key, computed key, or the `serializeFamilyForSubprocess(…,
 *          process.env)` helper call) is observable here as a mutated env.
 *  HIGH-3  ONE normalization owner. The lenient (`resolveDatasetFamily`) and
 *          fail-closed (`parseDatasetFamilyOrThrow`) resolvers must AGREE on
 *          every token either of them accepts — disagreement by construction is
 *          impossible because both delegate to `normalizeDatasetFamilyToken`.
 *  LOW-8   The intended, now-explicit whitespace semantics (trim everywhere).
 *
 *  MED-6 / MED-7 are covered end-to-end through the REAL CLI dispatch
 *  (subprocess), not the pure resolver — the pure resolver was already green
 *  while the live path was broken.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDatasetFamily } from "./dataset-family"
import { DATASET_FAMILIES, normalizeDatasetFamilyToken } from "./dataset-family-token"
import { buildSubprocessFamilyEnv, parseDatasetFamilyOrThrow } from "./run-config"
import { applyBenchEnvDefaults } from "./run-main"

const FAMILY_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"

/** Adversarial token table — leading/trailing/inner whitespace, mixed case,
 *  empty, whitespace-only, unknown, near-miss typo. Flowed through BOTH
 *  resolvers in BOTH directions (no vacuous single-literal narrowing). */
const ADVERSARIAL_TOKENS = [
  "pro",
  " pro",
  "pro ",
  "  pro  ",
  "\tpro\n",
  "PRO",
  " Pro ",
  "live",
  " live",
  "LIVE ",
  "verified",
  " VERIFIED ",
  "pr o", // inner whitespace ⇒ NOT a family
  "",
  "   ",
  "prow",
  "bogus",
  "pro,live",
] as const

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-3 + LOW-8 — ONE normalization owner
// ─────────────────────────────────────────────────────────────────────────────
describe("HIGH-3 — one normalization owner: every in-process family resolution agrees", () => {
  test("normalizer is total and non-vacuous over the whole family union", () => {
    // Full union flows through, both directions: every registered family
    // normalizes to ITSELF, and the registry floor is the real one.
    expect([...DATASET_FAMILIES].sort()).toEqual(["live", "pro", "promax", "verified"])
    for (const fam of DATASET_FAMILIES) {
      expect(normalizeDatasetFamilyToken(fam)).toBe(fam)
      expect(normalizeDatasetFamilyToken(`  ${fam.toUpperCase()}  `)).toBe(fam)
    }
    expect(normalizeDatasetFamilyToken("prow")).toBeUndefined()
    expect(normalizeDatasetFamilyToken("")).toBeUndefined()
  })

  test("lenient and fail-closed resolvers agree on EVERY adversarial token", () => {
    for (const raw of ADVERSARIAL_TOKENS) {
      const normalized = normalizeDatasetFamilyToken(raw)
      // argv channel
      const lenientArgv = resolveDatasetFamily(raw, {})
      // env channel — the SAME token must resolve identically through env
      const lenientEnv = resolveDatasetFamily(undefined, { [FAMILY_KEY]: raw })
      expect(lenientArgv, `argv/env channel disagreement for ${JSON.stringify(raw)}`).toBe(
        lenientEnv,
      )
      if (normalized === undefined) {
        // Unknown/blank: the lenient resolver defaults, the fail-closed one REFUSES.
        // That divergence is the DOCUMENTED contract (fail-safe vs fail-closed),
        // and it is total — there is no third outcome.
        expect(lenientArgv, `unknown token ${JSON.stringify(raw)} must default`).toBe("verified")
        expect(() => parseDatasetFamilyOrThrow(raw)).toThrow()
      } else {
        // Known token (in ANY spelling): BOTH resolvers must produce the SAME family.
        expect(
          lenientArgv,
          `resolver split-brain for ${JSON.stringify(raw)}: lenient=${lenientArgv} strict=${parseDatasetFamilyOrThrow(raw)}`,
        ).toBe(parseDatasetFamilyOrThrow(raw))
      }
    }
  })

  test("LOW-8 — whitespace-padded selectors resolve to the family (documented semantics)", () => {
    // The pre-repair behavior: `--dataset-family \" pro\"` validated as Pro in
    // run-config but degraded to Verified in the legacy resolver, so the corpus
    // parse / verifier label / report stamp silently disagreed with the box.
    // Intended semantics, now explicit and covered: trim + case-fold, everywhere.
    for (const padded of [" pro", "pro ", "  PRO  ", "\tlive ", " Verified\n"]) {
      const expected = normalizeDatasetFamilyToken(padded)
      expect(expected).toBeDefined()
      expect(resolveDatasetFamily(padded, {})).toBe(expected!)
      expect(resolveDatasetFamily(undefined, { [FAMILY_KEY]: padded })).toBe(expected!)
      expect(parseDatasetFamilyOrThrow(padded)).toBe(expected!)
    }
  })

  test("LOW-8 — the subprocess WIRE carries an EXPLICITLY-SELECTED family, canonicalized", () => {
    // The launching side encodes the RESOLVED family onto the envelope whenever
    // the operator NAMED one — the encoding no longer has to consult ambient env
    // to decide, which is what removed the bug's habitat (the write condition was
    // why the ambient write existed at all).
    //
    // ⚠️ CORRECTED (aug-22 re-audit R3). This test previously asserted the wire
    // ALWAYS carries the family "including the default", and called that
    // "behaviorally inert". It was not inert: it is a live WIRE-SHAPE change on
    // the default (i.e. every) run. HEAD emitted NO `QUANTA_SWEBENCH_DATASET_FAMILY`
    // key at all for an absent selector — the pool bridge wrote the env var only
    // for a non-empty argv value, and full-remote forwarded ambient env verbatim —
    // so every box command grew a fabricated `='verified'` assignment. The
    // provenance now rides on the typed config, so the encoder reproduces HEAD's
    // shape without re-reading ambient env. See the ABSENT case below.
    for (const fam of DATASET_FAMILIES) {
      const envelope = buildSubprocessFamilyEnv(
        { datasetFamily: fam, familySelector: "explicit" },
        { HOME: "/home/x" },
      )
      expect(envelope[FAMILY_KEY]).toBe(fam)
    }
    // A padded selector reaches the wire CANONICALIZED, so the box can never
    // re-resolve it differently from the launcher.
    const canonical = buildSubprocessFamilyEnv(
      { datasetFamily: parseDatasetFamilyOrThrow("  PRO "), familySelector: "explicit" },
      {},
    )
    expect(canonical[FAMILY_KEY]).toBe("pro")
    expect(resolveDatasetFamily(undefined, canonical)).toBe("pro")
  })

  test("R3 — an ABSENT selector puts NO family key on the wire (HEAD's shape)", () => {
    const envelope = buildSubprocessFamilyEnv(
      { datasetFamily: "verified", familySelector: "absent" },
      { HOME: "/home/x" },
    )
    expect(FAMILY_KEY in envelope).toBe(false)
    expect(envelope[FAMILY_KEY]).toBeUndefined()
    // The rest of the parent env still rides across — this is an omission of ONE
    // key, not a dropped envelope.
    expect(envelope.HOME).toBe("/home/x")
    // The child re-resolves the SAME family from the key-less envelope, which is
    // why omitting it is safe: absent ⇒ the one absent-default owner ⇒ verified.
    expect(resolveDatasetFamily(undefined, envelope)).toBe("verified")
    // PAIRED, and the whole point of keeping the provenance: an EXPLICIT
    // `verified` is a DIFFERENT wire shape from absent, even though both resolve
    // to the same family. A bare-family encoder cannot tell them apart.
    const explicit = buildSubprocessFamilyEnv(
      { datasetFamily: "verified", familySelector: "explicit" },
      { HOME: "/home/x" },
    )
    expect(explicit[FAMILY_KEY]).toBe("verified")
    // …and an absent selector never leaks a stale parent value either way.
    expect(
      buildSubprocessFamilyEnv({ datasetFamily: "pro", familySelector: "absent" }, {})[FAMILY_KEY],
    ).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-1 / HIGH-2 — no ambient env authority channel
// ─────────────────────────────────────────────────────────────────────────────

/** Run a body with `process.argv` pinned and the FULL `process.env` snapshotted
 *  + restored (runMain's dotenv shim writes into ambient env). */
const withArgv = async <T>(argv: readonly string[], body: () => Promise<T>): Promise<T> => {
  const argvBefore = process.argv
  const envBefore = { ...process.env }
  process.argv = ["bun", "cli.ts", ...argv]
  try {
    return await body()
  } finally {
    process.argv = argvBefore
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, envBefore)
  }
}

const noopExit = (): never => undefined as never

describe("HIGH-1/HIGH-2 — the composition root does NOT write family authority into ambient env", () => {
  test("runMain with --dataset-family pro leaves process.env untouched for the family key", async () => {
    const { runMain, __resetBenchExitForTest } = await import("./run-main")
    await withArgv(["run", "--dataset-family", "pro", "--help"], async () => {
      delete process.env[FAMILY_KEY]
      await runMain({ exit: noopExit })
      // RED-on-injection: re-add ANY in-process ambient write (literal key,
      // computed key, or serializeFamilyForSubprocess(…, process.env)) and this
      // observes "pro" instead of undefined.
      expect(process.env[FAMILY_KEY]).toBeUndefined()
    })
    __resetBenchExitForTest()
  })

  test("runMain does not REWRITE an operator-set family env value either", async () => {
    const { runMain, __resetBenchExitForTest } = await import("./run-main")
    await withArgv(["run", "--dataset-family", "pro", "--help"], async () => {
      // Sentinel: an ambient value that DISAGREES with argv. If any in-process
      // code path canonicalizes argv into ambient env, this flips to "pro".
      process.env[FAMILY_KEY] = "  LIVE  "
      await runMain({ exit: noopExit })
      expect(process.env[FAMILY_KEY]).toBe("  LIVE  ")
    })
    __resetBenchExitForTest()
  })

  test("preset seeding takes the family from the TYPED config, not ambient env", () => {
    // The in-process authority round-trip this rail exists to kill:
    //   argv --dataset-family pro → env → preset.ts reads env → Pro preset.
    // With the typed param the preset decision must follow the TYPED family even
    // when ambient env says something else (and must NOT follow ambient env when
    // the typed family says verified).
    const proEnv: Record<string, string | undefined> = {}
    applyBenchEnvDefaults(proEnv, { datasetFamily: "pro" })
    expect(proEnv.QUANTA_BENCH_PRESET).toBe("agentless-v1")

    // Ambient env claims pro, typed config says verified ⇒ typed config wins.
    const conflicting: Record<string, string | undefined> = { [FAMILY_KEY]: "pro" }
    applyBenchEnvDefaults(conflicting, { datasetFamily: "verified" })
    expect(conflicting.QUANTA_BENCH_PRESET).toBe("agentless-v3-thin-strict")

    // And the reverse direction: ambient env says verified, typed says pro.
    const conflicting2: Record<string, string | undefined> = { [FAMILY_KEY]: "verified" }
    applyBenchEnvDefaults(conflicting2, { datasetFamily: "pro" })
    expect(conflicting2.QUANTA_BENCH_PRESET).toBe("agentless-v1")

    // Whole union flows through (live is a non-Pro family ⇒ base preset), and an
    // ambient "pro" cannot flip it.
    const liveEnv: Record<string, string | undefined> = { [FAMILY_KEY]: "pro" }
    applyBenchEnvDefaults(liveEnv, { datasetFamily: "live" })
    expect(liveEnv.QUANTA_BENCH_PRESET).toBe("agentless-v3-thin-strict")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MED-6 / MED-7 — the LIVE CLI dispatch (subprocess), not the pure resolver
// ─────────────────────────────────────────────────────────────────────────────
const CLI = join(import.meta.dir, "cli.ts")

const runCli = (
  args: readonly string[],
  env: Record<string, string> = {},
): { code: number; out: string } => {
  // The family env var must be genuinely ABSENT unless a case sets it — an
  // empty string is itself an explicit-blank selector and would make the
  // terminal refusal pass for the WRONG reason (vacuous green).
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  if (!(FAMILY_KEY in env)) delete childEnv[FAMILY_KEY]
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: childEnv as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  }
}

describe("MED-6 — `quanta-bench terminal --dataset-family` is REFUSED on the live CLI path", () => {
  test("positive control: bare `terminal` still succeeds (rail is not blanket-failing)", () => {
    const r = runCli(["terminal"])
    expect(r.code).toBe(0)
  })

  test("argv --dataset-family on terminal ⇒ non-zero exit + dataset-family error", () => {
    const r = runCli(["terminal", "--dataset-family", "pro"])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/dataset-family/i)
  })

  test("env family on terminal ⇒ non-zero exit (pre-existing rail stays green)", () => {
    const r = runCli(["terminal"], { [FAMILY_KEY]: "pro" })
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/dataset-family|SWE-only/i)
  })
})

describe("MED-7 — `bestk-passk --dataset-family <typo>` fails closed instead of re-grading Verified", () => {
  const fixtureReport = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-bestk-"))
    const report = join(dir, "report.json")
    writeFileSync(report, JSON.stringify({ model: "gpt-5.4", resolved_ids: [] }))
    return report
  }

  test("explicit-unknown family ⇒ non-zero exit, never a silent Verified fallback", () => {
    const report = fixtureReport()
    const r = runCli(
      [
        "bestk-passk",
        "--observe-root",
        "/nonexistent-observe-root",
        "--dataset",
        "/nonexistent.jsonl",
        "--backend",
        "ec2",
        "--report",
        report,
        "--dataset-family",
        "prow",
      ],
      { QUANTA_BENCH_BESTK_PASSK: "1" },
    )
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/unknown dataset family/i)
    expect(r.out).toMatch(/prow/)
  })

  test("positive control: a VALID explicit family gets past the family gate", () => {
    const report = fixtureReport()
    const r = runCli(
      [
        "bestk-passk",
        "--observe-root",
        "/nonexistent-observe-root",
        "--dataset",
        "/nonexistent.jsonl",
        "--backend",
        "ec2",
        "--report",
        report,
        "--dataset-family",
        "pro",
      ],
      { QUANTA_BENCH_BESTK_PASSK: "1" },
    )
    // It fails LATER (missing observe root / dataset), but never on the family.
    expect(r.out).not.toMatch(/unknown dataset family/i)
  })
})
