/**
 * ADVERSARIAL HELLGATE — network-egress host-matching (ci-bot allowlist +
 * proxy `decideEgress`), DEEPER LAYER.
 *
 * ADDS territory `tests/unit/runtime/network-allowlist.test.ts` does not cover:
 * the host-matching EDGE CASES an exfil attacker probes — trailing dot, port
 * authority, userinfo spoof, embedded-suffix bypass, case in the allowlist
 * ENTRY, wildcard partial-suffix — plus the `decideEgress` fail-closed order
 * (SSRF-before-allowlist, unknown → deny).
 *
 * THE INVARIANT (under-block direction is the security one): a host NOT on the
 * allowlist must NEVER resolve to allowed. Over-blocking a canonical-but-odd
 * form (trailing dot / bare host with port) is FAIL-CLOSED and acceptable; this
 * file PINS the current fail-closed behavior so a naive "normalize the dot/port"
 * refactor that opens an under-block would go RED.
 */

import { describe, expect, test } from "bun:test"
import { isHostAllowed } from "@/../src/runtime/network-allowlist"
import { decideEgress, NetworkPolicyAmendment } from "@/runtime/network-proxy"

const AL = ["api.github.com", "*.githubusercontent.com"] as const

describe("host-matching adversarial — UNDER-BLOCK hunt (a denied host must never read as allowed)", () => {
  test("embedded allowlisted suffix in a longer host is DENIED (raw.githubusercontent.com.evil.com)", () => {
    // Classic suffix-confusion: the allowlisted string appears as a LABEL PREFIX
    // of an attacker domain. Must not match the *.githubusercontent.com wildcard.
    expect(isHostAllowed("https://raw.githubusercontent.com.evil.com/x", AL)).toBe(false)
    expect(isHostAllowed("raw.githubusercontent.com.evil.com", AL)).toBe(false)
  })

  test("glued suffix without a dot is DENIED (evilgithubusercontent.com)", () => {
    // `*.githubusercontent.com` must require a real label boundary, not a bare
    // string-suffix — else `evilgithubusercontent.com` would pass.
    expect(isHostAllowed("evilgithubusercontent.com", AL)).toBe(false)
    expect(isHostAllowed("https://xgithubusercontent.com/x", AL)).toBe(false)
  })

  test("wildcard apex is DENIED; a real subdomain is ALLOWED (boundary of the R2 fix)", () => {
    expect(isHostAllowed("githubusercontent.com", AL)).toBe(false)
    expect(isHostAllowed("raw.githubusercontent.com", AL)).toBe(true)
  })

  test("userinfo cannot spoof the authority: real hostname is what is checked", () => {
    // https://<allowlisted>@<evil>/ → the REAL host is evil; must be denied.
    expect(isHostAllowed("https://api.github.com@evil.com/x", AL)).toBe(false)
    // https://<evil-userinfo>@<allowlisted>/ → the REAL host is allowlisted; allow.
    expect(isHostAllowed("https://evil.com@api.github.com/x", AL)).toBe(true)
  })

  test("path/query cannot smuggle an allowlisted token past a denied authority", () => {
    expect(isHostAllowed("https://evil.com/api.github.com?x=raw.githubusercontent.com", AL)).toBe(
      false,
    )
  })

  test("an empty-leading-label form does not slip through the wildcard", () => {
    // `.githubusercontent.com` — equal length to the suffix ⇒ the strict
    // `length > suffix.length` guard denies it (no zero-label subdomain).
    expect(isHostAllowed(".githubusercontent.com", AL)).toBe(false)
  })

  test("a typosquat that DROPS a character from the suffix is denied", () => {
    // `githubusercontent` misspelled/truncated must not match `*.githubusercontent.com`.
    expect(isHostAllowed("raw.githubusercontnt.com", AL)).toBe(false)
    expect(isHostAllowed("raw.githubusercontent.co", AL)).toBe(false)
  })
})

