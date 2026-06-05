/**
 * ★ CONTRACT — H7 rotating cloud credentials (apiKeyHelper + aws/gcp pre-call refresh):
 *
 *   - `mintApiKey()` runs the configured helper SHELL COMMAND via an injected
 *     shell-exec port and returns the trimmed stdout as the minted key.
 *   - TTL CACHE keyed by the helper command: a second `mintApiKey()` within the
 *     TTL window does NOT re-run the shell; after the TTL elapses it re-runs.
 *   - `refreshCloudCreds("aws"|"gcp")` runs the configured refresh command
 *     BEFORE a provider call; it is TTL-throttled (at most once per window).
 *   - A FAILING helper (non-zero exit / shell throws) surfaces a typed
 *     `CredentialHelperError` — NEVER a crash, never an unhandled rejection.
 *   - TRUST GATE: when the injected `isTrusted` predicate returns false the
 *     helper command is BLOCKED (shell NEVER invoked) and a typed error
 *     (`code:"untrusted"`) is returned/raised.
 *   - NO CONFIG (helper command absent) ⇒ the port is a NO-OP: `mintApiKey`
 *     returns undefined, `refreshCloudCreds` returns without shelling out.
 *   - The minted key / refreshed creds NEVER appear in any error message or
 *     telemetry (anti-leak — the secret value is not echoed back).
 */
import { describe, expect, test } from "bun:test"
import {
  CredentialHelperError,
  createCredentialSource,
  type ShellExecFn,
  type ShellExecResult,
} from "@/llm/credential-helper"

const ok = (stdout: string): ShellExecResult => ({ stdout, stderr: "", exitCode: 0 })

/** A fake clock the TTL cache reads from (no Date.now in the port). */
const makeClock = (start = 0) => {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

/** A recording shell-exec stub. Records every command; returns a scripted
 *  result (default ok). */
const makeShell = (
  result: (cmd: string) => ShellExecResult | Promise<ShellExecResult> = () => ok("KEY"),
): { exec: ShellExecFn; calls: string[] } => {
  const calls: string[] = []
  const exec: ShellExecFn = async (command) => {
    calls.push(command)
    return result(command)
  }
  return { exec, calls }
}

describe("H7 credential-helper — apiKeyHelper mint + TTL cache", () => {
  test("mints a key via the configured shell command (trimmed stdout)", async () => {
    const shell = makeShell(() => ok("sk-minted-123\n"))
    const clock = makeClock()
    const src = createCredentialSource({
      apiKeyHelper: "my-mint-cmd",
      apiKeyHelperTtlMs: 60_000,
      shellExec: shell.exec,
      isTrusted: () => true,
      now: clock.now,
    })
    const key = await src.mintApiKey()
    expect(key).toBe("sk-minted-123")
    expect(shell.calls).toEqual(["my-mint-cmd"])
  })

  test("TTL-caches: 2nd call within window does NOT re-run; after TTL re-runs", async () => {
    let n = 0
    const shell = makeShell(() => ok(`key-${++n}`))
    const clock = makeClock()
    const src = createCredentialSource({
      apiKeyHelper: "mint",
      apiKeyHelperTtlMs: 1000,
      shellExec: shell.exec,
      isTrusted: () => true,
      now: clock.now,
    })
    const first = await src.mintApiKey()
    expect(first).toBe("key-1")
    expect(shell.calls.length).toBe(1)

    // Within TTL — cached, no second shell call.
    clock.advance(999)
    const second = await src.mintApiKey()
    expect(second).toBe("key-1")
    expect(shell.calls.length).toBe(1)

    // TTL elapsed — re-run.
    clock.advance(2)
    const third = await src.mintApiKey()
    expect(third).toBe("key-2")
    expect(shell.calls.length).toBe(2)
  })

  test("no config ⇒ mintApiKey returns undefined, never shells out", async () => {
    const shell = makeShell()
    const src = createCredentialSource({
      shellExec: shell.exec,
      isTrusted: () => true,
    })
    const key = await src.mintApiKey()
    expect(key).toBeUndefined()
    expect(shell.calls.length).toBe(0)
  })
})

describe("H7 credential-helper — aws/gcp pre-call refresh", () => {
  test("refreshCloudCreds('aws') runs the configured command", async () => {
    const shell = makeShell()
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      shellExec: shell.exec,
      isTrusted: () => true,
    })
    await src.refreshCloudCreds("aws")
    expect(shell.calls).toEqual(["aws sso login"])
  })

  test("refreshCloudCreds is TTL-throttled (at most once per window)", async () => {
    const shell = makeShell()
    const clock = makeClock()
    const src = createCredentialSource({
      awsAuthRefresh: "refresh",
      apiKeyHelperTtlMs: 5000,
      shellExec: shell.exec,
      isTrusted: () => true,
      now: clock.now,
    })
    await src.refreshCloudCreds("aws")
    await src.refreshCloudCreds("aws")
    expect(shell.calls.length).toBe(1) // throttled within window

    clock.advance(5001)
    await src.refreshCloudCreds("aws")
    expect(shell.calls.length).toBe(2)
  })

  test("no gcp config ⇒ refreshCloudCreds('gcp') is a no-op, never shells", async () => {
    const shell = makeShell()
    const src = createCredentialSource({
      awsAuthRefresh: "aws-only",
      shellExec: shell.exec,
      isTrusted: () => true,
    })
    await src.refreshCloudCreds("gcp")
    expect(shell.calls.length).toBe(0)
  })
})

