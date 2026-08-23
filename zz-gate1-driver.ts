/** Gate 1 driver: build the sentinel predictions + argv with the PRODUCTION
 *  builders, spawn the pinned evaluator, then classify with the production
 *  adapter. No logic is reimplemented here — this is the process boundary
 *  PMX-03 deferred to PMX-04. */
import { readFileSync, writeFileSync } from "node:fs"
import {
  buildProMaxEvaluatorInvocation,
  buildProMaxOfficialGradeReceipt,
  evaluateGoldSentinelGate,
  buildGoldSentinelPatch,
  serializeProMaxPredictions,
} from "@/apps/bench/harness/promax"

const SP = process.argv[2]!
const CAMPAIGN = "pmx7-gold-2026-08-23"
const golden = `${SP}/pmx7-freeze/campaign-golden.json`
const rows = JSON.parse(readFileSync(golden, "utf8")) as Array<{ instance_id: string }>
const ids = rows.map((r) => r.instance_id)
console.log("assigned:", ids.length)

const preds = ids.map((instanceId) => ({
  instanceId,
  modelPatch: buildGoldSentinelPatch(CAMPAIGN),
}))
const ser = serializeProMaxPredictions(preds)
if (!ser.ok) { console.log("PREDICTIONS REFUSED:", JSON.stringify(ser.failures)); process.exit(1) }
const predPath = `${SP}/pmx7-gate1/preds.json`
writeFileSync(predPath, ser.json)
console.log("sentinel patch bytes:", buildGoldSentinelPatch(CAMPAIGN).length)

const inv = buildProMaxEvaluatorInvocation({
  pinnedRoot: `${SP}/pmx7-gate1/pinned`,
  predictionsPath: predPath,
  goldenPath: golden,
  outputPath: `${SP}/pmx7-gate1/pass-rate.json`,
  pythonExecutable: "python3",
})
if (!inv.ok) { console.log("INVOCATION REFUSED:", JSON.stringify(inv.failures)); process.exit(1) }
console.log("argv:", inv.invocation.argv.join(" "))
console.log("cwd :", inv.invocation.cwd)
writeFileSync(`${SP}/pmx7-gate1/argv.json`, JSON.stringify(inv.invocation, null, 2))
