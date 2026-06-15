---
instance_id: django__django-12965
repo: django/django
base_commit: 437196da9a386bd4cc62b0ce3f2de4aba468613d
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-05-24T13:20:03Z
fail_to_pass: 1
pass_to_pass: 52
gold_files: [django/db/models/sql/compiler.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-12965

## 문제 요약
Django 3.1에서 `Model.objects.all().delete()`가 3.0의 단순한 `DELETE FROM table` 대신 `DELETE FROM table WHERE id IN (SELECT id FROM table)` 형태로 불필요한 서브쿼리를 생성하는 회귀다. 서브쿼리에 alias가 없어 MySQL `LOCK TABLES`와 함께 쓸 수 없고(같은 테이블을 alias 없이 두 번 참조 불가), 10만 행 기준 0.2초 → 7.5초의 성능 저하를 일으킨다. PR #11931 / #23576에서 유입된 회귀이며, 사용자는 필터 없는 단일 테이블 풀 delete에서 3.0처럼 평면 DELETE가 나오길 기대한다.

## 유형 (정형화)

- **L (Localization) = L1 (Traceable)**: problem_statement가 생성 SQL과 `delete()`를 직접 지목하고 hints_text가 "single alias일 때 query를 막을 수 있어야 한다"고 거의 심볼급으로 가리킨다. 다만 `delete()` 진입점에서 `SQLDeleteCompiler.single_alias`까지는 `Collector.delete()` → fast-delete → compiler로 한두 홉 추적이 필요해 L0(grep 한 방)는 아니다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning) + S5 (Spec-Inference)**: 고칠 메서드(`single_alias`)는 비교적 쉽게 좁혀지나, 픽스의 본질은 `alias_refcount` 합이 "왜 0인지"를 추론하고 — 필터 없는 쿼리는 base alias가 `alias_map`에 아직 lazy-populate 되지 않았다는 불변식을 따져 — `get_initial_alias()`로 alias를 강제 등록해야 카운트가 1이 되는 올바른 조건을 합성하는 데 있다(S2). 동시에 "단일 테이블 풀 delete는 평면 DELETE여야 한다"는 의도된 동작은 코드만으론 결정되지 않고 이슈 본문(3.0 vs 3.1 SQL 대조)에서 스펙을 재구성해야 하므로 S5가 보조로 붙는다. 후보를 여러 개 찍어 테스트로 거르는 G&V(S3/S4)가 아니라 alias lifecycle을 "생각으로" 푸는 semantic repair다.
- **K (Knowledge) = K-Domain**: `alias_refcount` / `alias_map` / `get_initial_alias` 의 lazy alias population 시맨틱은 django query-compiler 내부 지식이다. 일반 파이썬 추론으로는 "refcount 합이 0"의 의미를 못 짚는다.

**Primary type = T-ConstraintReason**: 위치는 명확히 좁혀지지만 진짜 난점이 "올바른 조건을 추론으로 합성"(alias가 채워지지 않은 게 원인 → 채워 넣어 단일-alias 판정 복원)에 있어, T-ConstraintReason이 dominant. localize가 본질이 아니므로 T-DiffuseLoc이 아니고, 기계적 가드/기본값 변경(S1)이 아니므로 T-DirectMap도 아니다.

