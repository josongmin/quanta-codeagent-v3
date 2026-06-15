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
---

# django__django-11848

## 문제 요약
`django.utils.http.parse_http_date`는 RFC 850 형식의 2자리 연도를 해석할 때 0~69는 2000~2069로, 70~99는 1970~1999로 하드코딩해서 처리한다. 그러나 RFC 7231은 "미래로 50년 넘게 떨어진 것처럼 보이는 타임스탬프는 같은 끝 두 자리를 가진 가장 최근 과거 연도로 해석하라"고 명시한다. 즉 현재 연도 기준 상대 비교를 해야 하는데, 고정 임계값 70을 쓰는 바람에 시간이 지나도 경계가 갱신되지 않는 잘못된 결과가 나온다.

## 유형 분류
- 버그 카테고리: logic / edge-case (RFC 미준수, 시간 의존 off-by 경계)
- 서브시스템: django HTTP utils (날짜 파싱, `django/utils/http.py`)
- 증상 타입: silent-wrong (예외 없이 잘못된 연도로 파싱됨)
- 로컬라이제이션 신호: problem_statement가 함수명 `parse_http_date`와 "0-69 → 2000-2069, 70-99 → 1970-1999" 하드코딩 로직을 그대로 적시 → `django/utils/http.py`의 해당 분기로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/utils/http.py:parse_http_date`
- 근본 원인: 2자리 연도 보정이 고정 상수(70, 2000, 1900)에 묶여 있어 현재 연도와 무관. RFC 7231이 요구하는 "현재 기준 50년 초과 미래면 과거로 롤오버" 규칙을 구현하지 못함.
- 수정 요지:
  - `datetime.datetime.utcnow().year`로 현재 연도를 얻고, `current_century = current_year - (current_year % 100)`로 현재 세기를 계산.
  - `year - (current_year % 100) > 50`이면 50년 초과 미래로 보고 `year += current_century - 100`(이전 세기) 적용.
  - 그렇지 않으면 `year += current_century`(현재 세기) 적용.
  - 결과적으로 경계가 고정 70이 아니라 현재 연도에 따라 굴러가며 RFC 규칙을 만족.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_parsing_rfc850`: `datetime.datetime`을 mock하여 utcnow를 2019/2020/2048로 고정하고 여러 RFC850 문자열을 파싱.
  - `test_parsing_year_less_than_70`: 70 미만 연도 케이스(예: '31-Dec-69' → 2069, '06-Nov-94' → 1994 등)가 현재 연도 상대로 올바르게 해석되는지 확인.
- 증명 방식: utcnow를 고정 연도로 패치해 시간 의존성을 제거한 정적 테스트. 예) utcnow=2019일 때 '31-Dec-69' → 2069(50년 이내 미래 OK), '10-Nov-70' → 1970(50년 초과 미래라 과거 롤오버). utcnow=2020이면 '31-Dec-70'은 2070, '31-Dec-71'은 1971로 경계가 한 칸 이동 → 상대 비교가 실제로 작동함을 입증. 구 하드코딩 코드는 utcnow와 무관하게 같은 결과를 내므로 이 케이스들에서 실패.

## 공략 포인트 (뭘 조져야)
- localization 전략: `parse_http_date` 한 함수, 단일 파일. problem_statement에 로직이 그대로 인용돼 있어 위치 특정은 매우 쉽다.
- 함정/난이도 메모:
  - 단순히 임계값만 바꾸면 안 되고 "현재 연도 상대 + 50년 규칙"을 정확히 구현해야 함. `% 100` 산술과 세기 보정(`current_century - 100`)에서 off-by-century 실수 나기 쉬움.
  - RFC 7231 인용을 "정확히 50년"이 아니라 ">50"으로 읽어야 함(경계값 처리).
  - 테스트가 `django.utils.http.datetime.datetime`을 mock하므로, 구현은 반드시 `datetime.datetime.utcnow()`를 호출하는 형태여야 mock이 먹힌다(import 형태 의존).
- 우리 에이전트 관점: 코드 수정 난이도는 낮으나, "현재 연도 대비 50년 초과" 조건의 산술을 정확히 세우는 것이 핵심. 안일하게 `if year > 50` 같은 단순화로 가면 세기 롤오버를 놓쳐 일부 케이스만 통과하고 utcnow=2020/2048 경계 케이스에서 깨진다.
