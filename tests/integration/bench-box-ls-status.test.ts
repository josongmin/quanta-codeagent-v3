import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRY = "src/apps/bench/cli.ts"
const REPO = process.cwd()

let dir = ""
let fakeBin = ""
let budgetDir = ""
let badBudgetPath = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-box-ls-"))
  fakeBin = join(dir, "bin")
  mkdirSync(fakeBin)
  const aws = join(fakeBin, "aws")
  const ssh = join(fakeBin, "ssh")
  const now = Date.now()
  const busyLaunchAt = new Date(now - 10 * 60_000).toISOString()
  const idleLaunchAt = new Date(now - 8 * 60_000).toISOString()
  const probeLaunchAt = new Date(now - 11 * 60_000).toISOString()
  const pendingLaunchAt = new Date(now - 6 * 60_000).toISOString()
  const busyStartedAt = new Date(now - 4 * 60_000).toISOString()
  const busyUpdatedAt = new Date(now - 60_000).toISOString()
  const idleStartedAt = new Date(now - 3 * 60_000).toISOString()
  const idleUpdatedAt = new Date(now - 90_000).toISOString()
  const probeUpdatedAt = new Date(now - 75_000).toISOString()
  const budgetHeldAt = new Date(now - 30_000).toISOString()
  budgetDir = join(dir, "budget")
  mkdirSync(budgetDir)
  badBudgetPath = join(dir, "budget-bad-file")
  writeFileSync(
    join(budgetDir, "lease-demo.lease.json"),
    `${JSON.stringify({
      leaseId: "lease-demo",
      label: "pool:wave7",
      requestedUnits: 16,
      units: 12,
      pid: process.pid,
      acquiredAt: budgetHeldAt,
      heartbeatAt: budgetHeldAt,
    })}\n`,
  )
  writeFileSync(badBudgetPath, "not-a-directory\n")
  writeFileSync(
    aws,
    `#!/bin/sh
if [ "\${QUANTA_BOX_TEST_EMPTY:-0}" = "1" ]; then
  exit 0
fi
case " $* " in
  *" ec2 describe-instances "*)
    cat <<'EOF'
i-busy running ${busyLaunchAt} 1.2.3.4 c7i.8xlarge pool agentless-v2 gpt-5.4 wave7-s0.jsonl wave7-s0
i-idle running ${idleLaunchAt} 1.2.3.5 c7i.8xlarge full-remote agentless-v3-thin gpt-5.4 single.jsonl django__django-11179
i-probe running ${probeLaunchAt} 1.2.3.6 c7i.8xlarge pool agentless-v2 gpt-5.4 wave7-s1.jsonl wave7-s1
i-pending pending ${pendingLaunchAt} None c7i.8xlarge full-remote agentless-v3-thin gpt-5.4 pending.jsonl django__django-11179
EOF
    exit 0
    ;;
esac
echo "unexpected aws args: $*" >&2
exit 1
`,
  )
  writeFileSync(
    ssh,
    `#!/bin/sh
host=""
last=""
for arg in "$@"; do
  last="$arg"
  case "$arg" in
    ubuntu@*) host="$arg" ;;
  esac
done

case "$host::$last" in
  ubuntu@1.2.3.4::*"test -x ~/.bun/bin/bun"*)
    echo OK
    exit 0
    ;;
  ubuntu@1.2.3.5::*"test -x ~/.bun/bin/bun"*)
    echo OK
    exit 0
    ;;
  ubuntu@1.2.3.6::*"test -x ~/.bun/bin/bun"*)
    echo OK
    exit 0
    ;;
  ubuntu@1.2.3.4::*"pgrep -f 'cli.ts run'"*)
    echo BUSY
    exit 0
    ;;
  ubuntu@1.2.3.5::*"pgrep -f 'cli.ts run'"*)
    echo IDLE
    exit 0
    ;;
  ubuntu@1.2.3.6::*"pgrep -f 'cli.ts run'"*)
    echo BUSY
    exit 0
    ;;
  ubuntu@1.2.3.4::*"cat ~/.quanta/bench-box-status.json"*)
    cat <<'EOF'
{"phase":"running","mode":"pool","runId":"wave7-s0","accountLabel":"acct-a","workload":"wave7-s0","dataset":"wave7-s0.jsonl","instanceCount":16,"instancePreview":["demo__inst-1","demo__inst-2","demo__inst-3"],"preset":"agentless-v2","model":"gpt-5.4","concurrency":16,"startedAt":"${busyStartedAt}","updatedAt":"${busyUpdatedAt}","runLogPath":"~/runs/wave7-s0/run.log","reportPath":"~/runs/wave7-s0/report.json","predictionsPath":"~/runs/wave7-s0/preds.jsonl","observeDir":"~/runs/wave7-s0/observe","lspGrounding":{"backend":"pyright","language":"pyright-langserver","launch":"ok"},"lastLogLine":"[PASS] demo__inst-1 (turns=2)"}
EOF
    exit 0
    ;;
  ubuntu@1.2.3.5::*"cat ~/.quanta/bench-box-status.json"*)
    cat <<'EOF'
{"phase":"idle","mode":"full-remote","workload":"django__django-11179","dataset":"single.jsonl","instanceCount":1,"instancePreview":["django__django-11179"],"preset":"agentless-v3-thin","model":"gpt-5.4","concurrency":16,"startedAt":"${idleStartedAt}","updatedAt":"${idleUpdatedAt}","runLogPath":"~/run.log","reportPath":"~/report.json","predictionsPath":"~/preds.jsonl","observeDir":"~/observe","resolvedCount":1,"unresolvedCount":0,"erroredCount":0,"emptyPatchCount":0,"lastExitCode":0,"lspGrounding":{"backend":"pyright","language":"pyright-langserver","launch":"missing_binary","reason":"PYRIGHT_MISSING"},"lastLogLine":"resolved 1 | unresolved 0"}
EOF
    exit 0
    ;;
  ubuntu@1.2.3.6::*"cat ~/.quanta/bench-box-status.json"*)
    case "\${QUANTA_BOX_TEST_PROBE_SNAPSHOT_STATE:-missing}" in
      missing)
        printf '__QUANTA_BOX_SNAPSHOT_MISSING__\n'
        exit 0
        ;;
      invalid)
        echo '{"phase":"running"'
        exit 0
        ;;
      read-failed)
        echo "snapshot read failed" >&2
        exit 255
        ;;
    esac
    exit 1
    ;;
  ubuntu@1.2.3.4::*"__QUANTA_BOX_RUNTIME_PROBE__"*)
    cat <<'EOF'
{"activeRunDetected":true,"runLogPath":"~/runs/wave7-s0/run.log","runLogUpdatedAt":"${busyUpdatedAt}","reportPath":"~/runs/wave7-s0/report.json","reportExists":false,"predictionsPath":"~/runs/wave7-s0/preds.jsonl","predictionsLines":7,"observeDir":"~/runs/wave7-s0/observe","runExitPath":"~/runs/wave7-s0/run.exit","runExitExists":false,"lastLogLine":"[PASS] demo__inst-1 (turns=2)"}
EOF
    exit 0
    ;;
  ubuntu@1.2.3.5::*"__QUANTA_BOX_RUNTIME_PROBE__"*)
    cat <<'EOF'
{"activeRunDetected":false,"runLogPath":"~/run.log","runLogUpdatedAt":"${idleUpdatedAt}","reportPath":"~/report.json","reportExists":true,"predictionsPath":"~/preds.jsonl","predictionsLines":1,"observeDir":"~/observe","runExitPath":"~/run.exit","runExitExists":true,"lastLogLine":"resolved 1 | unresolved 0"}
EOF
    exit 0
    ;;
  ubuntu@1.2.3.6::*"__QUANTA_BOX_RUNTIME_PROBE__"*)
    cat <<'EOF'
{"activeRunDetected":true,"runLogPath":"~/run.log","runLogUpdatedAt":"${probeUpdatedAt}","reportPath":"~/report.json","reportExists":false,"predictionsPath":"~/preds.jsonl","predictionsLines":84,"observeDir":"~/observe","runExitPath":"~/run.exit","runExitExists":false,"lastLogLine":"[warn] pyright warm-up budget exhausted"}
EOF
    exit 0
    ;;
  ubuntu@1.2.3.4::*"tail -n 80 ~/runs/wave7-s0/run.log"*)
    cat <<'EOF'
[info] bench(swebench): 16 task(s), provider=chatgpt-oauth
[PASS] demo__inst-1 (turns=2)
EOF
    exit 0
    ;;
  ubuntu@1.2.3.4::*"tail -n 5 ~/runs/wave7-s0/run.log"*)
    cat <<'EOF'
[PASS] demo__inst-1 (turns=2)
EOF
    exit 0
    ;;
  ubuntu@1.2.3.6::*"tail -n 80 ~/run.log"*)
    cat <<'EOF'
[info] bench(swebench): 16 task(s), provider=chatgpt-oauth
[warn] pyright warm-up budget exhausted
EOF
    exit 0
    ;;
  ubuntu@1.2.3.6::*"tail -n 5 ~/run.log"*)
    cat <<'EOF'
[warn] pyright warm-up budget exhausted
EOF
    exit 0
    ;;
esac

echo "unexpected ssh host/cmd: $host :: $last" >&2
exit 1
`,
  )
  chmodSync(aws, 0o755)
  chmodSync(ssh, 0o755)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const runCli = async (
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      QUANTA_BENCH_TOKEN_BUDGET_DIR: env.QUANTA_BENCH_TOKEN_BUDGET_DIR ?? budgetDir,
    },
  })
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
  return { code: await proc.exited, out }
}

