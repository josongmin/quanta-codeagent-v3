# ADR-0047 — HITL 4-tier gate: annotation registry + handoff seam

- **상태**: Accepted
- **날짜**: 2026-05-21
- **확장 대상 ADR**: ADR-0020 (4-tier 정의), ADR-0026 (admissibility-gate SSOT),
  ADR-0029 (3-tier reviewer — 직교 축)
- **관련 ADR**: ADR-0046 (permission stack — sibling track, 비교차)
- **관련 메모**: `[[codex-desktop-build-2867-round-4]]` (Guardian "Post-denial
  precedence"), Codex `hitl-audit.md`

## 맥락

ADR-0020은 HITL 4-tier 어휘(`hand-off-required | always-confirm |
pre-approval-ok | none`)를 정의하고 admissibility-gate 안에 라우팅을
박았다. ADR-0026은 그 라우팅을 단일 SSOT 함수로 추출했다. 두 ADR이
다루지 않은 두 부분이 남아있다:

1. **annotation registry** — 도구가 직접 `hitlTier(input)`을 구현하지 않는
   경우(framework-owned 결정, 운영자별 정책 차이) tier를 어디서 결정할지.
2. **handoff UI seam** — 게이트가 `hand-off-required`로 거절했을 때
   UI(또는 외부 컨슈머)가 그 사실을 알 수 있는 *구조화된* 채널이 없었다.
   현재는 deny 메시지의 텍스트를 파싱해야만 했다.

## 결정

### R1. `HitlTier` 어휘 SSOT 재확인 + agent surface alias

`@/permission/types.ts#HITLTier`가 SSOT다. `src/agent/hitl-tier.ts`는
이를 **그대로 re-export**하고 lower-camel alias `HitlTier`를 추가한다.
새 타입을 정의하지 않는다 — 두 모듈에 enum이 따로 살면 시간이 지나며
드리프트가 일어난다.

### R2. Annotation registry (`src/agent/hitl-tier-registry.ts`)

```typescript
interface HitlAnnotation {
  readonly tool: string
  readonly commandPrefix?: string
  readonly tier: HitlTier
  readonly reason?: string
}

resolveHitlAnnotation(tool, input, baseline) → { tier, matched }
```

- **Built-in 테이블** — 빌트인은 일부러 비어있다. 기본 케이스(curl/wget/
  git push/git fetch/git reset --hard/git commit --amend)는 이미 bash
  classifier가 커버한다. 빌트인 슬롯은 **framework-owned** 결정을 추후
  추가할 자리로 남겨둔다 — 빈 채로 가는 것이 byte-identical 계약 유지.
- **Operator overrides** — `~/.quanta/hitl-overrides.json`(경로는
  `QUANTA_HITL_OVERRIDES`로 변경 가능)에서 로드한다.
- **One-way ratchet** — override는 tier를 *escalate*만 할 수 있다.
  built-in이 `pre-approval-ok`였는데 override가 `always-confirm`이면 적용.
  built-in이 `always-confirm`인데 override가 `none`이면 무시 + stderr
  warn (one-way ratchet 위반).
- **`hand-off-required` 보호** — upstream classifier(또는
  built-in)에서 이미 `hand-off-required`로 결정된 경우 override는 절대
  내릴 수 없다. registry는 그 분기를 short-circuit.

### R3. Failure mode

Override 파일이 깨졌을 때(JSON 파싱 실패, 알려지지 않은 tier, 스키마 위반):
- **throw하지 않는다.** 시작 시점 throw는 운영자에게 foot-gun.
- stderr에 warn 한 줄 출력 + 빌트인 어노테이션만으로 fallback.
- ENOENT(파일 없음)는 warn 없이 silent — 운영자가 단순히 작성 안 한 일반 케이스.

### R4. `HandoffRequiredEvent` UI seam

`src/agent/hitl-tier.ts`에 typed event 정의:

```typescript
interface HandoffRequiredEvent {
  readonly kind: "hitl-handoff"
  readonly tool: string
  readonly args: unknown
  readonly handoffMessage: string
  readonly reason: string
  readonly timestamp: number
}
```

`AgentConfig.onHandoff?: (event: HandoffRequiredEvent) => void` 콜백
seam을 추가한다. admissibility-gate가 `hand-off-required` deny를 낼 때
(HARD_DENY 히트 또는 명시적/registry-promoted tier) 이벤트를 발사한다.
콜백 try/catch 래핑 — 호스트 측 버그가 dispatch로 전파되지 않는다 (deny
result가 권위; 이벤트는 best-effort 알림).

### R5. OTel telemetry

`src/observability/vocabulary.ts#hitl`에 3개 키 추가:
- `quanta.hitl.tier_resolved` — 매 HITL 게이트 실행마다 resolved tier
- `quanta.hitl.registry_escalated` — registry가 baseline tier를 escalate했는지
- `quanta.hitl.handoff_emitted` — handoff 이벤트의 reason 태그

### R6. 한계 / 의도적 negative space

- **regex 매칭 지원하지 않는다.** override 파일은 exact tool name + 옵션
  literal `commandPrefix`만 받는다. regex는 (a) 평가가 비결정적이 될 수 있고
  (b) 운영자가 손으로 감사하기 어려워진다. ADR-0031 prefix DSL의 학습:
  단순함을 깨지 말 것.
- **GUI override editor 없다.** Phase 1은 dev tool. JSON 직접 편집.
- **per-session override 없다.** Override 파일은 process-life cached
  (`__resetHitlOverrides` test seam만). 운영자가 파일을 바꿔도 프로세스
  재시작 전까지는 반영되지 않는다 — 의도적 (runtime mutation 추적이
  악몽이라).

## 메커니즘 (admissibility-gate 순서)

```
1. mode-posture block (plan/review/audit)
2. HITL gate (enabled일 때):
     a. HARD_DENY → handoff deny + onHandoff(event)
     b. resolveHitlAnnotation(call.name, call.input, inferToolTier(...))
     c. tier === hand-off-required → handoff deny + onHandoff(event)
     d. tier === always-confirm   → onConfirm 강제
     e. tier === none             → allow (mode policy skip)
     f. tier === pre-approval-ok  → fall through to mode policy
3. mode-policy (HARD_DENY redundant guard inside; auto-classifier route)
4. pre_tool_use hook
```

## 결과

- **byte-identical 기본 경로**: `config.hitl` absent, override 파일 absent
  → 게이트는 ADR-0020 ADR-0026 그대로 동작.
- **UI integration 가능**: `onHandoff` 콜백으로 deny 메시지를 파싱하지
  않고 구조화된 이벤트 수신 가능.
- **operator policy tightening**: `~/.quanta/hitl-overrides.json`에서
  per-deploy tier를 조정 가능. one-way ratchet으로 안전.

## 테스트

- `tests/unit/hitl-tier-registry.test.ts` — 33개:
  built-in 비어있음, override loader, JSON 파싱 실패 graceful,
  unknown tier 스키마 거부, missing path silent, ratchet escalate-only,
  ratchet downgrade warn, `hand-off-required` 강제 보존, commandPrefix
  매칭, malformed input(`command` 필드 없음) 동작, ENOENT silent,
  cache reset seam.
- `tests/unit/hitl-tier-gate.test.ts` — 9개: gate가 handoff event를 발사,
  payload 정확성, `onHandoff` 없을 때 byte-identical, throwing
  `onHandoff` swallow, override가 always-confirm을 escalate, registry가
  hand-off-required로 escalate.
- `tests/integration/hitl-tier-dispatch-e2e.test.ts` — 7개: dispatchTool
  통합, registry + admissibility 결합.

## Override 예시

```json
{
  "version": 1,
  "annotations": [
    {
      "tool": "bash",
      "commandPrefix": "kubectl apply",
      "tier": "always-confirm",
      "reason": "K8s cluster mutations require explicit confirm in this deploy"
    },
    {
      "tool": "bash",
      "commandPrefix": "terraform apply",
      "tier": "hand-off-required",
      "reason": "Infra changes go through change management — agent must hand off"
    }
  ]
}
```

## References

- ADR-0020 — HITL 4-tier 정의 (확장 대상)
- ADR-0026 — admissibility-gate SSOT (확장 대상)
- ADR-0029 — reviewer 3-tier (직교 축)
- ADR-0046 — permission stack (sibling track — 교차 없음)
- ADR-0031 — prefix DSL (negative reference: 단순함 깨지 말 것)
- Codex `hitl-audit.md`
- `[[codex-desktop-build-2867-round-4]]` Guardian Post-denial precedence
