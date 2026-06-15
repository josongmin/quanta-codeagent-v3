---
instance_id: django__django-15957
repo: django/django
base_commit: f387d024fc75569d2a4a338bfda76cc2f328f627
version: 4.2
difficulty: 1-4 hours
created_at: 2022-08-13T06:18:25Z
fail_to_pass: 4
pass_to_pass: 89
gold_files: [django/db/models/fields/related_descriptors.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-15957

## 문제 요약
`Prefetch()`에 슬라이스된 queryset(예: `Post.objects.all()[:3]`)을 넘기면 `AssertionError: Cannot filter a query once a slice has been taken.`이 발생한다. prefetch는 내부적으로 `field__in=instances` 필터를 추가로 거는데, 슬라이스가 이미 적용된 query는 더 이상 필터링할 수 없기 때문이다. 사용자 의도는 "카테고리별 예시 N개씩"처럼 그룹당 상위 N개를 효율적으로(테이블 전체를 메모리에 로드하지 않고) prefetch하는 것. 이슈 스레드 자체가 "그냥 슬라이스를 무시하고 인메모리에서 `[:3]` 하면 안 되냐"는 안일한 우회를 명시적으로 거부하고 있고(전체 로드 = 의도 위반), 윈도우 함수(`Rank`/`RowNumber` `partition_by`) 기반 top-N-per-group이 진짜 해법이라고 스레드가 가리킨다.

- **⚠️ 결정적 전제(linchpin) — 직전 base commit이 이 픽스를 비로소 가능하게 만들었다**: 이 인스턴스의 `base_commit` `f387d024` 자체가 #28333 커밋 **"Refs #28333 -- Added partial support for filtering against window functions"**다. 즉 *윈도우 함수를 filter clause에서 쓸 수 있게 된 바로 그 직후 커밋* 위에서 이 문제를 푼다. 그 이전 Django에서는 `GreaterThan(window, ...)`/`LessThanOrEqual(window, ...)`처럼 윈도우 표현식으로 필터하면 hints_text에 적힌 대로 **"Window is disallowed in the filter clause" (`NotSupportedError`)**가 떠서 정답 구조(`ROW_NUMBER() OVER (PARTITION BY ...)`를 필터로) 자체가 **불가능**했다. hints_text의 "support for filter against window functions would allow ... #28333" / "doable before #28333 ... using Queryset.raw and Query.compile"이 정확히 이 의존을 가리킨다. 이 전제를 모르는 solver는 "윈도우를 filter에 못 쓰니 이 픽스는 불가능"하다고 결론내리게 된다 — 즉 *지금 시점에야 가능해졌다*는 사실이 이 문제의 핵심 크럭스다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: 이슈가 파일/심볼을 직접 지목하진 않지만, 에러 문자열 "Cannot filter a query once a slice has been taken"으로 grep → 슬라이스 가드 → prefetch 경로 역추적하면 좁게 `related_descriptors.py`의 `get_prefetch_queryset` 두 분기로 수렴한다. grep 한 방은 아니나 단일 파일로 좁혀짐. (L0 아님: `filter(**query)` 호출부가 어디인지는 약간의 콜체인 추적 필요.)
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning)**: 한 줄 가드가 아니라 **신규 헬퍼 `_filter_prefetch_queryset()`를 도입해 LIMIT/OFFSET을 윈도우 쿼리로 변환**하는 작은 구조 변경이 핵심(S6). 동시에 `low_mark`(배타 하한 `>`)와 `high_mark`(포함 상한 `<=`)의 경계 부호, `partition_by`/`order_by` 추출을 불변식으로 따져 올바른 식을 합성해야 해서 S2가 보조로 붙는다. G&V(S3)/CEGIS(S4) 아님: 테스트를 던져 plausible 후보를 수렴시키는 문제가 아니라, "그룹당 top-N = 윈도우 함수"라는 정답 구조를 선험적으로 알아야 한다.
- **K (Knowledge) = K-Domain**: `Window(RowNumber(), partition_by=..., order_by=...)`, `query.get_compiler(...).get_order_by()`, `query.low_mark/high_mark`, `query.is_sliced`, `query.clear_limits()`, `GreaterThan`/`LessThanOrEqual` 로우레벨 lookup, `DEFAULT_DB_ALIAS` — 전부 django ORM 쿼리 컴파일러 내부 지식. 일반 파이썬 추론으로는 도달 불가. K-API도 일부 걸치나(공개 `Prefetch` 동작 계약 확장) dominant는 ORM 내부지식.
- **primary type = T-DomainBound**: 병목이 "어디를 고치나"(L1로 어렵지 않음)도 "테스트로 수렴"도 아니라, **그룹별 limit을 윈도우 함수로 재현한다는 ORM 내부지식**이다. 이 지식이 없으면 S6 구조 자체를 떠올리지 못한다 → K-Domain dominant.
- **flag: `cross-file-dep` = 시간축(temporal) 의존**: 골드는 단일 파일만 건드리므로 *공간적* 멀티파일 의존은 아니다(`Window`/`RowNumber`/`GreaterThan`/`LessThanOrEqual` 소비는 일반 import에 불과). 이 플래그가 가리키는 건 **base commit `f387d024`(#28333, 윈도우 함수 filter 지원)에 대한 전제 의존**이다 — 정답 구조가 *바로 직전 커밋이 추가한 능력* 위에서만 성립하므로, 픽스 가능성 자체가 cross-commit(시간축) 선행 변경에 묶여 있다. (공간적 멀티파일 조율이라는 통상 의미가 아니라 이 시간축 전제로 읽어야 함.)

## 난이도 티어
**T5 (어려움)**. 공식 라벨은 `1-4 hours`(T4 prior에 해당)지만 T5로 상향한다.
- 상향 근거(구조적 피처):
  - **S6 design-refactor + 비자명한 ORM 빌딩블록 조합**: `Window`/`RowNumber`/`partition_by`/`get_order_by()`/`GreaterThan`/`LessThanOrEqual`를 정확히 엮어야 함. "그룹당 top-N = 윈도우 함수"라는 도메인 통찰이 없으면 정답 구조 자체가 안 나온다.
  - **K-Domain dominant**: 실패의 ~25%가 knowledge deficiency라는 실증과 정합. 이 문제는 추론보다 지식 병목.
  - **regression-trap (P2P=89)**: prefetch_related 전 영역(forward/reverse FK, m2m, GFK, multi-db, MTI, raw qs 등) 87+개 인접 동작을 안 깨야 한다. 비슬라이스 경로는 byte-identical하게 유지하면서 슬라이스 분기만 추가해야 함.
  - **overfit으로 빠지기 쉬운 함정**: "슬라이스 무시 후 인메모리 `[:n]`"이라는 순진한 픽스가 FAIL_TO_PASS의 동치성 단언은 통과시킬 수 있어 보이나 `assertNumQueries(3)`가 이를 차단 — 즉 잘못된 일반화로 끌려갈 인력이 강함.
- 하향 안 하는 이유: 단일 파일·gold 한 파일이라 T6(멀티파일 조율)까진 아니나, L1×S6×K-Domain×넓은 P2P trap 조합이 T4를 넘어선다. localize는 쉬워도 "픽스 구조 발견"의 지식장벽이 진짜 난점.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/related_descriptors.py`
  - 신규 모듈헬퍼 `_filter_prefetch_queryset(queryset, field_name, instances)` 추가.
  - reverse FK 매니저(`create_reverse_many_to_one_manager`)의 `get_prefetch_queryset` — 라인 ~738, 인라인 `query={...}; queryset.filter(**query)`를 헬퍼 호출로 교체.
  - m2m 매니저(`create_forward_many_to_many_manager`)의 `get_prefetch_queryset` — 라인 ~1069, `queryset._next_is_sticky().filter(**query)`를 `_filter_prefetch_queryset(queryset._next_is_sticky(), self.query_field_name, instances)`로 교체.
  - import 확장: `DEFAULT_DB_ALIAS`, `Window`, `RowNumber`, `GreaterThan`, `LessThanOrEqual`.
- **근본 원인**: prefetch는 2단계 — (1) 관련 객체를 한 번에 쿼리 → (2) 인메모리로 부모에 join. 두 분기 모두 `Q(field__in=instances)` 필터를 **추가로** 붙이는데(`.filter(**query)`), 슬라이스된 queryset은 `query.is_sliced`이고 `QuerySet._filter_or_exclude`(django/db/models/query.py ~954라인의 슬라이스 가드 `assert not self.query.is_sliced, "Cannot filter a query once a slice has been taken."`)가 `.filter(**query)`에서 직접 `AssertionError`를 던진다. 슬라이스를 단순히 풀어버리면 "그룹당 limit" 의미가 소실되어 전체 로드로 회귀(이슈가 거부한 동작).
- **수정 요지**: 공통 헬퍼에서 기본 predicate `Q(**{f"{field_name}__in": instances})`를 만들고, `queryset.query.is_sliced`이면:
  1. `low_mark, high_mark = query.low_mark, query.high_mark` 추출.
  2. `order_by`를 `query.get_compiler(using=queryset._db or DEFAULT_DB_ALIAS).get_order_by()`에서 표현식만 뽑아 구성(다중DB 안전 + `Meta.ordering`/`.reverse()` 반영).
  3. `window = Window(RowNumber(), partition_by=field_name, order_by=order_by)` — **그룹(부모)별로** 행번호 매김.
  4. `predicate &= GreaterThan(window, low_mark)`; `high_mark`가 있으면 `predicate &= LessThanOrEqual(window, high_mark)` — OFFSET=`>low_mark`(배타), LIMIT 상한=`<=high_mark`(포함).
  5. `query.clear_limits()`로 원래 슬라이스 제거(이게 없으면 여전히 단언 실패).
  6. `queryset.filter(predicate)` 반환. → LIMIT/OFFSET을 **top-N-per-group 윈도우 쿼리**로 변환. 슬라이스가 없으면 predicate는 `field__in`만이라 기존 동작과 동일.

## 검증 (test_patch)
- **FAIL_TO_PASS (4개)**: `tests/prefetch_related/tests.py`의 신규 `PrefetchLimitTests` —
  - `test_m2m_forward`, `test_m2m_reverse`, `test_foreignkey_reverse`, `test_reverse_ordering`.
  - 각 테스트는 **같은 관계를 두 번 prefetch**한다: 슬라이스 없는 `Prefetch("authors", authors)`와 슬라이스된 `Prefetch("authors", authors[1:], to_attr="authors_sliced")`.
- **픽스 증명 메커니즘**:
  - `assertNumQueries(3)`: 슬라이스 prefetch도 부모쿼리+비슬라이스+슬라이스 = 정확히 3쿼리로 처리됨을 강제 → **인메모리 폭발(전체 로드) 우회를 차단**. 슬라이스 무시 후 파이썬 `[:n]`으로 때우는 안일한 픽스는 쿼리 수/로드 양에서 걸린다.
  - `book.authors_sliced == list(book.authors.all())[1:]`: 윈도우 기반 그룹별 슬라이스 결과가 파이썬 인메모리 슬라이스와 **동치**임을 증명. 경계 부호(`>low_mark`, `<=high_mark`)가 틀리면 off-by-one으로 실패.
  - `test_reverse_ordering`은 `Author.objects.reverse()`(=`Meta.ordering` 역순)에서도 `get_order_by()` 추출이 윈도우 `order_by`에 올바르게 반영되는지 검증 — order 추출을 하드코딩/생략하면 깨진다.
- **overfit 관점**: FAIL_TO_PASS가 4개로 forward/reverse FK·m2m·reverse-order를 모두 커버하고 동치단언+쿼리수단언이 결합되어 있어, special-case 픽스(특정 슬라이스값만 맞추기)로는 통과 불가. CEGIS적 과소명세 위험은 낮은 편 — 단, `[1:]`(상한 무) / `[1:2]`(상·하한 모두) 케이스가 다 있어 `high_mark is None` 분기까지 운동시킨다.
- **regression 관점**: PASS_TO_PASS=89가 prefetch_related 전 표면(GFK, multi-db, MTI, raw qs, custom prefetch, nullable 등)을 덮는다. 헬퍼가 **비슬라이스 경로에서 정확히 기존과 동일한 `field__in` filter**를 내야 함 — `is_sliced` 분기 밖에선 동작 불변이라야 87+개가 산다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 정확한 에러 문자열 `"Cannot filter a query once a slice has been taken"`을 코드베이스에 grep → `QuerySet._filter_or_exclude`(django/db/models/query.py ~954라인)의 슬라이스 가드 `assert not self.query.is_sliced`에 도달. 거기서 "누가 슬라이스된 qs에 `.filter()`를 거나" 역추적 → prefetch가 `field__in=instances`를 붙이는 지점, 즉 `related_descriptors.py`의 `get_prefetch_queryset` (reverse FK 분기 ~738, m2m 분기 ~1069). 두 분기가 동일 패턴(`query={...}; filter(**query)`)임을 확인 → 공통화 대상 식별.
2. **픽스와 올바른 일반화인 이유**: 두 호출부를 공통 헬퍼 `_filter_prefetch_queryset`로 추출하고, 슬라이스가 걸린 경우 LIMIT/OFFSET을 `Window(RowNumber(), partition_by=field_name, order_by=...)` + `RowNumber`에 대한 `GreaterThan(low_mark)`/`LessThanOrEqual(high_mark)` 필터로 변환한다. 이게 올바른 일반화인 이유: 사용자가 원한 의미는 "부모(그룹)당 상위 N"이고, SQL에서 그룹당 top-N의 정준해가 윈도우 함수 `ROW_NUMBER() OVER (PARTITION BY group ORDER BY ...)`다. `partition_by=field_name`이 그룹 경계를, `order_by`를 컴파일러 `get_order_by()`에서 뽑는 것이 슬라이스의 정렬 의미(`Meta.ordering`/`.reverse()` 포함)를 보존. `low_mark>`(배타)·`high_mark<=`(포함)가 파이썬 슬라이스 `[low:high]` 반열림 구간과 정확히 대응. → 특정 테스트값이 아니라 임의 `[a:b]`에 대해 의미 보존.
3. **regression 안전**: 비슬라이스 경로(`is_sliced` False)에선 predicate가 `field__in`만이라 헬퍼가 **기존과 byte-동치 쿼리**를 내야 한다 — 이게 PASS_TO_PASS 89개(GFK/multi-db/MTI/raw/custom prefetch 등)를 지키는 핵심. `queryset._db or DEFAULT_DB_ALIAS`로 다중DB(`MultiDbTests`)에서 컴파일러 별칭이 깨지지 않게 처리. m2m 분기는 `_next_is_sticky()` 순서를 유지해야 m2m 어노테이션 join이 살아남는다.
4. **함정 회피**: (a) "슬라이스 무시하고 인메모리 `[:n]`"의 유혹 — 이슈가 명시적으로 거부했고 `assertNumQueries(3)`가 잡는다. 반드시 DB측 윈도우로 풀어야 함. (b) `clear_limits()` 누락 → 윈도우 필터를 붙여도 원래 LIMIT가 남아 단언 재발. (c) 경계 off-by-one — `low_mark`는 `>`(OFFSET은 그 다음 행부터), `high_mark`는 `<=`이며 `high_mark is None`(상한 없는 `[1:]`) 분기를 빠뜨리면 `LessThanOrEqual(window, None)`로 깨진다. (d) `order_by`를 생략/하드코딩하면 `test_reverse_ordering`에서 정렬이 어긋남 — 반드시 컴파일러 `get_order_by()`에서 표현식을 추출. (e) 두 호출부 중 하나만 고치면 forward/reverse 한쪽 FAIL_TO_PASS가 남는다 — 공통 헬퍼로 양쪽 교체 필수.