describe("bench box ls status view", () => {
  test("plain output shows lifecycle plus current workload details", async () => {
    const { code, out } = await runCli(["box", "ls"])
    expect(code).toBe(0)
    expect(out).toContain("[box] running boxes:")
    expect(out).toContain("i-busy  running  c7i.8xlarge  1.2.3.4  status=busy/running")
    expect(out).toContain(
      "source=snapshot  mode=pool  account=acct-a  workload=wave7-s0  dataset=wave7-s0.jsonl",
    )
    // LSP-02: typed grounding status renders as its own line, NOT inferred from
    // the log tail. (Red-on-injection: drop the renderer wiring and this line
    // disappears.)
    expect(out).toContain("lsp=pyright/pyright-langserver launch=ok")
    expect(out).toContain("log=[PASS] demo__inst-1 (turns=2)")
    expect(out).toContain("i-idle  running  c7i.8xlarge  1.2.3.5  status=idle/idle")
    expect(out).toContain("source=snapshot  mode=full-remote  workload=django__django-11179")
    // LSP-02: the box's LAUNCH probe (`pyright --version`) distinguishes
    // missing_binary from ok as a TYPED line — RCA reads the enum, not the
    // "resolved 1" log tail. (The box probe is launch-only; per-instance ready
    // outcomes like ready_timeout live in report.json, surfaced via the
    // lsp-grounding-summary aggregator — not the box snapshot.)
    expect(out).toContain("lsp=pyright/pyright-langserver launch=missing_binary: PYRIGHT_MISSING")
    expect(out).toContain("i-probe  running  c7i.8xlarge  1.2.3.6  status=busy")
    expect(out).toContain(
      "source=probe  snapshot=write-failed  active=yes  report=no  runExit=no  preds=84",
    )
    expect(out).toContain("i-pending  pending  c7i.8xlarge  None  status=bootstrapping")
    expect(out).toContain(
      "source=launch-tags  snapshot=not-ready  mode=full-remote  preset=agentless-v3-thin  model=gpt-5.4  dataset=pending.jsonl  selection=django__django-11179",
    )
  })

  test("--json returns machine-readable lifecycle/snapshot state", async () => {
    const { code, out } = await runCli(["box", "ls", "--json"])
    expect(code).toBe(0)
    const rows = JSON.parse(out) as Array<{
      iid: string
      lifecycle: string
      freshness?: string
      statusSource?: string
      logPath?: string
      followHint?: string
      snapshot?: {
        mode?: string
        runId?: string
        workload?: string
        runLogPath?: string
        reportPath?: string
      }
      probe?: {
        activeRunDetected?: boolean
        predictionsLines?: number
        runLogPath?: string
      }
    }>
    expect(rows.find((r) => r.iid === "i-busy")).toEqual(
      expect.objectContaining({
        lifecycle: "busy",
        freshness: "fresh",
        statusSource: "snapshot",
        logPath: "~/runs/wave7-s0/run.log",
        followHint: expect.stringContaining("box logs i-busy --follow"),
        snapshot: expect.objectContaining({
          mode: "pool",
          runId: "wave7-s0",
          accountLabel: "acct-a",
          runLogPath: "~/runs/wave7-s0/run.log",
          reportPath: "~/runs/wave7-s0/report.json",
        }),
      }),
    )
    expect(rows.find((r) => r.iid === "i-idle")).toEqual(
      expect.objectContaining({
        lifecycle: "idle",
        freshness: "fresh",
        statusSource: "snapshot",
        logPath: "~/run.log",
        snapshot: expect.objectContaining({
          mode: "full-remote",
          workload: "django__django-11179",
          runLogPath: "~/run.log",
        }),
      }),
    )
    expect(rows.find((r) => r.iid === "i-probe")).toEqual(
      expect.objectContaining({
        lifecycle: "busy",
        freshness: "fresh",
        statusSource: "probe",
        logPath: "~/run.log",
        probe: expect.objectContaining({
          activeRunDetected: true,
          predictionsLines: 84,
          runLogPath: "~/run.log",
        }),
      }),
    )
    expect(rows.find((r) => r.iid === "i-pending")).toEqual(
      expect.objectContaining({
        lifecycle: "bootstrapping",
        freshness: "unknown",
        statusSource: "launch-tags",
        launchMode: "full-remote",
        launchPreset: "agentless-v3-thin",
        launchModel: "gpt-5.4",
        launchDataset: "pending.jsonl",
        launchSelection: "django__django-11179",
      }),
    )
  })

  test("box status prints operator summary with a recommended target", async () => {
    const { code, out } = await runCli(["box", "status"])
    expect(code).toBe(0)
    expect(out).toContain("[box] summary:")
    expect(out).toContain(
      "total=4  busy=2  idle=1  bootstrapping=1  unreachable=0  stale=0  snapshotIssues=2  snapshotStates=write-failed:1,not-ready:1",
    )
    expect(out).toContain("patchGenBudget=12/16  available=4  holders=1  leases=pool:wave7:12")
    expect(out).toContain("target=i-busy  status=busy/running  source=snapshot")
    expect(out).toContain("follow=bun run src/apps/bench/cli.ts box logs i-busy --follow")
  })

  test("box status --json exposes summary plus full rows", async () => {
    const { code, out } = await runCli(["box", "status", "--json"])
    expect(code).toBe(0)
    const parsed = JSON.parse(out) as {
      summary: {
        total: number
        busy: number
        idle: number
        bootstrapping: number
        stale: number
        snapshotIssues?: number
        snapshotStateCounts?: Record<string, number>
        target?: string
      }
      budget?: {
        limit: number
        inUse: number
        available: number
        leases: Array<{ label: string; units: number }>
      }
      boxes: Array<{ iid: string }>
    }
    expect(parsed.summary).toEqual(
      expect.objectContaining({
        total: 4,
        busy: 2,
        idle: 1,
        bootstrapping: 1,
        stale: 0,
        snapshotIssues: 2,
        snapshotStateCounts: { "write-failed": 1, "not-ready": 1 },
        target: "i-busy",
      }),
    )
    expect(parsed.budget).toEqual(
      expect.objectContaining({
        limit: 16,
        inUse: 12,
        available: 4,
        leases: [expect.objectContaining({ label: "pool:wave7", units: 12 })],
      }),
    )
    expect(parsed.boxes.map((row) => row.iid)).toEqual(["i-pending", "i-idle", "i-busy", "i-probe"])
  })

  test("box status --json surfaces write-failed snapshots when runtime probe proves the run is active", async () => {
    const { code, out } = await runCli(["box", "status", "--json"])
    expect(code).toBe(0)
    const parsed = JSON.parse(out) as {
      boxes: Array<{
        iid: string
        snapshotHealthy?: boolean
        snapshotState?: string
        statusSource?: string
      }>
    }
    expect(parsed.boxes.find((row) => row.iid === "i-probe")).toEqual(
      expect.objectContaining({
        statusSource: "probe",
        snapshotHealthy: false,
        snapshotState: "write-failed",
      }),
    )
    expect(parsed.boxes.find((row) => row.iid === "i-pending")).toEqual(
      expect.objectContaining({
        statusSource: "launch-tags",
        snapshotHealthy: false,
        snapshotState: "not-ready",
      }),
    )
  })

  test("box status --json distinguishes invalid snapshot payloads from missing snapshots", async () => {
    const { code, out } = await runCli(["box", "status", "--json"], {
      QUANTA_BOX_TEST_PROBE_SNAPSHOT_STATE: "invalid",
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(out) as {
      boxes: Array<{
        iid: string
        snapshotHealthy?: boolean
        snapshotState?: string
        statusSource?: string
      }>
    }
    expect(parsed.boxes.find((row) => row.iid === "i-probe")).toEqual(
      expect.objectContaining({
        statusSource: "probe",
        snapshotHealthy: false,
        snapshotState: "invalid",
      }),
    )
  })

  test("box status --json distinguishes read-failed snapshots from missing snapshots", async () => {
    const { code, out } = await runCli(["box", "status", "--json"], {
      QUANTA_BOX_TEST_PROBE_SNAPSHOT_STATE: "read-failed",
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(out) as {
      boxes: Array<{
        iid: string
        snapshotHealthy?: boolean
        snapshotState?: string
        statusSource?: string
      }>
    }
    expect(parsed.boxes.find((row) => row.iid === "i-probe")).toEqual(
      expect.objectContaining({
        statusSource: "probe",
        snapshotHealthy: false,
        snapshotState: "read-failed",
      }),
    )
  })

  test("box status still surfaces budget truth when no boxes are running", async () => {
    const { code, out } = await runCli(["box", "status", "--json"], {
      QUANTA_BOX_TEST_EMPTY: "1",
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(out) as {
      summary: {
        total: number
        busy: number
        idle: number
        bootstrapping: number
        stale: number
        snapshotIssues?: number
        snapshotStateCounts?: Record<string, number>
      }
      budget?: { inUse: number; limit: number; available: number }
      boxes: Array<unknown>
    }
    expect(parsed.summary).toEqual(
      expect.objectContaining({
        total: 0,
        busy: 0,
        idle: 0,
        bootstrapping: 0,
        stale: 0,
        snapshotIssues: 0,
        snapshotStateCounts: {},
      }),
    )
    expect(parsed.budget).toEqual(
      expect.objectContaining({
        inUse: 12,
        limit: 16,
        available: 4,
      }),
    )
    expect(parsed.boxes).toEqual([])
  })

  test("box status surfaces token-budget read failures instead of silently hiding them", async () => {
    const { code, out } = await runCli(["box", "status", "--json"], {
      QUANTA_BENCH_TOKEN_BUDGET_DIR: badBudgetPath,
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(out) as {
      summary: { total: number }
      budget?: unknown
      budgetError?: string
    }
    expect(parsed.summary.total).toBe(4)
    expect(parsed.budget).toBeUndefined()
    expect(parsed.budgetError).toMatch(/patch-gen budget/i)
  })

  test("plain box status prints an explicit budget error line", async () => {
    const { code, out } = await runCli(["box", "status"], {
      QUANTA_BENCH_TOKEN_BUDGET_DIR: badBudgetPath,
    })
    expect(code).toBe(0)
    expect(out).toContain("patchGenBudget=unavailable")
    expect(out).toMatch(/patch-gen budget/i)
  })

  test("box logs tails the resolved log path for the selected box", async () => {
    const { code, out } = await runCli(["box", "logs", "busy"])
    expect(code).toBe(0)
    expect(out).toContain("[box] i-busy  ubuntu@1.2.3.4")
    expect(out).toContain("logPath=~/runs/wave7-s0/run.log")
    expect(out).toContain("--- tail -n 80 ---")
    expect(out).toContain("[info] bench(swebench): 16 task(s), provider=chatgpt-oauth")
    expect(out).toContain("[PASS] demo__inst-1 (turns=2)")
  })

  test("box logs --json exposes machine-readable tail metadata", async () => {
    const { code, out } = await runCli(["box", "logs", "busy", "--json", "--lines", "5"])
    expect(code).toBe(0)
    const parsed = JSON.parse(out) as {
      iid: string
      logPath: string
      followHint: string
      lines: number
      snapshot?: { runId?: string }
      tail: string
    }
    expect(parsed.iid).toBe("i-busy")
    expect(parsed.logPath).toBe("~/runs/wave7-s0/run.log")
    expect(parsed.lines).toBe(5)
    expect(parsed.followHint).toContain("box logs i-busy --follow")
    expect(parsed.snapshot?.runId).toBe("wave7-s0")
    expect(parsed.tail).toContain("[PASS] demo__inst-1 (turns=2)")
  })

  test("box logs falls back to probe metadata when the runtime-visible snapshot write failed", async () => {
    const { code, out } = await runCli(["box", "logs", "i-probe"])
    expect(code).toBe(0)
    expect(out).toContain("[box] i-probe  ubuntu@1.2.3.6")
    expect(out).toContain("source=probe  snapshot=write-failed")
    expect(out).toContain("logPath=~/run.log")
    expect(out).toContain("[warn] pyright warm-up budget exhausted")
  })

  test("box logs explains when a bootstrapping box has no run log yet", async () => {
    const { code, out } = await runCli(["box", "logs", "i-pending"])
    expect(code).toBe(0)
    expect(out).toContain("status=bootstrapping")
    expect(out).toContain("source=launch-tags  snapshot=not-ready")
    expect(out).toContain("dataset=pending.jsonl")
    expect(out).toContain("run log not created yet; box is still bootstrapping")
  })
})
