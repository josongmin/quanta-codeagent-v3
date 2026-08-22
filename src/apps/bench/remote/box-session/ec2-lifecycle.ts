/**
 * EC2 BOX LIFECYCLE for full-remote bench runs. Extracted from `box-session.ts`.
 * Owns the expensive launch + bootstrap surface (SG, hardened spot/on-demand
 * launch, cloud-init wait, rsync+bun install+phantom deps+swebench warm+pyright
 * grounding) and the REUSE paths (find idle / attach / inspect a warm box). A
 * launched box is ALWAYS terminated on bootstrap failure; a reused box's
 * `terminate` is a no-op (it self-terminates at its EC2 TTL). All IO routes
 * through the injected {@link SpawnFn} so the flow is unit-testable offline.
 */

import { basename } from "node:path"
import { errMessage, gateOn } from "@/shared"
import type { DatasetFamily } from "../../dataset-family-token"
import { presetRequiresLiveLspGrounding } from "../../preset"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"
import { datasetFamilyOrDefault } from "../../run-config"
import { defaultSpawn, type SpawnFn, type SpawnResult } from "../backend"
import { type BootstrapTracer, createBootstrapTracer } from "../bootstrap-tracer"
import { PHANTOM_DEPS } from "./auth"
import { resolveMaxReadyPolls, waitForBoxReady } from "./box-readiness"
import { readDatasetInstanceIds } from "./dataset-preflight"
import {
  assertFamilyAdmitsBox,
  ensureWarmBoxFamilyBootstrap,
  setupBoxForFamily,
} from "./family-box-setup"
import { probePyrightGrounding, verifyPyrightGrounding } from "./pyright-grounding"
import { aws, BENCH_SSH_SAFE_OPTS, makeSsh, oneLine, shq } from "./shell"
import {
  type BoxSnapshotRead,
  readBoxRuntimeProbe,
  readBoxSnapshot,
  resolveSnapshotInspection,
} from "./snapshot"
import { buildSrcRsyncArgs, ensureBoxConfigCurrent, ensureBoxSrcCurrent } from "./src-sync-guard"
import { type BoxInspection, type BoxSession, D, type FullRemoteConfig } from "./types"

/** Resolve a stable public SSM AMI reference just before launch. Explicit ami-*
 * overrides pass through byte-for-byte; malformed/failed SSM results fail loud
 * before RunInstances rather than surfacing as an opaque InvalidAMIID retry. */
export const resolveLaunchAmi = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  configured: string,
): Promise<string> => {
  if (!configured.startsWith("ssm:")) return configured
  const parameterName = configured.slice("ssm:".length)
  const result = await awsFn([
    "ssm",
    "get-parameter",
    "--name",
    parameterName,
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ])
  const imageId = oneLine(result.stdout)
  if (result.code !== 0 || !/^ami-[0-9a-f]+$/.test(imageId)) {
    throw new Error(
      `[full-remote] AMI SSM resolution failed for ${parameterName} (code ${result.code}): ${result.stderr || result.stdout}`,
    )
  }
  return imageId
}

/** The grading-shim file body. `shq` the spec (not bare single-quotes): QUANTA_SWEBENCH_PIP_SPEC
 *  is operator-controlled and a value with a `'` would break out of the quoting. The exact
 *  `--from ${shq(spec)} ` token is what {@link ensureBoxSwebenchShimCurrent} matches to detect
 *  a stale shim on a reused box. Pure + exported for unit test. */
export const buildSwebenchShim = (pipSpec: string): string =>
  `#!/usr/bin/env bash\nexec "$HOME/.local/bin/uvx" --from ${shq(pipSpec)} --python 3.11 --quiet python "$@"\n`

/** The pip-spec a run WANTS. FAMILY is a TYPED param threaded from the launch
 *  config (aug-22 HIGH-1); it used to be an ambient-env read that only held the
 *  right value because the composition root mirrored argv into ambient env. The
 *  remaining env reads are operator knobs on a different axis, not the family.
 *
 *  aug-22 HIGH-4: the pip-spec DERIVATION is the family profile's `harnessSpec`
 *  port, not a local `family === "live"` compare — this module no longer knows
 *  what any family name means. The ABSENT-selector default (the launch config's
 *  field is optional) comes from its ONE owner, `datasetFamilyOrDefault`
 *  (re-audit R4) — never a private literal here. */
const wantedSwebenchPipSpec = (family: DatasetFamily | undefined): string =>
  resolveDatasetFamilyProfile(datasetFamilyOrDefault(family)).harnessSpec({
    datasetName: process.env.QUANTA_SWEBENCH_DATASET_NAME ?? "",
    pipSpecOverride: process.env.QUANTA_SWEBENCH_PIP_SPEC,
  }).pipSpec

