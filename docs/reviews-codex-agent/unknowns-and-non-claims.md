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

---

## Round 2 update (2026-05-21 deep dive)

이 라운드에서 실제 설치된 `Codex.app` (build 2867) 바이너리/리소스/IPC를 직접 관측하면서, **새로 명시적으로 비주장으로 못 박을 항목**들이 늘었다. 직접 관측한 `[FACT]`는 [direct-observable-facts.md](direct-observable-facts.md) §14~26에 누적했고, 이 섹션은 그 위에서 "관측되었지만 단정해서는 안 되는" 경계를 적는다.

### 11. Round 2 — Anthropic SDK presence vs traffic routing

직접 관측된 사실:
- `cache_creation_input_tokens`, `cache_read_input_tokens`, `anthropic.response.timestamp`, `anthropic_error`, `anthropic.stream_error` 문자열이 `app-session.js`와 `worker.js`에 들어 있다 `[FACT]`

따라서 **주장하지 않는다**:
- Codex가 사용자 트래픽을 Anthropic API로 라우팅한다
- Anthropic SDK가 production code path에서 active하게 호출된다
- 어떤 사용자/모드/모델 조건에서 Anthropic 경로가 trigger되는지

현재까지는 SDK marker presence만 직접 관측되었고, trigger path는 확인되지 않았다.

### 12. Round 2 — `gpt-5.1-codex-max` 활성 여부

직접 관측된 사실:
- 이 모델 이름은 `hide_gpt-5.1-codex-max_migration_prompt` 같은 config notice key에서만 나타난다 `[FACT]`
- `models_cache.json`에는 들어 있지 않다 `[FACT]`
- 어떤 binary string scan에서도 active enum으로 등장하지 않는다 `[FACT]`

따라서 **주장하지 않는다**:
- `gpt-5.1-codex-max`가 현재 active model이다
- 이 모델로 사용자가 routing될 수 있다

### 13. Round 2 — `~/.codex/pets/` 의미

직접 관측된 사실:
- `~/.codex/pets/` directory가 이 머신에서 비어 있다 `[FACT]`
- bundles의 어떤 string에도 이 경로에 대한 reference가 없다 `[FACT]`

따라서 **주장하지 않는다**:
- `~/.codex/pets/`의 용도/내용/lifecycle

### 14. Round 2 — `logs_2.sqlite` secret 포함 여부

직접 관측된 사실:
- `~/.codex/logs_2.sqlite`는 14.8 GB이다 `[FACT]`
- sampled row들은 telemetry/metric 성격이다 `[FACT]`
- 14.8 GB full scan은 의도적으로 회피했다 `[FACT]`

따라서 **주장하지 않는다**:
- `logs_2.sqlite`가 secret/credential/유저 PII를 포함하지 않는다
- 반대로 포함한다고도 단정하지 않는다

샘플 기준은 telemetry shape에 가깝지만, 전수 audit은 끝나지 않았다.

### 15. Round 2 — workspace 패키지 공개 소스

직접 관측된 사실:
- `package.json`에 `app-server-types`, `commands`, `protocol`, `shared-node`, `external-agent-migration`, `browser-api`, `browser-backend-common`, `browser-common` 같은 internal workspace 패키지가 참조된다 `[FACT]`
- 이 이름들은 공개 `openai/codex` monorepo에는 보이지 않는다 `[FACT]`

따라서 **주장하지 않는다**:
- 이 패키지들의 공개 소스가 존재한다
- 이 패키지들의 implementation을 우리가 본 적이 있다

이름과 인터페이스 surface만 관측되었고, 내부 구현은 가시 영역 밖이다.

### 16. Round 2 — `comment-preload.js`와 MCP 관계 (Round 1 정정)

~~Round 1 분석에서는 `comment-preload.js`를 MCP-related preload로 분류했을 가능성이 있다.~~ **CORRECTED 2026-05-21**:
- Round-2 evidence에 따르면 `comment-preload.js`는 browser sidebar annotation overlay preload다 `[FACT]`
- MCP sandbox preload는 별도 2KB 파일인 `sandbox-preload.js`다 `[FACT]`

따라서 **주장하지 않는다**:
- `comment-preload.js`가 MCP의 일부다

Round-1 reviewer가 filename adjacency 때문에 그렇게 추론했을 수 있으나, Round-2 evidence는 둘이 다른 surface임을 보여준다.

### 17. Round 2 — `runWidgetCode` exploitability

직접 관측된 사실:
- Skybridge sandbox-preload protocol에 `runWidgetCode`와 `setAdditionalGlobals`가 노출된다 `[FACT]`
- 두 API 모두 임의 code/globals를 받는 shape를 가진다 `[FACT]`

따라서 **주장하지 않는다**:
- `runWidgetCode`가 현재 deployment에서 exploitable하다
- host-side MCP server allowlist가 어떻게 구성되어 있는지

위협 표면은 host-side allowlist 정책에 의해 좌우되며, 그 allowlist는 renderer bundle에서 보이지 않는다. risk register에는 `Critical` severity의 conditional risk로 표시한다.

### 18. Round 2 — 1.49 GB/day log growth 일반화

직접 관측된 사실:
- `logs_2.sqlite`가 이 머신에서 14.8 GB이고, 약 10일치 사용 흔적으로 보인다 `[FACT]`

따라서 **주장하지 않는다**:
- 모든 사용자가 1.49 GB/day sustained로 로그가 쌓인다
- retention policy가 적용되지 않는다

이는 한 머신에서의 10일 관측이며, 별도 메모([codex-logs-retention-pattern](codex-logs-retention-pattern))에 기록된 대로 size-based sliding window가 실제 보존량을 cap한다.

### 19. Round 2 most important new non-claims

1. Anthropic SDK presence ≠ Anthropic traffic routing
2. `gpt-5.1-codex-max` 활성 모델 비주장
3. `~/.codex/pets/` 용도 비주장
4. `logs_2.sqlite` secret 포함/미포함 비주장
5. workspace 비공개 패키지 source 비주장
6. `comment-preload.js` ≠ MCP preload (Round 1 정정)
7. `runWidgetCode` exploitability 단정 비주장
8. 1.49 GB/day sustained 비주장
