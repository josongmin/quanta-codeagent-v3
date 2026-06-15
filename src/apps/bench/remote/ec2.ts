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
  type GradeBackend,
  type GradeOptions,
  type GradeOutcome,
  type SpawnFn,
  defaultSpawn,
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
  readonly maxWorkers?: number
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
  ami: "ami-0afe1fd15675c3f15",
  instanceType: "c7i.8xlarge",
  keyName: "pickinstead_korea.pem",
  keyPath: "~/Downloads/pickinstead_korea.pem",
  subnetId: "subnet-9c13f1e7",
  vpcId: "vpc-4340a92a",
  sgName: "quanta-bench-sg",
  diskGb: 600,
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
  const diskGb = cfg.diskGb ?? DEFAULTS.diskGb
  const ttlMinutes = cfg.ttlMinutes ?? DEFAULTS.ttlMinutes
  const keep = cfg.keep ?? false

  const aws = (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
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
        throw new Error(`[ec2-backend] create-security-group failed (code ${created.code}): ${created.stderr}`)
      }
      sgId = oneLine(created.stdout)
    }

    // Authorize :22 from the current public IP only. ifconfig.me ⇒ public IP.
    const ipRes = await spawn("curl", ["-s", "ifconfig.me"])
    const myIp = oneLine(ipRes.stdout)
    if (myIp === "") {
      throw new Error("[ec2-backend] could not determine public IP via ifconfig.me")
    }
    // Idempotent: a duplicate rule returns non-zero (InvalidPermission.Duplicate)
    // which we tolerate — the rule already being present is the desired state.
    await aws([
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
    return sgId
  }

  /** Stage 1: run-instances SPOT with the validated params. */
  const launchInstance = async (sgId: string): Promise<string> => {
    const userData = buildUserData(ttlMinutes)
    const res = await aws([
      "ec2",
      "run-instances",
      "--image-id",
      ami,
      "--instance-type",
      instanceType,
      "--key-name",
      keyName,
      "--subnet-id",
      subnetId,
      "--security-group-ids",
      sgId,
      "--instance-market-options",
      '{"MarketType":"spot"}',
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
    ])
    if (res.code !== 0) {
      throw new Error(`[ec2-backend] run-instances failed (code ${res.code}): ${res.stderr}`)
    }
    const iid = oneLine(res.stdout)
    if (iid === "" || iid === "None") {
      throw new Error(`[ec2-backend] run-instances returned no instance id: ${res.stdout}`)
    }
    return iid
  }

  /** Stage 2: wait running, fetch public IP. */
  const waitForHost = async (iid: string): Promise<string> => {
    const wait = await aws(["ec2", "wait", "instance-running", "--instance-ids", iid])
    if (wait.code !== 0) {
      throw new Error(`[ec2-backend] wait instance-running failed (code ${wait.code}): ${wait.stderr}`)
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
      // Stages 3–5: delegate to the ssh backend against the fresh box.
      const ssh = createSshBackend({
        host: `ubuntu@${ip}`,
        keyPath,
        maxWorkers,
        spawn,
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