/** Self-heal the grading shim on a REUSED warm box. `isBootstrapped` only checks the shim
 *  FILE EXISTS, not its content — so a box first bootstrapped for Verified (`swebench`) and
 *  later reused for a Live run would keep the stock shim and KeyError on every Live repo
 *  (audit r2 BUG#2). Rewrite + re-warm iff the on-box shim's `--from` differs from what this
 *  run wants. A fast no-op (single `cat`) when already current ⇒ Verified reuse unchanged. */
export const ensureBoxSwebenchShimCurrent = async (
  session: BoxSession,
  family: DatasetFamily | undefined,
): Promise<void> => {
  const want = wantedSwebenchPipSpec(family)
  const marker = `--from ${shq(want)} `
  const cur = await session.ssh("cat ~/swebench-python 2>/dev/null || true")
  if (cur.stdout.includes(marker)) return // shim already targets the wanted spec
  session.log(`[pool] box swebench shim stale → rewriting (from=${want}) + re-warming…`)
  const wrote = await session.ssh(
    "cat > ~/swebench-python && chmod +x ~/swebench-python",
    buildSwebenchShim(want),
  )
  if (wrote.code !== 0) {
    throw new Error(
      `[pool] rewriting stale swebench shim failed (code ${wrote.code}): ${wrote.stderr}`,
    )
  }
  const warm = await session.ssh(
    'set -o pipefail; ~/swebench-python -c "import swebench; print(swebench.__version__)" 2>&1 | tail -3',
  )
  if (warm.code !== 0) {
    throw new Error(
      `[pool] re-warming swebench shim (from=${want}) failed (code ${warm.code}):\n${warm.stdout}`,
    )
  }
}

const RUNNING_BOX_FILTERS = [
  "Name=tag:Name,Values=quanta-bench-full",
  "Name=instance-state-name,Values=running",
] as const

const LIVE_BOX_FILTERS = [
  "Name=tag:Name,Values=quanta-bench-full",
  "Name=instance-state-name,Values=running,pending",
] as const

const MAX_LAUNCH_TAG_VALUE = 120

const launchTagValue = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const sanitized = raw
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_LAUNCH_TAG_VALUE)
  return sanitized === "" ? undefined : sanitized
}

const launchSelectionTag = (cfg: FullRemoteConfig): string | undefined => {
  if ((cfg.launchMode ?? "full-remote") === "pool") return undefined
  if (cfg.instanceIds !== undefined && cfg.instanceIds.length === 1) {
    return launchTagValue(cfg.instanceIds[0])
  }
  if (cfg.instanceIds !== undefined && cfg.instanceIds.length > 1) {
    return `count-${cfg.instanceIds.length}`
  }
  if (cfg.datasetPath === "") return undefined
  // PMX-02 — decoded through the FAMILY's reader, so a launch tag for a
  // JSON-array corpus is not silently `count-0`. The absent-selector default
  // comes from its ONE owner.
  const ids = readDatasetInstanceIds(
    cfg.datasetPath,
    datasetFamilyOrDefault(cfg.swebenchDatasetFamily),
  )
  if (ids.length === 1) return launchTagValue(ids[0])
  if (ids.length > 1) return `count-${ids.length}`
  return undefined
}

const launchTagSpecifications = (cfg: FullRemoteConfig): string => {
  const tags: Array<{ key: string; value: string }> = [{ key: "Name", value: "quanta-bench-full" }]
  const mode = launchTagValue(cfg.launchMode ?? "full-remote")
  const preset = launchTagValue(cfg.preset)
  const model = launchTagValue(cfg.model)
  const dataset = cfg.datasetPath !== "" ? launchTagValue(basename(cfg.datasetPath)) : undefined
  const selection = launchSelectionTag(cfg)
  if (mode !== undefined) tags.push({ key: "QuantaMode", value: mode })
  if (preset !== undefined) tags.push({ key: "QuantaPreset", value: preset })
  if (model !== undefined) tags.push({ key: "QuantaModel", value: model })
  if (dataset !== undefined) tags.push({ key: "QuantaDataset", value: dataset })
  if (selection !== undefined) tags.push({ key: "QuantaSelection", value: selection })
  return `ResourceType=instance,Tags=[${tags.map((tag) => `{Key=${tag.key},Value=${tag.value}}`).join(",")}]`
}

const terminateFailure = (iid: string, result: SpawnResult): Error => {
  const detail =
    result.stderr.trim() || result.stdout.trim() || `aws terminate-instances exited ${result.code}`
  return new Error(`[full-remote] terminate-instances failed for ${iid}: ${detail}`)
}

const cleanupFailure = (phase: string, iid: string, primary: unknown, cleanup: unknown): Error =>
  new Error(
    `[full-remote] ${phase} failed and cleanup failed for ${iid}: primary=${errMessage(primary)}; cleanup=${errMessage(cleanup)}`,
  )

