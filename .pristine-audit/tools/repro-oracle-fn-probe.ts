/**
 * repro-oracle-fn-probe — the ONE gate for "re-enable closure-repair (prometheus loop)".
 *
 * presets.ts:153-159 turned the repair EXECUTOR off with a measured reason
 * (jun-19 wide-12: resolution 9→7 because the repro oracle is a false-NEGATIVE —
 * it does not recognize a correct fix, so repair churns to max rounds). That
 * measurement PREDATES the repro-gen reliability fixes (python-version jun-20,
 * uv --with-editable, sidecar-grounded verdict jun-23), so it is STALE.
 *
 * This probe re-measures the EXACT gate the comment names — does the repro
 * oracle reliably flip `reproduced → resolved` on a KNOWN-correct (gold) patch —
 * WITHOUT a full agent solve loop or official grading:
 *
 *   per instance:
 *     1. generate K repro candidates on the BASE tree (real repro-gen LLM path)
 *     2. keep the ones that REPRODUCE (red on base = a real witness)
 *     3. apply the GOLD patch to a fresh sandbox
 *     4. re-run the reproducing witnesses on the PATCHED tree
 *     5. classify: resolved (oracle correct ✓) | reproduced (oracle FALSE-NEG ✗)
 *                  | exec_failed/other/unknown (oracle broken)
 *
 * Readout decides closure-repair:
 *   - high FLIP rate (gold ⇒ resolved) ⇒ oracle trustworthy ⇒ enable closure-repair,
 *     the prometheus loop should now win.
 *   - high FALSE-NEG (gold stays reproduced) ⇒ oracle still broken ⇒ fixing the
 *     oracle is the precondition; turning the loop on repeats the jun-19 net-neg.
 *   - high NO-REPRO (no witness generated at all) ⇒ the generation problem
 *     (no_reproduced bucket), orthogonal to oracle FN and reported separately.
 *
 * gold is used for ORACLE VALIDATION (measurement), NOT a selection heuristic —
 * the no-answer-key rule forbids gold-derived SELECTION gaming, not gold-grounded
 * measurement.
 *
 * Run (LIVE: clones repos on first touch + K LLM calls/instance; no concurrent bench):
 *   bun run tools/repro-oracle-fn-probe.ts --swebench tests/smoke/swebench/picks-10.jsonl --k 5
 *   [--instance <substr>] [--limit N]
 */

import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tryCreateLLM, pickProvider } from "@/llm/factory"
import { defaultExec, parseSwebenchJsonl, prepareTaskRepo, toInstance } from "@/runner/batch/corpus/dataset"
import type { SwebenchTask } from "@/runner/batch/corpus/dataset"
import { exec } from "@/runner/batch/eval/exec"
import { prepareReproTestDetailed, reproExecBundle } from "@/runner/batch/eval/driver"
import { cleanupSandbox, copyRepo, createSandbox } from "@/runner/batch/eval/sandbox"
import { executeReproTests } from "@/agent/repro-test/execute"
import type { Instance } from "@/runner/batch/types"

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

const PREP_TIMEOUT_MS = 600_000
const EXEC_TIMEOUT_MS = 120_000

const GOLD_PATCH_FILE = ".quanta-gold.patch"

interface InstanceProbe {
  id: string
  /** "no_gold" | "no_repro" | "measured" — coarse status. */
  status: "no_gold" | "no_repro" | "measured" | "error"
  /** # repro candidates that reproduced (red) on base. */
  reproduced: number
  /** Of the reproducing witnesses re-run on the GOLD-patched tree: */
  flipped: number // reproduced → resolved (oracle CORRECT)
  falseNeg: number // stayed reproduced (oracle FALSE-NEGATIVE)
  broken: number // exec_failed / other / unknown (oracle could not judge)
  note?: string
}

/** Generate repro on the BASE tree and return the witnesses that reproduced. */
const witnessesOnBase = async (
  instance: Instance,
  k: number,
  llm: Parameters<typeof prepareReproTestDetailed>[3]["llm"],
): Promise<readonly string[]> => {
  const sandbox = await createSandbox(instance)
  try {
    await copyRepo(instance, sandbox)
    const detailed = await prepareReproTestDetailed(instance, sandbox, k, { llm })
    const samples = detailed.selection?.samples ?? []
    return samples.filter((s) => s.outcome === "reproduced").map((s) => s.source)
  } finally {
    await cleanupSandbox(sandbox)
  }
}

/** Apply gold, re-run the witnesses, and tally the oracle's verdicts. */
const oracleVerdictOnGold = async (
  instance: Instance,
  witnesses: readonly string[],
): Promise<{ flipped: number; falseNeg: number; broken: number; note?: string }> => {
  const sandbox = await createSandbox(instance)
  try {
    await copyRepo(instance, sandbox)
    await Bun.write(join(sandbox, GOLD_PATCH_FILE), instance.goldPatch ?? "")
    const applied = await exec(`git apply --whitespace=nowarn ${GOLD_PATCH_FILE}`, sandbox, EXEC_TIMEOUT_MS, {
      ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
    })
    if (applied.code !== 0) {
      return { flipped: 0, falseNeg: 0, broken: witnesses.length, note: `gold apply failed (${applied.code})` }
    }
    const samples = await executeReproTests({
      tests: witnesses,
      repoRoot: sandbox,
      ...reproExecBundle(instance),
      config: { execTimeoutMs: EXEC_TIMEOUT_MS },
    })
    let flipped = 0
    let falseNeg = 0
    let broken = 0
    for (const s of samples) {
      if (s.outcome === "resolved") flipped++
      else if (s.outcome === "reproduced") falseNeg++
      else broken++
    }
    return { flipped, falseNeg, broken }
  } finally {
    await cleanupSandbox(sandbox)
  }
}

