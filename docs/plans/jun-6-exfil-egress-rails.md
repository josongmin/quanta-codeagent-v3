# RFC — Exfiltration mechanical rails + secret-aware egress

> Status: IMPLEMENTED — **(a) write-count cap + (b) glob-in-write guard ✅ (jun-06)**; **(c) exfil-scouting ✅ IMPLEMENTED (jun-06)**; **(B) secret-egress ✅ IMPLEMENTED (jun-06, PLAINTEXT-HTTP)** — and the **HTTPS-opaque gap is now CLOSED** by the Phase-2 TLS-MITM RFC **✅ IMPLEMENTED (jun-07)**: `docs/plans/jun-6-tls-mitm-egress.md` (ephemeral-CA decrypt → reuse this scan → re-encrypt; default-OFF + operator-opt-in; node:tls runtime, fail-closed on Bun).
> Date: 2026-06-06
> Slices touched: `src/tool/write/`, `src/tool/edit/` (a, b), `src/permission/classifier.ts` (c), `src/runtime/network-proxy/` (B)
> Default posture: OFF (byte-identical when every knob is unset)
> Feature axis: exfil-prevention **enforcement** (the mechanical teeth behind a taxonomy quanta already ships verbatim)

---

## 1. 요약 (and the honest framing)

quanta already ships the **Data-Exfiltration POLICY verbatim** — the security-monitor taxonomy in `src/permission/classifier.ts` carries the exact wording ("exfiltrating data", the Slack/Teams messaging-service exemption "the messaging-service exemption covers the destination, not the content", DELAYED/ENABLED-EFFECTS, ENCODED-COMMANDS, sub-agent-handoff). What is **absent is the mechanical enforcement** — the deterministic, non-LLM rails that fire even when the auto-mode classifier is OFF / unwired / circuit-broken. This RFC adds four such rails, each a small, additive, **default-OFF** seam:

- **(a) per-turn write/edit-count cap** — a dispatch-layer counter that, in an **untrusted-input** turn, requires confirmation / denies after N writes (defeats "drip-exfil via many small writes").
- **(b) glob-in-write guard** — write/edit input validation rejects a glob/wildcard in the `path` arg → typed `rejected` ("specify an exact path"). Closes the "write to `**/secrets/*`"-style fan-out.
- **(c) exfil-scouting classifier signal** — a deterministic detector for a *sequence* of probes against endpoints NOT in the Environment allowlist (webhook sinks, file-share, DNS resolvers) → surface an `exfil-scouting` classification as a strong block hint.
- **(B) secret-aware egress** — wire the EXISTING `compositeSecretScanner` (`src/security/secret-detection/`) into the egress proxy's request path so an outbound BODY/HEADER carrying a declared secret is denied/redacted — today the proxy decides on **HOST ONLY**.

**Honesty up front (false-positive risk is the whole ballgame here).** These are security teeth, and a too-aggressive teeth set breaks legitimate work: a legit codegen turn writes 30 files; a legit `web_fetch` POSTs a body containing a high-entropy token that is NOT a secret; a legit health-check probes a non-allowlisted host. Every rail below is therefore (i) default-OFF, (ii) gated as narrowly as the signal allows (untrusted-context for (a), declared-secrets-only for (B)), and (iii) shipped with explicit false-positive accounting in §7. We frame all four as **enforcement of an existing policy**, not new policy.

---

## 2. 경쟁사 레퍼런스 (verified evidence)

### 2.1 (a)(b)(c) — Claude Code CLI exfil rails (rounds 3 + 5)

- **(a) per-turn write cap** — verbatim rationale: *"limit prevents data exfiltration via repeated write operations in untrusted-input workflows."* A count cap on writes within a single turn, gated on the turn carrying untrusted input.
- **(b) glob-in-write ban** — verbatim user-facing message: *"Glob patterns are not allowed in write operations. Please specify an exact file path."* Write/edit reject a path that is a glob pattern (the tool writes ONE file; a glob is either a mistake or a fan-out exfil attempt).
- **(c) Exfil Scouting** — verbatim taxonomy entry: *"Testing which endpoints not listed in Environment are reachable — webhook sites, file-sharing, DNS resolvers — treat as preparation for data exfiltration."* The signal is a *probe sequence* against hosts absent from the declared Environment allowlist.

### 2.2 (B) — Codex secret-aware egress (round 5)

