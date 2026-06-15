/**
 * Full-remote executor (ADR-0536 §6 / P3) — runs BOTH patch-gen and grading on
 * a fresh EC2 box, for fully-detached long runs.
 *
 * ⚠️ SECURITY: full-remote needs an LLM credential ON the box (it runs the
 * agent, which executes model-generated code). The hardening here is mandatory:
 *   - only the SHORT-LIVED `access_token` is shipped — `refresh_token`/`id_token`
 *     are STRIPPED ({@link stripToAccessToken}); a leaked access_token expires
 *     and cannot mint new ones;
 *   - the token is piped over `ssh` STDIN (never a CLI arg / `ps` / local temp
 *     file / rsync artifact);
 *   - the box enforces IMDSv2 hop-1 (no metadata-credential pivot) + a
 *     `shutdown -h +<ttl>` self-terminate backstop, and is ALWAYS terminated
 *     (even on failure).
 *
 * NOTE: actually invoking `run()` ships a credential across a trust boundary and
 * may be blocked by the harness; that's by design. The executor + its security
 * invariants are fully unit-tested offline via an injected {@link SpawnFn}.
 */
import { defaultSpawn, parseSwebenchReport, type SpawnFn } from "./backend"

export interface FullRemoteConfig {
  /** Local quanta repo to rsync to the box (excludes node_modules/.git). */
  readonly repoDir: string
  /** RAW chatgpt.json content (the caller reads it; we strip it here). */
  readonly authJson: string
  /** Local swebench instances.jsonl. */
  readonly datasetPath: string
  /** Subset to run (default: all rows in the dataset). */
  readonly instanceIds?: readonly string[]
  /** Bench preset. Default `agentless-v1`. */
  readonly preset?: string
  /** Model id (predictions/report naming). Default `gpt-5.4`. */
  readonly model?: string
  readonly dryRun?: boolean
  readonly spawn?: SpawnFn
  /** Progress sink — called at each stage so a long run isn't a silent black box. */
  readonly onLog?: (msg: string) => void
  /** Injectable sleep (test seam — default real setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>
  /** Max cloud-init readiness polls (test seam — default 30 × 10s ≈ 5min). */
  readonly maxReadyPolls?: number
  readonly region?: string
  readonly ami?: string
  readonly instanceType?: string
  readonly keyName?: string
  readonly keyPath?: string
  readonly subnetId?: string
  readonly vpcId?: string
  readonly sgName?: string
  readonly diskGb?: number
  readonly ttlMinutes?: number
  readonly keep?: boolean
}

const D = {
  region: "ap-northeast-2",
  ami: "ami-0afe1fd15675c3f15",
  instanceType: "c7i.8xlarge",
  keyName: "pickinstead_korea.pem",
  keyPath: "~/Downloads/pickinstead_korea.pem",
  subnetId: "subnet-9c13f1e7",
  vpcId: "vpc-4340a92a",
  sgName: "quanta-bench-sg",
  diskGb: 600,
  ttlMinutes: 180,
  preset: "agentless-v1",
  model: "gpt-5.4",
} as const

/**
 * Reduce a chatgpt.json to the MINIMUM the box needs: the short-lived
 * `access_token` + non-secret account fields. The long-lived `refresh_token`
 * and `id_token` are dropped so a box compromise can't mint fresh credentials.
 */
export const stripToAccessToken = (authJson: string): string => {
  const parsed = JSON.parse(authJson) as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const k of ["access_token", "account_id", "expires_at", "last_refresh", "plan_type"]) {
    if (parsed[k] !== undefined) safe[k] = parsed[k]
  }
  return JSON.stringify(safe)
}

const oneLine = (s: string): string => s.trim().split(/\s+/)[0] ?? ""

const userData = (ttl: number): string =>
  [
    "#!/bin/bash",
    "set -eux",
    `shutdown -h +${ttl}`,
    "apt-get update -y && apt-get install -y docker.io git curl unzip",
    "systemctl enable --now docker",
    "usermod -aG docker ubuntu",
    "su - ubuntu -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'",
    "su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'",
  ].join("\n")

export interface FullRemoteResult {
  readonly reportPath?: string
  readonly resolved?: readonly string[]
  readonly unresolved?: readonly string[]
  readonly errored?: readonly string[]
  readonly emptyPatch?: readonly string[]
  readonly dryRun?: boolean
  readonly plan?: readonly string[]
}