## 난이도 티어
**Tier = T4 (약간 어려움)**.
구조적 피처: 단일 파일·단일 메서드·실질 2줄 수정이라 patch scope 자체는 작지만(T2~T3 신호), 이 티어로 미는 요인은 (1) **K-Domain**: query-compiler의 alias refcount/lazy population 시맨틱 이해가 병목, (2) **S2 constraint-reasoning**: "왜 refcount가 0인가"를 진단해야 하며 표면적으로는 `_as_sql`이나 `Collector`를 고치려는 오판이 쉽다, (3) **regression-trap**: PASS_TO_PASS 51개가 fast-delete/cascade/restrict/inheritance 등 인접 delete 동작 전반이라 alias 강제 등록이 조인/멀티테이블 경로의 판정을 깨면 광범위하게 회귀한다.
완화 요인: `has-repro`(이슈에 3.0 vs 3.1 SQL과 MySQL 재현 시퀀스가 명시 — 가장 강한 easiness 신호)와 단일파일 소규모 patch가 T5로 가지 않게 막는다.
공식 라벨("15분-1시간", T2~T3 prior)보다 한 단계 높게 본 이유: 시간 라벨은 "정답을 아는 개발자의 구현시간"이라 2줄 추가가 빠르지만, 오라클 없는 에이전트 관점에서는 alias가 채워지지 않은 게 근본원인임을 진단하는 도메인 추론 비용과 P2P trap이 시간 라벨에 잡히지 않는다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/sql/compiler.py` 의 `SQLDeleteCompiler.single_alias` (`@cached_property`).
- **근본 원인**: `single_alias`는 `sum(self.query.alias_refcount[t] > 0 for t in self.query.alias_map) == 1` 로 활성 alias가 정확히 1개인지 세서, 1개면 평면 `DELETE FROM`(`_as_sql`), 아니면 subquery 경로를 탄다. 그런데 `Model.objects.all()`처럼 필터/조인이 없는 쿼리는 base 테이블 alias가 `alias_map`에 lazy하게 아직 등록되지 않아 refcount 합이 0이 되고, `== 1`이 False가 되어 단일 테이블인데도 불필요한 subquery 경로로 빠졌다.
- **수정 요지**: `single_alias` 계산 직전에 `self.query.get_initial_alias()`를 호출(+ "Ensure base table is in aliases." 주석 1줄)해 base 테이블 alias를 강제로 `alias_map`에 채운다. 이로써 단일 테이블 풀 delete에서도 alias 카운트가 1이 되어 평면 `DELETE FROM table` 경로가 선택되고 3.0 동작이 복원된다. 실질 추가 2줄.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_fast_delete_all (delete.tests.FastDeleteTests)`.
- **픽스 증명**: 테스트는 `User.objects.all().delete()`를 `assertNumQueries(1)`로 감싸 쿼리가 정확히 1개만 나가는지 확인하고, 캡처된 SQL(`ctx.captured_queries[0]['sql']`)에 `assertNotIn('SELECT', sql)`로 subquery 부재를 단언한다. 픽스 전: `... WHERE id IN (SELECT ...)` → SELECT 포함 → 실패. 픽스 후: 평면 `DELETE FROM` → 통과.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 단언이 "쿼리 수 1 AND SELECT 미포함"의 동작 불변식이라 special-case 통과가 어렵다. 다만 `single_alias`를 항상 True로 강제하는 식의 잘못된 일반화는 이 테스트만으론 못 걸러진다(아래 P2P가 그 가드 역할).
- **regression 관점**: PASS_TO_PASS 51개(`test_fast_delete_fk/m2m/inheritance/joined_qs/large_batch`, `OnDeleteTests` cascade/restrict/setnull 전반, `DeletionTests` bulk/large_delete 등)가 조인·멀티테이블·필터 있는 delete 경로의 판정이 그대로 유지되는지 보장한다. `get_initial_alias()`는 alias_map에 base alias를 "존재"시킬 뿐 멀티-alias 쿼리의 카운트를 1로 만들지 않으므로, 이들 경로의 subquery 선택은 보존된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "3.1이 `WHERE id IN (SELECT ...)`를 생성" + hints_text의 "single alias일 때 query를 막을 수 있어야"가 신호. `delete()` → `Collector.delete()` → fast-delete 분기 → `SQLDeleteCompiler`로 좁히고, "single alias"라는 단어가 `single_alias` cached_property를 거의 직접 지목한다. SQL을 실제로 찍어 3.0 평면 DELETE vs 3.1 subquery를 대조해 분기점이 `single_alias` 판정임을 확정.
2. **픽스와 왜 올바른 일반화인가**: 근본원인은 `_as_sql`/`Collector`가 아니라 `single_alias`의 입력 데이터(`alias_map`이 비어 있음)다. `get_initial_alias()`로 base alias를 등록하면 필터 없는 단일 테이블에서 카운트가 1이 되어 평면 경로 복원. 이는 "필터 없는 쿼리는 base alias가 lazy하게 미등록"이라는 일반 사실을 고치는 것이라 `all().delete()`뿐 아니라 base만 참조하는 모든 단일 테이블 delete에 일반화된다 — 특정 테스트 입력에 맞춘 special-case가 아니다.
3. **regression 안전**: `get_initial_alias()`는 멱등하게 base alias만 보장하고 조인 alias의 refcount를 건드리지 않으므로, fk/m2m/inheritance/joined_qs 등 멀티-alias 경로는 여전히 카운트>1 → subquery를 탄다. 51개 P2P(특히 `test_fast_delete_joined_qs`, `test_fast_delete_combined_relationships`)가 이 경계를 지킨다. 따라서 "subquery를 무조건 끄는" 식의 광폭 수정은 금물.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답은 (a) 증상이 SQL이라 `_as_sql`/`as_sql`을 직접 패치하려 들기, (b) `single_alias`를 단순히 `True`로 바꾸거나 subquery 분기를 제거해 멀티테이블 delete를 깨기, (c) `Collector` 레벨에서 fast-delete 조건을 바꾸기. 회피법: alias 카운트가 "왜 0인지"를 먼저 진단(필터 없으면 alias 미등록)하고, 분기 로직이 아니라 그 분기의 입력(alias_map 채움)을 고친다. SQL을 직접 캡처해 멀티테이블 케이스가 여전히 subquery를 쓰는지 확인하면 (b)/(c) 과잉수정을 즉시 잡아낸다.
