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
import { DEFAULT_TIMEOUT_MS, defaultGhExec, type GhExecPort } from "@/tool/gh"

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
 * Production `gh` CLI adapter over the canonical {@link GhExecPort}.
 * Tests pass a fake `GhCliPort` directly; this is the boundary impl.
 */
export const createBunGhCliPort = (
  binary: string = "gh",
  exec: GhExecPort = defaultGhExec,
): GhCliPort => ({
  async run(args, cwd, signal): Promise<GhCliResult> {
    const result = await exec({
      argv: [binary, ...args],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  },
})