export const createFullRemoteBackend = (
  cfg: FullRemoteConfig,
): { run: () => Promise<FullRemoteResult> } => {
  const spawn = cfg.spawn ?? defaultSpawn
  const region = cfg.region ?? D.region
  const keyPath = cfg.keyPath ?? D.keyPath
  const ttl = cfg.ttlMinutes ?? D.ttlMinutes
  const preset = cfg.preset ?? D.preset
  const model = cfg.model ?? D.model
  const keep = cfg.keep ?? false
  const log = cfg.onLog ?? (() => {})

  const sgName = cfg.sgName ?? D.sgName
  const vpcId = cfg.vpcId ?? D.vpcId
  const aws = (args: readonly string[]) => spawn("aws", ["--region", region, ...args])
  /** ssh helper bound to the resolved host (`ubuntu@<ip>`). Token, when given,
   *  goes over STDIN — never an argv. Short connect-timeout so a closed :22
   *  fails fast instead of the default ~2min hang. */
  const sshTo = (host: string, remoteCmd: string, input?: string) =>
    spawn(
      "ssh",
      [
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        host,
        remoteCmd,
      ],
      ...(input !== undefined ? [{ input }] : []),
    )

  /** Find-or-create the SG + authorize :22 from the current public IP. Without
   *  this the box lands in the default SG (no inbound :22) ⇒ ssh times out. */
  const ensureSecurityGroup = async (): Promise<string> => {
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
    const ipRes = await spawn("curl", ["-s", "ifconfig.me"])
    const myIp = oneLine(ipRes.stdout)
    if (myIp === "") throw new Error("[full-remote] could not determine public IP via ifconfig.me")
    // Idempotent — a duplicate rule returns non-zero, which we tolerate.
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

  const plan = (): readonly string[] => [
    `[dry-run] would launch ${cfg.instanceType ?? D.instanceType} spot (IMDSv2 hop-1, shutdown -h +${ttl})`,
    `[dry-run] would rsync ${cfg.repoDir} (excl node_modules/.git) + bun install`,
    "[dry-run] would ship STRIPPED token over ssh stdin (access_token only; refresh/id dropped)",
    `[dry-run] would run: bun run bench run --swebench <dataset> --grade-backend local (preset=${preset})`,
    "[dry-run] would scp report+observe back, then terminate the box",
  ]

  const run = async (): Promise<FullRemoteResult> => {
    if (cfg.dryRun) return { dryRun: true, plan: plan() }

    log("[full-remote] ensuring security group (:22 from your IP)…")
    const sgId = await ensureSecurityGroup()
    log("[full-remote] launching hardened spot box (IMDSv2 hop-1, TTL self-terminate)…")
    // Stage 0/1: launch a hardened spot box.
    const launch = await aws([
      "ec2",
      "run-instances",
      "--image-id",
      cfg.ami ?? D.ami,
      "--instance-type",
      cfg.instanceType ?? D.instanceType,
      "--key-name",
      cfg.keyName ?? D.keyName,
      "--subnet-id",
      cfg.subnetId ?? D.subnetId,
      "--security-group-ids",
      sgId,
      "--instance-market-options",
      '{"MarketType":"spot"}',
      "--metadata-options",
      "HttpTokens=required,HttpPutResponseHopLimit=1",
      "--instance-initiated-shutdown-behavior",
      "terminate",
      "--block-device-mappings",
      `[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":${cfg.diskGb ?? D.diskGb},"VolumeType":"gp3","DeleteOnTermination":true}}]`,
      "--user-data",
      userData(ttl),
      "--tag-specifications",
      "ResourceType=instance,Tags=[{Key=Name,Value=quanta-bench-full}]",
      "--query",
      "Instances[0].InstanceId",
      "--output",
      "text",
    ])
    const iid = oneLine(launch.stdout)
    if (launch.code !== 0 || iid === "" || iid === "None") {
      throw new Error(`[full-remote] run-instances failed (code ${launch.code}): ${launch.stderr}`)
    }

    const terminate = async (): Promise<void> => {
      if (!keep) await aws(["ec2", "terminate-instances", "--instance-ids", iid])
    }

    log(`[full-remote] instance ${iid} — waiting for running…`)
    try {
      await aws(["ec2", "wait", "instance-running", "--instance-ids", iid])
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
        throw new Error(`[full-remote] no public IP for ${iid}: ${desc.stdout}`)
      }
      const host = `ubuntu@${ip}`
      log(`[full-remote] box up at ${ip}. Waiting for cloud-init (docker+bun+uv ~2-3min)…`)

      // Wait until SSH is reachable AND cloud-init finished installing bun —
      // instance-running ≠ bootstrap-done. Poll up to ~5min.
      const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
      const maxReadyPolls = cfg.maxReadyPolls ?? 30
      let ready = false
      for (let i = 0; i < maxReadyPolls; i++) {
        const probe = await sshTo(
          host,
          "sudo cloud-init status --wait >/dev/null 2>&1; test -x ~/.bun/bin/bun && echo READY",
        )
        if (probe.code === 0 && probe.stdout.includes("READY")) {
          ready = true
          break
        }
        await sleep(10_000)
      }
      if (!ready)
        throw new Error(
          "[full-remote] box never became ssh-reachable + bun-ready (check SG :22 / cloud-init)",
        )

      log("[full-remote] bootstrapped. Rsyncing repo (excl node_modules/.git/.env/.quanta)…")
      // Bootstrap: sync repo + deps. Exclude node_modules/.git AND any local
      // secret stores (.env / .quanta) so we never ship UNRELATED credentials.
      const rsynced = await spawn("rsync", [
        "-az",
        "--exclude",
        "node_modules",
        "--exclude",
        ".git",
        "--exclude",
        ".env",
        "--exclude",
        ".env.*",
        "--exclude",
        ".quanta",
        "-e",
        `ssh -i ${keyPath} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15`,
        `${cfg.repoDir}/`,
        `${host}:~/quanta/`,
      ])
      if (rsynced.code !== 0) {
        throw new Error(`[full-remote] rsync failed (code ${rsynced.code}): ${rsynced.stderr}`)
      }
      log("[full-remote] rsynced repo; running bun install on box…")
      const installed = await sshTo(host, "cd ~/quanta && ~/.bun/bin/bun install 2>&1 | tail -3")
      if (installed.code !== 0) {
        throw new Error(
          `[full-remote] bun install failed (code ${installed.code}): ${installed.stdout}${installed.stderr}`,
        )
      }
      const scpDs = await spawn("scp", [
        "-i",
        keyPath,
        "-o",
        "ConnectTimeout=15",
        cfg.datasetPath,
        `${host}:~/instances.jsonl`,
      ])
      if (scpDs.code !== 0) {
        throw new Error(`[full-remote] scp dataset failed (code ${scpDs.code}): ${scpDs.stderr}`)
      }

      // Ship the STRIPPED token over ssh STDIN (never an arg / temp file).
      log("[full-remote] shipping stripped token (access_token only) over ssh stdin…")
      const shipped = await sshTo(
        host,
        "mkdir -p ~/.quanta/auth && cat > ~/.quanta/auth/chatgpt.json",
        stripToAccessToken(cfg.authJson),
      )
      if (shipped.code !== 0) {
        throw new Error(`[full-remote] token ship failed (code ${shipped.code}): ${shipped.stderr}`)
      }

      // Run patch-gen + grading ON the box (full remote). Tee to ~/run.log so the
      // operator can watch live from another terminal.
      const idsFlag =
        cfg.instanceIds && cfg.instanceIds.length > 0
          ? ` --instance ${cfg.instanceIds.join(",")}`
          : ""
      log(
        `[full-remote] running patch-gen + grading on box (minutes). Watch live:\n` +
          `    ssh -i ${keyPath} ${host} 'tail -f ~/run.log'`,
      )
      const remoteRun = await sshTo(
        host,
        `cd ~/quanta && QUANTA_BENCH_PRESET=${preset} QUANTA_PROVIDER=chatgpt-oauth QUANTA_SWEBENCH_PYTHON=1 ` +
          `QUANTA_SWEBENCH_PYTHON_BIN="$HOME/.local/bin/uvx" ` +
          `~/.bun/bin/bun run src/apps/bench/cli.ts run --swebench ~/instances.jsonl${idsFlag} ` +
          `--model ${model} --predictions ~/preds.jsonl --report ~/report.json 2>&1 | tee ~/run.log`,
      )
      if (remoteRun.code !== 0) {
        throw new Error(
          `[full-remote] remote bench run failed (code ${remoteRun.code}): ${remoteRun.stderr}`,
        )
      }

      log("[full-remote] run done; fetching report + terminating box…")
      const fetched = await sshTo(host, "cat ~/report.json")
      let parsed: ReturnType<typeof parseSwebenchReport> = {
        resolved: [],
        unresolved: [],
        errored: [],
        emptyPatch: [],
      }
      try {
        parsed = parseSwebenchReport(JSON.parse(fetched.stdout))
      } catch {
        // leave empty — surfaced as no verdicts
      }
      await terminate()
      return { reportPath: "~/report.json", ...parsed }
    } catch (err) {
      await terminate().catch(() => undefined)
      throw err
    }
  }

  return { run }
}
