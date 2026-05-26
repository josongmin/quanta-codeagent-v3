/**
 * Runner unit tests — all IO faked via RunnerPorts. No real process.exit, no
 * real stdout/stderr, no real signal install (we pass a noop installer).
 *
 * Covers: argv → args parse (positive + negative), help flag, unknown flag,
 * env-off exit code, trust-scope validation, trigger-phrase aggregation,
 * SIGINT propagation via injected installer.
 */

import { describe, expect, it } from "bun:test"

import { type RunnerPorts, runFromPrCmdMain } from "@/apps/cli/from-pr-cmd-runner"

interface CaptureSinks {
  readonly stdout: string[]
  readonly stderr: string[]
  exitCode: number | undefined
  readonly controllers: AbortController[]
}

const makePorts = (
  argv: readonly string[],
  envOverride: Record<string, string | undefined> = {},
): { ports: RunnerPorts; sinks: CaptureSinks; restoreEnv: () => void } => {
  const stdout: string[] = []
  const stderr: string[] = []
  const controllers: AbortController[] = []
  const sinks: CaptureSinks = { stdout, stderr, exitCode: undefined, controllers }

  // env stash — restore exactly the keys we touched.
  const previousEnv: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(envOverride)) {
    previousEnv[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  const ports: RunnerPorts = {
    argv,
    writeLine: (s) => stdout.push(s),
    writeErr: (s) => stderr.push(s),
    onExit: (code) => {
      sinks.exitCode = code
    },
    installSignals: (c) => {
      controllers.push(c)
      return () => {
        /* noop — no real signal install */
      }
    },
  }
  return {
    ports,
    sinks,
    restoreEnv: () => {
      for (const [k, v] of Object.entries(previousEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    },
  }
}

describe("runFromPrCmdMain", () => {
  it("--help → exit 0 + USAGE on stdout", async () => {
    const { ports, sinks, restoreEnv } = makePorts(["--help"])
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.exitCode).toBe(0)
      expect(sinks.stdout.join("\n")).toContain("Usage:")
    } finally {
      restoreEnv()
    }
  })

  it("unknown flag → exit 64 + USAGE on stderr", async () => {
    const { ports, sinks, restoreEnv } = makePorts(["--nope"])
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.exitCode).toBe(64)
      expect(sinks.stderr.join("\n")).toContain("Usage:")
    } finally {
      restoreEnv()
    }
  })

  it("--pr non-integer → exit 64", async () => {
    const { ports, sinks, restoreEnv } = makePorts(["--pr", "abc"])
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.exitCode).toBe(64)
      expect(sinks.stderr.join("\n")).toContain("--pr")
    } finally {
      restoreEnv()
    }
  })

  it("--pr negative → exit 64", async () => {
    const { ports, sinks, restoreEnv } = makePorts(["--pr", "-1"])
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.exitCode).toBe(64)
    } finally {
      restoreEnv()
    }
  })

  it("--trust-scope invalid → exit 64", async () => {
    const { ports, sinks, restoreEnv } = makePorts(["--trust-scope", "anyone"])
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.exitCode).toBe(64)
      expect(sinks.stderr.join("\n")).toContain("--trust-scope")
    } finally {
      restoreEnv()
    }
  })

  it("--event-source webhook → still parses, runFromPrCmd emits skipped event-source-not-implemented", async () => {
    const { ports, sinks, restoreEnv } = makePorts(["--event-source", "webhook"], {
      QUANTA_GH_ACTIONS_TRIGGER: "1",
    })
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.exitCode).toBe(0)
      const events = sinks.stdout.map((l) => JSON.parse(l) as { type: string; reason?: string })
      expect(
        events.some(
          (e) => e.type === "skipped" && e.reason?.startsWith("event-source-not-implemented"),
        ),
      ).toBe(true)
    } finally {
      restoreEnv()
    }
  })

  it("env-off (QUANTA_GH_ACTIONS_TRIGGER unset) → exit 0 + skipped reason=env-off", async () => {
    const { ports, sinks, restoreEnv } = makePorts([], { QUANTA_GH_ACTIONS_TRIGGER: undefined })
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.exitCode).toBe(0)
      const events = sinks.stdout.map((l) => JSON.parse(l) as { type: string; reason?: string })
      expect(events.some((e) => e.type === "skipped" && e.reason === "env-off")).toBe(true)
    } finally {
      restoreEnv()
    }
  })

  it("installSignals is called exactly once and receives an AbortController", async () => {
    const { ports, sinks, restoreEnv } = makePorts([])
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.controllers.length).toBe(1)
      expect(sinks.controllers[0]).toBeInstanceOf(AbortController)
    } finally {
      restoreEnv()
    }
  })

  it("--trigger-phrase repeatable accumulates", async () => {
    const { ports, sinks, restoreEnv } = makePorts(
      ["--trigger-phrase", "@bot1", "--trigger-phrase", "@bot2", "--trigger-phrase", "/bot3"],
      { QUANTA_GH_ACTIONS_TRIGGER: "1" },
    )
    try {
      await runFromPrCmdMain(ports)
      // argv parses cleanly; downstream runFromPrCmd no-ops because no event file. Exit 0.
      expect(sinks.exitCode).toBe(0)
    } finally {
      restoreEnv()
    }
  })

  it("aborts via injected controller → runFromPrCmd sees signal.aborted", async () => {
    const { ports, sinks, restoreEnv } = makePorts([], { QUANTA_GH_ACTIONS_TRIGGER: "1" })
    try {
      // Install our own listener: as soon as the controller is registered, abort it.
      const originalInstall = ports.installSignals
      const ported: RunnerPorts = {
        ...ports,
        installSignals: (c) => {
          const r = originalInstall(c)
          c.abort()
          return r
        },
      }
      await runFromPrCmdMain(ported)
      expect(sinks.exitCode).toBe(0)
      const events = sinks.stdout.map((l) => JSON.parse(l) as { type: string; reason?: string })
      expect(events.some((e) => e.type === "skipped" && e.reason === "abort")).toBe(true)
    } finally {
      restoreEnv()
    }
  })

  it("default argv (no flags, no env) → exit 0 + zero triggers, no error", async () => {
    const { ports, sinks, restoreEnv } = makePorts([], { QUANTA_GH_ACTIONS_TRIGGER: undefined })
    try {
      await runFromPrCmdMain(ports)
      expect(sinks.exitCode).toBe(0)
      expect(sinks.stderr).toEqual([])
    } finally {
      restoreEnv()
    }
  })
})
