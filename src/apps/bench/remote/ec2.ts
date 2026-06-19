/**
 * EC2 grading backend (ADR-0536 P0).
 *
 * Automates stages 0–5 of `docs/swebench-ec2-runbook.md`:
 *
 *   0. ensure security group `quanta-bench-sg` exists, authorize :22 from the
 *      current public IP only.
 *   1. run-instances SPOT with the validated params (IMDSv2 enforced, gp3
 *      disk, `shutdown -h +<ttl>` user-data backstop, terminate-on-shutdown,
 *      Name=quanta-bench tag).
 *   2. wait instance-running, fetch the public IP.
 *   3-5. DELEGATE grading to {@link createSshBackend} against `ubuntu@<ip>`.
 *   6. terminate the instance (unless `keep`) and confirm.
 *
 * Every external call (aws, curl, ssh, scp) goes through the injected
 * {@link SpawnFn}; the whole flow is unit-testable offline.
 */
import {
  DEFAULT_MAX_WORKERS,
  defaultSpawn,
  type GradeBackend,
  type GradeOptions,
  type GradeOutcome,
  type SpawnFn,
} from "./backend"
import { createSshBackend } from "./ssh"

export interface Ec2BackendConfig {
  readonly region?: string
  readonly ami?: string
  readonly instanceType?: string
  readonly keyName?: string
  readonly keyPath?: string
  readonly subnetId?: string
  readonly vpcId?: string
  readonly sgName?: string
  readonly diskGb?: number
  /** Self-terminate backstop in minutes (`shutdown -h +<ttl>`). Default 360. */
  readonly ttlMinutes?: number
  /** Keep the box alive after grading (debug). Default false ⇒ terminate. */
  readonly keep?: boolean
  /** Launch ON-DEMAND instead of spot (no reclaim) — for capacity crunches where
   *  spot is reclaimed mid-grade. ~3× cost. Default false (spot). */
  readonly onDemand?: boolean
  readonly maxWorkers?: number
  /** model_name_or_path baked into the predictions rows (report filename
   *  `<model>.<runId>.json`). Forwarded to the internal ssh backend; default
   *  "quanta". Set this when predictions use a different model name. */
  readonly modelName?: string
  readonly spawn?: SpawnFn
  /** Injectable sleep (threaded into the ssh backend polling). */
  readonly sleep?: (ms: number) => Promise<void>
  /** ssh report-poll interval (forwarded to the ssh backend). */
  readonly pollIntervalMs?: number
  /** ssh max polls (forwarded to the ssh backend). */
  readonly maxPolls?: number
}

const DEFAULTS = {
  region: "ap-northeast-2",
  // Prebaked AMI (available 2026-06-17, swe-bench-tools/bake-ami.sh): docker +
  // uv + all 84 easy-django swebench EVAL images pre-pulled into /var/lib/docker.
  // Boxes boot ready → no cloud-init install, no ~150GB image pull → grade
  // ~15min → ~3-5min. Stock fallback (clean Ubuntu): ami-0afe1fd15675c3f15.
  ami: "ami-04c2cdd2e17b15779",
  // 16 vCPU is plenty for the default grading concurrency (max_workers≈6) — the
  // prior 8xlarge (32 vCPU) paid for idle cores. ~$0.24/hr spot vs ~$0.5/hr.
  // Bump back to a larger type explicitly (--instance-type) only for high
  // max_workers. See cost notes in docs/swebench-ec2-runbook.md.
  instanceType: "c7i.4xlarge",
  keyName: "pickinstead_korea.pem",
  keyPath: "~/Downloads/pickinstead_korea.pem",
  subnetId: "subnet-9c13f1e7",
  vpcId: "vpc-4340a92a",
  sgName: "quanta-bench-sg",
  // 84 SWE-bench Verified django images ≈ 150 GB; 300 GB gp3 leaves headroom
  // for build layers while halving the prior 600 GB EBS cost + speeding init.
  diskGb: 300,
  ttlMinutes: 360,
} as const

/**
 * user-data bootstrap (mirrors the runbook). `shutdown -h +<ttl>` is the
 * runaway-cost backstop — combined with `--instance-initiated-shutdown-behavior
 * terminate` the box deletes itself if anything hangs. Installs docker + uv.
 */
const buildUserData = (ttlMinutes: number): string =>
  [
    "#!/bin/bash",
    "set -eux",
    `shutdown -h +${ttlMinutes}`,
    "apt-get update -y && apt-get install -y docker.io git python3-pip",
    "systemctl enable --now docker",
    "usermod -aG docker ubuntu",
    "su - ubuntu -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'",
    "",
  ].join("\n")

/** Pull the first non-empty trimmed token from aws cli `--output text`. */
const oneLine = (s: string): string => s.trim().split(/\s+/)[0] ?? ""

