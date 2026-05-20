# Unknowns and Non-Claims

Overview router: [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

이 문서는 `/docs/analysis/codex-agent/` 아래 분석 문서들이 **무엇을 주장하지 않는지**, 그리고 **현재 증거로는 무엇을 알 수 없는지**를 명시한다.

목적:
- overclaim 방지
- hidden implementation을 사실처럼 굳히는 오류 방지
- FACT / inference 경계 보호

---

## 1. General rule

이 디렉터리 문서들은 다음을 우선한다.

1. 현재 세션에서 직접 관측 가능한 사실
2. 그 사실을 가장 잘 설명하는 강한 추론
3. 그 이상은 `unknown` 또는 `not enough evidence`

따라서 아래 항목들은 명시적으로 **비주장(non-claim)** 이다.

---

## 2. Hidden model internals

우리는 아래를 직접 보지 못했다.

1. hidden system prompt 원문 전체
2. hidden developer prompt 원문 전체의 모든 prior revision
3. hidden planner implementation
4. hidden confidence/ranking/scoring implementation
5. hidden memory retrieval engine internals

따라서 **주장하지 않는다**:

- 내부에 정확히 어떤 planner object가 있다
- exact latent score threshold가 얼마다
- hidden classifier가 어떤 weights/architecture를 가진다

---

## 3. Intent / mode / router internals

우리는 직접 보지 못했다.

1. literal `enum IntentKind` 존재 여부
2. exact task classifier implementation
3. exact mode transition graph
4. hidden mode set 전체

따라서 **주장하지 않는다**:

- 내부에서 반드시 특정 이름의 typed enum이 돈다
- Default/Plan 외 다른 mode가 없다
- exact routing precedence implementation이 hardcoded table이다

---

## 4. Memory internals

우리는 직접 보지 못했다.

1. global persistent memory database
2. cross-thread personal memory API
3. embedding/vector memory store
4. hidden summarization persistence engine

따라서 **주장하지 않는다**:

- Codex가 전역 personal memory를 가진다
- user preference가 자동으로 영구 저장된다
- long-term memory retrieval가 always-on이다

---

## 5. Plugin internals

우리는 직접 보지 못했다.

1. plugin package manifest internals
2. marketplace sync/update internals
3. plugin loader implementation details
4. plugin sandbox or isolation implementation details

따라서 **주장하지 않는다**:

- plugin이 내부적으로 정확히 어떤 ABI를 가진다
- plugin loading lifecycle이 어떻게 구현돼 있는지

---

## 6. Permission / sandbox internals

우리는 직접 보지 못했다.

1. sandbox mode의 전체 enum/domain
2. alternate deployment의 full permission matrix
3. hidden backend IAM / ACL
4. approval-enabled deployment의 exact UX implementation

따라서 **주장하지 않는다**:

- `danger-full-access` 말고 어떤 sandbox mode가 정확히 존재한다
- 각 mode가 exact하게 무엇을 허용/차단한다

---

## 7. Replay / cassette completeness

우리는 직접 보지 못했다.

1. production-grade full replay harness implementation
2. full golden replay set implementation
3. API/DB specific canonicalization contract
4. cassette payload redaction/PII policy implementation

따라서 **주장하지 않는다**:

- current repo가 이미 full deterministic replay authority를 가진다
- current validator가 strict per-entry replay verification을 완료했다

---

## 8. Cross-deployment generalization

우리는 현재 세션만 본다.

따라서 **주장하지 않는다**:

1. 모든 Codex deployment가 동일한 tool set을 가진다
2. 모든 deployment가 동일한 approval/HITL/policy stack을 가진다
3. 데스크톱 앱 외 환경도 동일하게 동작한다

---

## 9. Safe wording guideline

현재 증거 수준에 따라 아래 표현만 허용하는 것이 맞다.

### Strong

- “현재 세션에서 직접 관측된다”
- “현재 tool schema는 …를 직접 보여준다”
- “observed behavior를 가장 잘 설명하는 모델은 …다”

### Weak / cautious

- “가능성이 높다”
- “가장 설명력이 높다”
- “not enough evidence”
- “overclaim하면 안 된다”

### Avoid

- “분명히 내부적으로 …다”
- “항상 …다”
- “모든 deployment에서 …다”

---

## 10. Most important non-claims

1. hidden internal code/infra architecture exact shape
2. global persistent memory existence
3. complete planner/router internals
4. complete plugin backend lifecycle
5. complete sandbox mode universe
6. complete replay authority completeness

이 여섯 축은 계속 non-claim으로 유지하는 것이 맞다.
