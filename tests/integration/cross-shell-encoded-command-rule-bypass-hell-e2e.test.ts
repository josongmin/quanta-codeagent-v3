/**
 * Cross-shell encoded-command rule-bypass HELLGATE (e2e) — seals the EXACT
 * boundary between the two admissibility layers when a denylisted payload is
 * hidden behind a shell encoding wrapper (`pwsh -EncodedCommand <base64>`,
 * `pwsh -enc`, `cmd /c <payload>`).
 *
 * ── The asymmetry under test (verified, jun-10) ────────────────────────────
 * Two independent admissibility layers exist in quanta:
 *
 *   (1) DETERMINISTIC rules  — src/rules/matcher.ts + src/rules/argv.ts.
 *       Byte-prefix / argv-token-prefix matching over the command STRING.
 *       Explicitly contracted as "no I/O, no heuristics, total function of
 *       (rules, command)" (src/rules/types.ts:16-20) and "a MATCHING aid,
 *       NOT a security boundary" (src/rules/argv.ts:42-45). It does NOT and
 *       (by design) MUST NOT base64/hex-decode payloads — that would be an
 *       unbounded heuristic (which base64 variant? UTF-16LE vs UTF-8 for
 *       pwsh? `-enc`/`-e`/`-ec` abbreviations? embedded `;`? a hex char-array
 *       instead?) the slice's determinism contract forbids.
 *
 *   (2) LLM CLASSIFIER  — src/permission/classifier.ts:119 ("ENCODED
 *       COMMANDS"). The auto-mode classifier prompt EXPLICITLY owns decode:
 *       "When the command payload is base64-encoded or otherwise obfuscated
 *       (e.g. `pwsh -EncodedCommand` ...), decode it and apply the BLOCK/ALLOW
 *       rules to the decoded content. If you cannot confidently decode it ...
 *       block it."
 *
 * BRANCH CHOSEN: (B) — design split, not a bug.
 *   Decoding belongs to the LLM classifier, NOT the deterministic matcher.
 *   Pushing a partial base64 decoder into src/rules/** would (a) violate the
 *   slice's stated "no heuristics" determinism contract, (b) be a leaky,
 *   false-confidence patch (attacker swaps to hex/char-array/another shell),
 *   and (c) duplicate a responsibility the classifier prompt already owns
 *   verbatim. So we do NOT modify src/rules/** or src/permission/**. Instead
 *   we SEAL the current contract as a deliberate, documented regression guard.
 *
 * ── RESIDUAL RISK (bypass IS possible; this is the documented boundary) ─────
 * A deterministic argv DENY rule (`deny ["rm","-rf"]`) does NOT catch a
 * payload hidden behind `pwsh -EncodedCommand`/`-enc`. base64 ALSO hides the
 * `rm -rf` plaintext from the separate HARD_DENY dangerous-command substring
 * gate (which DOES catch the un-encoded `cmd /c rm -rf /` form — see the
 * defense-in-depth case below). So a base64 pwsh wrapper is the STRICTLY
 * STRONGER bypass: it evades BOTH the argv rule AND the substring gate. Under a
 * FALLTHROUGH / allowlist posture (no rule fires ⇒ fall through) such a command
 * is admitted by the deterministic layers and the encoding must be caught
 * downstream by the LLM classifier (layer 2, src/permission/classifier.ts:119).
 * Under a DEFAULT-DENY posture (`noMatchPolicy:"deny"`) the same wrapper is
 * denied precisely BECAUSE no rule matches — the residual risk is therefore
 * specific to fallthrough/allowlist deployments, and is sealed as such below.
 *
 * If a future change makes the deterministic matcher decode encodings, the
 * `no_match` assertions here turn RED — forcing an explicit decision to update
 * BOTH the contract docs AND this guard rather than silently shifting the
 * layer boundary.
 *
 * Hermetic: pure rules-store + gate seam, no clock/network, no timing asserts.
 */
import { describe, expect, test } from "bun:test"
import { type AdmissibilityWaveAOptions, runAdmissibilityGate } from "@/agent/admissibility-gate"
import { RulesStore } from "@/rules"
import { ToolRegistry } from "@/tool"
import { actionOf, bashSchema, call, cfg, makeTool } from "./admissibility-wave-a/_fixtures"

const loadedStore = (lines: string): RulesStore => {
  const s = new RulesStore()
  s.loadLayer("user", lines, "user.rules")
  return s
}

const bash = makeTool("bash", {
  readOnly: false,
  schema: bashSchema,
  extractShellCommand: (input) => (input as { command: string }).command,
})

/** Drive a command through the REAL admissibility gate with a user argv DENY
 *  rule loaded. `noMatchPolicy` selects the deployment posture:
 *   - "fallthrough" (allowlist/permissive): no_match ⇒ admit (bypass surface).
 *   - "deny" (default-deny): no_match ⇒ terminal deny. */
const runGate = async (
  storeLines: string,
  command: string,
  noMatchPolicy: "deny" | "fallthrough" = "fallthrough",
) => {
  const wave: AdmissibilityWaveAOptions = { rulesStore: loadedStore(storeLines), noMatchPolicy }
  const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
  const input = { command }
  return runAdmissibilityGate(
    call("bash", input),
    c,
    { mode: "bypass" },
    actionOf(bash, input),
    undefined,
    wave,
  )
}

/** PowerShell `-EncodedCommand` payloads are base64 of UTF-16LE. Build the
 *  real wire format an attacker would emit so the test is not strawman. */
const pwshEncoded = (script: string): string => Buffer.from(script, "utf16le").toString("base64")

const DENY_RM = 'deny ["rm", "-rf"]\n'

