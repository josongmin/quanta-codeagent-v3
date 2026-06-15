---
instance_id: django__django-11848
repo: django/django
base_commit: f0adf3b9b7a19cdee05368ff0c0c2d087f011180
version: "3.1"
difficulty: 15 min - 1 hour
created_at: 2019-09-28T04:28:22Z
fail_to_pass: 2
pass_to_pass: 43
gold_files: [django/utils/http.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [overfit-risk, regression-trap]
---

# django__django-11848

## 문제 요약
`django.utils.http.parse_http_date`는 RFC 850 형식의 2자리 연도를 해석할 때 0~69는 2000~2069로, 70~99는 1970~1999로 하드코딩(상수 70/2000/1900)해서 처리한다. 그러나 RFC 7231은 "미래로 50년 넘게 떨어진 것처럼 보이는 타임스탬프는 같은 끝 두 자리를 가진 가장 최근 과거 연도로 해석하라"고 명시한다. 즉 현재 연도 기준 상대 비교를 해야 하는데, 고정 임계값을 쓰는 바람에 시간이 흘러도 경계가 갱신되지 않아 RFC 위반 결과(silent-wrong, 예외 없이 잘못된 연도)가 나온다. 이슈 본문이 함수명·하드코딩 로직·RFC 인용까지 그대로 적시한다.

## 유형 (정형화)
- **L(localization) = L0 (Pinpointed)**: problem_statement가 함수명 `parse_http_date`와 "0-69 → 2000-2069, 70-99 → 1970-1999" 분기를 문자 그대로 인용 → `django/utils/http.py` 단일 함수의 단일 분기로 grep 한 방에 직결. 탐색 불필요.
- **S(repair strategy) = S2 (Constraint-Reasoning)**: 고칠 *지점*은 자명하지만 올바른 *식*을 추론으로 합성해야 한다. "현재 연도 대비 50년 초과 미래면 직전 세기로 롤오버"라는 불변식을 `current_century = current_year - (current_year % 100)`, `year - (current_year % 100) > 50` 산술로 정확히 세워야 함. 후보를 여러 개 던져 테스트로 고르는 G&V(S3)가 아니라 모듈러 산술과 경계(>50 vs ≥50)를 "생각으로" 풀어야 하는 SemFix/Angelix류 의미 수리. S1(상수만 교체)으로는 풀리지 않음 — 시간 의존 동작 자체를 도입해야 하므로.
- **K(knowledge) = K-Gen (General)**: 필요한 지식은 일반 파이썬(모듈러 산술 + `datetime.utcnow`)뿐. RFC 규칙은 이슈가 직접 인용해줌. django ORM/query-compiler 같은 프레임워크 내부지식 불요.
- **primary type = T-ConstraintReason**: 위치는 명확(L0)하나 픽스의 본질이 "올바른 조건식·세기 보정 산술을 추론 합성"(S2)하는 데 있음 → 루브릭 정의 3번에 정확히 매칭. T-DirectMap이 아닌 이유는 픽스가 기계적 가드/상수 교체가 아니라 새 산술 불변식을 도출해야 하기 때문.

## 난이도 티어
**T3 (중간).** 공식 difficulty 라벨은 "15분-1시간"(prior로 T2~T3 사이).

이 티어로 미는 구조적 피처:
- 단일 파일·단일 함수·소규모 헌크(±6줄)라 patch scope는 작음 → 위로 안 밈.
- 그러나 L0임에도 S2 추론이 실질적: 세기 롤오버(`current_century - 100`)와 `> 50` 경계를 정확히 세우지 못하면 일부 케이스만 통과(overfit). 단순 상수 추론(T2)을 넘는 의미 합성이 핵심.
- **overfit-risk**: FAIL_TO_PASS가 mock된 고정 연도 7케이스로 구성돼 있어, `if year > 50` 같은 순진한 단순화가 일부만 통과시키고 utcnow=2020/2048 경계에서 깨질 수 있음. 테스트가 충분히 두텁지 않으면 plausible≠correct 위험.
- **regression-trap**: PASS_TO_PASS 43개 중 `test_parsing_rfc1123`/`test_parsing_asctime`/`test_http_date` 등 4자리 연도 경로가 같은 함수를 통과 — `year < 100` 분기 밖을 안 건드려야 함.

공식 라벨과의 차이: 라벨은 "개발자 구현시간"이라 산술 도출 시간만 반영. 에이전트 관점에서는 localize는 trivial(L0)이라 시간이 안 들지만, 정확한 일반화(세기 산술 + 경계)와 overfit 회피가 난점이라 T1/T2가 아닌 **T3**가 적정.

## 골드패치 분석
- **건드린 파일·함수**: `django/utils/http.py` 내 `parse_http_date` (단 하나).
- **근본 원인**: 2자리 연도 보정이 고정 상수(임계 70, +2000, +1900)에 묶여 현재 연도와 무관. RFC 7231이 요구하는 "현재 기준 50년 초과 미래 → 직전 세기로 롤오버" 규칙을 표현하지 못함. 시간이 흐를수록 틀려지는 시간 의존 결함.
- **수정 요지**:
  - `current_year = datetime.datetime.utcnow().year`로 현재 연도 취득.
  - `current_century = current_year - (current_year % 100)`로 현재 세기 산출.
  - `if year - (current_year % 100) > 50:` → 끝 두 자리 비교가 50년 초과 미래로 보이면 `year += current_century - 100`(직전 세기).
  - else → `year += current_century`(현재 세기).
  - 결과적으로 경계가 고정 70이 아니라 현재 연도에 따라 굴러가며 RFC 규칙 만족. 기존 `year < 70 → +2000 / else +1900` 분기를 통째로 대체.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `test_parsing_rfc850`: `@mock.patch('django.utils.http.datetime.datetime')`로 `utcnow`를 2019/2020/2048로 고정한 뒤 7개 RFC850 문자열을 subTest로 파싱. 예) utcnow=2019: '31-Dec-69'→2069(50년 이내 미래 OK), '10-Nov-70'→1970(50년 초과 미래라 과거 롤오버). utcnow=2020: '31-Dec-70'→2070, '31-Dec-71'→1971(경계가 한 칸 이동). utcnow=2048: '31-Dec-00'→2000, '31-Dec-99'→1999.
  - `test_parsing_year_less_than_70`: 70 미만 연도가 현재 연도 상대로 올바르게 해석되는지 확인하는 회귀 케이스.
