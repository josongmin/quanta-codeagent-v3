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
const BASENAME_CALL = /executableBasename\s*\(/
const CODE_SHAPE_CALL = /classifyCodeShape\s*\(/
const RAW_PROCESS_ENV = /includes\(\s*["']process\.env["']\s*\)/

type F07Check = {
  readonly hits: number
  readonly failures: readonly string[]
}

export const checkCommandShapeContract = (classifier: string, commandShape: string): F07Check => {
  const failures: string[] = []
  let hits = 0
  if (ZSH_WRAPPER.test(commandShape)) hits++
  else failures.push("zsh missing from SHELL_WRAPPER_HEADS")
  if (BASENAME_CALL.test(commandShape) && BASENAME_CALL.test(classifier)) hits++
  else failures.push("executableBasename( call missing")
  if (CODE_SHAPE_CALL.test(classifier)) hits++
  else failures.push("classifyCodeShape( call missing from classifier")
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
    expect(check.hits).toBeGreaterThanOrEqual(3)
  })

  test("live sources satisfy the F-07 contract", () => {
    const check = checkCommandShapeContract(classifier, commandShape)
    expect(check.failures).toEqual([])
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
