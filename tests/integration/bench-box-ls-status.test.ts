import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRY = "src/apps/bench/cli.ts"
const REPO = process.cwd()

let dir = ""
let fakeBin = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-box-ls-"))
  fakeBin = join(dir, "bin")
  mkdirSync(fakeBin)
  const aws = join(fakeBin, "aws")
  const ssh = join(fakeBin, "ssh")
  writeFileSync(
    aws,
    `#!/bin/sh
case " $* " in
  *" ec2 describe-instances "*)
    cat <<'EOF'
i-busy running 2026-06-20T00:00:00+00:00 1.2.3.4 c7i.8xlarge
i-idle running 2026-06-20T00:05:00+00:00 1.2.3.5 c7i.8xlarge
i-pending pending 2026-06-20T00:10:00+00:00 None c7i.8xlarge
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
  ubuntu@1.2.3.4::*"pgrep -f 'cli.ts run'"*)
    echo BUSY
    exit 0
    ;;
  ubuntu@1.2.3.5::*"pgrep -f 'cli.ts run'"*)
    echo IDLE
    exit 0
    ;;
  ubuntu@1.2.3.4::*"cat ~/.quanta/bench-box-status.json"*)
    cat <<'EOF'
{"phase":"running","mode":"pool","runId":"wave7-s0","workload":"wave7-s0","dataset":"wave7-s0.jsonl","instanceCount":16,"preset":"agentless-v2","model":"gpt-5.4","concurrency":16,"updatedAt":"2026-06-20T09:00:00.000Z","lastLogLine":"[PASS] demo__inst-1 (turns=2)"}
EOF
    exit 0
    ;;
  ubuntu@1.2.3.5::*"cat ~/.quanta/bench-box-status.json"*)
    cat <<'EOF'
{"phase":"idle","mode":"full-remote","workload":"django__django-11179","dataset":"single.jsonl","instanceCount":1,"preset":"agentless-v2-safe","model":"gpt-5.4","concurrency":16,"updatedAt":"2026-06-20T09:05:00.000Z","lastExitCode":0,"lastLogLine":"resolved 1 | unresolved 0"}
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

const runCli = async (...args: string[]): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  })
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`
  return { code: await proc.exited, out }
}

describe("bench box ls status view", () => {
  test("plain output shows lifecycle plus current workload details", async () => {
    const { code, out } = await runCli("box", "ls")
    expect(code).toBe(0)
    expect(out).toContain("[box] running boxes:")
    expect(out).toContain("i-busy  running  c7i.8xlarge  1.2.3.4  status=busy/running")
    expect(out).toContain("mode=pool  workload=wave7-s0  dataset=wave7-s0.jsonl")
    expect(out).toContain("log=[PASS] demo__inst-1 (turns=2)")
    expect(out).toContain("i-idle  running  c7i.8xlarge  1.2.3.5  status=idle/idle")
    expect(out).toContain("mode=full-remote  workload=django__django-11179")
    expect(out).toContain("i-pending  pending  c7i.8xlarge  None  status=bootstrapping")
  })

  test("--json returns machine-readable lifecycle/snapshot state", async () => {
    const { code, out } = await runCli("box", "ls", "--json")
    expect(code).toBe(0)
    const rows = JSON.parse(out) as Array<{
      iid: string
      lifecycle: string
      snapshot?: { mode?: string; runId?: string; workload?: string }
    }>
    expect(rows.find((r) => r.iid === "i-busy")).toEqual(
      expect.objectContaining({
        lifecycle: "busy",
        snapshot: expect.objectContaining({ mode: "pool", runId: "wave7-s0" }),
      }),
    )
    expect(rows.find((r) => r.iid === "i-idle")).toEqual(
      expect.objectContaining({
        lifecycle: "idle",
        snapshot: expect.objectContaining({ mode: "full-remote", workload: "django__django-11179" }),
      }),
    )
    expect(rows.find((r) => r.iid === "i-pending")).toEqual(
      expect.objectContaining({ lifecycle: "bootstrapping" }),
    )
  })
})