- **픽스 증명**: utcnow를 서로 다른 고정 연도로 패치했을 때 같은 입력 문자열이 *다른* 연도로 매핑됨(2070 vs 1971 경계 이동)을 단언 → 상대 비교가 실제로 작동함을 입증. 구 하드코딩 코드는 utcnow와 무관하게 항상 같은 결과를 내므로 이 케이스들에서 반드시 실패(red-on-old).
- **overfit 관점**: 테스트가 utcnow=2019/2020/2048 세 시점 × 경계 양쪽(>50, ≤50)을 커버해 단순 상수 단순화를 걸러냄. 다만 mock 7케이스로 한정돼 있어 입력공간이 완전 포화는 아님 → `overfit-risk` 플래그.
- **regression 관점**: PASS_TO_PASS 43개 중 4자리 연도(rfc1123/asctime/http_date) 경로는 `year < 100` 분기 밖이라 영향 없음을 보장해야 함 → `regression-trap`.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 함수명 `parse_http_date`와 "0-69→2000-2069, 70-99→1970-1999" 하드코딩을 직접 인용 → `django/utils/http.py`에서 `parse_http_date`의 `if year < 100:` 분기를 즉시 특정(L0, grep 한 방). 탐색 노력 사실상 0.
2. **픽스와 올바른 일반화 이유**: 고정 임계 70을 버리고 RFC 7231 문장 그대로 "현재 연도 끝 두 자리 대비 50년 초과 미래면 직전 세기"를 산술화. `year - (current_year % 100) > 50`은 임의 상수가 아니라 RFC 규칙의 직역이며, `current_century`/`current_century - 100` 세기 보정으로 모든 연도·시점에 일반화됨. utcnow를 바꿔도 규칙이 동형으로 작동하므로 특정 테스트 케이스에 맞춘 것이 아닌 올바른 일반화.
3. **regression 안전**: 수정은 `year < 100`(2자리) 분기 *안*에만 국한. 4자리 연도를 다루는 rfc1123/asctime/http_date 경로(PASS_TO_PASS)는 분기 밖이라 불변 → 43개 P2P를 안전하게 보존. `month = MONTHS.index(...)` 이하 후속 파싱 로직도 손대지 않음.
4. **함정 회피**: (a) RFC 인용을 "정확히 50년"이 아닌 "**>50**"으로 읽어 경계값 한 칸 실수 방지. (b) 세기 롤오버를 `current_century - 100`으로 명시 — `if year > 50`식 순진한 단순화는 세기 보정을 빠뜨려 utcnow=2020/2048 경계에서 깨짐(overfit). (c) 테스트가 `django.utils.http.datetime.datetime`을 mock하므로 구현은 반드시 `datetime.datetime.utcnow()` 형태로 호출해야 mock이 먹힘 — `from datetime import datetime` 직접 import나 `date.today()` 등으로 바꾸면 mock 우회로 테스트가 통과/실패가 뒤틀림(import 형태 의존). (d) UTC를 써야 함(non-UTC `today()`는 PR 리뷰에서 명시적으로 거부됐던 함정).
