/**
 * WS-G (jul-10 uiux) — OperatorNotice bus hellgate.
 *
 * Root cause under test: silent degrade — surface code swallows failures in
 * `catch {}` with zero operator signal. The bus is the ONE seam every adoption
 * emits through; these tests pin its safety contract:
 *
 *   1. emit with NO sink installed is a total no-op (never throws) — surface
 *      code must be able to emit unconditionally.
 *   2. install → emit routes the notice verbatim to the sink.
 *   3. a THROWING sink can never crash the emitter (fail-silent).
 *   4. the disposer uninstalls; a stale disposer (superseded install) does NOT
 *      clobber the newer sink.
 *   5. the CLI stderr sink renders `[quanta] <source>: <message> (<hint>)`
 *      with severity-coded color (dim info / plain warn / red error) and
 *      plain text when color is off.
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetOperatorNoticeSinkForTest,
  emitOperatorNotice,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared/operator-notice"
import {
  createCliOperatorNoticeSink,
  renderOperatorNotice,
} from "../../../src/apps/cli/operator-notice"

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
})

describe("operator-notice bus kernel", () => {
  test("emit with no sink installed is a silent no-op", () => {
    expect(() =>
      emitOperatorNotice({ severity: "warn", source: "test", message: "nobody listening" }),
    ).not.toThrow()
  })

  test("install → emit routes the notice verbatim", () => {
    const seen: OperatorNotice[] = []
    installOperatorNoticeSink((n) => seen.push(n))
    const notice: OperatorNotice = {
      severity: "error",
      source: "mcp",
      message: "server exited",
      hint: "restart with /mcp",
    }
    emitOperatorNotice(notice)
    expect(seen).toEqual([notice])
  })

  test("a throwing sink never crashes the emitter", () => {
    installOperatorNoticeSink(() => {
      throw new Error("sink is broken")
    })
    expect(() =>
      emitOperatorNotice({ severity: "info", source: "test", message: "boom-safe" }),
    ).not.toThrow()
  })

  test("disposer uninstalls the sink", () => {
    const seen: OperatorNotice[] = []
    const dispose = installOperatorNoticeSink((n) => seen.push(n))
    dispose()
    emitOperatorNotice({ severity: "warn", source: "test", message: "after dispose" })
    expect(seen).toHaveLength(0)
  })

  test("a stale disposer does not clobber a newer sink", () => {
    const first: OperatorNotice[] = []
    const second: OperatorNotice[] = []
    const disposeFirst = installOperatorNoticeSink((n) => first.push(n))
    installOperatorNoticeSink((n) => second.push(n))
    disposeFirst() // stale — must NOT remove the second sink
    emitOperatorNotice({ severity: "warn", source: "test", message: "to the second" })
    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })
})

describe("CLI stderr sink renderer", () => {
  test("renders [quanta] <source>: <message> (<hint>) without color", () => {
    const line = renderOperatorNotice(
      {
        severity: "warn",
        source: "/replay",
        message: "skipped 3 malformed rows",
        hint: "old file",
      },
      false,
    )
    expect(line).toBe("[quanta] /replay: skipped 3 malformed rows (old file)\n")
  })

  test("omits the hint parens when no hint", () => {
    const line = renderOperatorNotice(
      { severity: "warn", source: "memory", message: "write blocked" },
      false,
    )
    expect(line).toBe("[quanta] memory: write blocked\n")
  })

  test("severity coloring: dim info, plain warn, red error", () => {
    const info = renderOperatorNotice({ severity: "info", source: "s", message: "m" }, true)
    const warn = renderOperatorNotice({ severity: "warn", source: "s", message: "m" }, true)
    const error = renderOperatorNotice({ severity: "error", source: "s", message: "m" }, true)
    expect(info).toContain("\x1b[2m")
    expect(info).toContain("\x1b[0m")
    expect(warn).not.toContain("\x1b[")
    expect(error).toContain("\x1b[31m")
    expect(error).toContain("\x1b[0m")
  })

  test("createCliOperatorNoticeSink writes the rendered line to the injected writer", () => {
    const out: string[] = []
    const sink = createCliOperatorNoticeSink({ write: (s) => out.push(s), color: false })
    sink({ severity: "error", source: "webhook", message: "publish dropped" })
    expect(out).toEqual(["[quanta] webhook: publish dropped\n"])
  })

  test("sink write failure is swallowed (never throws)", () => {
    const sink = createCliOperatorNoticeSink({
      write: () => {
        throw new Error("EPIPE")
      },
      color: false,
    })
    expect(() => sink({ severity: "info", source: "s", message: "m" })).not.toThrow()
  })
})