export const createEc2Backend = (cfg: Ec2BackendConfig = {}): GradeBackend => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? DEFAULTS.region
  const ami = cfg.ami ?? DEFAULTS.ami
  const instanceType = cfg.instanceType ?? DEFAULTS.instanceType
  const keyName = cfg.keyName ?? DEFAULTS.keyName
  const keyPath = cfg.keyPath ?? DEFAULTS.keyPath
  const subnetId = cfg.subnetId ?? DEFAULTS.subnetId
  const vpcId = cfg.vpcId ?? DEFAULTS.vpcId
  const sgName = cfg.sgName ?? DEFAULTS.sgName
  const onDemand = cfg.onDemand ?? false
  const diskGb = cfg.diskGb ?? DEFAULTS.diskGb
  const ttlMinutes = cfg.ttlMinutes ?? DEFAULTS.ttlMinutes
  const keep = cfg.keep ?? false
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const aws = (
    args: readonly string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    spawn("aws", ["--region", region, ...args])

  /** Stage 0: ensure the SG exists + :22 ingress from current public IP. */
  const ensureSecurityGroup = async (): Promise<string> => {
    // Find an existing SG by name (idempotent re-use across runs).
    const found = await aws([
      "ec2",
      "describe-security-groups",
      "--filters",
      `Name=group-name,Values=${sgName}`,
      "--query",
      "SecurityGroups[0].GroupId",
      "--output",
      "text",
    ])
    let sgId = oneLine(found.stdout)
    if (found.code !== 0 || sgId === "" || sgId === "None") {
      const created = await aws([
        "ec2",
        "create-security-group",
        "--group-name",
        sgName,
        "--description",
        "quanta bench grading box",
        "--vpc-id",
        vpcId,
        "--query",
        "GroupId",
        "--output",
        "text",
      ])
      if (created.code !== 0) {
        throw new Error(
          `[ec2-backend] create-security-group failed (code ${created.code}): ${created.stderr}`,
        )
      }
      sgId = oneLine(created.stdout)
    }

    // Authorize :22 from the current public IP only. ifconfig.me ⇒ public IP.
    const ipRes = await spawn("curl", ["-s", "ifconfig.me"])
    const myIp = oneLine(ipRes.stdout)
    // Validate it's actually an IPv4 — a failed/proxied curl can return an HTML
    // error page whose first token is non-empty but not an IP, which would build
    // a bogus `--cidr` and (since authorize errors were swallowed) leave the box
    // unreachable with only a misleading later timeout to show for it.
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(myIp)) {
      throw new Error(
        `[ec2-backend] could not determine a valid public IP via ifconfig.me (got "${myIp.slice(0, 60)}")`,
      )
    }
    // Idempotent: a DUPLICATE rule returns non-zero (InvalidPermission.Duplicate),
    // which we tolerate — the rule already being present is the desired state. A
    // REAL failure (wrong VPC / perms) must fail fast: otherwise the box launches
    // into an SG with no :22 and the only symptom is a 5-min ready-poll timeout.
    const auth = await aws([
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
        `[ec2-backend] authorize :22 ingress failed (code ${auth.code}): ${auth.stderr}`,
      )
    }
    return sgId
  }

  /** Stage 1: run-instances SPOT with the validated params. */
  const launchInstance = async (sgId: string): Promise<string> => {
    const userData = buildUserData(ttlMinutes)
    // Capacity resilience: do NOT pin a subnet/AZ unless the caller set one
    // (pinning an AZ is the #1 cause of InsufficientInstanceCapacity), and fall
    // back across instance types on a capacity error.
    // Fall back across same-class, similarly-priced 16-vCPU types on a spot
    // capacity error (NOT bigger/pricier ones — keep cost flat).
    const typeCandidates = [...new Set([instanceType, "c6i.4xlarge", "m7i.4xlarge", "c7i.2xlarge"])]
    const launchArgs = (it: string): string[] => [
      "ec2",
      "run-instances",
      "--image-id",
      ami,
      "--instance-type",
      it,
      "--key-name",
      keyName,
      ...(cfg.subnetId !== undefined ? ["--subnet-id", subnetId] : []),
      "--security-group-ids",
      sgId,
      // Spot (default, ~3× cheaper) ⇒ reclaimable; on-demand ⇒ no market option
      // (AWS default) ⇒ no reclaim, for capacity crunches.
      ...(onDemand ? [] : ["--instance-market-options", '{"MarketType":"spot"}']),
      "--metadata-options",
      "HttpTokens=required,HttpPutResponseHopLimit=1",
      "--instance-initiated-shutdown-behavior",
      "terminate",
      "--block-device-mappings",
      `[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":${diskGb},"VolumeType":"gp3","DeleteOnTermination":true}}]`,
      "--user-data",
      userData,
      "--tag-specifications",
      "ResourceType=instance,Tags=[{Key=Name,Value=quanta-bench}]",
      "--query",
      "Instances[0].InstanceId",
      "--output",
      "text",
    ]
    let lastErr = ""
    for (const it of typeCandidates) {
      const res = await aws(launchArgs(it))
      const iid = oneLine(res.stdout)
      if (res.code === 0 && iid !== "" && iid !== "None") return iid
      lastErr = res.stderr
      if (/InsufficientInstanceCapacity|capacity/i.test(res.stderr)) continue
      throw new Error(`[ec2-backend] run-instances failed (code ${res.code}): ${res.stderr}`)
    }
    throw new Error(
      `[ec2-backend] no spot capacity across ${typeCandidates.join(", ")}: ${lastErr}`,
    )
  }

  /** Stage 2: wait running, fetch public IP. */
  const waitForHost = async (iid: string): Promise<string> => {
    const wait = await aws(["ec2", "wait", "instance-running", "--instance-ids", iid])
    if (wait.code !== 0) {
      throw new Error(
        `[ec2-backend] wait instance-running failed (code ${wait.code}): ${wait.stderr}`,
      )
    }
    const desc = await aws([
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
      throw new Error(`[ec2-backend] no public IP for ${iid}: ${desc.stdout}`)
    }
    return ip
  }

  /** Stage 2.5: wait for sshd to accept connections AND cloud-init (docker + uv
   *  bootstrap) to finish. `instance-running` only means the VM booted — sshd
   *  and the user-data install run AFTER that, so delegating to scp immediately
   *  fails with "connection refused" (TCP reachable, no listener yet). Poll ssh
   *  until a trivial command succeeds, then block on `cloud-init status --wait`
   *  so docker/uv are present before grading. */
  const sshReadyArgs = (ip: string, remoteCmd: string): string[] => [
    "-i",
    keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "BatchMode=yes",
    `ubuntu@${ip}`,
    remoteCmd,
  ]
  const waitForSsh = async (ip: string): Promise<void> => {
    const maxAttempts = 90 // 90 × 5s = 7.5 min ceiling (cloud-init apt+docker install)
    for (let i = 0; i < maxAttempts; i++) {
      const r = await spawn("ssh", sshReadyArgs(ip, "echo READY"))
      if (r.code === 0 && /READY/.test(r.stdout)) {
        // sshd is up — now block until the user-data bootstrap (docker + uv) is done.
        await spawn("ssh", sshReadyArgs(ip, "cloud-init status --wait >/dev/null 2>&1 || true"))
        return
      }
      await sleep(5000)
    }
    throw new Error(
      `[ec2-backend] ssh not ready on ${ip} after ${maxAttempts} attempts (~7.5m). ` +
        `Box may be slow to bootstrap or :22 blocked.`,
    )
  }

  /** Stage 6: terminate + confirm. */
  const terminate = async (iid: string): Promise<void> => {
    const term = await aws(["ec2", "terminate-instances", "--instance-ids", iid])
    if (term.code !== 0) {
      throw new Error(
        `[ec2-backend] terminate-instances failed for ${iid} (code ${term.code}): ${term.stderr}. ` +
          `The ${ttlMinutes}m TTL backstop will still self-terminate the box.`,
      )
    }
  }

  const grade = async (predictionsPath: string, opts: GradeOptions): Promise<GradeOutcome> => {
    const maxWorkers = opts.maxWorkers ?? cfg.maxWorkers ?? DEFAULT_MAX_WORKERS
    const sgId = await ensureSecurityGroup()
    const iid = await launchInstance(sgId)
    try {
      const ip = await waitForHost(iid)
      await waitForSsh(ip) // sshd + cloud-init bootstrap ready before scp/grade
      // Stages 3–5: delegate to the ssh backend against the fresh box.
      const ssh = createSshBackend({
        host: `ubuntu@${ip}`,
        keyPath,
        maxWorkers,
        spawn,
        ...(cfg.modelName ? { modelName: cfg.modelName } : {}),
        ...(cfg.sleep ? { sleep: cfg.sleep } : {}),
        ...(cfg.pollIntervalMs !== undefined ? { pollIntervalMs: cfg.pollIntervalMs } : {}),
        ...(cfg.maxPolls !== undefined ? { maxPolls: cfg.maxPolls } : {}),
      })
      const outcome = await ssh.grade(predictionsPath, { ...opts, maxWorkers })
      if (!keep) await terminate(iid)
      return outcome
    } catch (err) {
      // Best-effort terminate on failure so a crashed grading run doesn't leak a
      // billable box (the TTL backstop is a fallback, not a substitute).
      if (!keep) {
        try {
          await terminate(iid)
        } catch {
          // swallow — surface the original error below
        }
      }
      throw err
    }
  }

  return { name: "ec2", grade }
}
