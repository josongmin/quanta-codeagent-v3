/**
 * A MODEL-SUPPLIED SHELL LINE MUST NOT INHERIT THE PARENT ENVIRONMENT.
 *
 * `handleExecCommand` runs `bash -lc <input.command>` — the command text comes
 * from the model. Its env was built two ways, and BOTH are the shapes the
 * exec-cluster ban exists to forbid:
 *
 *   input.env absent  ⇒ `env` omitted from the spawn options ⇒ Bun inherits
 *                       `process.env` wholesale (inherit-by-omission);
 *   input.env present ⇒ `{ ...process.env, ...input.env }` spread raw.
 *
 * Either way every `*_API_KEY`, `*_TOKEN` and `AWS_*` credential in the parent
 * reaches a process whose argv the model chose. The ban never covered this file
 * — its scan list named five cluster files and this was not one of them.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "../_shared/strip-comments"

const SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/subagent/exec-command.ts",
)

describe("the subagent exec path scrubs the environment", () => {
  // COMMENTS STRIPPED. The fix's own comment quotes the banned shapes to explain
  // what was wrong; a raw text scan would flag the explanation as the defect.
  const source = (): string => stripComments(readFileSync(SRC, "utf8"))

  test("🔴 it does NOT spread `process.env` into the child", () => {
    // The spread is the leak: `{ ...process.env, ...input.env }` hands the
    // model's shell every credential this process holds.
    expect(
      /\.\.\.\(?\s*process\.env/.test(source()),
      "a raw process.env spread reaches a model-supplied `bash -lc`",
    ).toBe(false)
  })

  test("🔴 it does NOT inherit by omission", () => {
    // `...(env !== undefined ? { env } : {})` — when the caller passes no env,
    // the spawn carries no `env` key at all and Bun hands over `process.env`.
    expect(
      /\?\s*\{\s*env\s*\}\s*:\s*\{\s*\}/.test(source()),
      "the spawn omits `env` on one branch, which inherits the parent wholesale",
    ).toBe(false)
  })

  test("🔴 it routes through the shared scrubber", () => {
    // `scrubEnv()` is allowlist-based: the child receives what a shell needs and
    // nothing else, so a credential cannot ride along by default.
    expect(source()).toMatch(/scrubEnv\s*\(/)
  })

  test("ANTI-VACUITY: the detectors fire on the shapes they name", () => {
    expect(/\.\.\.\(?\s*process\.env/.test("const e = { ...process.env }")).toBe(true)
    expect(/\?\s*\{\s*env\s*\}\s*:\s*\{\s*\}/.test("...(env !== undefined ? { env } : {})")).toBe(
      true,
    )
    expect(/\.\.\.\(?\s*process\.env/.test("const e = scrubEnv()")).toBe(false)
  })
})
