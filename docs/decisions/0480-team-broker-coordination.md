# ADR-0480: Team broker coordination — leader-mediated permission escalation for worker subagents

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0026 (admissibility-gate SSOT — the broker is consulted from the gate's SOFT mode-policy deny arm; HARD_DENY is structurally excluded BEFORE the broker is ever reached)
  - ADR-0046 (permission stack / post-denial — the leader's `onConfirm`/HITL authority the broker wraps is the same one that decides foreground actions)
  - ADR-0416 (subagent-mailbox — the existing transport the escalation `request`/`response` rides; the broker mints no new channel)
  - ADR-0470 / ADR-0471 (config-provenance-gate / untrusted-source-envelope — the H2/B2 provenance posture this slice mirrors: a grant flows from the higher-authority source ONLY; a worker can never self-grant)
- **참조**:
  - `src/subagent/coordination/broker.ts` — pure NO-THROW cores: `parseEscalationRequest` / `buildDecisionResponse` / `brokerStep` / `brokerLoop` / `applyDecisionResponse` + the `EscalationRequest` / `EscalationDecision` / `EscalationDeciderPort` / `BrokerMessage` / `BrokerMailbox` shapes.
  - `src/subagent/coordination/index.ts` — slice barrel (Capability B re-exports).
  - `src/agent/admissibility-gate.ts` — `GateEscalationBroker` (duck-typed port, gate-local), `runBrokerEscalation` (fail-closed adapter), and the consult site in `runModePolicy`'s `decision.kind === "deny"` arm (re-checks `hardDenyReason(action) === null`).
  - `src/agent/coordination-broker-wire.ts` — `buildLeaderHitlBroker` (the composition-root adapter: real mailbox round-trip + `applyDecisionResponse` with a pinned `leaderId`) + `LeaderEscalationDecider`.
  - `src/agent/subagent-runner.ts` — `maybeWireCoordinationBroker` (default-OFF injection of the broker onto the CHILD's `admissibility.coordinationBroker`).
  - `src/shared/runtime-config.ts` — `teamBroker` knob (`QUANTA_TEAM_BROKER === "1"`, strict opt-in, default false).
  - Tests: `tests/unit/coordination/team-broker-hellgate.test.ts` (pure cores + self-grant security), `tests/unit/coordination/team-broker-e2e-hellgate.test.ts` (real mailbox round-trip), `tests/unit/coordination/team-broker-gate-escalation-hellgate.test.ts` (LIVE gate wiring + HARD_DENY exclusion + fail-closed), `tests/unit/coordination/team-broker-composition-wire-hellgate.test.ts` (knob-gated injection).
  - Feature catalog: `tools/feature-catalog/features/09-integration/team-broker-coordination.yaml`.

## 맥락

A worker subagent runs under the same admissibility gate (ADR-0026) as its spawning leader. When the worker hits a tool the gate denies — a SOFT mode-policy denial, e.g. the `auto`-mode classifier returns `verdict: "deny"`, or a default-mode policy `deny` arm — the pre-broker behavior was a hard failure: the tool call returns `Permission denied`, and the worker either stalls or abandons the subtask. The leader, who has broader HITL authority (its `onConfirm`/permission decide path, ADR-0046), has no way to be consulted: the worker cannot reach back up.

Claude Code's `--agent-teams` model brokers exactly this — a leader mediates a worker's blocked action rather than letting the worker hard-fail. This ADR absorbs the leader-broker arm (the sibling task-dependency DAG and team-idle barrier are Capabilities A/C of the same coordination plan): a blocked worker requests escalation; the LEADER's authority brokers the decision; the worker applies a verdict it did NOT author.

The load-bearing constraint is security. The broker is a GRANT path, so it must never become a privilege-escalation backdoor. Two structural invariants bound it: (1) a HARD_DENY (denylisted destructive command, e.g. `rm -rf /`) is NEVER escalatable, even by an approve-everything broker; (2) a worker can NEVER self-grant — the only message that widens its permission is a `response` authored by the pinned leader and matching its outstanding `correlationId`. This mirrors the H2/B2 provenance posture (ADR-0470/0471): grants flow from the higher-authority source only.

## 결정

A pure NO-THROW broker core in the `src/subagent/**` slice plus a HOST-side composition wire and a single gate consult site.

**The escalation flow (request → verdict → admit).** When a worker's tool hits the SOFT-deny arm of `runModePolicy` (`decision.kind === "deny"`), and a broker is present, and (re-checked) `hardDenyReason(action) === null`, the gate calls `broker.escalate({ tool, scope, reason })` (`runBrokerEscalation`). `scope` is `action.shellCommand ?? action.tool`; `reason` is the policy's own deny message. The broker round-trips:

1. worker → leader `request` (`from=workerId`, `to=leaderId`, body = the `{tool, scope, reason}` envelope, fresh `correlationId`) — audit/transport on the existing mailbox.
2. the LEADER authority (`leaderDecide`, wrapping `parent.onConfirm`) produces the `EscalationDecision` — the worker does NOT author it.
3. `buildDecisionResponse` serializes the leader's verdict (`from=leaderId`), round-tripping the SAME `correlationId`.
4. the worker validates it via `applyDecisionResponse(..., { leaderId })` — honored ONLY when `kind === "response"` AND `correlationId` matches the outstanding request AND `from === leaderId`.

On `approved`, `runBrokerEscalation` returns `"approved"` and `runModePolicy` emits a corrective `allow` decision event (two events — deny then broker-allow — tell the true story to a tracer) and returns `null`, which routes the call onward to the `pre_tool_use` hook. The leader override does NOT skip the hook: the repo-local hook keeps its irrevocable last word (a hook veto after a broker approve is a final DENY). On `denied`, the worker stays blocked with the legacy `Permission denied` wording.

**Composition over the admissibility gate (decoupling).** The gate (security SSOT) never imports `@/subagent/coordination`; it knows only the gate-local duck-typed `GateEscalationBroker { escalate(req) => Promise<{approved, reason?}> }`. The `src/subagent/**` slice fence is symmetric: `broker.ts` imports ONLY `@/shared` — the decision authority (`EscalationDeciderPort`) and the transport (`BrokerMailbox`) are injected duck-typed ports, never a hard `@/permission`/`@/agent` import. `coordination-broker-wire.ts` (`buildLeaderHitlBroker`) is the ONLY place `@/agent` bridges the gate's port to the real broker, threading the real security model (mailbox round-trip + `leaderId`-pinned `applyDecisionResponse`).

**Fail-closed default.** `runBrokerEscalation` wraps `broker.escalate` in try/catch and returns `"denied"` on any throw — a crashing decider can never widen permission. `buildLeaderHitlBroker` is exhaustive: an `applied` that is not `approved:true` yields `{ approved: false, reason }` (the leader's reason, or `"leader denied"`). The pure cores degrade rather than throw: parsers return `undefined` on hostile input, `brokerStep` skips an offending entry, `brokerLoop` returns the count actually sent. No `Date.now()` / `Math.random` / `localeCompare` anywhere — the correlation-id source is an injected deterministic counter (`${workerId}#esc${esc++}`) so a recorded session re-mints identical ids.

**Default-OFF knob.** `runtimeConfig().teamBroker` reads `QUANTA_TEAM_BROKER === "1"` (strict opt-in, default false). `maybeWireCoordinationBroker` returns `{}` (no `admissibility` slot ⇒ byte-identical legacy child) UNLESS the knob is on AND the parent carries an `onConfirm` (no leader authority ⇒ nothing to escalate to) AND both worker/leader mailbox ids are non-empty. The gate itself reads no knob — "broker present ⇒ armed". The injected child `admissibility` bundle carries ONLY `coordinationBroker` (it never inherits/clobbers the parent's reviewerPort/rulesStore/permissionStore).

## 결과

- A worker's SOFT-denied tool can now be brokered up to its leader's existing HITL authority instead of hard-failing — Claude `--agent-teams` leader-broker parity — on the existing mailbox transport with no new channel.
- The security boundary is structural, not heuristic: HARD_DENY is excluded before the broker is reached and re-checked at the consult site; the worker applies only a leader-authored, correlation-matched response; a leader override still passes the `pre_tool_use` hook.
- Default-OFF and byte-identical when unset: a denied worker tool stays a hard failure with no broker, no envelope on the wire — the slice can ride trunk dark until the host decides to arm it per-deployment.

## Trade-offs / Negative invariants

- **Fail-closed when the decider throws (CRITICAL — tested).** `team-broker-hellgate.test.ts` "broker.brokerStep decide: decider blew up → escalate threw (fail-closed deny)" and the gate-level "broker THROWS ⇒ fail-closed DENY" both pin it: a throwing decider produces no response / a denied verdict — a crash NEVER widens permission. `runBrokerEscalation` catches and returns `"denied"`; `brokerStep` catches and skips the entry.
- **HARD_DENY is never escalatable (load-bearing).** `team-broker-gate-escalation-hellgate.test.ts`: `rm -rf /` + an approve-all broker ⇒ DENIED and the broker is NEVER consulted (`calls === []`). The gate excludes HARD_DENY at `earlyHardDeny` before mode-policy, and the consult site re-checks `hardDenyReason(action) === null`. An approve-everything leader cannot grant a denylisted command.
- **A worker can never self-grant.** `applyDecisionResponse` rejects a worker-authored `request`/`broadcast` that "looks like" an approval, a mismatched/forged/empty `correlationId`, and — when `leaderId` is pinned — a `response` whose `from !== leaderId` (a self-authored or sibling response). The e2e test confirms the real mailbox additionally never delivers a message to its own sender; even if surfaced it is rejected.
- **The hook is the last gate, not the broker.** A broker approve returns `null` (admit) which routes through `pre_tool_use`; a hook veto AFTER a leader approve is a final DENY. The leader override can shorten the policy deny but cannot skip the repo-local hook.
- **Idempotent on re-read, no double-grant.** `brokerStep` is a pure projection (same pending ⇒ same responses); the LIVE drain-once is the mailbox read-cursor (`brokerLoop` reads the inbox, which marks delivered). A second `brokerLoop` over a drained inbox sends nothing.
- **Default-OFF gates on leader authority, not just the knob.** Knob ON but no `parent.onConfirm` ⇒ no broker (there is no authority to escalate to). The child's `admissibility` carries ONLY the broker, asserted by an exact-keys hellgate so a future change that leaks other admissibility axes into a worker fails loudly.
- **Trust scope.** The broker presumes the leader's `onConfirm` is a trustworthy authority. It does not bound WHICH soft denials are escalatable beyond the HARD_DENY exclusion — a leader configured to approve-all will admit any non-HARD_DENY soft denial. The deployment opts into that posture by setting the knob and supplying the authority.