describe("host-matching adversarial — FAIL-CLOSED over-blocking (pinned; a naive normalize must not open a hole)", () => {
  test("bare host with a trailing dot is DENIED today (fail-closed; pinned regression guard)", () => {
    // `api.github.com.` is DNS-equivalent to `api.github.com`, but the bare path
    // does not strip the dot ⇒ denied. Safe (over-block). Pinned so a future
    // "normalize trailing dot" change is forced to ALSO prove no under-block.
    expect(isHostAllowed("api.github.com.", AL)).toBe(false)
  })

  test("bare host WITH a port is DENIED today (fail-closed; pinned)", () => {
    expect(isHostAllowed("api.github.com:443", AL)).toBe(false)
  })

  test("a URL with an explicit :443 port IS allowed (port stripped by the URL parser)", () => {
    // The URL path extracts `hostname` (port-free) ⇒ allowed. Contrast with the
    // bare-host path above — pins the asymmetry so a refactor keeps it or fixes
    // both without opening an under-block.
    expect(isHostAllowed("https://api.github.com:443/x", AL)).toBe(true)
  })
})

describe("host-matching adversarial — case-insensitivity is symmetric (host AND entry)", () => {
  test("mixed-case host matches a lowercase entry", () => {
    expect(isHostAllowed("HTTPS://API.GITHUB.COM/x", AL)).toBe(true)
  })
  test("lowercase host matches a MIXED-CASE entry (entry is lowercased before compare)", () => {
    expect(isHostAllowed("a.githubusercontent.com", ["*.GITHUBUSERCONTENT.COM"])).toBe(true)
    expect(isHostAllowed("api.github.com", ["API.GITHUB.COM"])).toBe(true)
  })
})

describe("host-matching adversarial — empty allowlist is deny-all (no implicit allow)", () => {
  test("empty allowlist denies even a canonical host", () => {
    expect(isHostAllowed("https://api.github.com/x", [])).toBe(false)
    expect(isHostAllowed("api.github.com", [])).toBe(false)
  })
})

// ── proxy decideEgress: fail-closed ORDER (SSRF before allowlist, unknown→deny) ──

/** A fresh, empty amend-set (deterministic clock). */
const noAmend = (): NetworkPolicyAmendment => new NetworkPolicyAmendment(() => 0)

describe("decideEgress adversarial — SSRF guard fires BEFORE the allowlist", () => {
  test("a loopback/private literal IP is denied EVEN IF the caller allowlisted it", () => {
    // An operator who mistakenly allowlists 127.0.0.1 must still be blocked — the
    // SSRF classifier runs first (fail-closed order). Under-block sentinel.
    for (const ip of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "0.0.0.0"]) {
      const d = decideEgress({ host: ip, allowlist: [ip], amendments: noAmend() })
      expect(d.decision).toBe("deny")
    }
  })

  test("cloud-metadata endpoint gets a DEDICATED deny reason and cannot be allowlisted", () => {
    const d = decideEgress({
      host: "169.254.169.254",
      allowlist: ["169.254.169.254"],
      amendments: noAmend(),
    })
    expect(d.decision).toBe("deny")
    expect(d.reason.toLowerCase()).toContain("metadata")
  })

  test("an obfuscated-decimal form of the metadata IP is still denied", () => {
    // 169.254.169.254 == 2852039166; the structural classifier canonicalizes it.
    const d = decideEgress({ host: "2852039166", allowlist: [], amendments: noAmend() })
    expect(d.decision).toBe("deny")
  })
})

describe("decideEgress adversarial — unknown host fails closed to deny", () => {
  test("a public host NOT on the allowlist and NOT amended → deny", () => {
    const d = decideEgress({ host: "attacker.example.org", allowlist: AL, amendments: noAmend() })
    expect(d.decision).toBe("deny")
    expect(d.reason.includes("not in allow-set")).toBe(true)
  })

  test("an allowlisted public host → allow", () => {
    const d = decideEgress({ host: "api.github.com", allowlist: AL, amendments: noAmend() })
    expect(d.decision).toBe("allow")
  })

  test("an amendment can allow a non-SSRF host (post-approval flow)", () => {
    const amend = noAmend()
    amend.amend({ host: "extra.example.com", scope: "session", reason: "operator approved" })
    expect(
      decideEgress({ host: "extra.example.com", allowlist: [], amendments: amend }).decision,
    ).toBe("amended-allow")
  })

  test("an amendment for a private IP is MOOT — SSRF denies before the amendment lookup", () => {
    const amendIp = noAmend()
    amendIp.amend({ host: "127.0.0.1", scope: "session", reason: "x" })
    expect(decideEgress({ host: "127.0.0.1", allowlist: [], amendments: amendIp }).decision).toBe(
      "deny",
    )
  })
})
