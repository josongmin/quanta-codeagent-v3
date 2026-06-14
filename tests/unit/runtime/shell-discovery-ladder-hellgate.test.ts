/**
 * ADR-0529 — cross-platform shell discovery ladder (SOTA++ P16 승급).
 *
 * P16 only did "loud-refuse on win32, or cmd.exe on explicit opt-in". This locks
 * the SOTA++ ladder: on win32 `QUANTA_WIN_SHELL=auto` walks
 *   POSIX(Git-Bash/WSL) → PowerShell → cmd.exe → typed error,
 * returning the chosen `dialect`. The ladder is a PURE function of an injected
 * `ShellProbe`, so EVERY win32 branch is unit-tested here ON DARWIN (only the
 * real spawn is platform-bound). `discoverShells` takes an injected `which` for
 * the same reason.
 *
 * RED-first: pre-0529 `buildBaseShellArgv` takes no probe, returns no `dialect`,
 * and treats `auto`/`bash`/`pwsh` as the safe `error` default; `discoverShells`
 * does not exist.
 */
import { describe, expect, test } from "bun:test"
import { buildBaseShellArgv, discoverShells, resolveWinShellMode } from "@/runtime"

describe("ADR-0529 — win32 auto ladder (pure, darwin-testable)", () => {
  test("POSIX-FIRST: Git-Bash on PATH ⇒ bash -lc (byte-identical to darwin) + dialect posix", () => {
    const d = buildBaseShellArgv("echo hi", "win32", "auto", {
      bash: "C:\\Git\\usr\\bin\\bash.exe",
      pwsh: "C:\\pwsh.exe",
      cmd: "C:\\Windows\\System32\\cmd.exe",
    })
    expect(d.kind).toBe("argv")
    expect(d.kind === "argv" && d.argv).toEqual(["C:\\Git\\usr\\bin\\bash.exe", "-lc", "echo hi"])
    expect(d.kind === "argv" && d.dialect).toBe("posix")
  })

  test("no bash, PowerShell present ⇒ pwsh -NoProfile -NonInteractive -Command + dialect powershell", () => {
    const d = buildBaseShellArgv("echo hi", "win32", "auto", {
      bash: null,
      pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      cmd: "C:\\Windows\\System32\\cmd.exe",
    })
    expect(d.kind === "argv" && d.argv).toEqual([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "echo hi",
    ])
    expect(d.kind === "argv" && d.dialect).toBe("powershell")
  })

  test("only cmd.exe ⇒ cmd fallback + dialect cmd", () => {
    const d = buildBaseShellArgv("echo hi", "win32", "auto", {
      bash: null,
      pwsh: null,
      cmd: "C:\\Windows\\System32\\cmd.exe",
    })
    expect(d.kind === "argv" && d.argv).toEqual(["cmd.exe", "/d", "/s", "/c", "echo hi"])
    expect(d.kind === "argv" && d.dialect).toBe("cmd")
  })

  test("nothing discoverable ⇒ typed error (loud refuse, no silent spawn)", () => {
    const d = buildBaseShellArgv("echo hi", "win32", "auto", { bash: null, pwsh: null, cmd: null })
    expect(d.kind).toBe("error")
  })

  test("auto WITHOUT a probe ⇒ error (cannot discover ⇒ refuse, never guess)", () => {
    const d = buildBaseShellArgv("echo hi", "win32", "auto")
    expect(d.kind).toBe("error")
  })

  test("explicit bash / pwsh modes pick that dialect with the exact argv (no probe)", () => {
    const b = buildBaseShellArgv("echo hi", "win32", "bash", {
      bash: "C:\\Git\\usr\\bin\\bash.exe",
      pwsh: null,
      cmd: null,
    })
    expect(b.kind === "argv" && b.argv).toEqual(["bash", "-lc", "echo hi"])
    expect(b.kind === "argv" && b.dialect).toBe("posix")
    const p = buildBaseShellArgv("echo hi", "win32", "pwsh")
    expect(p.kind === "argv" && p.dialect).toBe("powershell")
    // teeth: pin the bare-`pwsh` fallback exe + flags (wrong exe ⇒ resolve fail;
    // wrong flags ⇒ $PROFILE side-effects / prompt hang).
    expect(p.kind === "argv" && p.argv).toEqual([
      "pwsh",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "echo hi",
    ])
  })

  test("non-win32 uses the resolved absolute bash path", () => {
    const d = buildBaseShellArgv("echo hi", "darwin", "error", {
      bash: "/bin/bash",
      pwsh: null,
      cmd: null,
    })
    expect(d.kind === "argv" && d.argv).toEqual(["/bin/bash", "-lc", "echo hi"])
    expect(d.kind === "argv" && d.dialect).toBe("posix")
  })

  test("non-win32 without a resolved bash path ⇒ typed error", () => {
    const d = buildBaseShellArgv("echo hi", "darwin", "error", {
      bash: null,
      pwsh: null,
      cmd: null,
    })
    expect(d.kind).toBe("error")
    expect(d.kind === "error" && d.reason).toContain("bash executable unavailable")
  })

  test("resolveWinShellMode parses the extended vocab (auto/bash/pwsh), unknown ⇒ error", () => {
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "auto" })).toBe("auto")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "  BASH " })).toBe("bash")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "pwsh" })).toBe("pwsh")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "cmd" })).toBe("cmd")
    expect(resolveWinShellMode({ QUANTA_WIN_SHELL: "powershell" })).toBe("error") // not a valid token (pwsh is)
    expect(resolveWinShellMode({})).toBe("error")
  })

  test("discoverShells maps an injected which (darwin-testable, no real PATH dep)", () => {
    const probe = discoverShells((n) => (n === "bash" ? "/usr/bin/bash" : null))
    expect(probe.bash).toBe("/usr/bin/bash")
    expect(probe.pwsh).toBeNull()
    expect(probe.cmd).toBeNull()
    // pwsh falls back to "powershell" when "pwsh" is absent:
    const p2 = discoverShells((n) => (n === "powershell" ? "C:\\ps.exe" : null))
    expect(p2.pwsh).toBe("C:\\ps.exe")
    // cmd falls back to bare "cmd" when "cmd.exe" is absent (teeth on that branch):
    const p3 = discoverShells(
      (n) => (n === "cmd" ? "C:\\bare-cmd" : null),
      () => false,
    )
    expect(p3.cmd).toBe("C:\\bare-cmd")
    expect(p3.bash).toBeNull()
  })

  test("discoverShells resolves a deterministic platform bash fallback when PATH lookup misses", () => {
    const probe = discoverShells(
      () => null,
      (path) => path === "/bin/bash",
      "darwin",
    )
    expect(probe.bash).toBe("/bin/bash")
  })
})