const probeOne = async (
  task: SwebenchTask,
  k: number,
  llm: Parameters<typeof prepareReproTestDetailed>[3]["llm"],
): Promise<InstanceProbe> => {
  const base: InstanceProbe = { id: task.instanceId, status: "error", reproduced: 0, flipped: 0, falseNeg: 0, broken: 0 }
  const work = await mkdtemp(join("/tmp", `repro-fn-${task.instanceId}-`))
  const dest = join(work, "repo")
  try {
    await prepareTaskRepo(task, dest, defaultExec, undefined, PREP_TIMEOUT_MS)
    const instance = toInstance(task, dest)
    if (instance.goldPatch === undefined || instance.goldPatch === "") {
      return { ...base, status: "no_gold" }
    }
    const witnesses = await witnessesOnBase(instance, k, llm)
    if (witnesses.length === 0) {
      return { ...base, status: "no_repro", note: "no candidate reproduced on base (generation gap)" }
    }
    const v = await oracleVerdictOnGold(instance, witnesses)
    return {
      ...base,
      status: "measured",
      reproduced: witnesses.length,
      flipped: v.flipped,
      falseNeg: v.falseNeg,
      broken: v.broken,
      ...(v.note !== undefined ? { note: v.note } : {}),
    }
  } catch (e) {
    return { ...base, status: "error", note: e instanceof Error ? e.message.slice(0, 120) : String(e) }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

const main = async (): Promise<void> => {
  const datasetFile = argValue("--swebench")
  if (datasetFile === undefined) {
    console.error("usage: --swebench <dataset.jsonl> [--k 5] [--instance <substr>] [--limit N]")
    process.exit(2)
  }
  const k = Number(argValue("--k") ?? "5")
  const instanceFilter = argValue("--instance")
  const limit = argValue("--limit") !== undefined ? Number(argValue("--limit")) : undefined

  const provider = pickProvider(process.env)
  const llm = tryCreateLLM(provider, {}, process.env)
  if (!llm) {
    console.error(`no API key for provider "${provider}"`)
    process.exit(2)
  }

  let tasks = parseSwebenchJsonl(await Bun.file(datasetFile).text())
  if (instanceFilter !== undefined && instanceFilter !== "") {
    tasks = tasks.filter((t) => t.instanceId.includes(instanceFilter))
  }
  if (limit !== undefined) tasks = tasks.slice(0, limit)

  console.error(`repro-oracle-fn-probe: ${tasks.length} instance(s), K=${k}, provider=${provider}\n`)

  const results: InstanceProbe[] = []
  for (const task of tasks) {
    process.stderr.write(`▶ ${task.instanceId} … `)
    const r = await probeOne(task, k, llm)
    results.push(r)
    if (r.status === "measured") {
      const verdict = r.flipped > r.falseNeg + r.broken ? "TRUST" : "FN"
      console.error(
        `${verdict} repro=${r.reproduced} flip=${r.flipped} falseNeg=${r.falseNeg} broken=${r.broken}`,
      )
    } else {
      console.error(`${r.status}${r.note ? ` (${r.note})` : ""}`)
    }
  }

  // ---- aggregate ----
  const measured = results.filter((r) => r.status === "measured")
  const totalWit = measured.reduce((a, r) => a + r.reproduced, 0)
  const totalFlip = measured.reduce((a, r) => a + r.flipped, 0)
  const totalFN = measured.reduce((a, r) => a + r.falseNeg, 0)
  const totalBroken = measured.reduce((a, r) => a + r.broken, 0)
  // instance-level: an instance "trusts" the oracle if a majority of its
  // witnesses flip to resolved on gold.
  const trustInst = measured.filter((r) => r.flipped > r.falseNeg + r.broken).length
  const noRepro = results.filter((r) => r.status === "no_repro").length
  const noGold = results.filter((r) => r.status === "no_gold").length
  const errored = results.filter((r) => r.status === "error").length

  const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`)

  console.error(`\n${"=".repeat(60)}\nREPRO ORACLE FN PROBE — readout\n${"=".repeat(60)}`)
  console.error(`instances:        ${results.length}  (measured ${measured.length} | no_repro ${noRepro} | no_gold ${noGold} | error ${errored})`)
  console.error(`\n[generation]  no-repro rate (no witness on base) = ${pct(noRepro, results.length - noGold - errored)}  ← the no_reproduced bucket`)
  console.error(`\n[oracle, witness-level over ${totalWit} witnesses on gold]`)
  console.error(`  FLIP  (reproduced→resolved, oracle CORRECT) = ${totalFlip}  ${pct(totalFlip, totalWit)}`)
  console.error(`  FALSE-NEG (stayed reproduced, oracle WRONG) = ${totalFN}  ${pct(totalFN, totalWit)}`)
  console.error(`  BROKEN (exec_failed/other/unknown)          = ${totalBroken}  ${pct(totalBroken, totalWit)}`)
  console.error(`\n[oracle, instance-level]  trust (majority flip) = ${trustInst}/${measured.length}  ${pct(trustInst, measured.length)}`)
  console.error(`\nDECISION: closure-repair (prometheus loop) is safe to re-enable iff oracle FLIP`)
  console.error(`is high and FALSE-NEG is low. High FALSE-NEG ⇒ fix the oracle first (jun-19 net-neg repeats).`)

  // machine-readable line for piping
  console.log(JSON.stringify({ flip: totalFlip, falseNeg: totalFN, broken: totalBroken, witnesses: totalWit, trustInst, measured: measured.length, noRepro, noGold, errored }))
}

void main()
