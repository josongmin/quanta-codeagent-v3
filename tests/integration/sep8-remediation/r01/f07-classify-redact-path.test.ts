/**
 * F-07.4 consumer rail — classifyCommandShape → redactSecrets.
 * A synthetic env value that is NOT a format-regex secret must vanish when
 * Layer-1 source class is secret. Classifier-only is not enough.
 *
 * bash.classifySource is `classifyCommandShape(input.command ?? "")` — pinned
 * by a call-pattern scan of `src/tool/bash/index.ts` (tool files are not in
 * this write set; the scan fails if that wiring is removed).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { classifyCommandShape, redactSecrets } from "@/security"

const SYNTH = "SYNTH_ENV_NOT_A_FORMAT_SECRET_9f3a"
const DUMP = `HOME=/Users/me\nAPI_TOKEN=${SYNTH}\nPATH=/usr/bin`
const BASH_SRC = join(import.meta.dir, "../../../../src/tool/bash/index.ts")

const BYPASS_COMMANDS = [
  "/bin/bash -c printenv",
  "zsh -c printenv",
  "bash -xc printenv",
  `bash -c "printenv 2>&1"`,
  `bash -c "printenv | cat"`,
  `node -e 'console.log(process["env"])'`,
] as const

const CLASSIFY_SOURCE_CALL =
  /classifySource:\s*\(input:\s*Input\)\s*=>\s*classifyCommandShape\s*\(\s*input\.command/

describe("F-07.4 classifyCommandShape → redactSecrets consumer", () => {
  test("bash classifySource still calls classifyCommandShape (producer wiring)", () => {
    const src = readFileSync(BASH_SRC, "utf8")
    expect(CLASSIFY_SOURCE_CALL.test(src)).toBe(true)
  })

  test("Layer-2 format regex does not catch the synthetic env value", () => {
    const layer2 = redactSecrets(DUMP, { origin: "tool_result" })
    expect(layer2.unchanged).toBe(true)
    expect(layer2.text).toContain(SYNTH)
  })

  test("classify + redactSecrets replaces the entire dump; raw synth is gone", () => {
    for (const command of BYPASS_COMMANDS) {
      const sourceClass = classifyCommandShape(command)
      expect(sourceClass, command).toBe("secret")
      const result = redactSecrets(DUMP, { origin: "tool_result", sourceClass })
      expect(result.text, command).not.toContain(SYNTH)
      expect(result.text, command).toContain("[REDACTED:source_class_secret]")
      expect(result.unchanged).toBe(false)
    }
  })

  test("benign classify stays public and leaves the synth in Layer-2", () => {
    const sourceClass = classifyCommandShape("bash -c echo hi")
    expect(sourceClass).toBe("public")
    const result = redactSecrets(DUMP, { origin: "tool_result", sourceClass })
    expect(result.text).toContain(SYNTH)
  })
})
