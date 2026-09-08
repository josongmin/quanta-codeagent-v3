/**
 * F-07 cheap mutation rail — basename heads, zsh wrapper, shared
 * classifyCodeShape for interpreter eval. Call patterns, not bare names.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const CLASSIFIER = join(import.meta.dir, "../../../../src/security/sensitivity-classifier.ts")
const COMMAND_SHAPE = join(import.meta.dir, "../../../../src/security/command-shape.ts")

const ZSH_WRAPPER = /SHELL_WRAPPER_HEADS[\s\S]*?"zsh"/
const EVAL_PREFIX = /COMMAND_PREFIX_HEADS[\s\S]*?"eval"/
const PREFIX_SKIP_CALL = /skipUtilityPrefixArgs\s*\(/
const SUBSTITUTION_CALL = /commandSubstitutionInners\s*\(/
const PHP_DASH_R = /phpDashRSource\s*\(/
const PERL_HEAD = /INTERPRETER_EVAL_HEADS[\s\S]*?"perl"/
const RUBY_ENV = /RUBY_ENV_DUMP\.test\s*\(/
const BASENAME_CALL = /executableBasename\s*\(/
const CODE_SHAPE_CALL = /classifyCodeShape\s*\(/
const RAW_PROCESS_ENV = /includes\(\s*["']process\.env["']\s*\)/

type F07Check = {
  readonly hits: number
  readonly failures: readonly string[]
}

const CONTRACT_CHECKS: readonly {
  readonly ok: (classifier: string, commandShape: string) => boolean
  readonly fail: string
}[] = [
  { ok: (_c, s) => ZSH_WRAPPER.test(s), fail: "zsh missing from SHELL_WRAPPER_HEADS" },
  { ok: (_c, s) => EVAL_PREFIX.test(s), fail: "eval missing from COMMAND_PREFIX_HEADS" },
  {
    ok: (c) => PREFIX_SKIP_CALL.test(c),
    fail: "skipUtilityPrefixArgs( call missing from classifier",
  },
  {
    ok: (c) => SUBSTITUTION_CALL.test(c),
    fail: "commandSubstitutionInners( call missing from classifier",
  },
  { ok: (c) => PHP_DASH_R.test(c), fail: "phpDashRSource( call missing from classifier" },
  { ok: (_c, s) => PERL_HEAD.test(s), fail: "perl missing from INTERPRETER_EVAL_HEADS" },
  { ok: (c) => RUBY_ENV.test(c), fail: "RUBY_ENV_DUMP missing from classifier" },
  {
    ok: (c, s) => BASENAME_CALL.test(s) && BASENAME_CALL.test(c),
    fail: "executableBasename( call missing",
  },
  { ok: (c) => CODE_SHAPE_CALL.test(c), fail: "classifyCodeShape( call missing from classifier" },
]

export const checkCommandShapeContract = (classifier: string, commandShape: string): F07Check => {
  const failures: string[] = []
  let hits = 0
  for (const check of CONTRACT_CHECKS) {
    if (check.ok(classifier, commandShape)) hits++
    else failures.push(check.fail)
  }
  if (RAW_PROCESS_ENV.test(classifier) || RAW_PROCESS_ENV.test(commandShape)) {
    failures.push("raw includes(process.env) duplicate rule still present")
  }
  return { hits, failures }
}

describe("F-07 command-shape structural ratchet", () => {
  const classifier = readFileSync(CLASSIFIER, "utf8")
  const commandShape = readFileSync(COMMAND_SHAPE, "utf8")

  test("anti-vacuum: basename, zsh wrapper, and classifyCodeShape calls exist", () => {
    const check = checkCommandShapeContract(classifier, commandShape)
    expect(check.hits).toBeGreaterThanOrEqual(9)
  })

  test("live sources satisfy the F-07 contract", () => {
    const check = checkCommandShapeContract(classifier, commandShape)
    expect(check.failures).toEqual([])
  })

  test("red-on-injection: dropping perl from INTERPRETER_EVAL_HEADS fails", () => {
    const mutated = commandShape.replace('"perl"', "")
    expect(mutated).not.toBe(commandShape)
    const check = checkCommandShapeContract(classifier, mutated)
    expect(check.failures.length).toBeGreaterThan(0)
  })

  test("red-on-injection: dropping eval from COMMAND_PREFIX_HEADS fails", () => {
    const mutated = commandShape.replace('"eval"', "")
    expect(mutated).not.toBe(commandShape)
    const check = checkCommandShapeContract(classifier, mutated)
    expect(check.failures.length).toBeGreaterThan(0)
  })

  test("red-on-injection: dropping zsh from the wrapper set fails", () => {
    const mutated = commandShape.replace('"zsh"', "")
    expect(mutated).not.toBe(commandShape)
    const check = checkCommandShapeContract(classifier, mutated)
    expect(check.failures.length).toBeGreaterThan(0)
  })

  test("red-on-injection: restoring includes(process.env) fails", () => {
    const mutated = classifier.replace(
      "classifyCodeShape(source)",
      'source.includes("process.env")',
    )
    expect(mutated).not.toBe(classifier)
    const check = checkCommandShapeContract(mutated, commandShape)
    expect(check.failures.length).toBeGreaterThan(0)
  })
})
