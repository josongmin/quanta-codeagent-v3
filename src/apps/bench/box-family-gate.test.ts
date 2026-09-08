/**
 * HELLGATE — `quanta-bench box` is a FAMILY-BEARING composition root (aug-22
 * re-audit R1 + R2).
 *
 * WHY THIS FILE EXISTS. `box up` → `provisionBox` → `bootstrapBox` picks the
 * swebench pip-spec / grading shim and runs the family profile's `setupBox`
 * port. Before this repair:
 *
 *   R2 — `commands/box.ts` never parsed or validated `--dataset-family` at all,
 *        so it was the ONE family-bearing subcommand with no fail-closed gate:
 *        `quanta-bench box up --dataset-family prow` provisioned a Verified box
 *        without a word.
 *   R1 — the T2 repair removed `bootstrapBox`'s ambient
 *        `?? process.env.QUANTA_SWEBENCH_DATASET_FAMILY` tail but never threaded
 *        the typed field in from the box command, so an operator who exported
 *        `QUANTA_SWEBENCH_DATASET_FAMILY=pro` (which WORKED at HEAD, via that
 *        tail) silently got a Verified box: wrong pip-spec, wrong shim, no Pro
 *        on-box bootstrap.
 *
 * ⚠️ SPEND SAFETY — READ BEFORE ADDING A CASE. `box up` PROVISIONS A REAL SPOT
 * EC2 BOX. Writing this file's first draft cost three live `c7i.4xlarge` boxes:
 * it spawned the REAL CLI as `box up --dataset-family <garbage>` expecting the
 * (not-yet-implemented) gate to refuse, and instead each spawn ran a full
 * RunInstances. So:
 *   - the child-process cases here use ONLY `box <unknown-action>`, which
 *     reaches the SAME composition-root gate with zero AWS by construction;
 *   - every `up` case runs IN-PROCESS with the `provisionBox` port INJECTED, so
 *     a regressed gate can never spend again — and "the port was never called"
 *     is itself the load-bearing refusal assertion.
 *
 * OBSERVABLES (real effects, never a re-assertion of the resolver):
 *   - the REAL CLI child process: exit status + the operator-facing refusal text;
 *   - the REAL `cmdBox` dispatch in-process: whether the provision port is
 *     reached at all, and what launch config `box up` actually hands it.
 *
 * NON-VACUITY: the full family union flows through the threading test, and the
 * ABSENT case is asserted to be a DISTINCT wire shape (field omitted), so a
 * `cmdBoxUp` that hardcoded any single family fails.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { BoxSession, FullRemoteConfig } from "./remote/box-session/types"

const FAMILY_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"
const CLI = join(import.meta.dir, "cli.ts")
const SPAWN_BUDGET_MS = 240_000

interface CliResult {
  readonly code: number
  readonly out: string
}

/** Spawn the REAL CLI. The family env var is genuinely DELETED unless the case
 *  sets it — an empty string is itself an explicit-blank selector and would make
 *  a refusal pass for the WRONG reason.
 *
 *  ⚠️ Callers MUST NOT pass the `up` action here (see the spend-safety note). */
