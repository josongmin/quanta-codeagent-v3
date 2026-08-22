import { describe, expect, test } from "bun:test"
import { lowerSimpleHereDocForReadMode } from "@/tool/bash/heredoc-lowering"

describe("bash read-mode here-doc lowering", () => {
  test("lowers one simple quoted here-doc into stdin pipe", () => {
    const lowered = lowerSimpleHereDocForReadMode(
      ["python - <<'PY'", "print('seed')", "PY"].join("\n"),
    )

    expect(lowered.lowered).toBe(true)
    expect(lowered.command).toBe(`printf '%s\\n' 'print('"'"'seed'"'"')' | python -`)
  })

  test("preserves multi-line body and quoted delimiter semantics", () => {
    const lowered = lowerSimpleHereDocForReadMode(
      ['node <<-"JS"', "\tconsole.log('a')", "\tconsole.log('b')", "\tJS"].join("\n"),
    )

    expect(lowered.lowered).toBe(true)
    expect(lowered.command).toBe(
      `printf '%s\\n' 'console.log('"'"'a'"'"')\nconsole.log('"'"'b'"'"')' | node`,
    )
  })

  test("leaves commands without a here-doc byte-identical", () => {
    const command = "printf ok"

    expect(lowerSimpleHereDocForReadMode(command)).toEqual({ command, lowered: false })
  })

  test("leaves unclosed here-doc byte-identical", () => {
    const command = ["python - <<'PY'", "print('seed')"].join("\n")

    expect(lowerSimpleHereDocForReadMode(command)).toEqual({ command, lowered: false })
  })

  test("leaves compound suffix after the closing delimiter byte-identical", () => {
    const command = ["python - <<'PY'", "print('seed')", "PY", "touch leaked"].join("\n")

    expect(lowerSimpleHereDocForReadMode(command)).toEqual({ command, lowered: false })
  })
})
