/**
 * `tools/dev/with-capability-receipt` — give a lane that is not a shard campaign
 * the capability receipt its gated files read.
 *
 * # The defect
 *
 * Only `run-test-shards.ts` produces a receipt. `test:contract` and
 * `test:real-toolchain` run plain `bun test`, so every receipt-gated file in those
 * lanes answered `blocked-missing` on every host:
 *
 *  - locally, a SILENT GREEN — the gated describes skipped;
 *  - in the CI `contract` job, which sets `REQUIRE_CONTRACT=1`, a RED on a fully
 *    provisioned runner — reproduced with `typescript-language-server` installed:
 *    `[contract] "typescript-language-server" is unavailable but REQUIRE_CONTRACT
 *    is set … 0 pass 1 fail`.
 *
 * Produces the receipt, arms the strictness switch for the ids it answered
 * definitely (see `definiteCapabilityIds`), runs the command, and removes the
 * receipt afterwards.
 *
 * # The probes and the child share one SCRATCH home
 *
 * A probe answers for the environment it ran in, so it must run in the one the
 * consumer sees — and that is NOT the caller's. `tests/setup.ts` (the preload of
 * every `bun test`) moves `HOME`, `QUANTA_HOME` and `QUANTA_PREFS_HOME` to scratch
 * unless they already point there. MEASURED on this host: probed under the real
 * HOME, `lancedb` answered `available`; inside the test, under the fenced HOME,
 * the shim died on `ModuleNotFoundError: No module named 'numpy'` (numpy lives in
 * the user site under the real HOME), and both Lance contracts timed out waiting
 * for it instead of skipping. So this gives the child a scratch home the fence
 * KEEPS, probes under that same home, and removes it afterwards — the shard
 * runner's worker layout, for the same reason.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join, resolve } from "node:path"
import { runBoundedChild } from "./bounded-child"
import { capabilityReceiptEnvForCampaign, type ProbeSpawner } from "./capability-probe-producer"
import {
  CAPABILITY_REQUIRE_ENV,
  definiteCapabilityIds,
  MAX_CAPABILITY_RECEIPT_TTL_MS,
  mergeRequiredCapabilities,
} from "./capability-receipt"
import {
  capabilityReceiptDirectory,
  capabilityReceiptPathFor,
  sweepCapabilityReceipts,
} from "./capability-receipt-files"
import { lendToolchainRoots, toolchainLinks } from "./toolchain-roots"
import { sharedVerificationCacheRoot } from "./verification-receipt"

const REPO_ROOT = resolve(import.meta.dir, "..", "..")

export interface WithCapabilityReceiptInput {
  readonly lane: string
  readonly cmd: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly repoRoot?: string
  /** Injected by the arm, so it does not depend on what this host has installed. */
  readonly spawn?: ProbeSpawner
  readonly onStdout?: (text: string) => void
  readonly onStderr?: (text: string) => void
  /** Ctrl-C and SIGTERM, so the receipt is removed instead of left in the shared cache. */
  readonly signal?: AbortSignal
  /** The real home the probes compare against; injected by the arm. */
  readonly hostHome?: string
  /**
   * Where the receipt goes, and which directory this lane SWEEPS. Required: it
   * defaulted to the clone's shared verification cache, and one arm that did not
   * pass scratch swept the real cache from inside `bun test`. The CLI and the
   * matrix worker pass `sharedVerificationCacheRoot` themselves.
   */
  readonly cacheRoot: string
}

export type CapabilityLaneInput = Pick<
  WithCapabilityReceiptInput,
  "lane" | "env" | "repoRoot" | "spawn" | "hostHome" | "cacheRoot"
>

export interface CapabilityLane {
  /** The child's environment: scratch homes, the receipt's variables, the armed switch. */
  readonly env: Record<string, string>
  /** Removes the receipt and the scratch homes. Idempotent. */
  readonly dispose: () => void
}

/**
 * The receipt, homes and switch a lane's child runs under, without running it.
 *
 * Split out for the verification matrix's worker, which starts `bun test` under
 * its own bound. It spawned with `{ ...process.env }`: no receipt, so every gated
 * consumer answered `blocked-missing` and skipped green, while the shadow matrix
 * exists to be compared with the monolith runner, which gives its workers one.
 */
