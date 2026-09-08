/**
 * F-07 RED rail — command-shape wrappers that currently classify `public`
 * while the inner shape is a known secret dump (printenv / process["env"]).
 */
import { describe, expect, test } from "bun:test"
import { classifyCodeShape, classifyCommandShape } from "@/security"

const SECRET_SHAPES = [
  "/bin/bash -c printenv",
  "zsh -c printenv",
  "bash -xc printenv",
  `bash -c "printenv 2>&1"`,
  `bash -c "printenv | cat"`,
  `node -e 'console.log(process["env"])'`,
] as const

describe("F-07 command-shape bypass families", () => {
  test("the six audit reproductions classify secret", () => {
    for (const cmd of SECRET_SHAPES) {
      expect(classifyCommandShape(cmd), cmd).toBe("secret")
    }
  })

  test("nested wrapper + prefix + redirect still classify secret", () => {
    expect(classifyCommandShape(`bash -c "bash -c 'printenv'"`)).toBe("secret")
    expect(classifyCommandShape("/usr/bin/zsh -lc printenv")).toBe("secret")
    expect(classifyCommandShape("FOO=1 printenv")).toBe("secret")
    expect(classifyCommandShape("printenv 2>&1")).toBe("secret")
    expect(classifyCommandShape("printenv | cat")).toBe("secret")
  })

  test("benign controls stay public", () => {
    expect(classifyCommandShape("bash -c echo hi")).toBe("public")
    expect(classifyCommandShape("env FOO=1")).toBe("public")
    expect(classifyCommandShape("printenv HOME")).toBe("public")
    expect(classifyCommandShape("bash script.sh")).toBe("public")
    expect(classifyCommandShape(`node -e 'console.log(1 + 1)'`)).toBe("public")
  })

  test("interpreter eval shares classifyCodeShape / CODE_ENV_ACCESS", () => {
    const bracket = `console.log(process["env"])`
    expect(classifyCodeShape(bracket)).toBe("secret")
    expect(classifyCommandShape(`node -e '${bracket}'`)).toBe("secret")
  })
})