const userData = (ttl: number): string =>
  [
    "#!/bin/bash",
    "set -eux",
    `shutdown -h +${ttl}`,
    // ripgrep (jun-19): the `grep` tool AND the new `find_references` tool both
    // shell out to `rg`. It was MISSING from every bench box → both returned
    // "rg: command not found" and the agent silently fell back to bash grep
    // (measured on django-11400: 5/5 grep-tool calls + find_references all failed).
    // Installing it un-breaks the grep tool too, not just find_references.
    // PyPI pyright's managed Node binary links libatomic.so.1 on Ubuntu.
    "apt-get update -y && apt-get install -y docker.io git curl unzip ripgrep libatomic1",
    "systemctl enable --now docker",
    "usermod -aG docker ubuntu",
    "su - ubuntu -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'",
    "su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'",
    // jun-19: the LSP nav-grounding lever (DEFAULT-ON since jun-17) was 100%
    // INERT on every bench box — `pyright-langserver` is not installed, so the
    // shared nav session failed to ready on every instance ("Executable not
    // found in $PATH"). The box has neither node nor pyright. `uv tool install
    // pyright` lands the PyPI wrapper (which self-manages a pinned node) at
    // ~/.local/bin/pyright-langserver, which remoteRun already puts on PATH.
    // The trailing `pyright --version` warms the one-time node download so the
    // first instance doesn't eat that latency. Fail-OPEN (`|| true`) at
    // cloud-init so the EC2 launch itself stays robust; the post-bootstrap
    // launch-proof below decides whether an inert pyright install is a loud
    // warning or a strict fail-closed stop, depending on the selected preset.
    // jun-19 hardening: the prior line warmed `pyright` (CLI) but the LSP
    // adapter spawns `pyright-langserver`; if uv only linked `pyright` the nav
    // session still failed "not found". Now we (1) install, (2) warm the node
    // download via `pyright --version`, (3) GUARANTEE a `pyright-langserver` on
    // PATH by symlinking it from the uv tool venv when uv didn't expose it, and
    // (4) warm the langserver binary itself. All fail-OPEN (`|| true`).
    "su - ubuntu -c '~/.local/bin/uv tool install pyright >/dev/null 2>&1 || true'",
    "su - ubuntu -c '~/.local/bin/pyright --version >/dev/null 2>&1 || true'",
    "su - ubuntu -c 'test -x ~/.local/bin/pyright-langserver || ln -sf \"$(find ~/.local/share/uv/tools/pyright -name pyright-langserver -type f 2>/dev/null | head -1)\" ~/.local/bin/pyright-langserver 2>/dev/null || true'",
    "su - ubuntu -c '~/.local/bin/pyright-langserver --version >/dev/null 2>&1 || true'",
  ].join("\n")

/** Find-or-create the SG + open :22. Without an attached SG the box lands in the
 *  default SG (no inbound :22) ⇒ ssh times out. Per the jun-25 user directive
 *  (see below) this path authorizes `0.0.0.0/0` rather than a detected
 *  `<myIp>/32`: the public-IP lookup curl returned stale IPs on degraded
 *  networks and stranded ssh after a healthy launch. Boxes are key-ONLY,
 *  ephemeral, IMDSv2, short-TTL, so world-open :22 is safe (only the key holder
 *  connects). Throws on a REAL authorize failure (never masks a connectivity
 *  error by blindly creating). */
const ensureSecurityGroup = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  _spawn: SpawnFn,
  sgName: string,
  vpcId: string,
  region: string,
): Promise<string> => {
  const found = await awsFn([
    "ec2",
    "describe-security-groups",
    "--filters",
    `Name=group-name,Values=${sgName}`,
    "--query",
    "SecurityGroups[0].GroupId",
    "--output",
    "text",
  ])
  if (found.code !== 0) {
    throw new Error(
      `[full-remote] could not reach EC2 (${region}) — network/credentials? : ${found.stderr.trim()}`,
    )
  }
  let sgId = oneLine(found.stdout)
  if (sgId === "" || sgId === "None") {
    const created = await awsFn([
      "ec2",
      "create-security-group",
      "--group-name",
      sgName,
      "--description",
      "quanta bench box",
      "--vpc-id",
      vpcId,
      "--query",
      "GroupId",
      "--output",
      "text",
    ])
    if (created.code !== 0) {
      throw new Error(
        `[full-remote] create-security-group failed (code ${created.code}): ${created.stderr}`,
      )
    }
    sgId = oneLine(created.stdout)
  }
  // jun-25 (user directive): open :22 to 0.0.0.0/0 rather than the detected
  // `${myIp}/32`. The public-IP lookup is a network-dependent curl that, on a
  // locally-degraded network (corp proxy / endpoint-security resetting egress),
  // returned a STALE/WRONG IP — so :22 was authorized for an address that wasn't
  // ours and every ssh/scp/rsync timed out AFTER a healthy box launch. Boxes are
  // ephemeral, key-ONLY (no password), IMDSv2, short-TTL, so world-open :22 is
  // safe: only the private key holder can connect. Removing the lookup also drops
  // a blocked-network failure point entirely.
  const auth = await awsFn([
    "ec2",
    "authorize-security-group-ingress",
    "--group-id",
    sgId,
    "--protocol",
    "tcp",
    "--port",
    "22",
    "--cidr",
    "0.0.0.0/0",
  ])
  if (auth.code !== 0 && !/Duplicate/i.test(auth.stderr)) {
    throw new Error(
      `[full-remote] authorize :22 ingress failed (code ${auth.code}): ${auth.stderr}`,
    )
  }
  return sgId
}

