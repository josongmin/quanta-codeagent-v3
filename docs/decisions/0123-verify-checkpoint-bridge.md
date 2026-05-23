# ADR-0123: Verify-checkpoint bridge — opt-in markVerified caller seam

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0108 (Shadow git ODB foundation), ADR-0118 (rewindToLast), ADR-0122 (markVerified port + rewindToVerified — 본 ADR 의 producer surface)
- **참조**:
  - `src/agent/verify-checkpoint-bridge.ts` — 신규 (50 LOC)
  - `tests/unit/shadow-odb-rewind-extensions-hellgate.test.ts` — D 섹션 3 case (HELL-D16..D18)

## Context

ADR-0122 가 `ShadowOdb.markVerified` port 를 추가하면서 caller 쪽 wiring 은 의식적으로 분리했다. 이유:

1. **verify-guard.ts 가 in-flight.** `src/agent/verify-guard.ts` 는 다른 트랙의 사용자 작업이 모디파이 중인 파일 (status: `M src/agent/verify-guard.ts`). 본 라운드의 단일-agent 제약상 그 파일을 만지면 안 됨. 따라서 markVerified 의 wiring 을 verify-guard 안에 직접 박는 옵션은 OFF.
2. **caller surface 와 port surface 분리가 SOLID-순응.** "어떤 시점에 markVerified 가 호출되어야 하는가" 는 policy (verify-guard 가 통과한 시점, 또는 closeout 의 특정 단계, 또는 …). "markVerified 가 ref 를 어떻게 advance 하는가" 는 mechanism (ADR-0122 port). 두 책임을 분리하면 policy 변경 시 port 가 미변경.
3. **Cursor `markVerifiedV2` 의 진짜 패턴 == opt-in caller.** Cursor 는 agent (caller) 가 `markVerifiedV2()` 를 명시적으로 호출 — 자동 wiring 없음. quanta 도 mirror.

본 ADR 은 **passively-wireable bridge** 를 신설한다. host (apps/agent/run.ts, 미래 loop hook, custom integration) 가 `onVerifySuccess(workspace)` 한 줄 호출 — 그 외 모든 plumbing 은 bridge 가 처리.

## Decision

`src/agent/verify-checkpoint-bridge.ts` 신규. 두 export:

```ts
export interface VerifyCheckpointBridge {
  onVerifySuccess(workspace: string): Promise<void>
}

export const defaultVerifyCheckpointBridge = (odb: ShadowOdb | undefined): VerifyCheckpointBridge
```

세 invariant:

1. **NO-THROW.** `onVerifySuccess` 는 절대 throw 하지 않는다. `markVerified` 가 던지는 모든 ShadowOdbError (uninitialized, spawn-failed, git-failed) 를 silently swallow. 이유: observability/instrumentation surfaces 는 verify 경로 자체를 망가뜨리면 안 됨. verify 가 통과했음에도 markVerified 가 실패해 verify 경로가 fail-back 되면 사용자가 "통과했는데 왜 실패로 나옴" 으로 confuse. 실패의 cost == 다음 `rewindToVerified` 가 typed `no-verified-anchor` 로 응답 (정상 UX).
2. **Default-OFF.** `odb === undefined` ⇒ `onVerifySuccess` 가 즉시 resolve, 어떤 side-effect 없음. host 가 unconditional 으로 wire 해도 byte-identical 한 안전성. `AgentConfig.shadowOdb` 가 set 됐을 때만 실제로 markVerified 가 호출됨.
3. **plane-clean.** 본 파일은 `@/storage/shadow-odb` 만 import. `@/agent/verify-guard` 는 import 하지 않음 (in-flight 트랙 의존성 격리).

## Why opt-in (auto-wiring 거부)

`verify-guard.ts` 가 stable 됐을 때조차 자동 wiring 은 거부.

- **agent autonomy.** "verify 통과" 정의가 context-dependent — typecheck 만? + tests? + lint? + 사용자 manual approval? caller 가 결정해야 함.
- **markVerified 의 cost.** `markVerified` 는 update-ref 한 번 (싸지만 0 아님). verify gate 가 매 turn 마다 통과해도 bridge 를 conditional 으로 호출하면 host 가 "이번 turn 은 anchor 안 박을래" 의 agency 보존.
- **separation 의 진짜 가치.** auto-wiring 은 ADR-0122 (port) 가 모디파이 없이 빌트인. opt-in seam 은 ADR-0122 와 ADR-0123 가 *별도로* releaseable. ADR-0122 만 적용된 호스트는 `defaultShadowOdb().markVerified(ws)` 를 직접 호출하면 됨 — bridge 없어도 fully functional.