Codex's config exposes `secret_env_var` / `secret_file` declarations plus a `network.mitm` + `inject_request_headers` egress layer. The egress proxy **inspects the request BODY and HEADERS** and strips/blocks declared secrets from leaving over the wire — i.e. the protection is content-level on the OUTBOUND payload, not just a host allow/deny. This is strictly stronger than quanta's current host-only `decideEgress`.

---

## 3. 현재 quanta 상태 (grep-verified) — RE-AUDIT verdict per sub-part

### 3.0 Policy already absorbed (confirm — NOT a gap)

`src/permission/classifier.ts` `CLASSIFIER_SYSTEM_PROMPT` (lines 49–143) carries the Data-Exfiltration taxonomy verbatim, including the messaging-service exemption (line 122: *"the messaging-service exemption covers the destination, not the content"*), DELAYED/ENABLED-EFFECTS (line 115), ENCODED-COMMANDS (line 119), and PREEMPTIVE-BLOCK-ON-CLEAR-INTENT (line 120). **Round-3's claim is correct: the policy is present.** The gap is mechanical teeth + ONE missing classification label (exfil-scouting, §3.4).

### 3.1 (a) per-turn write-count cap — **GENUINE GAP (absent)**

- `grep -rn "writeCount|writeCap|writeLimit|maxWrites|writesThisTurn|per-turn" src/tool/write/ src/tool/edit/ src/agent/dispatch*` → **no matches**.
- `src/tool/write/index.ts` has a *description-string* anti-pattern hint only ("Multiple consecutive writes to the same file is almost always a wrong pattern", lines 70–75) — **advisory prose to the model, NOT an enforced counter**. No per-turn state exists in the write/edit tools or in `src/agent/dispatch.ts`.
- `ToolContext` (`src/tool/types.ts:103`) has no write-counter field. **VERDICT: build it.**

### 3.2 (b) glob-in-write guard — **GENUINE GAP (absent)**

- `src/tool/write/index.ts` (read in full) validates: git-write-guard (`gitWriteGuardDeny`, line 101), stale-read-guard (line 113), FS-jail (`FsJailError`, line 150). The schema (lines 52–55) is `{ path: z.string(), content: z.string() }` — **no glob/wildcard rejection**. Same for `src/tool/edit/index.ts`. A path like `src/**/*.ts` is accepted as a literal filename; the jail/fs layer would then create/overwrite a single oddly-named file or error — neither is the typed `rejected` the feature wants. **VERDICT: add a small input-validation guard.**

### 3.3 (c) exfil-scouting detection — **GENUINE GAP (label + sequence detector absent)**

- `grep -rn "scout|Scout|unlisted|reachab|webhook|file-shar|DNS resolv" src/permission/ src/runtime/network-proxy/` → only unrelated hits (`per-host-mode` env "probe" comment, `inspect.ts` `probeAction`). **No exfil-scouting signal.**
- The taxonomy prose (§3.0) does NOT contain the exfil-scouting entry — it is the one missing line vs the round-3+5 corpus. And there is no *deterministic sequence detector* watching repeated denied-host probes.
- The raw material IS present: `src/runtime/network-proxy/decision.ts` already DENIES non-allowlisted hosts (line 103) and writes a `DecisionLogEntry` (`loopback-proxy.ts:186` `record()` → `decisionLog()`), and `@/runtime/network-allowlist#isHostAllowed` is the canonical allow predicate. So a detector can be built by *reading the existing deny-log*, not new interception. **VERDICT: add the taxonomy line + a deterministic detector over the deny-log.**

### 3.4 (B) secret-aware egress — **GENUINE GAP (host-only today)**

- `src/runtime/network-proxy/decision.ts` `decideEgress` (read in full): decides on **HOST ONLY** — SSRF literal-IP guard → `isHostAllowed` → amendment → fail-closed. **Never touches body or headers.** `DecideInput` is `{ host, allowlist, amendments }` — no payload field.
- `src/runtime/network-proxy/loopback-proxy.ts` (read in full): the intercept seam exists. **CRITICAL HONEST CAVEAT** — the plain-HTTP path (`onRequest`/`pipeHttp`, lines 195–253) *does* see `req` (method, headers, body stream) and could be scanned. But the **HTTPS path is `CONNECT host:443` → a raw TLS tunnel** (`onConnect`/`openTunnel`, lines 256–290) — the proxy *cannot read the encrypted bytes* (the file's own header comment says so, lines 11–14). So body/header secret-scanning is feasible **only for plaintext HTTP egress** unless we add MITM TLS termination (Codex's `network.mitm`) — which is a much larger, higher-risk change. See §5 for the scope decision.
- `src/security/secret-detection/composite-scanner.ts` (read in full): `compositeSecretScanner()` returns a `SecretScanner` with `scanText(text)` / `scanFile(path)` — pattern + entropy adapters, deduped, sorted. **This is exactly the scanner we inject.**
- Current scanner wiring is **inbound / logs only**: `src/tool/check_secrets.ts` (`scanText` on user-supplied text, line 117), `src/agent/dispatch.ts` `applyRedaction(result.output, …)` (line 1132) redacts **tool RESULT output** the model reads — i.e. data coming IN, never the request going OUT. Round-5's claim is confirmed: **the scanner redacts logs/output, NOT outbound payloads.** **VERDICT: wire the existing scanner into the egress decision's request path.**