/** Launch a hardened box (IMDSv2 hop-1, TTL self-terminate), with instance-type
 *  fallbacks on capacity errors. Returns the instance id. */
const launchInstance = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  cfg: FullRemoteConfig,
  sgId: string,
  ttl: number,
  marketLabel: string,
  log: (m: string) => void,
): Promise<string> => {
  const onDemand = cfg.onDemand ?? false
  const imageId = await resolveLaunchAmi(awsFn, cfg.ami ?? D.ami)
  // The subnet/AZ is DELIBERATELY NOT pinned unless the caller sets `subnetId` —
  // pinning an AZ is the #1 cause of `InsufficientInstanceCapacity`.
  const typeCandidates = [
    ...new Set([cfg.instanceType ?? D.instanceType, "c7i.4xlarge", "c6i.8xlarge", "m6i.8xlarge"]),
  ]
  const launchArgs = (instanceType: string): string[] => [
    "ec2",
    "run-instances",
    "--image-id",
    imageId,
    "--instance-type",
    instanceType,
    "--key-name",
    cfg.keyName ?? D.keyName,
    ...(cfg.subnetId !== undefined ? ["--subnet-id", cfg.subnetId] : []),
    "--security-group-ids",
    sgId,
    ...(onDemand ? [] : ["--instance-market-options", '{"MarketType":"spot"}']),
    // Resume needs the box to read/write its cassette in S3 → attach the scoped
    // instance-profile ONLY when resume is on (default-off ⇒ no profile, launch
    // byte-identical to today). Requires iam:PassRole on the launching principal.
    ...(gateOn(process.env, "QUANTA_BENCH_RESUME")
      ? [
          "--iam-instance-profile",
          `Name=${process.env.QUANTA_BENCH_RESUME_IAM_PROFILE ?? "quanta-bench-resume-profile"}`,
        ]
      : []),
    "--metadata-options",
    "HttpTokens=required,HttpPutResponseHopLimit=1",
    "--instance-initiated-shutdown-behavior",
    "terminate",
    "--block-device-mappings",
    `[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":${cfg.diskGb ?? D.diskGb},"VolumeType":"gp3","DeleteOnTermination":true}}]`,
    "--user-data",
    userData(ttl),
    "--tag-specifications",
    launchTagSpecifications(cfg),
    "--query",
    "Instances[0].InstanceId",
    "--output",
    "text",
  ]

  let iid = ""
  let lastErr = ""
  for (const it of typeCandidates) {
    log(`[full-remote] launching hardened ${marketLabel} box (${it}, IMDSv2 hop-1, TTL)…`)
    const launch = await awsFn(launchArgs(it))
    const got = oneLine(launch.stdout)
    if (launch.code === 0 && got !== "" && got !== "None") {
      iid = got
      break
    }
    lastErr = launch.stderr
    if (/InsufficientInstanceCapacity|capacity/i.test(launch.stderr)) {
      log(`[full-remote] no ${it} capacity — trying next type…`)
      continue
    }
    throw new Error(`[full-remote] run-instances failed (code ${launch.code}): ${launch.stderr}`)
  }
  if (iid === "") {
    throw new Error(
      `[full-remote] no spot capacity across ${typeCandidates.join(", ")}: ${lastErr}`,
    )
  }
  return iid
}

/** The reusable bootstrap surface: rsync src + config, bun install, phantom deps,
 *  swebench shim + warm, pyright nav-grounding probe. Runs on a ready box; throws
 *  on any hard failure (caller terminates). */
