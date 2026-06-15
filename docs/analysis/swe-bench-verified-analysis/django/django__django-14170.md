---
instance_id: django__django-14170
repo: django/django
base_commit: 6efc35b4fe3009666e56a60af0675d7d532bf4ff
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-03-23T08:53:41Z
fail_to_pass: 2
pass_to_pass: 76
gold_files: [django/db/backends/base/operations.py, django/db/models/lookups.py]
---

# django__django-14170

## 문제 요약
`YearLookup`은 인덱스를 활용하기 위해 `EXTRACT(year ...)` 대신 `BETWEEN <year>-01-01 AND <year>-12-31` 으로 쿼리를 최적화한다. 그런데 이 최적화가 `__iso_year` 룩업에도 그대로 적용되면서, ISO-8601 주차 연도(week-numbering year)의 경계가 그레고리력 연도 경계(1/1~12/31)와 다른데도 일반 연도 경계로 필터링해 잘못된 데이터가 반환된다. 사용자는 `start_date__iso_year=2020` 필터가 `ExtractIsoYear` 어노테이션과 동일한 의미로 동작하길 기대했지만, 실제로는 일반 연도 BETWEEN으로 치환되어 결과가 어긋났다.

## 유형 분류
- 버그 카테고리: logic / edge-case (regression — ExtractIsoYear가 도입된 Django 2.2 #28649 이후로 계속 존재)
- 서브시스템: django ORM query / lookups / DB backend operations
- 증상 타입: silent-wrong (예외 없이 잘못된 결과 row 반환)
- 로컬라이제이션 신호: problem_statement가 "optimization in YearLookup"과 "BETWEEN instead of the EXTRACT"를 직접 지목 → `db/models/lookups.py`의 `YearLookup`이 시작점. 거기서 호출하는 `year_lookup_bounds_*`가 `db/backends/base/operations.py`로 연결.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/lookups.py`: `YearLookup.year_lookup_bounds`
  - `django/db/backends/base/operations.py`: `year_lookup_bounds_for_date_field`, `year_lookup_bounds_for_datetime_field`
- 근본 원인: `YearLookup`이 lhs가 `ExtractYear`인지 `ExtractIsoYear`인지 구분하지 않고 무조건 그레고리력 연도 경계(1/1~12/31)로 BETWEEN 경계를 계산했다. ISO 연도는 12월 말~1월 초가 인접 ISO 연도에 속할 수 있어 경계가 다르다.
- 수정 요지:
  - `year_lookup_bounds`에서 `isinstance(self.lhs, ExtractIsoYear)`로 ISO 여부를 판별하고 그 결과를 `iso_year` 인자로 backend ops에 전달.
  - `year_lookup_bounds_for_date_field`/`_for_datetime_field`에 `iso_year=False` 파라미터를 추가. `iso_year=True`면 `datetime.date.fromisocalendar(value, 1, 1)`을 하한으로, `fromisocalendar(value+1, 1, 1) - timedelta(days=1)`(datetime은 `microseconds=1`)을 상한으로 사용해 ISO 주차 연도의 실제 경계를 계산.
  - 일반 연도 경로는 기존 1/1~12/31 로직을 그대로 유지(분기 처리).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_extract_iso_year_func_boundaries` (일반 + 타임존 케이스 2개).
- 테스트가 어떻게 증명하는지: 2014-W52, 2014/2015 경계의 W1, 2015-W53에 해당하는 datetime 3개로 객체를 생성하고 각 객체 핸들(`obj_1_iso_2014`, `obj_1_iso_2015`, `obj_2_iso_2015`)을 보관한다. 그 다음 `start_datetime__iso_year=2015`, `__iso_year__gt=2014`, `__iso_year__lte=2014` 룩업을 실제로 필터링해 반환 객체 집합을 검증한다. 픽스 전에는 BETWEEN이 그레고리력 경계를 써서 ISO 2015에 속하는 2014-12-29 같은 날짜를 누락/오분류했으나, 픽스 후 `fromisocalendar` 기반 경계로 정확히 ISO 연도별로 분리된다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 `YearLookup` + BETWEEN 최적화를 명시하므로 `lookups.py`의 `YearLookup`에서 출발 → `year_lookup_bounds`가 backend의 `year_lookup_bounds_for_{date,datetime}_field`를 호출하는 흐름을 따라간다. lhs 타입(`ExtractYear` vs `ExtractIsoYear`)이 핵심 분기점.
- 함정/난이도 메모: (1) 멀티파일 수정 — lookups.py 한 곳만 고치면 backend ops 시그니처가 없어 동작 안 함. (2) ISO 경계 계산은 단순 `date(value,1,1)`이 아니라 `fromisocalendar`를 써야 함 — 직관에 반하는 부분. (3) datetime 상한은 `days=1`이 아니라 `microseconds=1`을 빼야 정밀도가 맞음. (4) `ExtractIsoYear` import를 함수 내부에서 지연 import하는 이유는 순환 import 회피.
- 우리 에이전트 관점 막힐 지점: 어노테이션 단독으로는 `EXTRACT`가 정상 동작해 버그가 안 보이고 오직 filter 룩업 경로에서만 BETWEEN 치환이 일어나므로, 재현/원인 추적이 까다롭다. 또 `fromisocalendar`(Python 3.8+)라는 정확한 표준 라이브러리 API를 알아야 하고, date/datetime 두 backend 메서드를 대칭적으로 고쳐야 한다는 점을 놓치기 쉽다.