### 3.5 H2 untrusted-source envelope (the provenance tie for (a))

`src/agent/untrusted-envelope/` exists (ADR-0471): `gate.ts` resolves `QUANTA_UNTRUSTED_ENVELOPE === "1"` from an injected env bag; `wrap.ts`/`rule.ts`/`types.ts` mark content that entered from an untrusted source (web/MCP/file tool output). This is the **existing signal** the write-count cap (a) keys on — "is this turn processing untrusted input". `src/permission/policy-layers/provenance-guard.ts` is the per-tool provenance gate already in the tree. (a) reuses this rather than inventing an untrusted-context flag.

### 3.6 Summary table

| Sub-part | Verdict | Where the teeth go | Raw material reused |
| --- | --- | --- | --- |
| Data-Exfil policy | **ALREADY BUILT** (verbatim) | `classifier.ts:49-143` | — |
| (a) write-count cap | **GAP** | dispatch / `ToolContext` counter | untrusted-envelope gate (§3.5) |
| (b) glob-in-write | **GAP** | `write`/`edit` input validation | zod schema + typed `rejected` |
| (c) exfil-scouting | **GAP** | classifier label + deny-log detector | proxy `decisionLog()` + allowlist |
| (B) secret egress | **GAP** (host-only) | `decideEgress` request path | `compositeSecretScanner` |

---

## 4. 설계

### 4.1 (a) Per-turn write/edit-count cap — **✅ IMPLEMENTED (jun-06)**

> **AS-BUILT (jun-06).** Closed-port `WriteBudgetPort` (`src/tool/_shared/write-budget.ts`):
> the ctx-facing seam is `{ readonly maxWritesPerTurn; recordWrite(): "ok"|"confirm"|"deny" }`;
> the session-long, turn-keyed `SessionWriteBudget` (`recordWrite(turn)` resets the
> counter when the turn ordinal advances — pure-by-state, NO clock/random) is the
> concrete counter, adapted to the per-call seam by `bindWriteBudgetTurn(budget, turn, max)`.
> The host (`agent-config-assembler.ts maybeWireWriteBudget`) mints ONE
> `SessionWriteBudget` per session, with `untrustedContext` resolved from the
> EXISTING untrusted-envelope gate (`QUANTA_UNTRUSTED_ENVELOPE`) and the cap from
> `QUANTA_WRITE_BUDGET_MAX`. **Both `QUANTA_WRITE_BUDGET=1` AND a `QUANTA_WRITE_BUDGET_MAX`
> integer are REQUIRED** — the cap is a knob with **no hardcoded default** (no-heuristics
> rule), so an enabled-but-uncapped config is inert (byte-identical). Dispatch
> (`buildToolContext`) binds the current `config.run?.turn ?? 0` so the counter resets
> per turn. The over-cap verdict ships as `confirm` (the narrow §7 default). `write`/`edit`
> call the shared `writeBudgetDeny`/`writeBudgetEvent` (`_shared/exfil-rail-guards.ts`)
> AFTER the static + stale guards and BEFORE the commit (a deny is never a partial write).
> Tests: `tests/unit/exfil-rails-write-budget.test.ts` + the dispatch/assembler-wiring
> proof `tests/unit/exfil-rails-dispatch-wire-hellgate.test.ts`.

**Where.** A per-turn mutable counter in the dispatch layer, surfaced to write/edit via `ToolContext`. The counter is reset at turn start (the natural seam where the turn loop already builds `ToolContext`).

