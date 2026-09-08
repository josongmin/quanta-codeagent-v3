/**
 * LEAF — FRESH-BOX bootstrap PHASE executor. Extracted from `ec2-lifecycle.ts`
 * (G-F5 + 900-line cohort split).
 *
 * Order is the contract, not a comment:
 *   1. common prerequisites (rsync src/config, bun install, phantom deps)
 *   2. optional swebench grader shim (ONLY families that use the swebench harness)
 *   3. ALWAYS family setup (`setupBoxForFamily`)
 *   4. profile readiness (pyright launch-proof + the same probe warm selection uses)
 *
 * `boxGrade` means skip the SHIM, never skip family setup. Returning early
 * because a family grades in its own grader phase is the G-F5 P1.
 */
import { familyRequiresSwebenchShim } from "../../profiles/family-box-readiness"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"
import { datasetFamilyOrDefault } from "../../run-config"
import { PHANTOM_DEPS } from "./auth"
import { assertFamilyAdmitsBox, setupBoxForFamily } from "./family-box-setup"
import { assertBoxProfileReady } from "./profile-readiness"
import { verifyPyrightGrounding } from "./pyright-grounding"
import { BENCH_SSH_SAFE_OPTS, shq } from "./shell"
import { buildSrcRsyncArgs } from "./src-sync-guard"
import { type BoxSession, D, type FullRemoteConfig } from "./types"

/** The grading-shim file body. `shq` the spec (not bare single-quotes): QUANTA_SWEBENCH_PIP_SPEC
 *  is operator-controlled and a value with a `'` would break out of the quoting. The exact
 *  `--from ${shq(spec)} ` token is what {@link ensureBoxSwebenchShimCurrent} matches to detect
 *  a stale shim on a reused box. Pure + exported for unit test. */
export const buildSwebenchShim = (pipSpec: string): string =>
  `#!/usr/bin/env bash\nexec "$HOME/.local/bin/uvx" --from ${shq(pipSpec)} --python 3.11 --quiet python "$@"\n`

const sshOptsFor = (keyPath: string): string =>
  `ssh -i ${keyPath} ${BENCH_SSH_SAFE_OPTS.join(" ")} -o ConnectTimeout=15 -o ServerAliveInterval=15`

const syncBoxWorkspace = async (session: BoxSession, cfg: FullRemoteConfig): Promise<void> => {
  const { host, keyPath, spawn, log } = session
  const ssh = session.ssh.bind(session)
  log(
    "[full-remote] bootstrapped. Syncing src/ + config (SURGICAL — the monorepo's apps/crates/native are GBs and the bench needs only src)…",
  )
  // Same host-key/safety posture as makeSsh (SSOT) so the rsync transport
  // connects identically to the readiness/grade ssh — a recycled-IP stale key
  // must not refuse the rsync after readiness already succeeded.
  const sshOpts = sshOptsFor(keyPath)
  await ssh("mkdir -p ~/quanta")
  // SSOT excludes/argv shared with the reuse self-heal (src-sync-guard) so the
  // seed-sync and the verify-sync can never diverge. No opts ⇒ byte-identical to
  // the historical bootstrap rsync.
  const rsynced = await spawn("rsync", buildSrcRsyncArgs(cfg.repoDir, host, sshOpts))
  if (rsynced.code !== 0) {
    throw new Error(`[full-remote] rsync src failed (code ${rsynced.code}): ${rsynced.stderr}`)
  }
  const scpCfg = await spawn("scp", [
    "-i",
    keyPath,
    ...BENCH_SSH_SAFE_OPTS,
    "-o",
    "ConnectTimeout=15",
    `${cfg.repoDir}/package.json`,
    `${cfg.repoDir}/bun.lock`,
    `${cfg.repoDir}/tsconfig.json`,
    `${cfg.repoDir}/tsconfig.base.json`,
    `${cfg.repoDir}/bunfig.toml`,
    `${host}:~/quanta/`,
  ])
  if (scpCfg.code !== 0) {
    throw new Error(`[full-remote] scp config failed (code ${scpCfg.code}): ${scpCfg.stderr}`)
  }
}

