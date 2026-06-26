import { describe, expect, it } from "bun:test"
import { lowerSimpleHereDocForReadMode } from "./heredoc-lowering"

const runBash = async (script: string, env: Record<string, string>): Promise<string> => {
  const proc = Bun.spawn(["bash", "-c", script], {
    // Minimal explicit env (NOT process.env — the @/tool slice-boundary guard
    // forbids reading process.env even in co-located tests). A fixed PATH is all
    // bash needs here; the test's own vars come from `env`.
    env: { PATH: "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

describe("lowerSimpleHereDocForReadMode delimiter quoting", () => {
  it("keeps the body literal for a quoted delimiter (<<'EOF')", () => {
    const cmd = "cat <<'EOF'\nval=$FOO sub=$(echo hi)\nEOF"
    const lowered = lowerSimpleHereDocForReadMode(cmd)
    expect(lowered.lowered).toBe(true)
    // Single-quoted body => no expansion.
    expect(lowered.command).toBe("printf '%s\\n' 'val=$FOO sub=$(echo hi)' | cat")
  })

  it("preserves expansion for an unquoted delimiter (<<EOF)", () => {
    const cmd = "cat <<EOF\nval=$FOO sub=$(echo hi)\nEOF"
    const lowered = lowerSimpleHereDocForReadMode(cmd)
    expect(lowered.lowered).toBe(true)
    // Double-quoted body => shell still expands $var/$()/backticks.
    expect(lowered.command).toBe("printf '%s\\n' \"val=$FOO sub=$(echo hi)\" | cat")
  })

  it("unquoted delimiter executes with variable + command substitution (real effect)", async () => {
    const cmd = "cat <<EOF\nval=$FOO sub=$(echo hi) bt=`echo bk`\nEOF"
    const original = await runBash(cmd, { FOO: "bar" })
    const lowered = lowerSimpleHereDocForReadMode(cmd)
    expect(lowered.lowered).toBe(true)
    const loweredOut = await runBash(lowered.command, { FOO: "bar" })
    // Lowered command must reproduce the original here-doc's expansion.
    expect(original.trim()).toBe("val=bar sub=hi bt=bk")
    expect(loweredOut).toBe(original)
  })

  it("quoted delimiter stays literal under execution (real effect)", async () => {
    const cmd = "cat <<'EOF'\nval=$FOO sub=$(echo hi)\nEOF"
    const original = await runBash(cmd, { FOO: "bar" })
    const lowered = lowerSimpleHereDocForReadMode(cmd)
    const loweredOut = await runBash(lowered.command, { FOO: "bar" })
    expect(original.trim()).toBe("val=$FOO sub=$(echo hi)")
    expect(loweredOut).toBe(original)
  })

  it("unquoted body with embedded double-quotes round-trips faithfully", async () => {
    const cmd = 'cat <<EOF\nsay "quote" and $FOO done\nEOF'
    const original = await runBash(cmd, { FOO: "x" })
    const lowered = lowerSimpleHereDocForReadMode(cmd)
    const loweredOut = await runBash(lowered.command, { FOO: "x" })
    expect(original.trim()).toBe('say "quote" and x done')
    expect(loweredOut).toBe(original)
  })
})
