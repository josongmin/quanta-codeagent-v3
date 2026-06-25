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
import { errMessage } from "@/shared"
import { presetRequiresLiveLspGrounding } from "../../preset"
import { defaultSpawn, type SpawnFn, type SpawnResult } from "../backend"
import { lookupCurrentPublicIpv4 } from "../ec2"
import { PHANTOM_DEPS } from "./auth"
import { readDatasetInstanceIds } from "./dataset-preflight"
import { probePyrightGrounding, verifyPyrightGrounding } from "./pyright-grounding"
import { BENCH_SSH_SAFE_OPTS, aws, defaultSleep, expandHome, makeSsh, oneLine } from "./shell"
import {
  type BoxSnapshotRead,
  readBoxRuntimeProbe,
  readBoxSnapshot,
  resolveSnapshotInspection,
} from "./snapshot"
import { type BoxInspection, type BoxSession, D, type FullRemoteConfig } from "./types"

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
  const ids = readDatasetInstanceIds(cfg.datasetPath)
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
    "apt-get update -y && apt-get install -y docker.io git curl unzip ripgrep",
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
 *  default SG (no inbound :22) ⇒ ssh times out. Ingress is scoped to the current
 *  public IPv4 `/32` (via the SSOT {@link lookupCurrentPublicIpv4}, shared with
 *  ec2.ts) — NOT `0.0.0.0/0`: both sites authorize the SAME named SG, so a
 *  world-open rule here would permanently widen the SG the ec2 path restricts.
 *  Throws on a REAL failure (never masks a connectivity error by blindly
 *  creating, and fail-closes on an unresolvable IP rather than world-opening). */