describe("cross-shell encoded-command rule bypass — hellgate (Branch B: design split)", () => {
  // ── Regression baseline: the direct (unencoded) path STILL denies ─────────
  // This is the property the encoding wrapper subverts. If this ever stops
  // denying, the whole premise (and the rules slice) is broken.
  test("BASELINE: direct `rm -rf ./dist` is DENIED by the argv rule (not regressed)", async () => {
    const res = await runGate(DENY_RM, "rm -rf ./dist")
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("rule_deny")
    expect(res?.block.content).toContain("Permission denied by rule")
  })

  // ── The bypass surface, sealed (fallthrough/allowlist posture) ────────────
  // RESIDUAL RISK: each of these hides/relocates `rm -rf` so the deterministic
  // argv rule cannot see it. Under fallthrough the rules layer ADMITS (null) —
  // the classifier (layer 2) is the backstop. These are NOT bugs; they pin the
  // documented layer boundary. (A) would require these to be `not.toBeNull()`.

  test("BYPASS: `pwsh -EncodedCommand <base64(rm -rf /)>` is NOT caught by the rule (fallthrough admits)", async () => {
    const cmd = `pwsh -EncodedCommand ${pwshEncoded("rm -rf /")}`
    const res = await runGate(DENY_RM, cmd)
    // Deterministic argv rule sees argv = [pwsh, -EncodedCommand, <opaque b64>];
    // `rm` never appears as a token ⇒ no_match ⇒ fallthrough admits (null).
    expect(res).toBeNull()
  })

  test("BYPASS: `pwsh -enc <base64>` (abbreviated flag) is NOT caught either", async () => {
    const cmd = `pwsh -enc ${pwshEncoded("rm -rf /home")}`
    const res = await runGate(DENY_RM, cmd)
    expect(res).toBeNull()
  })

  test("DEFENSE-IN-DEPTH: `cmd /c rm -rf /` evades the ARGV RULE but is caught by the HARD_DENY substring gate", async () => {
    // No base64 here — the argv token-prefix rule anchors at argv[0]=`cmd`, so
    // the literal `rm -rf` tokens are NOT an argv prefix and the rule does not
    // fire. BUT the plaintext `rm -rf` substring is still visible to a separate
    // HARD_DENY dangerous-command gate downstream, which blocks it (preview
    // "handoff"). KEY CONTRAST vs the encoded cases below: base64 hides the
    // substring from THAT gate too, so encoding is the strictly stronger bypass.
    const res = await runGate(DENY_RM, "cmd /c rm -rf /")
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("handoff")
  })

  // ── The same wrappers under DEFAULT-DENY posture: denied (boundary clarity) ─
  // Demonstrates the residual risk is posture-specific. With noMatchPolicy
  // "deny", the encoded wrapper is denied PRECISELY because it doesn't match
  // any rule — the classifier carries the burden only under fallthrough.

  test("POSTURE: under default-deny, the pwsh-encoded wrapper IS denied (no rule matched ⇒ terminal deny)", async () => {
    const cmd = `pwsh -EncodedCommand ${pwshEncoded("rm -rf /")}`
    const res = await runGate(DENY_RM, cmd, "deny")
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("rule_no_match_deny")
  })

  test("POSTURE: under default-deny, even the direct `rm -rf` denies via the rule (preview distinguishes the path)", async () => {
    // Direct hit still routes through the rule (rule_deny), not no_match —
    // proving default-deny doesn't mask which layer fired.
    const res = await runGate(DENY_RM, "rm -rf /tmp/x", "deny")
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("rule_deny")
  })

  // ── Over-correction guard: benign encoding-shaped commands must NOT be ─────
  // false-positived. A hypothetical decode-and-match (Branch A) implementation
  // would be at risk of flagging these; the current design correctly admits
  // them, and any future decoder MUST preserve that.

  test("OVER-CORRECTION: a benign `pwsh -EncodedCommand <base64(echo hi)>` is admitted (no false deny)", async () => {
    const cmd = `pwsh -EncodedCommand ${pwshEncoded("echo hi")}`
    const res = await runGate(DENY_RM, cmd)
    expect(res).toBeNull()
  })

  test("OVER-CORRECTION: an UNRELATED command that merely contains the substring `rm` is not denied", async () => {
    // `npm` contains `rm`; `chmod -rf`-shaped tokens differ. The argv rule is
    // token-anchored at argv[0]=`rm`, so neither fires. Guards against a naive
    // substring-based decoder over-matching.
    expect(await runGate(DENY_RM, "npm run build")).toBeNull()
    expect(await runGate(DENY_RM, "term -rf ./x")).toBeNull()
  })

  test("OVER-CORRECTION: `pwsh` itself with a non-encoded benign subcommand is admitted", async () => {
    const res = await runGate(DENY_RM, "pwsh -Command Get-ChildItem")
    expect(res).toBeNull()
  })

  // ── Direct argv DENY still works for the NON-wrapper PowerShell-native form ─
  // If a deny rule is written against the pwsh-native argv (no encoding), it
  // fires normally — confirming the gap is the ENCODING, not pwsh per se.
  test('CONTROL: `deny ["pwsh","-EncodedCommand"]` DOES deny any -EncodedCommand invocation (operator can opt in)', async () => {
    // An operator who wants to ban encoded pwsh outright CAN express it at the
    // argv level (block the flag, not the payload). This is the deterministic,
    // heuristic-free mitigation available today.
    const cmd = `pwsh -EncodedCommand ${pwshEncoded("rm -rf /")}`
    const res = await runGate('deny ["pwsh", "-EncodedCommand"]\n', cmd)
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("rule_deny")
  })
})