## Hellgate (3 case)

`tests/unit/shadow-odb-rewind-extensions-hellgate.test.ts` D 섹션:

- **HELL-D16**: `defaultVerifyCheckpointBridge(undefined).onVerifySuccess(ws)` ⇒ no-op (no throw, resolves).
- **HELL-D17**: `markVerified` 가 던지는 ShadowOdbError ⇒ bridge 가 swallow. 호출은 발생했지만 caller 에 에러 propagate 안 됨.
- **HELL-D18**: 정상 odb ⇒ markVerified 가 정확한 workspace path 로 호출됨.

이상 3 케이스 + ADR-0122 의 B 섹션 (markVerified 자체의 4 case) 가 bridge ↔ port 쌍을 fully sealing.

## Alternatives rejected

1. **`verify-guard.ts` 안에 markVerified 직접 호출**
   - 본 라운드의 in-flight 제약 위반. 영속적 거부 사유도 있음 — verify-guard 가 markVerified policy 를 결정하면 두 책임이 fused (SRP 위반).
   - 거부 — 별도 bridge file 채택.

2. **passive observation port (e.g. EventEmitter on verify-guard)**
   - host 가 emitter 에 subscribe ⇒ markVerified call. EventEmitter 의 callback 이 throw 하면 다른 listener 도 깨지는 cross-coupling 위험; emitter 가 모듈 global 이면 test isolation 깨짐.
   - 거부 — host-controlled callback (현재 채택) 이 safer + explicit.

3. **bridge 가 markVerified 실패 시 logger.warn 으로 surface**
   - logger seam 이 본 파일에 import 됨 → plane-clean invariant 위반. instrument 는 ADR-0122 의 follow-up "OTel attribute" 에서 별도 처리 (port 가 emit, bridge 는 silent).
   - 거부 — log call 없음.

4. **markVerified 결과를 bridge 가 caller 에 return (성공/실패 typed result)**
   - bridge 의 invariant "NO-THROW" 와 "fire-and-forget" 의 결합이 핵심. result 를 return 하면 caller 가 그것을 체크하지 않을 때 silent-failure 인지 모름; check 하면 caller 가 verify-fail 경로로 분기할 위험.
   - 거부 — `Promise<void>` + silent swallow.

5. **factory 가 `ShadowOdb` 직접 받지 않고 `() => ShadowOdb | undefined` lazy 로 받기**
   - subagent / multi-workspace 시나리오에서 lazy 가 유용할 수 있으나 — 현재 host 는 한 odb 인스턴스. lazy 는 over-engineering.
   - 거부 — 직접 odb 인스턴스 (또는 undefined) 채택.

## SOTA++ 자리매김

| 시스템 | verified anchor port | opt-in caller bridge | NO-THROW invariant | hellgate |
|---|---|---|---|---|
| Cursor 3.2 | `markVerifiedV2` (closed source) | implicit (agent-side hook) | 추정 (closed) | ✗ |
| Codex / Claude Code | ✗ | ✗ | N/A | N/A |
| **quanta (R2)** | **ADR-0122** | **본 ADR (default-OFF + plane-clean)** | **명시적 + sealed (HELL-D17)** | **3 case** |

= "Cursor 의 verified-anchor 패턴을 mechanism (port) / policy (caller seam) 로 분리하면서 caller seam 자체에 NO-THROW invariant 를 명시적 sealing 한 최초 OSS 구현". Cursor 의 비공개 hook 동작을 typed-port + bridge 로 documented + testable 하게 환원.

## Follow-up (이 ADR 이 닫지 않음)

- **auto-rewind on verify-fail** — bridge 를 mirror 한 `onVerifyFailure(workspace)` 도 같은 패턴. 단, "auto rewind" 는 retry budget + breaker 정책 필요 (무한 thrash 방지) — 더 큰 scope. ADR-0124 후보.
- **verify-guard 통합** — `verify-guard.ts` 가 stable 된 이후 host 에서 bridge.onVerifySuccess 를 호출하는 1 라인 patch. ADR-0122 의 follow-up 으로 listed.
- **bridge 가 마지막 markVerified 시점/sha 를 노출** — debug/telemetry 용. `lastVerifiedAt: Date | null` getter. fire-and-forget invariant 와 conflict 없음 — 단방향 read 만 추가.
- **bridge 가 multi-workspace 호출 batch 지원** — 현재는 1 workspace per 호출. 단일 turn 에 여러 workspace 를 verify 하는 시나리오 (subagent fan-out 등) 에선 batch 가 합리적.