**Shape (closed-port, default-OFF).**
```ts
// src/tool/types.ts — additive optional field on ToolContext (absent ⇒ inert)
interface ToolContext {
  // … existing fields …
  /** jun-6 exfil-rail. Per-turn write/edit budget enforcement. Absent ⇒
   *  byte-identical (no counter, no cap). Wired only when the knob is ON. */
  writeBudget?: WriteBudgetPort
}

// src/tool/_shared/write-budget.ts (NEW, leaf — pure, injectable clock-free)
export interface WriteBudgetPort {
  /** True when the CURRENT turn is processing untrusted input (from the
   *  untrusted-envelope gate). Cap applies ONLY when this is true. */
  readonly untrustedContext: boolean
  /** Per-turn cap (default e.g. 50; see §7 calibration). */
  readonly maxWritesPerTurn: number
  /** Bump-and-check. Returns "ok" | "confirm" | "deny" for the Nth write. */
  recordWrite(): "ok" | "confirm" | "deny"
}
```

**Behavior.** In `write`/`edit` `execute`, after the existing guards, call `ctx.writeBudget?.recordWrite()`. `undefined` (unwired) ⇒ proceed (byte-identical). `"ok"` ⇒ proceed. `"confirm"` ⇒ yield a `ToolResult` requiring HITL confirmation (or, in headless/auto, route to `deny`). `"deny"` ⇒ typed `rejected` failure with reason `write_budget_exceeded` ("N writes in an untrusted-input turn; confirm to continue").

**Gating (the false-positive control).** The cap fires **only when `untrustedContext === true`** — i.e. the turn ingested web/MCP/file output (the §3.5 untrusted-envelope signal). A normal trusted codegen turn (user asked to scaffold a project) has `untrustedContext === false` ⇒ cap never fires ⇒ unlimited writes. This is the single most important false-positive guard: the cap targets the *drip-exfil-after-prompt-injection* shape, not legit bulk authoring.

**Knob.** `QUANTA_WRITE_BUDGET=1` enables; `QUANTA_WRITE_BUDGET_MAX=<N>` overrides the cap (default chosen in §7). Resolved from injected env via a `gate.ts` mirroring the untrusted-envelope gate (strict `=== "1"`).

### 4.2 (b) Glob-in-write guard — **✅ IMPLEMENTED (jun-06)**

