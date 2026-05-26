/**
 * Shared fakes / helpers for `@/integrations/github` unit tests.
 * Mirrors the `fakeGhPort` pattern in `tests/unit/reactor-trigger-source.test.ts`.
 */

import type { FsPort, RedactPort } from "@/integrations/github"
import type { ClockPort, EnvPort, GhCliPort, GhCliResult } from "@/reactor"

export const fixedClock = (at: number): ClockPort => ({ now: () => at })

export const envFromMap = (map: Record<string, string | undefined>): EnvPort => ({
  get: (name) => map[name],
})

export const fakeFs = (files: Record<string, string | Buffer>): FsPort => ({
  async stat(path) {
    const v = files[path]
    if (v === undefined) return undefined
    const buf = typeof v === "string" ? Buffer.from(v, "utf8") : v
    return { size: buf.length }
  },
  async readFile(path) {
    const v = files[path]
    if (v === undefined) return undefined
    return typeof v === "string" ? Buffer.from(v, "utf8") : v
  },
})

export interface FakeGhSetup {
  readonly port: GhCliPort
  readonly calls: ReadonlyArray<{ args: readonly string[]; cwd: string }>
}

export const fakeGhPort = (
  responses: ReadonlyArray<{
    match: (args: readonly string[]) => boolean
    result: GhCliResult | Error
  }>,
): FakeGhSetup => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = []
  const port: GhCliPort = {
    run: async (args, cwd) => {
      calls.push({ args, cwd })
      for (const r of responses) {
        if (r.match(args)) {
          if (r.result instanceof Error) throw r.result
          return r.result
        }
      }
      return { stdout: "", stderr: "no canned response", exitCode: 1 }
    },
  }
  return { port, calls }
}

export const ok = (json: unknown): GhCliResult => ({
  stdout: JSON.stringify(json),
  stderr: "",
  exitCode: 0,
})

export const okText = (text: string): GhCliResult => ({
  stdout: text,
  stderr: "",
  exitCode: 0,
})

export const fail = (stderr: string, code = 1): GhCliResult => ({
  stdout: "",
  stderr,
  exitCode: code,
})

export const identityRedact: RedactPort = {
  redact: (text) => text,
}

export const constantRedact = (replacement: string): RedactPort => ({
  redact: () => replacement,
})