const runCli = (args: readonly string[], env: Record<string, string> = {}): CliResult => {
  if (args.includes("up")) throw new Error("spend guard: never spawn `box up` in a test")
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

const BAD_SELECTORS = [
  { label: "unknown token", args: ["--dataset-family", "prow"] },
  { label: "empty string", args: ["--dataset-family", ""] },
  { label: "whitespace only", args: ["--dataset-family", "   "] },
  { label: "mixed-case garbage", args: ["--dataset-family", "PrOw"] },
  { label: "=-form unknown", args: ["--dataset-family=prow"] },
  { label: "=-form blank", args: ["--dataset-family="] },
  { label: "dangling flag (no value)", args: ["--dataset-family"] },
] as const

const FAMILY_REFUSAL = /unknown dataset family|is blank|requires a value/i

// ─────────────────────────────────────────────────────────────────────────────
// R2 (a) — the fail-closed gate, on the REAL CLI dispatch (zero AWS)
// ─────────────────────────────────────────────────────────────────────────────
describe("R2 — `box` fails closed on an explicit-invalid dataset-family selector", () => {
  test(
    `box: all ${BAD_SELECTORS.length} adversarial selectors are refused at the root`,
    () => {
      const survivors: string[] = []
      for (const sel of BAD_SELECTORS) {
        const r = runCli(["box", "bogus-action", ...sel.args])
        if (r.code === 0 || !FAMILY_REFUSAL.test(r.out)) {
          survivors.push(
            `${sel.label} (${sel.args.join(" ")}) -> exit ${r.code}: ${r.out.slice(0, 240)}`,
          )
        }
      }
      expect(
        survivors,
        `box accepted an explicit-invalid family selector:\n${survivors.join("\n")}`,
      ).toEqual([])
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "an explicit-invalid family in the ENV is refused too (not just argv)",
    () => {
      const r = runCli(["box", "bogus-action"], { [FAMILY_KEY]: "prow" })
      expect(r.code).not.toBe(0)
      expect(r.out).toMatch(/unknown dataset family/i)
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "the refusal NAMES the offending token and lists the valid ones",
    () => {
      // An operator has to be able to act on the message: a bare "invalid family"
      // does not tell them WHICH of their flags/exports is wrong.
      const r = runCli(["box", "bogus-action", "--dataset-family", "prow"])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain("prow")
      for (const valid of ["verified", "live", "pro", "promax"]) expect(r.out).toContain(valid)
      // PAIRED: a healthy invocation prints no such refusal at all.
      expect(runCli(["box", "bogus-action"]).out).not.toContain("unknown dataset family")
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "PAIRED CONTROL — every VALID family passes the gate (no blanket-failing gate)",
    () => {
      const leaked: string[] = []
      for (const family of ["verified", "live", "pro", "promax"]) {
        const r = runCli(["box", "bogus-action", "--dataset-family", family])
        // Reaches the action dispatch and refuses for its OWN reason (usage),
        // never for the family.
        if (FAMILY_REFUSAL.test(r.out) || !/usage: quanta-bench box/.test(r.out)) {
          leaked.push(`--dataset-family ${family}: exit ${r.code}: ${r.out.slice(0, 240)}`)
        }
        expect(r.code).toBe(2)
      }
      expect(leaked, `family gate mishandled a VALID family:\n${leaked.join("\n")}`).toEqual([])
      // ...and with NO selector at all the root is byte-identically unchanged.
      const absent = runCli(["box", "bogus-action"])
      expect(absent.code).toBe(2)
      expect(absent.out).toMatch(/usage: quanta-bench box/)
      expect(FAMILY_REFUSAL.test(absent.out)).toBe(false)
    },
    SPAWN_BUDGET_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// R1/R2 (b) — the `up` action, driven IN-PROCESS with the provisioner injected
// ─────────────────────────────────────────────────────────────────────────────

interface BoxUpProbe {
  readonly config?: FullRemoteConfig
  readonly provisionCalls: number
  readonly error?: unknown
}

/** Drive the REAL `cmdBox` dispatch with the `provisionBox` port injected, and
 *  capture BOTH whether the port was reached and what launch config `box up`
 *  built. Never touches AWS. */
const driveBoxUp = async (
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<BoxUpProbe> => {
  const { cmdBox } = await import("./commands/box")
  const argvBefore = process.argv
  const envBefore = { ...process.env }
  let config: FullRemoteConfig | undefined
  let provisionCalls = 0
  let error: unknown
  process.argv = ["bun", "cli.ts", "box", ...argv]
  delete process.env[FAMILY_KEY]
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await cmdBox({
      provision: async (cfg: FullRemoteConfig): Promise<BoxSession> => {
        provisionCalls += 1
        config = cfg
        return {
          iid: "i-test",
          ip: "1.2.3.4",
          ssh: async () => ({ code: 0, stdout: "", stderr: "" }),
          scp: async () => ({ code: 0, stdout: "", stderr: "" }),
          terminate: async () => {},
        } as unknown as BoxSession
      },
    })
  } catch (e) {
    error = e
  } finally {
    process.argv = argvBefore
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, envBefore)
  }
  return {
    ...(config !== undefined ? { config } : {}),
    provisionCalls,
    ...(error !== undefined ? { error } : {}),
  }
}

const capturedConfig = async (
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<FullRemoteConfig> => {
  const probe = await driveBoxUp(argv, env)
  if (probe.error !== undefined) throw probe.error
  if (probe.config === undefined) throw new Error("box up never called the provision port")
  return probe.config
}

describe("R2 — `box up` refuses an invalid family BEFORE it provisions anything", () => {
  test("every adversarial selector aborts with the provisioner UNTOUCHED", async () => {
    const survivors: string[] = []
    for (const sel of BAD_SELECTORS) {
      const probe = await driveBoxUp(["up", ...sel.args])
      const msg = probe.error instanceof Error ? probe.error.message : String(probe.error)
      if (probe.error === undefined || !FAMILY_REFUSAL.test(msg)) {
        survivors.push(`${sel.label} -> error=${msg}`)
      }
      // THE load-bearing assertion: an invalid selector must never reach EC2.
      expect(probe.provisionCalls, `${sel.label} still provisioned a box`).toBe(0)
    }
    expect(survivors, `box up accepted an invalid selector:\n${survivors.join("\n")}`).toEqual([])
  })

  test("PAIRED CONTROL — a valid selector DOES reach the provisioner", async () => {
    const probe = await driveBoxUp(["up", "--dataset-family", "pro"])
    expect(probe.error).toBeUndefined()
    expect(probe.provisionCalls).toBe(1)
  })
})

describe("R1 — `box up` threads the TYPED resolved family into provisionBox", () => {
  test("the FULL family union reaches the launch config (argv spelling)", async () => {
    for (const family of ["verified", "live", "pro", "promax"] as const) {
      const cfg = await capturedConfig(["up", "--dataset-family", family])
      expect(cfg.swebenchDatasetFamily, `--dataset-family ${family} was dropped`).toBe(family)
    }
  })

  test("the ENV spelling reaches the launch config (the tail R1 deleted)", async () => {
    // This is EXACTLY the HEAD behaviour the repair broke: `bootstrapBox` read
    // `?? process.env.QUANTA_SWEBENCH_DATASET_FAMILY`, so an exported family
    // configured a Pro/Live box. Dropping the ambient tail without threading the
    // typed field silently downgraded it to Verified.
    for (const family of ["live", "pro"] as const) {
      const cfg = await capturedConfig(["up"], { [FAMILY_KEY]: family })
      expect(cfg.swebenchDatasetFamily, `exported ${FAMILY_KEY}=${family} was dropped`).toBe(family)
    }
    // Canonicalized through the ONE normalization owner, like every other root.
    expect((await capturedConfig(["up"], { [FAMILY_KEY]: "  PRO " })).swebenchDatasetFamily).toBe(
      "pro",
    )
  })

  test("argv BEATS a conflicting env value, in both directions", async () => {
    expect(
      (await capturedConfig(["up", "--dataset-family", "pro"], { [FAMILY_KEY]: "live" }))
        .swebenchDatasetFamily,
    ).toBe("pro")
    expect(
      (await capturedConfig(["up", "--dataset-family", "live"], { [FAMILY_KEY]: "pro" }))
        .swebenchDatasetFamily,
    ).toBe("live")
  })

  test("ABSENT selector ⇒ the field is OMITTED (not a fabricated 'verified')", async () => {
    // The field means "the operator SELECTED this family". Omitted ⇒ absent, which
    // is what keeps the downstream subprocess wire byte-identical to HEAD.
    const cfg = await capturedConfig(["up"])
    expect(cfg.swebenchDatasetFamily).toBeUndefined()
    expect("swebenchDatasetFamily" in cfg).toBe(false)
    // PAIRED: an EXPLICIT `verified` is a different wire shape from absent.
    const explicit = await capturedConfig(["up", "--dataset-family", "verified"])
    expect(explicit.swebenchDatasetFamily).toBe("verified")
  })

  test("box up still launches a warm, KEPT box (the rest of the config is unchanged)", async () => {
    const cfg = await capturedConfig(["up", "--dataset-family", "pro"])
    expect(cfg.launchMode).toBe("warm-box")
    expect(cfg.keep).toBe(true)
  })

  test("ProMax `box up` carries the declared remoteBootstrap onto provision", async () => {
    const cfg = await capturedConfig(["up", "--dataset-family", "promax"])
    expect(cfg.swebenchDatasetFamily).toBe("promax")
    expect(cfg.remoteBootstrap?.family).toBe("promax")
    expect(cfg.remoteBootstrap?.commands.length ?? 0).toBeGreaterThan(0)
  })

  test("verified `box up` does NOT fabricate a remoteBootstrap", async () => {
    const cfg = await capturedConfig(["up", "--dataset-family", "verified"])
    expect(cfg.remoteBootstrap).toBeUndefined()
  })
})