const installBoxPackages = async (session: BoxSession): Promise<void> => {
  const ssh = session.ssh.bind(session)
  const { log } = session
  log("[full-remote] synced src + config; running bun install on box (full deps, ~1-2min)…")
  // `set -o pipefail` so a FAILED install propagates through the `tail`.
  const installed = await ssh(
    "set -o pipefail; cd ~/quanta && ~/.bun/bin/bun install 2>&1 | tail -25",
  )
  if (installed.code !== 0) {
    throw new Error(
      `[full-remote] bun install failed (code ${installed.code}):\n${installed.stdout}${installed.stderr}`,
    )
  }
  // PHANTOM DEPS: packages imported by src/ but undeclared in package.json.
  const phantoms = PHANTOM_DEPS.join(" ")
  log(`[full-remote] installing phantom deps (undeclared in package.json): ${phantoms}…`)
  const added = await ssh(
    `set -o pipefail; cd ~/quanta && ~/.bun/bin/bun add ${phantoms} 2>&1 | tail -15`,
  )
  if (added.code !== 0) {
    throw new Error(
      `[full-remote] bun add (phantom deps) failed (code ${added.code}):\n${added.stdout}${added.stderr}`,
    )
  }
}

/** Optional swebench shim. `familyRequiresSwebenchShim` is the gate — `boxGrade`
 *  skips THIS phase only. Never `return` from the whole bootstrap here. */
const maybeWriteSwebenchShim = async (
  session: BoxSession,
  cfg: FullRemoteConfig,
): Promise<void> => {
  const ssh = session.ssh.bind(session)
  const { log } = session
  const family = datasetFamilyOrDefault(cfg.swebenchDatasetFamily)
  const profile = resolveDatasetFamilyProfile(family)
  if (!familyRequiresSwebenchShim(profile)) {
    log(
      "[full-remote] dataset-family grades with its own pinned evaluator — SKIPPING the swebench " +
        "grading shim + uvx warm (neither is its grader).",
    )
    return
  }
  const swebenchPipSpec = profile.harnessSpec({
    datasetName: cfg.swebenchDatasetName ?? process.env.QUANTA_SWEBENCH_DATASET_NAME ?? "",
    pipSpecOverride: cfg.swebenchPipSpec ?? process.env.QUANTA_SWEBENCH_PIP_SPEC,
  }).pipSpec
  log(
    `[full-remote] creating swebench-python shim + warming uvx cache (from=${swebenchPipSpec}, first pull ~30-60s)…`,
  )
  const shim = buildSwebenchShim(swebenchPipSpec)
  const wrote = await ssh("cat > ~/swebench-python && chmod +x ~/swebench-python", shim)
  if (wrote.code !== 0) {
    throw new Error(
      `[full-remote] writing swebench-python shim failed (code ${wrote.code}): ${wrote.stderr}`,
    )
  }
  const warm = await ssh(
    'set -o pipefail; ~/swebench-python -c "import swebench; print(swebench.__version__)" 2>&1 | tail -3',
  )
  if (warm.code !== 0) {
    throw new Error(
      `[full-remote] swebench toolchain warm failed (code ${warm.code}):\n${warm.stdout}${warm.stderr}`,
    )
  }
}

/**
 * The reusable bootstrap surface: rsync src + config, bun install, phantom deps,
 * optional swebench shim, ALWAYS family setup, then profile readiness. Runs on a
 * ready box; throws on any hard failure (caller terminates).
 */
export const bootstrapBox = async (session: BoxSession, cfg: FullRemoteConfig): Promise<void> => {
  const ssh = session.ssh.bind(session)
  const family = datasetFamilyOrDefault(cfg.swebenchDatasetFamily)
  assertFamilyAdmitsBox({ family, log: session.log })
  await syncBoxWorkspace(session, cfg)
  await installBoxPackages(session)
  await maybeWriteSwebenchShim(session, cfg)
  await setupBoxForFamily({
    family,
    ...(cfg.remoteBootstrap !== undefined ? { bootstrap: cfg.remoteBootstrap } : {}),
    ssh: (cmd) => ssh(cmd),
    log: session.log,
  })
  await verifyPyrightGrounding(ssh, session.log, cfg.preset ?? D.preset)
  await assertBoxProfileReady((cmd) => ssh(cmd), family)
}
