---
instance_id: django__django-11490
repo: django/django
base_commit: a7038adbd02c916315b16939b835f021c2ee8880
version: 3.0
difficulty: <15 min fix
created_at: 2019-06-19T07:47:46Z
fail_to_pass: 1
pass_to_pass: 23
gold_files: [django/db/models/sql/compiler.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-11490

## 문제 요약
`union()`(및 intersection/difference) 등으로 합성한 QuerySet에서 `values()`/`values_list()`로 컬럼 목록을 지정해 **같은 합성 쿼리를 여러 번 평가**하면, 두 번째 이후의 컬럼 목록 변경이 반영되지 않는다. problem_statement의 재현:

```
>>> ReservedName.objects.create(name='a', order=2)
>>> qs1 = ReservedName.objects.all()
>>> print(qs1.union(qs1).values_list('name', 'order').get())   # ('a', 2)
>>> print(qs1.union(qs1).values_list('order').get())           # ('a', 2)  ← 기대: (2,)
```

두 번째 호출은 `order` 한 컬럼만 선택했는데도 첫 평가에서 박힌 `('name', 'order')`가 그대로 나온다. 이슈는 친절하게 `compiler.py#L428-L433`을 직접 지목한다.

## 유형 (정형화)
- **L0 (Pinpointed)** — 이슈 본문이 `compiler.py#L428-L433`이라는 파일+라인 포인터를 직접 박아준다. grep 없이 `get_combinator_sql`의 해당 블록으로 즉시 진입. 가장 강한 localize 신호.
- **S2 (Constraint-Reasoning) +S6 (Design-Refactor)** — 고칠 *지점*은 자명하지만, 올바른 픽스는 "in-place로 set_values 하지 말고 복제본에 적용"이라는 **불변식 추론**이 본질이다. 패치 자체는 `compiler.query = compiler.query.clone()` 한 줄이라 G&V(S3)처럼 테스트를 돌려가며 후보를 뽑는 문제가 아니라, "왜 공유 객체 mutation이 평가 간 오염을 일으키나"를 **생각으로** 풀어야 한다(SemFix 계열). +S6은 픽스의 형태가 단순 가드/상수 변경(S1)이 아니라 mutate-shared → clone-then-mutate라는 작은 lifecycle/소유권 재배치이기 때문.
- **K-Domain** — django ORM 내부 모델(SQLCompiler, combined query의 하위 컴파일러가 `compiler.query`를 **공유·재사용/캐시**한다는 사실, `Query.clone()`의 의미론)을 알아야 픽스가 도출된다. 일반 파이썬 추론(K-Gen)만으로는 "여기서 clone이 필요하다"가 안 나온다 → 도메인 지식이 병목.

**primary type = T-DomainBound**: 위치는 L0로 거의 공짜지만, 정답을 가르는 병목은 "ORM combinator 내부에서 하위 쿼리 객체가 공유/캐시된다"는 프레임워크 내부지식이다. T-DirectMap(S1 기계적 가드)이 아닌 이유는 픽스가 정형 결함클래스 템플릿에 매칭되지 않고 도메인 불변식 추론을 요구하기 때문이며, T-DiffuseLoc이 아닌 이유는 localize가 전혀 어렵지 않기 때문이다. dominant 병목이 K-Domain이라 T-DomainBound가 정확.

## 난이도 티어
**T4 (약간 어려움)**.

이 티어로 미는 구조적 피처:
- **K-Domain이 dominant** — 루브릭 T4 프로파일이 "constraint추론·소규모 refactor·도메인지식 중 하나"인데, 본 문제는 그 셋(S2·S6·K-Domain)을 동시에 충족한다.
- **regression-trap (P2P 23개)** — PASS_TO_PASS가 combinator 동작 전반(simple_union/union_distinct/intersection_with_values/difference_with_values/two_annotated_values_list/extra_and_values_list 등 23개)을 광범위하게 커버한다. `set_values`/`values_select` 비교 조건이나 `clone` 위치를 잘못 손대면 인접 combinator 경로가 줄줄이 깨진다 → 픽스의 *형태*는 작아도 안전 영역이 좁다.
- localize 직접성과 줄수만 보면 T1~T2처럼 보이지만, 정답이 "공유 객체 mutation"이라는 비자명 근본원인 위에 서 있어 단순 가드 추가로는 안 풀린다.

**공식 라벨(`<15 min fix`)과의 차이**: 공식 라벨은 *정답을 아는 코어 개발자의 구현시간*(한 줄 clone 삽입)이라 15분 미만이 맞다. 하지만 그 시간라벨은 (a) 근본원인이 ORM 도메인지식(공유 하위쿼리 캐시)이라는 점, (b) 23개 P2P regression-trap을 안 깨야 하는 제약을 잡지 못한다. 오라클 없는 에이전트 관점에서 minimal-fix를 분별하는 인지부하가 시간라벨보다 높아 T4로 올린다(T3로 내리지 않는 이유는 K-Domain+regression-trap 결합).

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/sql/compiler.py` → `SQLCompiler.get_combinator_sql`
- **근본원인**: combined query의 각 하위 컴파일러가 보유한 `compiler.query`는 합성 쿼리 평가 간 **공유·재사용**되는 객체다. 기존 코드는 `if not compiler.query.values_select and self.query.values_select:` 분기에서 그 공유 객체에 대해 `compiler.query.set_values((*self.query.extra_select, *self.query.values_select, ...))`를 **in-place로** 호출했다. 첫 평가에서 set_values로 박힌 컬럼 목록이 원본 하위쿼리에 영구히 남고, `values_select`가 이미 채워졌으므로 다음 평가에서는 `not compiler.query.values_select` 가드에 걸려 새 컬럼 목록이 무시된다. 결과적으로 두 번째 `values_list('order')`가 첫 번째의 `('name','order')`를 그대로 반환.
- **수정요지**: `set_values` 호출 직전에 `compiler.query = compiler.query.clone()` 한 줄을 삽입. 이로써 원본 하위쿼리를 건드리지 않고 **평가마다 fresh한 복제본**에만 `set_values`를 적용한다. 각 평가가 독립적인 컬럼 선택 상태를 갖게 되어 재평가 시 새 values_list 컬럼이 올바르게 반영된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_union_with_values (queries.test_qs_combinators.QuerySetSetOperationTests)`
- **동작/픽스 증명**: 기존 `test_union_with_values`에 단언 1줄을 추가한다 — 같은 합성 쿼리에서 `qs1.union(qs1).values_list('order').get()`이 `(2,)`여야 한다(`# List of columns can be changed.`). 이는 앞선 `values('name','order')`·`values_list('name','order','id')` 평가들과 **동일 테스트 메서드 내**에서 순차 실행되므로 "컬럼 목록 변경 가능"을 직접 검증한다. 패치 전: 첫 평가가 하위쿼리에 `name,order`를 박아 `('a', 2)` 반환 → 단언 실패. clone 추가 후: 복제본에만 `order`가 적용되어 `(2,)` 반환 → 통과.
- **overfit 관점**: FAIL_TO_PASS가 단 1개라 얇아 보이지만, 같은 메서드 안에서 *여러 컬럼 조합을 연쇄*로 평가하므로 special-case clone(특정 컬럼만 처리)으로는 통과할 수 없다 → overfit 여지가 작다. 그래서 `overfit-risk` 플래그는 붙이지 않았다. clone 한 줄은 본질적으로 일반적 픽스라 미검증 입력공간을 자연히 커버.
- **regression 관점**: P2P 23개가 union/intersection/difference × values/values_list/annotated/extra의 거의 모든 조합을 커버한다. clone은 새 객체를 set_values 대상으로만 바꿀 뿐 SQL 생성·컬럼 스프레드(`extra_select`/`values_select`) 로직은 그대로 두므로 이 23개를 안전하게 보존한다 → `regression-trap`은 실재하나 골드패치는 회피.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `compiler.py#L428-L433`을 직접 지목 → `django/db/models/sql/compiler.py`의 `SQLCompiler.get_combinator_sql`로 직행. 증상이 `union()` 합성 쿼리에서만, 그리고 *재평가*에서만 발생한다는 점으로 `if not compiler.query.values_select and self.query.values_select:` 블록의 `set_values` 호출을 즉시 용의선상에 올린다.
2. **픽스와 올바른 일반화**: 근본원인은 "공유 하위쿼리 객체에 대한 in-place set_values가 평가 간 상태를 오염"이다. 올바른 일반화는 mutation 직전 `compiler.query = compiler.query.clone()`으로 **복제본에만 변형을 가두는 것**. 이는 특정 컬럼/특정 combinator에 한정되지 않고 "공유객체를 mutate하지 말고 clone-then-mutate"라는 보편 불변식이라 overfit이 아니다. 가드 조건(`not values_select`)을 손대거나 캐시 무효화로 우회하면 더 광범위한 회귀를 부른다.
3. **regression 안전**: P2P 23개 combinator 테스트(simple_union, union_distinct, intersection/difference_with_values, two_annotated_values_list, extra_and_values_list, ordering_by_f_expression 등)를 깨면 안 된다. clone은 set_values 대상 객체만 교체하고 SQL 컬럼 생성·스프레드 로직과 가드 조건을 그대로 두므로 이들이 보존된다 — 핵심은 "변경 표면을 한 줄로 최소화"하는 것.
4. **함정 회피**: 오라클 없는 에이전트는 (a) 증상만 보고 가드 조건 `if not compiler.query.values_select ...`를 바꾸거나, (b) set_values의 컬럼 스프레드 자체를 의심하거나, (c) 외부 QuerySet 캐싱 레이어를 무효화하려는 *과한 수정*으로 흐르기 쉽다. 이를 피하려면 "하위쿼리 객체가 평가 간 공유/재사용된다"는 ORM 도메인 사실을 먼저 확인하고, in-place mutation 지점만 clone으로 격리하는 minimal-fix를 분별해야 한다. 인접 코드(`extra_select`/`values_select` 스프레드)는 건드리지 않는다.
