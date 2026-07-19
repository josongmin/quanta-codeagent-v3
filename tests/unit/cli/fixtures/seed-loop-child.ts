/**
 * DOF-20 tranche-1 — REAL seed-loop child process for the subprocess /
 * inheritance proof harness (`cli-feature-gate-seed-inheritance.hellgate`).
 *
 * This is NOT a mock. It runs the BYTE-IDENTICAL seed loop that
 * `src/apps/cli/index.ts:48-50` runs at CLI boot:
 *
 *     for (const gate of [...CLI_FEATURE_GATE_NAMES, ...seedEnvVarsForSurface("cli")])
 *       if (process.env[gate] === undefined) process.env[gate] = "1"
 *
 * It imports the SAME two seed sources index.ts imports (so a drift in either
 * source is reflected here — no parallel copy of the gate list), mutates its
 * OWN real `process.env`, then spawns a GRANDCHILD that reads `process.env`
 * WITHOUT re-running the seed. The grandchild's view therefore proves genuine
 * OS-level env inheritance across a process boundary (a mock/in-proc stub
 * could not exhibit this).
 *
 * Protocol:
 *   - argv[2] === "grandchild": this invocation is the grandchild. It does NOT
 *     seed; it just prints its inherited `process.env` view for the probed
 *     gates and exits. This is what proves inheritance.
 *   - otherwise: this is the child. It runs the real seed loop against its own
 *     inherited env, then spawns the grandchild and relays a merged JSON
 *     record { self, child } of gate → value|null for the probed gates.
 *
 * The parent test controls this process's inbound env (unset vs explicit "0")
 * to drive the four proof legs (a) unset⇒"1", (b) explicit "0" preserved,
 * (c) grandchild inheritance, (d) rollback to OFF.
 */

import { CLI_FEATURE_GATE_NAMES } from "@/apps/cli/cli-feature-gates"
import { gateOn } from "@/shared"
import { seedEnvVarsForSurface } from "@/tool"

/** The EXACT union the CLI seed loop iterates (index.ts:48). */
const SEED_UNION: readonly string[] = [
  ...CLI_FEATURE_GATE_NAMES,
  ...seedEnvVarsForSurface("cli"),
]

/** The subset of gate names the parent asked us to report on (comma list in
 *  QUANTA_PROBE_GATES) — keeps the JSON small and the assertions explicit. */
const probed = (): readonly string[] => {
  const raw = (process.env.QUANTA_PROBE_GATES ?? "").trim()
  return raw.length > 0 ? raw.split(",") : [...SEED_UNION]
}

/** A snapshot of env values (null = unset) + gateOn verdict for the probed set. */
const snapshot = (): Record<string, { value: string | null; on: boolean }> => {
  const out: Record<string, { value: string | null; on: boolean }> = {}
  for (const g of probed()) {
    out[g] = { value: process.env[g] ?? null, on: gateOn(process.env as Record<string, string | undefined>, g) }
  }
  return out
}

const runSeedLoop = (): void => {
  // BYTE-IDENTICAL to src/apps/cli/index.ts:48-50.
  for (const gate of SEED_UNION) {
    if (process.env[gate] === undefined) process.env[gate] = "1"
  }
}

const main = (): void => {
  if (process.argv[2] === "grandchild") {
    // Inheritance leg: do NOT seed. Report only what we inherited from the
    // child's (already-seeded) environment across the OS process boundary.
    process.stdout.write(JSON.stringify(snapshot()))
    return
  }

  runSeedLoop()
  const self = snapshot()

  // Spawn a grandchild that inherits THIS process's env (default env pass-through
  // = real OS inheritance). It must NOT re-seed, so it observes ONLY inherited
  // values.
  const proc = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, "grandchild"],
    env: process.env, // real inheritance of the seeded env
    stdout: "pipe",
    stderr: "pipe",
  })
  const childOut = proc.stdout.toString().trim()
  process.stdout.write(JSON.stringify({ self, child: JSON.parse(childOut) }))
}

main()