describe("H7 credential-helper — failure + trust gate (no-throw, no-leak)", () => {
  test("failing helper (non-zero exit) → typed CredentialHelperError, no crash", async () => {
    const shell = makeShell(() => ({ stdout: "", stderr: "boom", exitCode: 7 }))
    const src = createCredentialSource({
      apiKeyHelper: "bad",
      shellExec: shell.exec,
      isTrusted: () => true,
    })
    await expect(src.mintApiKey()).rejects.toBeInstanceOf(CredentialHelperError)
  })

  test("shell that throws → typed CredentialHelperError, not the raw throw", async () => {
    const shell: ShellExecFn = async () => {
      throw new Error("spawn EACCES")
    }
    const src = createCredentialSource({
      apiKeyHelper: "bad",
      shellExec: shell,
      isTrusted: () => true,
    })
    await expect(src.mintApiKey()).rejects.toBeInstanceOf(CredentialHelperError)
  })

  test("untrusted workspace → helper BLOCKED (shell never invoked)", async () => {
    const shell = makeShell()
    const src = createCredentialSource({
      apiKeyHelper: "mint",
      awsAuthRefresh: "refresh",
      shellExec: shell.exec,
      isTrusted: () => false,
    })
    await expect(src.mintApiKey()).rejects.toMatchObject({ code: "untrusted" })
    // refresh must also be blocked — and it MUST NOT throw the loop down, but it
    // must not run the shell either.
    await src.refreshCloudCreds("aws").catch(() => {})
    expect(shell.calls.length).toBe(0)
  })

  test("helper exits 0 but emits EMPTY/whitespace stdout → typed error, NOT a cached empty key", async () => {
    // A misconfigured helper that succeeds (exit 0) yet prints nothing (or only
    // whitespace) cannot have "minted" a key. Returning "" would (a) cache a
    // broken credential for the full TTL and (b) let a `mint ?? envKey`
    // consumer override a WORKING env key with "". It must be a typed failure.
    let calls = 0
    const shell: ShellExecFn = async () => {
      calls += 1
      return ok("   \n\t  ") // exit 0, whitespace-only stdout
    }
    const clock = makeClock()
    const src = createCredentialSource({
      apiKeyHelper: "blank-mint",
      apiKeyHelperTtlMs: 60_000,
      shellExec: shell,
      isTrusted: () => true,
      now: clock.now,
    })
    await expect(src.mintApiKey()).rejects.toBeInstanceOf(CredentialHelperError)
    // The empty result must NOT have been cached — a second call re-runs the
    // shell (it is not pinned to a bogus "" for the TTL window).
    clock.advance(1)
    await expect(src.mintApiKey()).rejects.toBeInstanceOf(CredentialHelperError)
    expect(calls).toBe(2)
  })

  test("the minted key value NEVER appears in the typed error message", async () => {
    // helper exits non-zero but somehow echoes a secret on stdout — the error
    // must not carry that value.
    const secret = "sk-super-secret-DO-NOT-LEAK"
    const shell = makeShell(() => ({ stdout: secret, stderr: secret, exitCode: 9 }))
    const src = createCredentialSource({
      apiKeyHelper: "leaky",
      shellExec: shell.exec,
      isTrusted: () => true,
    })
    const err = await src.mintApiKey().catch((e) => e)
    expect(err).toBeInstanceOf(CredentialHelperError)
    expect(String((err as Error).message)).not.toContain(secret)
    expect(JSON.stringify(err)).not.toContain(secret)
  })
})
