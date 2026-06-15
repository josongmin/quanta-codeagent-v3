---
instance_id: django__django-15554
repo: django/django
base_commit: 59ab3fd0e9e606d7f0f7ca26609c06ee679ece97
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-03-29T10:12:46Z
fail_to_pass: 1
pass_to_pass: 41
gold_files: [django/db/models/sql/query.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L2
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-15554

## 문제 요약
같은 relation(`myrelation__nested` / 테스트에선 `book`)에 대해 서로 다른 `condition`을 가진 `FilteredRelation`을 둘 이상 선언하면, ORM이 SQL JOIN을 하나만 생성하고 나머지를 무시한다. 사용자는 `relation_zone`과 `relation_all`(테스트의 `book_title_alice` / `book_title_jane`) 각각에 대한 별도 JOIN을 기대했지만, `print(str(qs.query))` 상에서 첫 번째 것만 JOIN으로 나타난다. 결과적으로 두 번째 `FilteredRelation`이 가리키는 컬럼이 첫 번째 JOIN의 alias로 병합되어 값이 조용히 누락/오염된다(silent-wrong). 이슈에 따르면 커밋 `0c71e0f9cfa714a22297ad31dd5613ee548db379`에서 도입된 회귀다.

## 유형 (정형화)

**L (Localization) = L2 (Diffuse).**
이슈는 증상("generates a single SQL JOIN ... ignores the other")만 주고, 고칠 파일/함수/심볼을 직접 지목하지 않는다. `FilteredRelation` 키워드로 query.py까지는 좁힐 수 있으나, 결함이 드러나는 표면은 `build_filtered_relation_q → build_filter → setup_joins → join`이라는 4-단계 데이터플로우 끝의 `join()` 안 `reuse_aliases` 산정이다. 다만 픽스 자체는 그 한 줄이 아니라 (1) `setup_joins`에서 `reuse`를 None→`can_reuse`로 강제하고 (2) `reuse_with_filtered_relation` 플래그를 4곳에 배선하는 조합이다. "왜 JOIN이 병합되는가"를 alias 재사용 로직까지 추적해야 하므로 L1(키워드→단일 후보)보다 깊다. 단, 수정은 결국 단일 파일(query.py) 안에서 일어나므로 L3(멀티파일 조율)은 아니다.

**S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design-Refactor).**
픽스의 본질은 "`equals`(filtered_relation 무시)와 `__eq__`(filtered_relation까지 비교)의 의미 차이를 따져, 어떤 비교를 어떤 경로에서 써야 정확한가"를 추론으로 합성하는 것이다 — 후보를 여러 개 던져 테스트로 고르는 G&V가 아니다(무작정 `==`로 바꾸면 즉시 41개 회귀). 동시에 한 줄 변경이 아니라 `reuse_with_filtered_relation` 파라미터를 4개 시그니처(`join`/`build_filter`/`setup_joins` + `build_filtered_relation_q` 호출부)에 일관되게 도입·배선하는 소규모 구조 변경이라 S6가 보조로 붙는다.

**K (Knowledge) = K-Domain.**
django query-compiler 내부 지식이 병목이다. `Join.equals()`가 의도적으로 `filtered_relation`을 비교에서 제외하도록 설계됐다는 사실, `setup_joins`의 `reuse = can_reuse if join.m2m ...` 규약, alias_map/refcount 재사용 의미를 알아야 "왜 병합되는지"와 "어디만 엄격 비교로 바꿔야 하는지"가 보인다. 일반 파이썬 추론(K-Gen)으론 닿지 않는다.

**Primary type = T-DomainBound.**
L2의 diffuse 탐색과 S2의 제약추론이 모두 작동하지만, 지배적 병목은 ORM join-aliasing 내부 규약(`equals` vs `==`의 도메인적 의도)을 아느냐다. 위치 찾기 자체가 진짜 난점이면 T-DiffuseLoc이겠으나, 여기선 "찾은 뒤에도 도메인 지식 없이는 올바른 분기를 못 짠다"가 핵심이라 T-DomainBound으로 본다.

## 난이도 티어
**T5 (어려움).** 공식 라벨은 "15 min - 1 hour"(T3~T4 prior)지만 한 단계 올린다.