const ensureSecurityGroup = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  spawn: SpawnFn,
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
  const myIp = await lookupCurrentPublicIpv4(spawn, "full-remote")
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
    `${myIp}/32`,
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
  // The subnet/AZ is DELIBERATELY NOT pinned unless the caller sets `subnetId` —
  // pinning an AZ is the #1 cause of `InsufficientInstanceCapacity`.
  const typeCandidates = [
    ...new Set([cfg.instanceType ?? D.instanceType, "c7i.4xlarge", "c6i.8xlarge", "m6i.8xlarge"]),
  ]
  const launchArgs = (instanceType: string): string[] => [
    "ec2",
    "run-instances",
    "--image-id",
    cfg.ami ?? D.ami,
    "--instance-type",
    instanceType,
    "--key-name",
    cfg.keyName ?? D.keyName,
    ...(cfg.subnetId !== undefined ? ["--subnet-id", cfg.subnetId] : []),
    "--security-group-ids",
    sgId,
    ...(onDemand ? [] : ["--instance-market-options", '{"MarketType":"spot"}']),
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
  log(
    "[full-remote] bootstrapped. Syncing src/ + config (SURGICAL — the monorepo's apps/crates/native are GBs and the bench needs only src)…",
  )
  // Same host-key/safety posture as makeSsh (SSOT) so the rsync transport
  // connects identically to the readiness/grade ssh — a recycled-IP stale key
  // must not refuse the rsync after readiness already succeeded.
  const sshOpts = `ssh -i ${expandHome(keyPath)} ${BENCH_SSH_SAFE_OPTS.join(" ")} -o ConnectTimeout=15 -o ServerAliveInterval=15`
  await ssh("mkdir -p ~/quanta")
  const rsynced = await spawn("rsync", [
    "-az",
    "--partial",
    "--exclude",
    "node_modules",
    "--exclude",
    "*.js", // stale compiled mirrors — bun runs the .ts directly
    "--exclude",
    "*.test.ts", // tests not needed to RUN the agent
    "--exclude",
    ".quanta",
    "-e",
    sshOpts,
    `${cfg.repoDir}/src/`,
    `${host}:~/quanta/src/`,
  ])
  if (rsynced.code !== 0) {
    throw new Error(`[full-remote] rsync src failed (code ${rsynced.code}): ${rsynced.stderr}`)
  }
  const scpCfg = await spawn("scp", [
    "-i",
    expandHome(keyPath),
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
  // Grading toolchain: the swebench-python shim (uvx --from swebench python) +
  // warm the uvx cache so the first import-probe doesn't time out.
  log(
    "[full-remote] creating swebench-python shim + warming uvx swebench cache (first pull ~30-60s)…",
  )
  const shim =
    '#!/usr/bin/env bash\nexec "$HOME/.local/bin/uvx" --from swebench --python 3.11 --quiet python "$@"\n'
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
  // #1-P0 (jun-19/20): prove LSP grounding is actually LIVE after bootstrap.
  // The thin-strict family is fail-closed: proceeding with silent no-nav
  // degrade would violate the preset's contract.
  await verifyPyrightGrounding(ssh, log, cfg.preset ?? D.preset)
}

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

const waitForBoxReady = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
  cfg: FullRemoteConfig,
): Promise<void> => {
  const sleep = cfg.sleep ?? defaultSleep
  const log = cfg.onLog ?? (() => {})
  // jun-25: 30→90 (5min→15min readiness window). A READY box returns on the
  // FIRST poll, so this only extends the wait for a SLOW bootstrap — which is
  // exactly what was failing: under a degraded network, cloud-init's
  // docker+bun+uv+pyright install ran past 5min, so the box was ssh-reachable
  // but not yet bun-ready when the old 30-poll window expired → "never became
  // ready" → relaunch → both attempts LOST despite the boxes being healthy.
  const maxReadyPolls = cfg.maxReadyPolls ?? 90
  // jun-25 RCA: the prior loop DISCARDED probe.code/stderr every poll and threw a
  // hardcoded guess ("check SG :22 / cloud-init"). So a box that was provably
  // reachable + ready + world-open-SG looked IDENTICAL to a dead one — a run
  // burned ~15min × 2 retries blind-polling, and the on-call had to hand-forensic
  // (ssh + auth.log + AWS state, ~25min) to learn the readiness ssh simply never
  // reached the box. Surface the REAL exit/stderr: first failure immediately
  // (the diagnostic that matters), a heartbeat every 10th poll, and the actual
  // last error in the throw.
  let lastCode = -1
  let lastErr = ""
  let consecutiveTerminal = 0
  for (let i = 0; i < maxReadyPolls; i++) {
    const probe = await ssh(
      "sudo cloud-init status --wait >/dev/null 2>&1; test -x ~/.bun/bin/bun && echo READY",
    )
    if (probe.code === 0 && probe.stdout.includes("READY")) return
    lastCode = probe.code
    lastErr = (probe.stderr || probe.stdout).trim().replace(/\s+/g, " ").slice(0, 300)
    const terminal = SSH_TERMINAL_ERROR.test(lastErr)
    consecutiveTerminal = terminal ? consecutiveTerminal + 1 : 0
    if (i === 0 || i % 10 === 9 || terminal) {
      log(
        `[full-remote] readiness poll ${i + 1}/${maxReadyPolls} not ready ` +
          `(ssh exit ${lastCode}${lastErr ? `: ${lastErr}` : ""})` +
          (terminal ? " — NON-RECOVERABLE (key/host-key/perm, not slow-boot)" : ""),
      )
    }
    // A non-recoverable ssh error (auth / host-key / unreadable key / bad config)
    // will NEVER heal by waiting — abort after a few consecutive hits instead of
    // burning the whole ~15min window (and then a retry burning another ~15min).
    // "Connection refused / timed out" is the NORMAL still-booting signal and is
    // deliberately NOT terminal, so a slow cloud-init still gets the full window.
    if (consecutiveTerminal >= 3) {
      throw new Error(
        `[full-remote] box ssh is NON-RECOVERABLE after ${i + 1} polls ` +
          `(ssh exit ${lastCode}: ${lastErr}) — not a slow boot; ` +
          "check key path / host-key / SG :22, not cloud-init",
      )
    }
    await sleep(10_000)
  }
  throw new Error(
    `[full-remote] box never became ssh-reachable + bun-ready after ${maxReadyPolls} polls ` +
      `(last ssh exit ${lastCode}${lastErr ? `: ${lastErr}` : ""})`,
  )
}

/** ssh stderr patterns that will NEVER self-heal by waiting longer (auth /
 *  host-key / unreadable key / misconfig) — as opposed to the normal still-
 *  booting signals ("Connection refused", "Operation timed out"), which are NOT
 *  listed here so a slow cloud-init keeps polling. Used by {@link waitForBoxReady}
 *  to fail fast instead of polling the full readiness window on a doomed box. */
const SSH_TERMINAL_ERROR =
  /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Permission denied|identity file .* not accessible|Bad (?:configuration|owner)|Could not resolve hostname|UNPROTECTED PRIVATE KEY|Too many authentication failures/i

/**
 * Launch + bootstrap a box; return a live {@link BoxSession}. On ANY failure
 * after the instance exists, the box is terminated before the error propagates
 * (a half-provisioned box must never linger and burn money / hold a credential).
 */
export const provisionBox = async (cfg: FullRemoteConfig): Promise<BoxSession> => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const keyPath = cfg.keyPath ?? D.keyPath
  const ttl = cfg.ttlMinutes ?? D.ttlMinutes
  const onDemand = cfg.onDemand ?? false
  const keep = cfg.keep ?? false
  const marketLabel = onDemand ? "on-demand" : "spot"
  const log = cfg.onLog ?? (() => {})
  const awsFn = aws(spawn, region)

  log("[full-remote] ensuring security group (:22 from your IP)…")
  const sgId = await ensureSecurityGroup(
    awsFn,
    spawn,
    cfg.sgName ?? D.sgName,
    cfg.vpcId ?? D.vpcId,
    region,
  )
  const iid = await launchInstance(awsFn, cfg, sgId, ttl, marketLabel, log)

  const terminate = async (): Promise<void> => {
    if (keep) return
    const terminated = await awsFn(["ec2", "terminate-instances", "--instance-ids", iid])
    if (terminated.code !== 0) throw terminateFailure(iid, terminated)
  }

  try {
    log(`[full-remote] instance ${iid} — waiting for running…`)
    await awsFn(["ec2", "wait", "instance-running", "--instance-ids", iid])
    const ip = await describeInstancePublicIp(awsFn, iid)
    const host = `ubuntu@${ip}`
    log(`[full-remote] box up at ${ip}. Waiting for cloud-init (docker+bun+uv ~2-3min)…`)
    // Copy-paste log tracker — printed the moment the IP is known (not ~5min later
    // at patch-gen) so you can `tail -f` the per-action run.log from the start.
    log(`[full-remote] 📋 track live (copy-paste):\n    ssh -i ${keyPath} ${host} 'tail -f ~/run.log'`)

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
    await waitForBoxReady(ssh, cfg)
    await bootstrapBox(session, cfg)
    return session
  } catch (err) {
    try {
      await terminate()
    } catch (cleanupErr) {
      throw cleanupFailure("bootstrap", iid, err, cleanupErr)
    }
    throw err
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
  if (!(await isBootstrapped((c) => ssh(c)))) {
    log(`[pool] box ${iid} missing bootstrap (stale) — re-bootstrapping…`)
    await bootstrapBox(session, cfg)
  } else if (presetRequiresLiveLspGrounding(preset)) {
    const groundingVerdict = await probePyrightGrounding((c) => ssh(c))
    if (!groundingVerdict.ready) {
      log(`[pool] box ${iid} lost live LSP grounding for preset ${preset} — re-bootstrapping…`)
      await bootstrapBox(session, cfg)
    } else {
      log(`[pool] warm box ${iid} LSP grounding ready — ${groundingVerdict.detail}`)
    }
  }
  return session
}
