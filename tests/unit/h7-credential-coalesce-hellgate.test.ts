/**
 * ★ HELLGATE — H7 credential helper SINGLE-FLIGHT (coalescing) under concurrency.
 *
 * The now-live composition path can share ONE `CredentialSource` across multiple
 * provider adapters (a fallback stack, parallel side-agents, two cloud adapters
 * built from the same builder). A shell-command credential helper / `*AuthRefresh`
 * is ARBITRARY COMMAND EXECUTION; firing it once PER concurrent caller is both a
 * resource defect (N redundant `aws sso login` shells) AND a cloud-auth-endpoint
 * rate-limit hazard. These cases pin: concurrent callers that all observe a
 * cache MISS / throttle-elapsed window collapse onto ONE shell invocation, while
 * NO-LEAK + the typed-error + the post-window re-run semantics survive.
 */
import { describe, expect, test } from "bun:test"
import {
  CredentialHelperError,
  createCredentialSource,
  type ShellExecResult,
} from "@/llm/credential-helper"

const SECRET = "sk-COALESCE-SECRET-AKIA1234567890DEADBEEF"

/** A gated shell: counts invocations and blocks until `release()` so we can pin
 *  TWO callers in-flight simultaneously before either completes. */
const gatedShell = (result?: () => { exitCode: number; stdout?: string }) => {
  let count = 0
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const shellExec = async (_command: string): Promise<ShellExecResult> => {
    count += 1
    await gate
    const r = result?.() ?? { exitCode: 0 }
    return { stdout: r.stdout ?? SECRET, stderr: SECRET, exitCode: r.exitCode }
  }
  return {
    shellExec,
    release,
    get count(): number {
      return count
    },
  }
}

describe("H7 coalesce — concurrent refreshCloudCreds share ONE shell", () => {
  test("two concurrent aws refreshes ⇒ shell runs EXACTLY once", async () => {
    const g = gatedShell()
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      shellExec: g.shellExec,
      isTrusted: () => true,
      now: () => 0,
    })
    const a = src.refreshCloudCreds("aws")
    const b = src.refreshCloudCreds("aws")
    g.release()
    await Promise.all([a, b])
    expect(g.count).toBe(1)
  })

  test("after the in-flight resolves, a DUE (post-TTL) refresh re-shells", async () => {
    const g = gatedShell()
    let now = 0
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      apiKeyHelperTtlMs: 1000,
      shellExec: g.shellExec,
      isTrusted: () => true,
      now: () => now,
    })
    const a = src.refreshCloudCreds("aws")
    const b = src.refreshCloudCreds("aws")
    g.release()
    await Promise.all([a, b])
    expect(g.count).toBe(1) // coalesced
    now = 2000 // TTL elapsed
    await src.refreshCloudCreds("aws")
    expect(g.count).toBe(2) // re-ran when DUE (not a stale single-flight pin)
  })

  test("aws + gcp concurrently ⇒ each cloud shells once (no cross-coalesce)", async () => {
    const g = gatedShell()
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      gcpAuthRefresh: "gcloud auth login",
      shellExec: g.shellExec,
      isTrusted: () => true,
      now: () => 0,
    })
    const a = src.refreshCloudCreds("aws")
    const c = src.refreshCloudCreds("gcp")
    g.release()
    await Promise.all([a, c])
    expect(g.count).toBe(2) // two distinct commands, one shell each
  })
})

describe("H7 coalesce — concurrent mintApiKey share ONE shell", () => {
  test("two concurrent mints ⇒ shell runs once, BOTH get the same key", async () => {
    const g = gatedShell(() => ({ exitCode: 0, stdout: "sk-minted-key" }))
    const src = createCredentialSource({
      apiKeyHelper: "mint",
      shellExec: g.shellExec,
      isTrusted: () => true,
      now: () => 0,
    })
    const a = src.mintApiKey()
    const b = src.mintApiKey()
    g.release()
    const [ka, kb] = await Promise.all([a, b])
    expect(g.count).toBe(1)
    expect(ka).toBe("sk-minted-key")
    expect(kb).toBe("sk-minted-key")
  })

  test("a FAILED concurrent mint is NOT pinned — a later mint retries", async () => {
    let calls = 0
    const shellExec = async (_c: string): Promise<ShellExecResult> => {
      calls += 1
      // First attempt fails, second (retry) succeeds.
      if (calls === 1) return { stdout: SECRET, stderr: SECRET, exitCode: 9 }
      return { stdout: "sk-recovered", stderr: "", exitCode: 0 }
    }
    const src = createCredentialSource({
      apiKeyHelper: "mint",
      shellExec,
      isTrusted: () => true,
      now: () => 0,
    })
    // First two concurrent calls coalesce onto the FAILING attempt.
    const results = await Promise.allSettled([src.mintApiKey(), src.mintApiKey()])
    for (const r of results) {
      expect(r.status).toBe("rejected")
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(CredentialHelperError)
        // NO-LEAK on the coalesced rejection.
        expect((r.reason as Error).message.includes(SECRET)).toBe(false)
      }
    }
    // A subsequent mint must NOT inherit the pinned failed promise — it retries.
    const recovered = await src.mintApiKey()
    expect(recovered).toBe("sk-recovered")
  })

  test("NO-LEAK survives coalescing: the shared key is never in a thrown message", async () => {
    const g = gatedShell(() => ({ exitCode: 5 }))
    const src = createCredentialSource({
      apiKeyHelper: "mint",
      shellExec: g.shellExec,
      isTrusted: () => true,
      now: () => 0,
    })
    const a = src.mintApiKey()
    const b = src.mintApiKey()
    g.release()
    const results = await Promise.allSettled([a, b])
    for (const r of results) {
      expect(r.status).toBe("rejected")
      if (r.status === "rejected") {
        expect((r.reason as Error).message.includes(SECRET)).toBe(false)
        expect((r.reason as CredentialHelperError).code).toBe("helper-failed")
      }
    }
  })
})
