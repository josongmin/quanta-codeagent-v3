import { describe, expect, test } from "bun:test"
import { evaluate } from "@/permission"

// T0.2 — HARD_DENY path-independent bypass hardening.
// Reference: bash-sandbox.md §2.6 / §3.4 (verbatim string literals).

const decide = (command: string) =>
  evaluate({ tool: "bash", input: { command }, isReadOnly: false }, { mode: "bypass" }).kind

describe("T0.2 path-independent HARD_DENY — git config-injection", () => {
  test.each([
    ["git -c core.pager=touch\\ pwned status", "git -c config override"],
    ["git -c protocol.ext.allow=always clone ext::sh", "git -c protocol bypass"],
    ["cd /tmp && git -c alias.x='!sh' x", "git -c after cd, not at root"],
    ["git -c=foo log", "git -c= equals form"],
    ["git --exec-path=/tmp/evil status", "git --exec-path hijack"],
    ["git --exec-path /tmp/evil add .", "git --exec-path space form"],
    ["git --config-env=foo=BAR commit -m x", "git --config-env injection"],
    ["FOO=1 git -c x=y status", "git -c with leading env, no path root"],
  ])("denies %s (%s)", (command) => {
    expect(decide(command)).toBe("deny")
  })
})

describe("T0.2 path-independent HARD_DENY — find action-flag set", () => {
  test.each([
    ["find . -name x -delete", "-delete anywhere (relative)"],
    ["find ./src -type f -delete", "-delete relative dir"],
    ["find build -exec rm {} +", "-exec"],
    ["find . -execdir sh -c 'x' \\;", "-execdir"],
    ["find . -fprintf out '%p'", "-fprintf"],
    ["find . -fprint out", "-fprint"],
    ["find . -fprint0 out", "-fprint0"],
    ["find . -fls out", "-fls"],
    ["find . -ok rm {} \\;", "-ok"],
    ["find . -okdir rm {} \\;", "-okdir"],
    ["cd /tmp/sub && find . -type f -delete", "-delete after cd in subdir"],
  ])("denies %s (%s)", (command) => {
    expect(decide(command)).toBe("deny")
  })
})

describe("T0.2 false-positive discipline — legit commands still pass", () => {
  test.each([
    // capital -C is `git -C <dir>` (change dir), NOT config injection.
    ["git -C ./repo status", "git -C capital-C change-dir"],
    ["git -C /Users/me/proj log --oneline", "git -C absolute path"],
    ["git commit -m 'fix: cleanup'", "ordinary git commit"],
    ["git status", "plain git status"],
    ["git checkout -b feature/x", "git branch create"],
    // find with safe predicates only.
    ["find . -name '*.ts'", "find . -name only"],
    ["find ./src -type f -print", "find -print only"],
    ["find . -type d -maxdepth 2", "find -maxdepth only"],
    ["find . -newer ref.txt -type f", "find -newer only"],
  ])("allows %s (%s)", (command) => {
    expect(decide(command)).not.toBe("deny")
  })
})
