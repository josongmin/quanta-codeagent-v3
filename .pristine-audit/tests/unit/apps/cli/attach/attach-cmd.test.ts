/**
 * CLI surface coverage for `quanta attach` — argv parsing (URL / --token / env
 * fallback) and the `--help` short-circuit (renders usage WITHOUT opening a
 * socket). The full socket/stdin loop is covered by `attach-e2e.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { parseAttachArgs, runAttachCmd } from "@/apps/cli/attach-cmd"

describe("parseAttachArgs", () => {
  test("defaults to ws://127.0.0.1:4096/ with no args", () => {
    const args = parseAttachArgs([], {} as NodeJS.ProcessEnv)
    expect(args.url).toBe("ws://127.0.0.1:4096/")
    expect(args.token).toBeUndefined()
    expect(args.help).toBe(false)
  })

  test("first positional is the URL", () => {
    const args = parseAttachArgs(["ws://10.0.0.5:5000/"], {} as NodeJS.ProcessEnv)
    expect(args.url).toBe("ws://10.0.0.5:5000/")
  })

  test("--token X and --token=X both set the token; explicit wins over env", () => {
    const a = parseAttachArgs(["--token", "abc"], {
      QUANTA_WEB_AUTH_TOKEN: "env-tok",
    } as NodeJS.ProcessEnv)
    expect(a.token).toBe("abc")
    const b = parseAttachArgs(["--token=xyz"], {} as NodeJS.ProcessEnv)
    expect(b.token).toBe("xyz")
  })

  test("falls back to QUANTA_WEB_AUTH_TOKEN when no --token", () => {
    const args = parseAttachArgs([], { QUANTA_WEB_AUTH_TOKEN: "env-tok" } as NodeJS.ProcessEnv)
    expect(args.token).toBe("env-tok")
  })

  test("-h / --help set the help flag", () => {
    expect(parseAttachArgs(["--help"], {} as NodeJS.ProcessEnv).help).toBe(true)
    expect(parseAttachArgs(["-h"], {} as NodeJS.ProcessEnv).help).toBe(true)
  })
})

describe("runAttachCmd --help", () => {
  test("renders usage and returns 0 WITHOUT calling the attach driver", async () => {
    let usage = ""
    let attachCalled = false
    const code = await runAttachCmd(["--help"], {
      writeUsage: (s) => {
        usage += s
      },
      attach: (async () => {
        attachCalled = true
        throw new Error("unreachable: attach on --help")
      }) as never,
    })
    expect(code).toBe(0)
    expect(attachCalled).toBe(false)
    expect(usage).toContain("quanta attach")
    expect(usage).toContain("--token")
  })
})