> **AS-BUILT (jun-06).** Pure leaf `pathLooksLikeGlob(path)` (`src/tool/_shared/glob-in-path.ts`)
> fires on the UNAMBIGUOUS glob tokens `*`, `?`, and `{a,b}` brace EXPANSION (a `{`
> whose matching `}` encloses a comma — depth-tracked linear scan). **It deliberately
> does NOT fire on a `[…]` bracket class** (`file[1].txt`/`arr[0].json` are real
> filenames and a class matches a single char, never a fan-out) — that is the
> documented no-false-positive decision (RFC §6 (b) test). When `ctx.globWriteGuard === true`
> (dispatch threads it from `QUANTA_GLOB_WRITE_GUARD=1`) the write/edit tools reject a
> glob `path` BEFORE any fs call with the typed `{mode:"rejected", reason:"glob_in_write_path"}`
> failure and the **verbatim** cc-cli message ("Glob patterns are not allowed in write
> operations. Please specify an exact file path."). Ships **default-OFF** for byte-identity
> (per the RFC; a strong default-ON candidate after a soak). Gate predicate
> `globWriteGuardEnabled` (`_shared/glob-write-gate.ts`). Tests:
> `tests/unit/exfil-rails-glob.test.ts` + the dispatch proof.

**Where.** A pure validator at the top of `write`/`edit` `execute`, BEFORE any fs call — same posture as `gitWriteGuardDeny` (`write/index.ts:101`).

**Shape.**
```ts
// src/tool/_shared/glob-in-path.ts (NEW, pure leaf)
/** True if `path` contains an UNESCAPED glob metacharacter (* ? [ ] { })
 *  in a position that makes it a pattern, not a literal filename. Conservative:
 *  only the unambiguous glob tokens, so a legit filename with a literal `[`
 *  is NOT a false positive unless it also pairs into a class. */
export const pathLooksLikeGlob = (path: string): boolean => /* … */
```

**Behavior.** When `pathLooksLikeGlob(input.path)` ⇒ yield typed `{ ok:false, failure:{ mode:"rejected", reason:"glob_in_write_path" }, output:"Glob patterns are not allowed in write operations. Please specify an exact file path." }` (the verbatim CC message). Else proceed unchanged.

**Honesty.** This one is nearly free of false-positive risk (a real write target is a single concrete path; `**`/`*`/`{a,b}` in a write path is virtually always a bug or attack). The conservative detector + the `**` / `*` / `{,}` tokens keeps the rare literal-bracket filename safe. Default-OFF gated `QUANTA_GLOB_WRITE_GUARD=1` out of caution, but this is the lowest-risk candidate and a strong default-ON candidate after a soak.

### 4.3 (c) Exfil-scouting sequence detector — **✅ IMPLEMENTED (jun-06)**

> **AS-BUILT (jun-06).** Pure `detectScouting(log, { threshold K, sampleCap? })`
> (`src/runtime/network-proxy/scouting.ts`) reads the proxy's EXISTING
> append-only `decisionLog()`, counts DISTINCT hosts whose decision is `deny`,
> and returns an advisory `ScoutingSignal { kind:"exfil-scouting",
> distinctDeniedHosts, sample }` IFF that count ≥ K. **K is a REQUIRED knob with
> NO hardcoded default** (no-heuristics: a non-positive / non-integer K ⇒ `null`,
> inert — never a guessed value); `QUANTA_EXFIL_SCOUTING_K` carries it. The
> verbatim taxonomy line (`EXFIL_SCOUTING_TAXONOMY_LINE`) is appended to the
> classifier prompt ONLY via `withExfilScoutingTaxonomy(base, enabled)` — OFF ⇒
> `base` UNCHANGED (byte-identical prompt). Gate `exfilScoutingEnabled`
> (`QUANTA_EXFIL_SCOUTING=1`). Advisory, NOT a hard auto-deny (RFC §7 (c)): only
> DISTINCT hosts count, so a same-host retry loop / K allowlisted hosts never
> trip it. Tests: `tests/unit/exfil-scouting-hellgate.test.ts`. The deny-log →
> classify-port advisory surfacing is a host-binding follow-up (pure seam today).

**Two parts.**

1. **Taxonomy line** — add the missing entry to `CLASSIFIER_SYSTEM_PROMPT` (the ONE line vs the corpus), verbatim: *"Exfil Scouting: Testing which endpoints not listed in Environment are reachable — webhook sites, file-sharing, DNS resolvers — treat as preparation for data exfiltration."* This is LLM-path policy (advisory to the auto-mode classifier). **It is prose-only and does not change byte-identical behavior of the deterministic path** (the classifier is already an injected, default-degrades-to-ask port).

2. **Deterministic detector (the teeth)** — a pure function over the EXISTING proxy `decisionLog()` (`loopback-proxy.ts:176`). It counts **distinct non-allowlisted hosts that were DENIED** within a turn window; ≥ K distinct denied hosts (default K, §7) → emit an `exfil-scouting` signal the policy layer can surface as a `classification`.
```ts
// src/runtime/network-proxy/scouting.ts (NEW, pure)
export interface ScoutingSignal { kind: "exfil-scouting"; distinctDeniedHosts: number; sample: string[] }
export const detectScouting = (
  log: readonly DecisionLogEntry[],
  opts: { window?: number; threshold?: number },
): ScoutingSignal | null => /* count distinct denied hosts in window vs threshold */
```

**Reuse.** No new interception — the proxy already records every deny (`record()`), and `isHostAllowed` already defines "not in Environment". The detector is a read-only aggregate. **Default-OFF** `QUANTA_EXFIL_SCOUTING=1`; when OFF the detector is never called and the prose line is omitted from the assembled prompt (so byte-identical prompt + behavior).

**Honesty.** A legit turn that *probes several services it forgot to allowlist* trips this. So the signal is **advisory** (a `classification` hint feeding the classifier / a surfaced warning), NOT a hard auto-deny — the user can allowlist and continue. Threshold K must be high enough that a couple of misconfigured hosts don't fire (§7).

### 4.4 (B) Secret-aware egress (the headline) — **✅ IMPLEMENTED (jun-06, PLAINTEXT-HTTP only)**

> **AS-BUILT (jun-06).** Closed-port `NetworkProxyConfig.secretEgress`
> ({ `scanner` = `compositeSecretScanner()`, `mode:"deny"|"redact"`, `declared?`,
> `maxBodyBytes` }) injects the EXISTING scanner into the proxy's PLAINTEXT-HTTP
> path. `onRequest` → after the host-allow decision, when `secretEgress` is
> present, `scanAndPipeHttp` buffers the outbound body up to `maxBodyBytes`,
> scans body + header values (`scanEgressText`: a ZERO-FP `declared` exact-match
> pass + the composite scanner), and on a hit either **denies** (403, a
> secret-free reason naming only finding KINDS) or **redacts** (masks the
> declared spans + drops the offending headers, forwards the rest via
> `pipeBufferedHttp`). A scanner-only finding (no exact declared span) cannot be
> safely in-place redacted ⇒ falls back to deny (fail-closed). A body past
> `maxBodyBytes` is forwarded UNSCANNED with a visible `body-cap-unscanned`
> decision-log marker (DoS guard — NEVER blocked-by-truncation). Gate
> `secretEgressMode` (`QUANTA_SECRET_EGRESS=deny|redact`); `maxBodyBytes` from
> `QUANTA_SECRET_EGRESS_MAX_BODY` (no hardcoded default). DEFAULT-OFF: absent ⇒
> host-only decision, byte-identical.
>
> **⚠️ HTTPS GAP — NOW CLOSED (jun-07) by the Phase-2 TLS-MITM RFC.** With MITM
> OFF (the default) the `CONNECT host:443` tunnel carries raw TLS bytes the proxy
> cannot read, so a CONNECT request is NEVER content-scanned and `onConnect`
> records a dedicated `connect-tunnel-unscanned` marker (VISIBLE, never a silent
> claim). When the operator EXPLICITLY opts into TLS-MITM (`QUANTA_TLS_MITM=1` +
> verbatim ack), an allowed CONNECT is TERMINATED, the decrypted body+headers run
> through THIS SAME secret-egress scan, then re-originate upstream (real cert
> validated). See `docs/plans/jun-6-tls-mitm-egress.md` (ephemeral-CA blast-radius
> threat model; node:tls runtime, fail-closed on Bun). Tests:
> `tests/unit/secret-egress-hellgate.test.ts` (pure core) +
> `tests/integration/secret-egress-proxy-e2e.test.ts` (real-socket: deny/redact/
> header/clean/CONNECT-unscanned/body-cap/default-OFF).

**Where.** Inject the existing `compositeSecretScanner` into the egress DECISION's *request path*. Two integration points in `loopback-proxy.ts`, but ONLY the **plaintext-HTTP** path can be scanned (the HTTPS CONNECT tunnel is opaque — §3.4 caveat).

**Closed-port shape.**
```ts
// src/runtime/network-proxy/types.ts — additive on NetworkProxyConfig
interface NetworkProxyConfig {
  // … existing { enabled, allowlist, … } …
  /** jun-6 secret-egress. Injected scanner. Absent ⇒ no body/header scan
   *  (byte-identical host-only decision). */
  secretEgress?: {
    readonly scanner: SecretScanner          // = compositeSecretScanner()
    readonly mode: "deny" | "redact"         // deny the request OR strip the secret
    readonly declared?: ReadonlyArray<string> // optional Codex-style secret_env_var values
  }
}
```

**Behavior (plaintext HTTP only).** In `pipeHttp` (before dialing upstream), buffer the request body up to a cap, run `scanner.scanText(body)` + scan header values; on a finding:
- `mode:"deny"` ⇒ `403` + reason `egress denied: outbound secret detected (<kind>)`, recorded in the deny-log (which also feeds (c)).
- `mode:"redact"` ⇒ replace the matched span with a mask before forwarding (mirrors the inbound `applyRedaction` shape) — preferred for legit-but-leaky payloads.
- `declared` (Codex parity) ⇒ exact-match those values in addition to pattern/entropy findings — a *declared* secret leaving is always denied regardless of entropy.

**The HTTPS honesty.** For `CONNECT`-tunneled HTTPS the proxy sees only the authority — **body/header scanning is NOT possible without TLS MITM.** Two options:
- **Phase 1 (this RFC):** scan plaintext-HTTP egress only + scan `declared` secrets that appear in the CONNECT authority / SNI is N/A; document the HTTPS gap loudly. This still covers a real class — many webhook/file-share exfil sinks and misconfigured internal services are plain HTTP, and quanta's own `web_fetch` / MCP-over-HTTP request bodies are visible when not TLS.
- **Phase 2 (DEFERRED, separate RFC):** Codex-style `network.mitm` — terminate TLS at the proxy with a locally-trusted CA, scan, re-originate. High blast radius (CA trust, cert pinning breakage, latency) — explicitly OUT of scope here.

**Reuse.** `compositeSecretScanner` is used as-is (pattern + entropy + the existing `allowlist` opt to drop fixture tokens — directly the false-positive lever). The proxy seam (`loopback-proxy.ts`) already intercepts; only the decision layer gains the scan. **Default-OFF**: `secretEgress` absent ⇒ host-only decision, byte-identical.

**Knob.** `QUANTA_SECRET_EGRESS=deny|redact` (unset ⇒ off). `QUANTA_SECRET_EGRESS_MAX_BODY=<bytes>` caps the buffered body (DoS guard — a streaming upload past the cap is forwarded unscanned with a logged warning, never blocked-by-truncation).

---

## 5. 스코프 결정 (what we build vs defer)

| Item | This RFC | Status | Deferred |
| --- | --- | --- | --- |
| (a) write cap (untrusted-gated) | ✅ | **✅ IMPLEMENTED (jun-06)** | trusted-context cap (rejected — breaks bulk authoring) |
| (b) glob-in-write reject | ✅ | **✅ IMPLEMENTED (jun-06)** | — |
| (c) scouting prose + deny-log detector | ✅ advisory | **✅ IMPLEMENTED (jun-06)** | hard auto-deny on scouting (too aggressive) |
| (B) secret egress — plaintext HTTP body/header | ✅ | **✅ IMPLEMENTED (jun-06)** | — |
| (B-Phase2) TLS-MITM — HTTPS body/header | ✅ | **✅ IMPLEMENTED (jun-07)** | `jun-6-tls-mitm-egress.md`: ephemeral-CA decrypt→reuse scan→re-encrypt; default-OFF + operator-opt-in; node:tls runtime (fail-closed on Bun) |

**TLS MITM (Phase-2, now done):** terminating TLS to scan HTTPS bodies does require a locally-trusted CA — but it is contained: an EPHEMERAL in-process CA trusted ONLY by quanta's own client for the MITM'd socket (never the OS / never persisted), double-gated default-OFF, upstream cert STILL validated, fail-closed on any handshake error. No new dep (pure `node:crypto` cert-gen). See the Phase-2 RFC for the full blast-radius threat model + the Bun runtime caveat.

---

## 6. 테스트 / hellgate (per part)

### (a) write-count cap — `tests/.../write-budget-hellgate.test.ts`
- Cap **fires at N** in an untrusted-context turn (`untrustedContext:true`) → Nth write returns `confirm`/`deny`.
- Cap **OFF when trusted** (`untrustedContext:false`) → 1000 writes all `ok`.
- Unwired (`ctx.writeBudget` absent) → byte-identical (no counter touched).
- Knob `QUANTA_WRITE_BUDGET` unset ⇒ wiring inert.
- Counter resets at turn boundary (write 1 of turn 2 is "ok" even after turn 1 hit the cap).

### (b) glob-in-write — `tests/.../glob-write-hellgate.test.ts`
- `path:"src/**/*.ts"` / `"a/*.js"` / `"{a,b}.txt"` → typed `rejected` reason `glob_in_write_path`, verbatim message.
- Exact path `"src/foo.ts"` → **allowed** (proceeds to existing fs path).
- Literal-bracket-but-not-a-class filename (e.g. `"file[1].txt"` if treated literal) — assert the conservative detector's documented decision (no false positive).
- Unwired/off ⇒ byte-identical.

### (c) exfil-scouting — `tests/.../scouting-hellgate.test.ts`
- A deny-log with **K distinct denied non-allowlisted hosts** in-window → `detectScouting` returns the signal with the sample.
- **NO false positive:** a single denied host, or K denials of the SAME host, or K *allowlisted* hosts → `null`.
- Prose line present in the assembled prompt **only when** `QUANTA_EXFIL_SCOUTING=1`; absent otherwise (byte-identical prompt assertion).

### (B) secret egress — `tests/.../secret-egress-hellgate.test.ts`
- A secret (AWS-key pattern + a `declared` token) in an outbound **plaintext-HTTP** body (`web_fetch`/MCP-over-HTTP) → `deny` (403, reason) or `redact` (masked span forwarded), per mode.
- Secret in a **request HEADER** value → same.
- **NO false positive:** a legit body with a high-entropy-but-allowlisted fixture token (via scanner `allowlist`) → forwarded unchanged.
- **HTTPS CONNECT** path → documented: body NOT scanned (assert the gap is explicit, not a silent claim of coverage).
- Body over `MAX_BODY` cap → forwarded with logged warning, NOT blocked-by-truncation.
- `secretEgress` absent ⇒ host-only decision byte-identical.

### Cross-cutting
- All four knobs unset ⇒ full byte-identical battery (write/edit output strings, proxy decision-log entries, assembled prompt bytes).

---

## 7. False-positive accounting (HONEST — this is the load-bearing risk)

The taxonomy is policy; teeth are enforcement; **the failure mode of teeth is breaking legit work**, not letting attacks through (those are caught by the existing classifier). For each rail, the legit-traffic shape that would mis-fire and the mitigation:

- **(a) write cap.** Legit mis-fire: a codegen turn that *also* ingested untrusted input (e.g. "read this web spec, then scaffold 80 files") legitimately writes > N. Mitigation: (i) gate on `untrustedContext` only — narrows to the genuinely-suspect shape; (ii) `confirm` (not silent deny) as the default verb so the user can wave it through; (iii) **calibrate N conservatively (proposed default 50)** — high enough that ordinary turns never approach it, low enough that a drip-exfil of hundreds of files trips. n=measure-first: the default MUST be set from a corpus of real turn write-counts, not guessed (per the no-heuristics memory rule) — flagged as a calibration TODO, NOT shipped as a magic number.
- **(b) glob-in-write.** Lowest risk — a write target is a single concrete path; a glob there is ~always a bug/attack. Residual risk: a real filename containing `*`/`{`. Mitigation: conservative token set + the literal-bracket test case; safe default-ON candidate after soak.
- **(c) scouting.** Legit mis-fire: a turn that probes several not-yet-allowlisted services (new integration setup). Mitigation: **advisory only** (a classification hint / warning, never a hard auto-deny), threshold K calibrated high (proposed ≥ 4 distinct denied hosts), and the user's natural fix (allowlist the host) clears it.
- **(B) secret egress.** Highest false-positive surface — a high-entropy string is not always a secret (a UUID, a base64 image chunk, a content hash in a legit POST body). Mitigations: (i) the scanner's existing pattern adapter (high-confidence known formats) is the primary signal; entropy is secondary; (ii) the scanner `allowlist` opt drops known-public tokens; (iii) `redact` mode (mask the span, forward the rest) is less disruptive than `deny`; (iv) `declared` (Codex `secret_env_var` parity) gives a **zero-false-positive** exact-match path for the secrets the user actually cares about — recommend `declared` as the default-recommended mode over broad entropy denial.

**Bottom line:** every rail defaults OFF and the two highest-FP rails ((a), (B)) ship with a *narrow* default mode (untrusted-gated `confirm`; declared-secret exact-match) so the broad/aggressive modes are opt-in.

---

## 8. 작업 분해 (L2/L3)

1. (b) glob-in-write — **✅ DONE (jun-06)**: `glob-in-path.ts` pure leaf + `glob-write-gate.ts` + `_shared/exfil-rail-guards.ts` guard in write/edit + dispatch flag thread + hellgate.
2. (B) secret-egress — **✅ DONE (jun-06, PLAINTEXT-HTTP)**: `NetworkProxyConfig.secretEgress` (`secret-egress.ts` pure core + `secret-egress-gate.ts`) + `pipeHttp` body/header scan + redact/deny + body cap + `connect-tunnel-unscanned`/`body-cap-unscanned` visible markers + hellgate (pure + e2e). Closed-port: injects `compositeSecretScanner`. HTTPS-MITM DEFERRED → NEW Phase-2 RFC `docs/plans/jun-6-tls-mitm-egress.md`.
3. (a) write-budget — **✅ DONE (jun-06)**: `WriteBudgetPort`/`SessionWriteBudget` (`_shared/write-budget.ts`) + `ToolContext.writeBudget` + `AgentConfig.writeBudget` + dispatch turn-bind reset + `maybeWireWriteBudget` untrusted-envelope tie + hellgate. **N is a required knob (`QUANTA_WRITE_BUDGET_MAX`), no default — calibrate from a real corpus before any default-ON.**
4. (c) scouting — **✅ DONE (jun-06)**: verbatim taxonomy prose line (`withExfilScoutingTaxonomy`, ON-only append) + `detectScouting` over `decisionLog()` (required-knob K, distinct-host count, advisory) + `exfil-scouting-gate.ts` + hellgate. Deny-log → classify-port advisory surfacing is a host-binding follow-up.

Each is an independent, default-OFF, byte-identical slice; no ordering dependency beyond (B) reusing the deny-log that (c) also reads.