export const prepareCapabilityLane = async (
  input: CapabilityLaneInput,
): Promise<CapabilityLane> => {
  const repoRoot = input.repoRoot ?? REPO_ROOT
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot, timeout: 10_000 })
    .stdout.toString()
    .trim()
  const cacheRoot = input.cacheRoot
  // What a killed wrapper or campaign could not remove (`capability-receipt-files`).
  sweepCapabilityReceipts({ directory: capabilityReceiptDirectory(cacheRoot), nowMs: Date.now() })
  const outPath = capabilityReceiptPathFor(cacheRoot, input.lane)
  const root = mkdtempSync(join(tmpdir(), `capability-lane-${input.lane}-`))
  const dispose = (): void => {
    rmSync(outPath, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
  const home = join(root, "home")
  const quantaHome = join(home, ".quanta")
  const prefsHome = join(root, "prefs-home")
  try {
    mkdirSync(quantaHome, { recursive: true })
    mkdirSync(prefsHome, { recursive: true })
    // What replacing HOME would hide from the child and its probes alike.
    lendToolchainRoots(toolchainLinks({ home, realHome: input.env.HOME, exists: existsSync }))
    // One base for the probes and the child. An inherited receipt in it is harmless:
    // the produced `receipt.env` always carries all three variables and replaces it.
    const base: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(input.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      HOME: home,
      QUANTA_HOME: quantaHome,
      QUANTA_PREFS_HOME: prefsHome,
    }
    const receipt = await capabilityReceiptEnvForCampaign({
      repoRoot,
      tier: input.lane,
      head,
      outPath,
      probeEnv: base,
      hostHome: input.hostHome ?? userInfo().homedir,
      ttlMs: MAX_CAPABILITY_RECEIPT_TTL_MS,
      // No lane here drives a browser; chrome bring-up would only cost them time.
      includeChrome: false,
      ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
    })
    return {
      env: {
        ...base,
        ...receipt.env,
        [CAPABILITY_REQUIRE_ENV]: mergeRequiredCapabilities(
          base[CAPABILITY_REQUIRE_ENV],
          definiteCapabilityIds(receipt.receipt),
        ),
      },
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}

export const runWithCapabilityReceipt = async (
  input: WithCapabilityReceiptInput,
): Promise<number> => {
  const lane = await prepareCapabilityLane(input)
  try {
    const outcome = await runBoundedChild({
      cmd: input.cmd,
      cwd: input.repoRoot ?? REPO_ROOT,
      env: lane.env,
      limits: { totalMs: 4 * 60 * 60_000, inactivityMs: 12 * 60_000 },
      ...(input.onStdout === undefined ? {} : { onStdout: input.onStdout }),
      ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (outcome.status !== "passed" && outcome.status !== "failed") {
      // A killed child has no exit code, and "1" alone would read as a test failure.
      input.onStderr?.(
        `[capability] lane=${input.lane} child ${outcome.status}` +
          `${outcome.deadline === undefined ? "" : ` (${outcome.deadline} deadline)`}` +
          `${outcome.spawnError === undefined ? "" : `: ${outcome.spawnError}`}\n`,
      )
    }
    return outcome.exitCode ?? 1
  } finally {
    lane.dispose()
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const separator = argv.indexOf("--")
  const lane = argv.find((arg) => arg.startsWith("--lane="))?.slice("--lane=".length)
  const cmd = separator === -1 ? [] : argv.slice(separator + 1)
  if (lane === undefined || lane === "" || cmd.length === 0) {
    process.stderr.write("usage: with-capability-receipt --lane=<id> -- <cmd…>\n")
    process.exit(2)
  }
  const interrupt = new AbortController()
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => interrupt.abort())
  }
  process.exit(
    await runWithCapabilityReceipt({
      lane,
      cmd,
      env: process.env,
      cacheRoot: sharedVerificationCacheRoot(REPO_ROOT),
      onStdout: (text) => process.stdout.write(text),
      onStderr: (text) => process.stderr.write(text),
      signal: interrupt.signal,
    }),
  )
}
