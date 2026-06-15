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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-14170

## 문제 요약
`YearLookup`은 인덱스를 활용하기 위해 `EXTRACT(year ...)` 대신 `BETWEEN <year>-01-01 AND <year>-12-31` 으로 쿼리를 최적화한다. 그런데 이 최적화가 `__iso_year` 룩업에도 무차별 적용되면서, ISO-8601 주차 연도(week-numbering year)의 경계가 그레고리력 연도 경계(1/1~12/31)와 다른데도 일반 연도 경계로 BETWEEN을 만들어 잘못된 row가 반환된다. 사용자는 `start_date__iso_year=2020` 필터가 `ExtractIsoYear` 어노테이션과 동일한 의미로 동작하길 기대했지만, 실제로는 일반 연도 BETWEEN으로 치환되어 결과가 어긋났다. `ExtractIsoYear`가 도입된 Django 2.2(#28649) 이후로 계속 잠복해 있던 회귀이며, 어노테이션 단독으로는 `EXTRACT`가 정상 동작하기 때문에(filter 경로에서만 BETWEEN 치환) 추적이 어려웠다.

## 유형 (정형화)
- **L (Localization) = L3** — Multi-site. problem_statement가 `YearLookup`과 "BETWEEN instead of the EXTRACT"를 직접 지목해 진입점(`lookups.py`의 `YearLookup`) 자체는 grep 한 방이지만(그 점만 보면 L0에 가까움), 올바른 픽스는 **두 파일이 함께 바뀌어야** 한다: `lookups.py`의 `year_lookup_bounds`가 ISO 여부를 판별·전달하고, `operations.py`의 `year_lookup_bounds_for_date_field`/`_for_datetime_field`가 그 플래그를 받아 경계를 다르게 계산해야 한다. 한 곳만 고치면 시그니처 불일치/동작 미반영. 진입점 명확성보다 **조율된 멀티사이트**가 축을 지배하므로 L3.
- **S (Repair Strategy) = S2 (+S6)** — Constraint-Reasoning이 dominant. 고칠 지점은 알지만, 올바른 ISO 연도 경계 식을 **불변식 추론으로 합성**해야 한다: 하한은 `fromisocalendar(value, 1, 1)`, 상한은 `fromisocalendar(value+1, 1, 1) - timedelta(...)`. 이는 "후보를 많이 던져보고 테스트로 거르는"(S3/S4) 문제가 아니라, ISO-8601 주차 연도 정의를 따져 정확한 식을 한 번에 도출하는 semantic 추론(SemFix/Angelix 계열)이다. 보조로 **S6**: backend 메서드에 `iso_year=False` 파라미터를 도입하고 분기를 추가하는 소규모 구조 변경(parameter introduction)이 동반된다.
- **K (Knowledge) = K-Domain** — django ORM lookup/query-compiler 내부 지식이 병목. `YearLookup`이 lhs의 `Extract*` 타입에 따라 분기한다는 점, lookup→backend ops 호출 흐름, `ExtractIsoYear`를 함수 내부에서 지연 import해야 순환 import를 피한다는 점이 전부 프레임워크 내부 지식이다. 동시에 `datetime.date.fromisocalendar`(Python 3.8+)라는 표준 라이브러리 API 지식도 필요(K-Gen 약간 섞이나 도메인이 우세).
- **primary_type = T-ConstraintReason** — 위치는 (이슈가 지목해) 비교적 명확하지만 진짜 난점은 올바른 경계 식의 추론 합성에 있다. localize가 본질인 T-DiffuseLoc도, K-Domain이 단독 병목인 T-DomainBound도 아니다(둘 다 보조 요인). S6가 섞이지만 한 줄짜리 구조 변경 수준이라 T-DesignRefactor로 끌어올릴 정도는 아니다.

## 난이도 티어
**T4 (약간 어려움).** 이 티어로 미는 구조적 피처:
- **멀티파일 조율(L3, cross-file-dep)** — 2파일 `operations.py`+`lookups.py`를 시그니처 정합성을 맞춰 함께 수정해야 함. 한 곳만 고치면 깨짐.
- **S2 constraint 추론** — `fromisocalendar` 기반 경계는 직관에 반하고(일반 `date(value,1,1)` 아님), datetime 상한은 `days=1`이 아니라 `microseconds=1`을 빼야 정밀도가 맞음. 식을 정확히 합성해야 한다.
- **K-Domain** — ORM lookup 분기/backend ops 구조 지식 + ISO-8601 표준 API.
- **regression-trap(넓은 P2P)** — PASS_TO_PASS 76개 중 일반 `__year` 룩업·`test_extract_year_*`·`Extract year uses a BETWEEN filter...` 등 인접 동작이 다수. 일반 연도 BETWEEN 최적화를 깨면 안 된다.

공식 라벨은 "15 min - 1 hour"(T2~T3 prior). 그러나 시간라벨은 **개발자 구현시간**이라 "익숙한 개발자가 답을 알 때"의 코딩 시간일 뿐, (a) ISO 경계가 그레고리력과 다르다는 통찰, (b) filter 경로에서만 재현되는 미묘한 재현성, (c) 멀티파일 조율, (d) 넓은 regression trap을 시간라벨이 잡지 못한다. 오라클 없는 에이전트에겐 이 4개가 실질 난점이라 한 단계 위인 T4로 재조정한다.

## 골드패치 분석
- **건드린 파일·함수:**
  - `django/db/models/lookups.py`: `YearLookup.year_lookup_bounds`
  - `django/db/backends/base/operations.py`: `year_lookup_bounds_for_date_field`, `year_lookup_bounds_for_datetime_field`
- **근본 원인:** `YearLookup.year_lookup_bounds`가 lhs가 `ExtractYear`인지 `ExtractIsoYear`인지 구분하지 않고 무조건 그레고리력 연도 경계(1/1~12/31)로 BETWEEN 경계를 계산했다. ISO 주차 연도는 12월 말~1월 초가 인접 ISO 연도에 속할 수 있어(예: 2014-12-29~31이 ISO 2015 W1) 경계가 그레고리력과 다르다. BETWEEN 최적화가 `__iso_year`까지 잘못 포섭해 의미가 깨졌다.
- **수정 요지:**
  - `year_lookup_bounds`에서 `from django.db.models.functions import ExtractIsoYear`(지연 import, 순환 import 회피) 후 `iso_year = isinstance(self.lhs, ExtractIsoYear)`로 ISO 여부 판별, 그 결과를 `iso_year=` 인자로 backend ops 두 메서드에 전달.
  - `year_lookup_bounds_for_date_field(self, value, iso_year=False)`: `iso_year=True`면 하한 `datetime.date.fromisocalendar(value, 1, 1)`, 상한 `datetime.date.fromisocalendar(value + 1, 1, 1) - datetime.timedelta(days=1)`.
  - `year_lookup_bounds_for_datetime_field(self, value, iso_year=False)`: `iso_year=True`면 하한 `datetime.datetime.fromisocalendar(value, 1, 1)`, 상한 `datetime.datetime.fromisocalendar(value + 1, 1, 1) - datetime.timedelta(microseconds=1)`.
  - 두 메서드 모두 `iso_year=False`(기본) 경로는 기존 1/1~12/31 로직을 그대로 유지하여 일반 `__year`는 byte-동일하게 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS (2):** `test_extract_iso_year_func_boundaries` — `DateFunctionTests`(일반)와 `DateFunctionWithTimeZoneTests`(타임존) 두 클래스.
- **동작:** 테스트는 ISO 경계를 가르는 3개 datetime(2014-W52 = `week_52_day_2014`, 2014/2015 경계의 W1 = `week_1_day_2014_2015`, 2015-W53 = `week_53_day_2015`)으로 객체를 만들고 핸들(`obj_1_iso_2014`, `obj_1_iso_2015`, `obj_2_iso_2015`)을 보관한다. 그다음 **실제 lookup 필터**를 돌려 반환 객체 집합을 단언한다: `__iso_year=2015` → `[obj_1_iso_2015, obj_2_iso_2015]`, `__iso_year__gt=2014` → 동일, `__iso_year__lte=2014` → `[obj_1_iso_2014]`.
- **픽스 증명:** 픽스 전에는 그레고리력 BETWEEN이 2014-12-29(ISO 2015 W1)를 ISO 2014로 오분류하고 2015-W53(2016년 1월 초 일부)을 누락해 위 단언이 깨진다. 픽스 후 `fromisocalendar` 경계가 ISO 연도별 실제 구간을 만들어 정확히 분리된다. `=`/`__gt`/`__lte` 세 가지를 함께 검증해 등가뿐 아니라 범위 비교(상·하한 모두)를 커버한다.
- **overfit 관점:** equality + 두 방향 range 비교를 묶고, ISO 경계가 그레고리력과 갈라지는 정확한 boundary 날짜를 골라 썼으므로 special-case 통과가 어렵다 — overfit-risk 낮음. 다만 FAIL_TO_PASS가 단 1개 테스트(2클래스)라 입력 다양성은 제한적.
- **regression 관점:** 픽스가 기본값 `iso_year=False`로 일반 경로를 보존하므로, P2P 76개의 일반 `__year`·`__year__gt/lt` BETWEEN 동작과 타임존 trunc/extract 전반이 깨지지 않는다. 이게 regression-trap의 핵심 방어선.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 "optimization in `YearLookup`"과 "BETWEEN instead of the EXTRACT"를 명시 → `django/db/models/lookups.py`의 `YearLookup`에서 출발. `year_lookup_bounds`가 lhs 타입을 보지 않고 무조건 `connection.ops.year_lookup_bounds_for_{date,datetime}_field`를 호출하는 것을 확인 → 그 호출이 `django/db/backends/base/operations.py`로 이어지는 데이터플로우를 따라간다. 분기점은 **lhs가 `ExtractYear`냐 `ExtractIsoYear`냐**.
2. **픽스 (올바른 일반화인 이유):** `isinstance(self.lhs, ExtractIsoYear)`로 ISO 여부를 판별해 backend ops에 `iso_year`로 넘기고, ops 쪽에서 ISO일 때만 `fromisocalendar`로 경계를 계산한다. 이는 특정 연도(2015)에 맞춘 하드코딩이 아니라 ISO-8601 주차 연도의 정의(`fromisocalendar(year,1,1)` ~ `fromisocalendar(year+1,1,1)-ε`)를 그대로 식으로 옮긴 것이라 **모든 연도에 일반적으로 옳다**. BETWEEN 최적화의 인덱스 이점도 유지(EXTRACT로 되돌리지 않음)하여 성능 회귀가 없다.
3. **regression 안전:** ops 메서드의 ISO 분기를 `iso_year=False` 기본값으로 게이팅해 일반 `__year` 경로를 변경 없이 보존해야 한다. 이로써 P2P의 `test_extract_year_func`, `test_extract_year_greaterthan/lessthan_lookup`, `Extract year uses a BETWEEN filter...`, 그리고 타임존 변형 다수가 깨지지 않는다 — 일반 연도 BETWEEN이 ISO와 의미가 다르므로 그쪽을 건드리면 즉시 회귀.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) `lookups.py` 한 곳만 고치고 끝낸다(시그니처 없는 backend 호출로 미동작) → date/datetime **두 backend 메서드를 대칭으로** 고쳐야 함을 인지. (b) ISO 경계를 `date(value,1,1)`이나 주차 산술로 근사 → 표준 `datetime.date.fromisocalendar`를 써야 함. (c) datetime 상한을 `days=1`로 빼서 마지막날 23:59:59.x를 누락 → `microseconds=1`. (d) `ExtractIsoYear`를 모듈 상단에서 import → 순환 import, 함수 내부 지연 import로 회피. (e) 재현 시 어노테이션 단독으로 시도하면 `EXTRACT`가 정상 동작해 버그가 안 보임 → 반드시 **filter lookup 경로**(`...filter(start_date__iso_year=...)`)로 재현해야 BETWEEN 치환이 드러난다.