const bootstrapBox = async (session: BoxSession, cfg: FullRemoteConfig): Promise<void> => {
  const { host, keyPath, spawn, log } = session
  const ssh = session.ssh.bind(session)
  assertFamilyAdmitsBox({ family: datasetFamilyOrDefault(cfg.swebenchDatasetFamily), log }) // A-C
  log(
    "[full-remote] bootstrapped. Syncing src/ + config (SURGICAL — the monorepo's apps/crates/native are GBs and the bench needs only src)…",
  )
  // Same host-key/safety posture as makeSsh (SSOT) so the rsync transport
  // connects identically to the readiness/grade ssh — a recycled-IP stale key
  // must not refuse the rsync after readiness already succeeded.
  const sshOpts = `ssh -i ${keyPath} ${BENCH_SSH_SAFE_OPTS.join(" ")} -o ConnectTimeout=15 -o ServerAliveInterval=15`
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
  // Grading toolchain: the swebench-python shim (uvx --from <spec> python) + warm the
  // uvx cache so the first import-probe doesn't time out.
  //
  // RFC jun-29 (Live grading fix): stock PyPI `swebench` only knows the ORIGINAL
  // SWE-bench repos — its `make_test_spec` does `MAP_REPO_VERSION_TO_SPECS[repo][version]`
  // and KeyErrors on a SWE-bench-Live repo (measured: `KeyError: 'conan-io/conan'`). The
  // SWE-bench-Live fork registers the Live repos, so for a Live `--dataset_name` we pull
  // the fork instead. Derived from the forwarded QUANTA_SWEBENCH_DATASET_NAME so the one
  // dataset signal drives BOTH grading params and the harness build; QUANTA_SWEBENCH_PIP_SPEC
  // is an explicit operator override. Default `swebench` ⇒ Verified/Pro unchanged.
  // HIGH-1 (aug-22): FAMILY comes from the TYPED launch config ONLY — the old
  // ambient-env `??` tail papered over a dropped thread and would now resolve the
  // WRONG harness fork. (DATASET_NAME / PIP_SPEC keep their env fallbacks: those
  // are operator knobs on a different axis, not the family authority.)
  // aug-22 HIGH-4: the pip-spec comes from the family PROFILE's `harnessSpec`
  // port, and the ABSENT-selector default from its ONE owner (re-audit R4).
  const swebenchPipSpec = resolveDatasetFamilyProfile(
    datasetFamilyOrDefault(cfg.swebenchDatasetFamily),
  ).harnessSpec({
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
  // HIGH-1 (aug-22): typed launch config only — see the pip-spec note above.
  // HIGH-4 (aug-22): the ON-BOX family bootstrap is the profile's `setupBox`
  // port. This module no longer branches on `family === "pro"`.
  await setupBoxForFamily({
    family: datasetFamilyOrDefault(cfg.swebenchDatasetFamily),
    // PMX-04: CARRIED, never re-derived here (see `family-bootstrap-exec.ts`).
    ...(cfg.remoteBootstrap !== undefined ? { bootstrap: cfg.remoteBootstrap } : {}),
    ssh: (cmd) => ssh(cmd),
    log,
  })
  // #1-P0 (jun-19/20): prove LSP grounding is actually LIVE after bootstrap.
  // The thin-strict family is fail-closed: proceeding with silent no-nav
  // degrade would violate the preset's contract.
  await verifyPyrightGrounding(ssh, log, cfg.preset ?? D.preset)
}

/** ON-BOX family bootstrap (aug-22 HIGH-4). `bootstrapBox`'s callee — the
 *  ordering (family ADMISSION GATE first, declared agent-phase bootstrap second)
 *  and the warm-box reuse gate live in `family-box-setup.ts`. Re-exported here
 *  because `bootstrapBox` is this module's, and callers import the callee from
 *  its owner. */
export { setupBoxForFamily }

const describeInstancePublicIp = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  iid: string,
): Promise<string> => {
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--instance-ids",
    iid,
    "--query",
    "Reservations[0].Instances[0].PublicIpAddress",
    "--output",
    "text",
  ])
  const ip = oneLine(desc.stdout)
  if (ip === "" || ip === "None") {
    throw new Error(`[full-remote] no public IP for ${iid}: ${desc.stdout}`)
  }
  return ip
}

/** The box READINESS-POLL loop lives in its own leaf (`box-readiness.ts`);
 *  `resolveMaxReadyPolls` is re-exported so no consumer's import moved. */
export { resolveMaxReadyPolls }

/** Terminate NOW, whatever `keep` says. Used on the provisioning FAILURE path. */
const forceTerminateInstance =
  (awsFn: (args: readonly string[]) => Promise<SpawnResult>, iid: string) =>
  async (): Promise<void> => {
    const terminated = await awsFn(["ec2", "terminate-instances", "--instance-ids", iid])
    if (terminated.code !== 0) throw terminateFailure(iid, terminated)
  }

/**
 * The terminator handed to a SUCCESSFULLY provisioned session. `keep` is a
 * success-path policy — "leave the warm box alive, that is the point of
 * `box up`" — and it is honoured only here.
 *
 * ⚠️ It must NOT be reused for the failure path. `keep: true` used to make the
 * bootstrap `catch` a no-op, so an instance that RunInstances had already
 * created but that failed to bootstrap was simply abandoned: nothing terminated
 * it and only the 180-minute TTL eventually reaped it. That is a real,
 * measured money leak — on aug-22 a `box up` whose family profile refused during
 * bootstrap left TEN live c7i.4xlarge spot instances running until their TTL
 * expired. A box that never finished bootstrapping is an ORPHAN, not something
 * an operator asked to keep, so {@link forceTerminateInstance} owns that path.
 */
export const createInstanceTerminator = (
  keep: boolean,
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  iid: string,
): (() => Promise<void>) => (keep ? async () => {} : forceTerminateInstance(awsFn, iid))

