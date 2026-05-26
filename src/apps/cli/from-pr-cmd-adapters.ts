/**
 * `from-pr` CLI — production-side adapters.
 *
 * Thin wrappers around node:fs, node:process, Bun.spawn, Date.now, and
 * `@/security/redaction`. The CLI lib (`from-pr-cmd.ts`) is port-only; this
 * file binds real OS calls. Each adapter is small enough to read at a glance.
 *
 * Tests pass fakes directly to `runFromPrCmd`; these adapters are only used
 * at the composition root (CLI entry).
 */

import { readFile, stat } from "node:fs/promises"
import type { FsPort, RedactPort } from "@/integrations/github"

import type { ClockPort, EnvPort, GhCliPort, GhCliResult } from "@/reactor"
import { redactSecrets } from "@/security/redaction"

export const createNodeEnvPort = (): EnvPort => ({
  get(name) {
    const v = process.env[name]
    return typeof v === "string" ? v : undefined
  },
})

export const createNodeFsPort = (): FsPort => ({
  async readFile(path, opts) {
    try {
      const buf = await readFile(path)
      const cap = opts?.maxBytes
      if (cap !== undefined && buf.length > cap) return undefined
      return buf
    } catch {
      return undefined
    }
  },
  async stat(path) {
    try {
      const s = await stat(path)
      return { size: s.size }
    } catch {
      return undefined
    }
  },
})

export const createSystemClockPort = (): ClockPort => ({
  now: () => Date.now(),
})

export const createRedactPort = (): RedactPort => ({
  redact: (text) => redactSecrets(text, { origin: "tool_result" }).text,
})

/**
 * Production `gh` CLI adapter via Bun.spawn. Tests pass a fake `GhCliPort`
 * directly; this is the boundary impl. Mirrors the pattern in
 * `src/reactor/trigger-source-ci.ts`.
 */
export const createBunGhCliPort = (binary: string = "gh"): GhCliPort => ({
  async run(args, cwd, signal): Promise<GhCliResult> {
    type SpawnFn = (
      cmd: readonly string[],
      opts: Record<string, unknown>,
    ) => {
      readonly exited: Promise<number>
      readonly stdout: ReadableStream<Uint8Array>
      readonly stderr: ReadableStream<Uint8Array>
    }
    const bun = (globalThis as unknown as { Bun?: { spawn: SpawnFn } }).Bun
    if (bun === undefined) {
      return { stdout: "", stderr: "Bun runtime unavailable", exitCode: 127 }
    }
    const spawnOpts: Record<string, unknown> = {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    }
    if (signal !== undefined) spawnOpts.signal = signal
    const proc = bun.spawn([binary, ...args], spawnOpts)
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      readStream(proc.stdout),
      readStream(proc.stderr),
    ])
    return { stdout, stderr, exitCode }
  },
})

const readStream = async (s: ReadableStream<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = []
  const reader = s.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
