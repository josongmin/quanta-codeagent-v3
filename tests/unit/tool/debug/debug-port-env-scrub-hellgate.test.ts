/**
 * THE DEBUGGER SPAWNS A MODEL-CHOSEN PROGRAM — IT MUST NOT HAND OVER THE PARENT ENV.
 *
 * `debug_inspect` builds its argv as
 *   `["node", `--inspect-brk=${port}`, program, ...(input.args ?? [])]`
 * where `program` and `args` come from the TOOL INPUT (`debug/tool.ts:218`).
 * All three spawn sites in `debug/port.ts` passed
 *   `spec.env !== undefined ? { ...process.env, ...spec.env } : process.env`
 * so every `*_API_KEY`, `*_TOKEN` and `AWS_*` credential reached a child whose
 * program the model named — the same shape as the `exec_command` leak, and it
 * escaped the exec-cluster ban because the argv head is `"node"` rather than a
 * shell binary.
 *
 * Mitigating but not sufficient: `debug_inspect` is default-OFF behind
 * `QUANTA_DEBUG_TOOLS` and always-confirm. A default-OFF leak is still a leak.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "../../_shared/strip-comments"

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../src/tool/debug/port.ts")
const source = (): string => stripComments(readFileSync(SRC, "utf8"))

describe("the debug spawn scrubs the environment", () => {
  test("🔴 no spawn site spreads or passes `process.env`", () => {
    const hits = source()
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((r) => /env:\s*[^\n]*process\.env|\.\.\.process\.env/.test(r.line))
    expect(hits, "a model-chosen program receives this process's credentials").toEqual([])
  })

  test("🔴 it routes through the shared scrubber", () => {
    expect(source()).toMatch(/scrubEnv\s*\(/)
  })

  test("ANTI-VACUITY: the detector fires on the shape it names", () => {
    const hit = (s: string) => /env:\s*[^\n]*process\.env|\.\.\.process\.env/.test(s)
    expect(
      hit("env: spec.env !== undefined ? { ...process.env, ...spec.env } : process.env,"),
    ).toBe(true)
    expect(hit("env: { ...scrubEnv(), ...(spec.env ?? {}) },")).toBe(false)
  })
})