const resolveProvisionContext = (cfg: FullRemoteConfig) => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const onDemand = cfg.onDemand ?? false
  return {
    spawn,
    region,
    keyPath: cfg.keyPath ?? D.keyPath,
    ttl: cfg.ttlMinutes ?? D.ttlMinutes,
    keep: cfg.keep ?? false,
    marketLabel: onDemand ? "on-demand" : "spot",
    log: cfg.onLog ?? (() => {}),
    awsFn: aws(spawn, region),
  }
}

/**
 * Launch + bootstrap a box; return a live {@link BoxSession}. On ANY failure
 * after the instance exists, the box is terminated before the error propagates
 * (a half-provisioned box must never linger and burn money / hold a credential).
 */
export const provisionBox = async (cfg: FullRemoteConfig): Promise<BoxSession> => {
  const { spawn, region, keyPath, ttl, keep, marketLabel, log, awsFn } =
    resolveProvisionContext(cfg)

  log("[full-remote] ensuring security group (:22 from your IP)…")
  const sgId = await ensureSecurityGroup(
    awsFn,
    spawn,
    cfg.sgName ?? D.sgName,
    cfg.vpcId ?? D.vpcId,
    region,
  )
  const iid = await launchInstance(awsFn, cfg, sgId, ttl, marketLabel, log)

  const terminate = createInstanceTerminator(keep, awsFn, iid)

  // ⚠️ THE ORPHAN FENCE STARTS HERE. `iid` exists, so AWS is already billing. From
  // this line until a session is handed back, EVERY throw must terminate the box —
  // which is why the tracer is constructed INSIDE the try rather than above it.
  // (aug-22 audit: it used to be constructed above, so a tracer factory that threw
  // reopened the exact leak `createInstanceTerminator` documents, on a narrower
  // path — an observability object failing to build would strand a live c7i box
  // until its 180-minute TTL.)
  let tracer: BootstrapTracer | undefined

  try {
    // jun-27 #4: live BOOTSTRAP-phase spans so the ~20min provision window is visible
    // in the operator's trace UI — a slow bootstrap vs a DEAD one no longer look the
    // same, and a failed phase surfaces WHERE it died (error span + message). Off
    // unless an OTEL endpoint is threaded in (cfg.otelEndpoint) ⇒ byte-identical.
    const boxTracer = (cfg.makeBootstrapTracer ?? createBootstrapTracer)({
      endpoint: cfg.otelEndpoint ?? "",
      iid,
    })
    tracer = boxTracer

    log(`[full-remote] instance ${iid} — waiting for running…`)
    await boxTracer.phase("wait-running", () =>
      awsFn(["ec2", "wait", "instance-running", "--instance-ids", iid]),
    )
    const ip = await describeInstancePublicIp(awsFn, iid)
    const host = `ubuntu@${ip}`
    log(`[full-remote] box up at ${ip}. Waiting for cloud-init (docker+bun+uv ~2-3min)…`)
    // Copy-paste log tracker — printed the moment the IP is known (not ~5min later
    // at patch-gen) so you can `tail -f` the per-action run.log from the start.
    log(
      `[full-remote] 📋 track live (copy-paste):\n    ssh -i ${keyPath} ${host} 'tail -f ~/run.log'`,
    )

    const ssh = makeSsh(spawn, keyPath, host)
    const session: BoxSession = {
      iid,
      ip,
      host,
      keyPath,
      region,
      spawn,
      log,
      ssh: (cmd, input, onData) => ssh(cmd, input, onData),
      aws: awsFn,
      terminate,
    }

    // Wait until SSH is reachable AND cloud-init finished installing bun.
    await boxTracer.phase("cloud-init", () => waitForBoxReady(ssh, cfg))
    await boxTracer.phase("bootstrap", () => bootstrapBox(session, cfg))
    return session
  } catch (err) {
    try {
      // FORCE, not `terminate()` — see createInstanceTerminator. A `keep: true`
      // caller (`box up`) still must not leak an instance that never bootstrapped.
      await forceTerminateInstance(awsFn, iid)()
    } catch (cleanupErr) {
      throw cleanupFailure("bootstrap", iid, err, cleanupErr)
    }
    throw err
  } finally {
    // Flush the bootstrap spans (success or failure) before the caller proceeds to
    // grading — which streams its OWN spans into the same trace UI.
    //
    // SWALLOWED, deliberately. Flushing is OBSERVABILITY, and this file's rule is
    // that observability never changes provisioning: a throw here would (a) replace
    // a real bootstrap failure with a meaningless exporter error in the `catch`
    // path's rethrow, and (b) on the SUCCESS path throw AFTER the box is live and
    // bootstrapped — stranding a running instance the caller never receives and so
    // can never terminate. `tracer` is undefined only when its factory threw, which
    // the catch above has already handled.
    try {
      await tracer?.close()
    } catch (flushErr) {
      log(`[full-remote] bootstrap span flush failed (ignored): ${errMessage(flushErr)}`)
    }
  }
}

