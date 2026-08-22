/**
 * Epic-2 — run_tests fault/false-green hellgate via an injected fake spawn port
 * (no real toolchain). The CRITICAL property for a test runner: a suite that
 * failed to BUILD/RUN must NEVER report ok:true (false green). Adversarial-audit
 * remediation: the exit-code safety net + go build-fail capture.
 */
import { describe, expect, test } from "bun:test"
import type { FileSystemPort } from "@/storage"
import { makeRunTestsTool, type TestRunPort } from "@/tool/testrun/tool"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const fsWith = (present: string[]): FileSystemPort =>
  ({ fileExists: async (name: string) => present.includes(name) }) as unknown as FileSystemPort

const portReturning = (out: {
  stdout?: string
  stderr?: string
  exitCode: number
}): TestRunPort => ({
  run: async () => ({ stdout: out.stdout ?? "", stderr: out.stderr ?? "", exitCode: out.exitCode }),
})

const run = async (tool: ReturnType<typeof makeRunTestsTool>, cwd = "/p"): Promise<ToolResult> => {
  const ctx = { cwd, signal: new AbortController().signal } as ToolContext
  let r: ToolResult | undefined
  for await (const ev of tool.execute({} as never, ctx) as AsyncIterable<ToolEvent>)
    if (ev.type === "result") r = ev.result
  if (r === undefined) throw new Error("no result")
  return r
}

describe("run_tests — false-green & fault hellgate", () => {
  test("GO COMPILE ERROR (build-fail, exit 1) ⇒ ok:false, NEVER a false green", async () => {
    const buildFail = [
      '{"ImportPath":"t [t.test]","Action":"build-output","Output":"./x_test.go:3:27: undefined: foo\\n"}',
      '{"ImportPath":"t [t.test]","Action":"build-fail"}',
      '{"Action":"output","Package":"t","Output":"FAIL\\tt [build failed]\\n"}',
      '{"Action":"fail","Package":"t","Elapsed":0,"FailedBuild":"t [t.test]"}',
    ].join("\n")
    const tool = makeRunTestsTool({
      fs: fsWith(["go.mod"]),
      port: portReturning({ stdout: buildFail, exitCode: 1 }),
    })
    const r = await run(tool)
    expect(r.ok).toBe(false) // the keystone: a build failure is NOT a pass
    expect(r.output.toLowerCase()).toContain("fail")
  })

  test("non-zero exit with NO parsed failures ⇒ safety net forces ok:false", async () => {
    // A runner that fails for a reason the parser doesn't model (e.g. cargo
    // panics before any test) must not slip through as green.
    const tool = makeRunTestsTool({
      fs: fsWith(["Cargo.toml"]),
      port: portReturning({ stdout: "weird output", exitCode: 101 }),
    })
    const r = await run(tool)
    expect(r.ok).toBe(false)
  })

  test("all-pass suite (exit 0) ⇒ ok:true", async () => {
    const goPass = [
      '{"Action":"pass","Test":"TestA"}',
      '{"Action":"pass","Test":"TestB"}',
      '{"Action":"pass","Package":"t"}',
    ].join("\n")
    const tool = makeRunTestsTool({
      fs: fsWith(["go.mod"]),
      port: portReturning({ stdout: goPass, exitCode: 0 }),
    })
    const r = await run(tool)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("2 passed")
  })

  test("no recognized toolchain ⇒ ok:false, NO spawn", async () => {
    let spawned = false
    const port: TestRunPort = {
      run: async () => {
        spawned = true
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    }
    const tool = makeRunTestsTool({ fs: fsWith([]), port })
    const r = await run(tool)
    expect(r.ok).toBe(false)
    expect(spawned).toBe(false)
  })
})