이 티어로 미는 구조적 피처:
- **K-Domain × 미묘한 의미 분기**: `Join.equals()`(filtered_relation 무시, `identity[:-1]`)와 `Join.__eq__()`(filtered_relation 포함, `identity` 전체) 차이가 클래스 정의를 읽어야만 드러나는 도메인 내부 규약이다. 표면 grep으로는 절대 안 잡힌다. 단, 골드패치는 이 차이를 "FilteredRelation 경로를 엄격화"하는 데 쓰는 게 아니다 — FR 경로는 여전히 `j.equals(join)`(loose)를 쓰고, `j == join`(strict) 쪽은 오히려 비-FR(else) 경로다.
- **강한 regression-trap (P2P=41)**: `filtered_relation` 디렉터리 전체 41개가 PASS_TO_PASS. 비-FilteredRelation 경로를 `equals`에서 `==`로 무조건 엄격화하면 일반 JOIN 재사용(`test_with_m2m`, `test_without_join` 등)이 줄줄이 깨진다. FilteredRelation 경로는 `can_reuse`로 제한된 집합 안에서만 `equals`로 재사용하도록 분리하는 게 핵심이다.
- **멀티-시그니처 배선 완결성**: 단일 파일이지만 `reuse_with_filtered_relation` 플래그를 4곳에 일관 전파해야 하고, 마지막 `setup_joins`의 `reuse = can_reuse if join.m2m or reuse_with_filtered_relation else None` 라인까지 엮어야 실제로 JOIN이 분리된다. 한 군데라도 빠지면 헌트가 끊겨 픽스가 무력화된다.

공식 시간라벨이 더 낮은 이유: 라벨은 "정답을 아는 개발자의 구현 시간"이라 메커니즘을 이미 이해한 상태를 가정한다. 에이전트 관점의 난점(diffuse localize + 도메인 의미 추론 + 넓은 회귀 함정)은 시간라벨에 안 잡힌다. has-repro(qs 재현 + 회귀 커밋 명시)가 easiness 신호이긴 하나, 그것이 곧 픽스를 명세하진 않으므로 T5에서 T4로 끌어내릴 만큼은 아니다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/sql/query.py` — `Query.join`, `Query.build_filter`, `Query.build_filtered_relation_q`, `Query.setup_joins`.
- **근본 원인**: `join()`이 재사용 alias 후보를 산정할 때 `j.equals(join)`을 썼다. `Join.equals()`는 의도적으로 `filtered_relation`을 비교에서 제외하므로, 동일 테이블·동일 join-type이지만 `condition`만 다른 두 `FilteredRelation`을 "같은 join"으로 판정한다. 그 결과 두 번째 FilteredRelation이 기존 alias를 재사용해 별도 JOIN이 생성되지 않고, 두 alias가 병합되어 값이 누락된다.
- **수정 요지**: `reuse_with_filtered_relation` 불리언 플래그를 콜체인 전체에 도입한다.
  - `join(self, join, reuse=None, reuse_with_filtered_relation=False)`: 플래그가 True이고 `reuse`가 있는 FilteredRelation 경로는 후보를 `a in reuse and j.equals(join)`로 제한한다 — 즉 `can_reuse`에 명시된 제한된 alias 집합 안에서만 `equals`(loose)로 재사용한다(여기서 `equals`는 그대로 유지됨). 반대로 그 외(else) 경로는 기존 `j.equals(join)`을 `j == join`(`__eq__`, filtered_relation까지 비교)으로 바꾼다. 즉 **strict `==` 는 FR 경로가 아니라 비-FilteredRelation 경로에 적용된다.**
  - `build_filter(...)`와 `setup_joins(...)`에 동일 파라미터를 추가해 `build_filter → setup_joins → join`으로 전파.
  - `build_filtered_relation_q`가 `build_filter(... reuse_with_filtered_relation=True)`로 호출해 FilteredRelation 경로에서만 플래그를 켠다.
  - **(실제 linchpin)** `setup_joins` 말미에서 `reuse = can_reuse if join.m2m or reuse_with_filtered_relation else None`로 바꿔, FilteredRelation일 때 `reuse`를 None→`can_reuse`(제한된 집합)로 강제한다. 이 강제가 없으면 `reuse`가 None이라 `join()`의 `reuse_with_filtered_relation and reuse` 조건이 False가 되어 픽스가 무력화된다. 이 변경이 각 FilteredRelation이 독립 JOIN을 갖게 만드는 핵심이다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_multiple` — 같은 `book` relation에 `book_title_alice`(`title__contains="Alice"`)와 `book_title_jane`(`title__icontains="Jane"`) 두 `FilteredRelation`을 걸고, `.filter(name="Jane").values("book_title_alice__title", "book_title_jane__title")`로 두 컬럼을 함께 조회.