/** Is this box fully bootstrapped (bun + swebench shim + synced src present)? A
 *  warm box from a prior run satisfies this; a half-provisioned one does not. */
const isBootstrapped = async (ssh: (cmd: string) => Promise<SpawnResult>): Promise<boolean> => {
  const probe = await ssh(
    "test -x ~/.bun/bin/bun && test -x ~/swebench-python && test -d ~/quanta/src && echo OK",
  )
  return probe.code === 0 && probe.stdout.includes("OK")
}

const listRunningBoxes = async (
  cfg: FullRemoteConfig,
): Promise<Array<{ iid: string; ip: string }>> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const awsFn = aws(spawn, region)
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--filters",
    ...RUNNING_BOX_FILTERS,
    "--query",
    "Reservations[].Instances[].[InstanceId,PublicIpAddress]",
    "--output",
    "text",
  ])
  if (desc.code !== 0) {
    throw new Error(`[full-remote] describe running boxes failed: ${desc.stderr || desc.stdout}`)
  }
  return desc.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && (p[0] ?? "").startsWith("i-") && p[1] !== "None" && p[1] !== "")
    .map(([iid, ip]) => ({ iid: iid as string, ip: ip as string }))
}

/** Running quanta-bench box count, regardless of idle/busy. Used by the single-
 *  box fail-closed guard: if ANY tagged box is already alive OR launching,
 *  callers must opt in before launching another one. */
export const countLiveBoxes = async (cfg: FullRemoteConfig): Promise<number> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const awsFn = aws(spawn, region)
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--filters",
    ...LIVE_BOX_FILTERS,
    "--query",
    "Reservations[].Instances[].InstanceId",
    "--output",
    "text",
  ])
  if (desc.code !== 0) {
    throw new Error(`[full-remote] describe live boxes failed: ${desc.stderr || desc.stdout}`)
  }
  return desc.stdout
    .trim()
    .split(/\s+/)
    .filter((iid) => iid.startsWith("i-")).length
}

const busyProbeCommand =
  "if pgrep -f '[c]li\\.ts run' >/dev/null 2>&1 || pgrep -f '[r]un_evaluation' >/dev/null 2>&1; then echo BUSY; " +
  "elif test -d ~/.pool-grade.lock; then " +
  'if find ~/.pool-grade.lock -maxdepth 0 -mmin +10 >/dev/null 2>&1 && [ -n "$(find ~/.pool-grade.lock -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir ~/.pool-grade.lock 2>/dev/null; echo IDLE; else echo BUSY; fi; ' +
  "else echo IDLE; fi"

/**
 * Find a RUNNING, bootstrapped, IDLE quanta-bench box to REUSE — so a back-to-back
 * run skips the whole bootstrap. "Idle" = no `bench run` (patch-gen) and no
 * `run_evaluation` (docker grade) process is live on the box; attaching to a BUSY
 * box would race its grade and false-negative correct patches (the concurrent-
 * grade hazard). Returns the instance id of the first reusable box, or undefined
 * (⇒ the caller launches a fresh one). Best-effort: any AWS/ssh error ⇒ undefined.
 */
export const findIdleBox = async (cfg: FullRemoteConfig): Promise<string | undefined> => {
  const keyPath = cfg.keyPath ?? D.keyPath
  const spawn = cfg.spawn ?? defaultSpawn
  const rows = await listRunningBoxes(cfg).catch(() => undefined)
  if (rows === undefined) return undefined
  for (const { iid, ip } of rows) {
    const ssh = makeSsh(spawn, keyPath, `ubuntu@${ip}`)
    if (!(await isBootstrapped((c) => ssh(c)).catch(() => false))) continue
    // BUSY iff a grade process is live OR a FRESH grade lock is held. A lock with
    // NO live grade process AND older than 10min is a STALE leak — the orchestrator
    // was killed mid-grade so the box-side `finally rmdir` never ran (a real grade
    // starts its process within seconds, so a 10min-old lock with no process can
    // only be a crash leak). Reclaim it (rmdir) so the box isn't wasted to its TTL.
    const idle = await ssh(busyProbeCommand).catch(() => undefined)
    if (idle !== undefined && idle.code === 0 && idle.stdout.includes("IDLE")) return iid
  }
  return undefined
}

/** Probe one running box for operator-visible runtime state (bootstrapping vs
 *  idle/busy, plus the current or last workload snapshot when available). */
