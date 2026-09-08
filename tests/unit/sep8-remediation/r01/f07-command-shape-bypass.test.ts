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
    expect(classifyCommandShape(`perl -e "print 1"`)).toBe("public")
    expect(classifyCommandShape(`php -r "echo 1;"`)).toBe("public")
    expect(classifyCommandShape(`deno eval "1 + 1"`)).toBe("public")
    expect(classifyCommandShape(`node -r fs -e 'console.log(1)'`)).toBe("public")
    expect(classifyCommandShape("gcc -c foo.c")).toBe("public")
    expect(classifyCommandShape("dash -c echo hi")).toBe("public")
  })

  test("unsupported -c wrappers fail closed when the payload is a secret dump", () => {
    expect(classifyCommandShape("dash -c printenv")).toBe("secret")
    expect(classifyCommandShape("ksh -c printenv")).toBe("secret")
    expect(classifyCommandShape("fish -c printenv")).toBe("secret")
    expect(classifyCommandShape("/usr/bin/env dash -c printenv")).toBe("secret")
  })

  test("utility prefixes that forward a command still classify the inner dump secret", () => {
    expect(classifyCommandShape("eval printenv")).toBe("secret")
    expect(classifyCommandShape("command printenv")).toBe("secret")
    expect(classifyCommandShape("command -p printenv")).toBe("secret")
    expect(classifyCommandShape("builtin printenv")).toBe("secret")
    expect(classifyCommandShape("nice printenv")).toBe("secret")
    expect(classifyCommandShape("nice -n 10 printenv")).toBe("secret")
    expect(classifyCommandShape("nohup printenv")).toBe("secret")
    expect(classifyCommandShape("timeout 1 printenv")).toBe("secret")
    expect(classifyCommandShape("timeout --foreground 1 printenv")).toBe("secret")
    expect(classifyCommandShape("sudo printenv")).toBe("secret")
    expect(classifyCommandShape("sudo -n printenv")).toBe("secret")
    expect(classifyCommandShape("busybox printenv")).toBe("secret")
    expect(classifyCommandShape(`bash -c "eval printenv"`)).toBe("secret")
    expect(classifyCommandShape(`bash -c "command printenv"`)).toBe("secret")
  })

  test("utility prefixes keep benign inner commands public", () => {
    expect(classifyCommandShape("eval echo hi")).toBe("public")
    expect(classifyCommandShape("command ls")).toBe("public")
    expect(classifyCommandShape("timeout 1 echo hi")).toBe("public")
    expect(classifyCommandShape("sudo echo hi")).toBe("public")
  })

  test("interpreter eval shares classifyCodeShape / CODE_ENV_ACCESS", () => {
    const bracket = `console.log(process["env"])`
    expect(classifyCodeShape(bracket)).toBe("secret")
    expect(classifyCommandShape(`node -e '${bracket}'`)).toBe("secret")
    expect(classifyCommandShape(`ruby -e "p ENV"`)).toBe("secret")
    expect(classifyCommandShape(`perl -e "print %ENV"`)).toBe("secret")
    expect(classifyCommandShape(`php -r "print_r($_ENV)"`)).toBe("secret")
    expect(classifyCommandShape(`deno eval "Deno.env.toObject()"`)).toBe("secret")
  })

  test("command substitution of a dump is secret; benign substitution stays public", () => {
    expect(classifyCommandShape("$(printenv)")).toBe("secret")
    expect(classifyCommandShape("`printenv`")).toBe("secret")
    expect(classifyCommandShape("echo $(printenv)")).toBe("secret")
    expect(classifyCommandShape(`bash -c "echo $(printenv)"`)).toBe("secret")
    expect(classifyCommandShape(`bash -c "$(printenv)"`)).toBe("secret")
    expect(classifyCommandShape("eval $(printenv)")).toBe("secret")
    expect(classifyCommandShape("echo $(date)")).toBe("public")
    expect(classifyCommandShape("echo `uname`")).toBe("public")
    expect(classifyCommandShape("$(printenv HOME)")).toBe("public")
  })
})