- **픽스 증명**: name="Jane"인 Author 2명에 대해 Alice 조건은 매칭이 없어 `book_title_alice__title`이 None(빈 문자열을 null로 보는 백엔드면 `""`), Jane 조건은 각각 "The book by Jane A" / "The book by Jane B"가 나와야 한다. 버그 상태에선 두 FilteredRelation이 하나의 JOIN으로 병합돼 두 컬럼이 같은 alias를 공유 → 기대값이 깨진다. 픽스 후 JOIN이 분리되어 각 컬럼이 자신의 condition으로 채워진다. `assertCountEqual`로 순서 무관 비교, 백엔드별 empty/null 차이를 `connection.features.interprets_empty_strings_as_nulls`로 흡수.
- **overfit 관점**: FAIL_TO_PASS는 1개뿐이라 표면상 얇아 보이나, 픽스가 special-case 우회로 통과 가능한 형태가 아니다(특정 입력에만 맞춘 if가 아니라 비교 의미 자체를 고침). 게다가 P2P 41개가 일반 JOIN 재사용 동작을 강하게 고정해 overfit 패치(무조건 새 JOIN 생성 등)는 즉시 깨진다. 따라서 overfit-risk는 낮다.
- **regression 관점**: regression-trap이 핵심. 골드패치는 비-FilteredRelation(else) 경로의 `equals`를 `==`로 바꾸는데, 이를 분기 없이 전역으로 적용하면(또는 FR 경로를 별도로 처리하지 않으면) `test_with_m2m`/`test_with_m2m_multijoin`/`test_without_join`/`test_relation_name_lookup` 등 다수가 깨진다. 골드패치는 `reuse_with_filtered_relation` 플래그로 FilteredRelation 경로를 `can_reuse` 제한 + `equals` 재사용으로 분리하고, `setup_joins`에서 `reuse`를 강제해 41개 P2P를 모두 보존한다.

## 모범답안 (오라클 기반)
이상적 풀이 궤적 4단계:

1. **localize 경로**: 이슈의 "multiple FilteredRelation ... single SQL JOIN ... ignores the other" 신호 → `FilteredRelation`으로 query.py grep → 진입점 `build_filtered_relation_q` 확인 → 그 안의 `build_filter` 호출을 따라 `setup_joins`로, 다시 `setup_joins` 내부의 `self.join(connection, reuse=reuse)`로 내려간다. `join()`의 `reuse_aliases` 컴프리헨션이 "어떤 join을 같다고 보고 재사용할지"를 결정하는 단일 지점 → 여기서 `j.equals(join)`를 발견. `Join.equals()` 정의를 읽어 `filtered_relation`이 비교에서 빠진다는 도메인 사실을 확인하면 근본원인이 잠긴다.

2. **픽스(올바른 일반화인 이유)**: "condition이 다른 FilteredRelation은 서로 다른 JOIN이어야 한다"는 불변식을 코드로 옮긴다. 핵심은 `reuse_with_filtered_relation` 플래그를 도입해 `join/build_filter/setup_joins`에 전파하고, FilteredRelation 경로에서는 `setup_joins`가 `reuse`를 None→`can_reuse`로 강제하여 `join()`이 후보를 `a in reuse and j.equals(join)`(제한된 집합 + loose equals)로 좁히도록 만드는 것이다. 동시에 비-FilteredRelation(else) 경로의 비교는 `equals`에서 더 엄격한 `__eq__`(`j == join`, filtered_relation 포함)로 바꾼다. 이는 특정 테스트 입력에 맞춘 게 아니라 "같은 relation + 다른 condition = 다른 alias"라는 ORM 의미 규칙을 일반적으로 복원하므로 올바른 일반화다.

3. **regression 안전**: P2P 41개 전부가 안 깨져야 한다 — 특히 일반 JOIN/m2m 재사용에 의존하는 `test_with_m2m`, `test_with_m2m_multijoin`, `test_without_join`, `test_multiple_times`, `test_relation_name_lookup`. 플래그를 기본 `False`로 두어 비-FilteredRelation 경로는 기존 `equals` 의미를 보존하고, `setup_joins`의 `reuse = can_reuse if join.m2m or reuse_with_filtered_relation else None`에서 `join.m2m` 분기를 유지해 m2m 재사용을 깨지 않는다.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `j.equals(join)`을 모든 경로에서 무조건 `j == join`으로 치환해 41개를 회귀시키는 것(가장 흔한 실패). 골드패치는 `==`를 비-FilteredRelation(else) 경로에만 적용하고, FilteredRelation 경로는 오히려 `equals`를 유지하되 `can_reuse`로 후보를 좁히는 방식이라, "전역 치환 금지 + 경로 분리"를 추론해야 한다. (b) `join()`만 고치고 `setup_joins`의 `reuse = ... if join.m2m else None`까지 안 엮어 플래그 전파가 끊기는 것 — 이게 진짜 linchpin이다. `reuse`가 None이면 `join()`의 `reuse_with_filtered_relation and reuse` 조건이 False가 되어 FilteredRelation alias가 can_reuse로 제한되지 않아 픽스가 무력화된다. (c) 백엔드별 empty-string-as-null 차이를 무시해 `None` 하드코딩으로 테스트를 좁게 보는 것. 4개 시그니처에 플래그를 일관 배선하고, FilteredRelation 경로는 `can_reuse` 제한, 비-FR 경로는 strict `==`로 분리하는 것이 함정 회피의 핵심이다.