export const inspectBox = async (
  cfg: FullRemoteConfig,
  box: { iid: string; ip: string },
): Promise<BoxInspection> => {
  const keyPath = cfg.keyPath ?? D.keyPath
  const spawn = cfg.spawn ?? defaultSpawn
  const ssh = makeSsh(spawn, keyPath, `ubuntu@${box.ip}`)
  const bootstrapped = await isBootstrapped((c) => ssh(c)).catch(() => false)
  if (!bootstrapped) {
    return {
      lifecycle: "bootstrapping",
      bootstrapped: false,
      busy: false,
      snapshotHealthy: false,
      snapshotState: "not-ready",
    }
  }
  const busyProbe = await ssh(busyProbeCommand).catch(() => undefined)
  if (busyProbe === undefined || busyProbe.code !== 0) {
    return {
      lifecycle: "unreachable",
      bootstrapped: true,
      busy: false,
      snapshotHealthy: false,
      snapshotState: "read-failed",
    }
  }
  const busy = busyProbe.stdout.includes("BUSY")
  const snapshotRead: BoxSnapshotRead = await readBoxSnapshot((cmd) => ssh(cmd))
  const probe = await readBoxRuntimeProbe((cmd) => ssh(cmd))
  const snapshotInspection = resolveSnapshotInspection(snapshotRead, probe, busy)
  return {
    lifecycle: busy ? "busy" : "idle",
    bootstrapped: true,
    busy,
    ...snapshotInspection,
    ...(probe !== undefined ? { probe } : {}),
  }
}

/**
 * Attach to an already-running box (REUSE) instead of launching. Resolves the ip,
 * verifies it is bootstrapped (re-bootstraps if a stale box lost its sync), and
 * returns a {@link BoxSession} whose `terminate` is a NO-OP — a reused box is left
 * WARM for the next run (it self-terminates at its EC2 TTL). The caller owns
 * idle-safety (see {@link findIdleBox}).
 */
export const attachBox = async (cfg: FullRemoteConfig, iid: string): Promise<BoxSession> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const keyPath = cfg.keyPath ?? D.keyPath
  const log = cfg.onLog ?? (() => {})
  const awsFn = aws(spawn, region)
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--instance-ids",
    iid,
    "--query",
    "Reservations[0].Instances[0].PublicIpAddress",
    "--output",
    "text",
  ])
  const ip = oneLine(desc.stdout)
  if (ip === "" || ip === "None") {
    throw new Error(`[pool] attach: no public IP for ${iid}: ${desc.stdout}`)
  }
  const host = `ubuntu@${ip}`
  const ssh = makeSsh(spawn, keyPath, host)
  const session: BoxSession = {
    iid,
    ip,
    host,
    keyPath,
    region,
    spawn,
    log,
    ssh: (cmd, input, onData) => ssh(cmd, input, onData),
    aws: awsFn,
    terminate: async () => {}, // reused box stays WARM (TTL reaps it)
  }
  log(`[pool] reusing warm box ${iid} (${ip})`)
  const preset = cfg.preset ?? D.preset
  let reBootstrapped = false
  if (!(await isBootstrapped((c) => ssh(c)))) {
    log(`[pool] box ${iid} missing bootstrap (stale) — re-bootstrapping…`)
    await bootstrapBox(session, cfg)
    reBootstrapped = true
  } else if (presetRequiresLiveLspGrounding(preset)) {
    const groundingVerdict = await probePyrightGrounding((c) => ssh(c))
    if (!groundingVerdict.ready) {
      log(`[pool] box ${iid} lost live LSP grounding for preset ${preset} — re-bootstrapping…`)
      await bootstrapBox(session, cfg)
      reBootstrapped = true
    } else {
      log(`[pool] warm box ${iid} LSP grounding ready — ${groundingVerdict.detail}`)
    }
  }
  // Close the silent-stale-CODE class: a warm box reused across a code change
  // would otherwise grade with the src + config rsynced at its ORIGINAL bootstrap.
  // Checksum-mode rsyncs are a fast no-op when current and self-heal when stale.
  // src: --delete-enabled (orphans removed). config: re-syncs package.json/
  // bun.lock/tsconfig*/bunfig + re-runs bun install when the dep graph drifted.
  // (Skip when we just re-bootstrapped — that already seed-synced fresh src+config.)
  if (!reBootstrapped) {
    // FIRST, as on the provision path: `bootstrapBox` did not run here, so a
    // family's declared pinned-checkout + digest gate was never verified on this
    // box. Re-prove or refuse (rationale + byte-identical control: family-box-setup).
    await ensureWarmBoxFamilyBootstrap({
      family: datasetFamilyOrDefault(cfg.swebenchDatasetFamily),
      ...(cfg.remoteBootstrap !== undefined ? { bootstrap: cfg.remoteBootstrap } : {}),
      ssh: (c) => ssh(c),
      log,
    })
    await ensureBoxSrcCurrent({ spawn, repoDir: cfg.repoDir, host, keyPath, log })
    await ensureBoxConfigCurrent({
      spawn,
      ssh: (c) => ssh(c),
      repoDir: cfg.repoDir,
      host,
      keyPath,
      log,
    })
    // Close the silent-stale-SHIM class (audit r2 BUG#2): a Verified-bootstrapped box reused
    // for a Live run would otherwise grade on the stock-swebench shim → KeyError on Live repos.
    await ensureBoxSwebenchShimCurrent(session, cfg.swebenchDatasetFamily)
  }
  return session
}
