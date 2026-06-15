---
instance_id: django__django-12708
repo: django/django
base_commit: 447980e72ac01da1594dd3373a03ba40b7ee6f80
version: 3.1
difficulty: 1-4 hours
created_at: 2020-04-12T22:20:59Z
fail_to_pass: 1
pass_to_pass: 101
gold_files: [django/db/backends/base/schema.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-12708

## 문제 요약
동일한 필드 집합에 `unique_together`와 `index_together`가 둘 다 걸려 있을 때, `index_together`만 삭제하는 마이그레이션이 크래시한다. `_delete_composed_index()`가 해당 필드들에 대한 제약을 조회하면 `_uniq`와 `_idx` 두 개가 잡혀 `ValueError: Found wrong number (2) of constraints`가 발생한다. 사용자는 unique는 그대로 둔 채 index만 안전하게 제거되길 기대했고, 실제 시나리오는 `index_together` 선언을 `Options.indexes`로 리팩터하려다 발생했다. problem_statement가 파일·라인·함수·에러 메시지를 모두 직접 명시한다.

## 유형 (정형화)

3축 점수:

- **L0 (Pinpointed)** — problem_statement가 `django/db/backends/base/schema.py`, line 378, `_delete_composed_index()`, 그리고 `ValueError: Found wrong number (2) of constraints` 에러 메시지를 verbatim으로 준다. grep 한 방으로 정확한 함수에 도달. 수정도 단일 파일·단일 헌크(`alter_index_together`)에 국한 — multi-site 조율 없음. 가장 강한 localize 신호.
- **S2 (Constraint-Reasoning) (+S1)** — 위치는 자명하지만 *올바른 필터 조건을 추론으로 합성*해야 한다. 표면 증상은 `_delete_composed_index`가 던지는 "정확히 1개" 카운트 위반인데, 정답은 그 throw 지점을 건드리는 게 아니라 **호출자가 제약 조회 필터를 좁히는 것**이다. "introspection이 unique 제약을 index로도 집계한다"는 불변식을 이해해야 `{'index': True}` → `{'index': True, 'unique': False}`라는 정확한 조건이 도출된다. 일단 그 불변식과 대칭 호출부(`alter_unique_together`의 `{'unique': True}`)를 파악하면 픽스 자체는 한 키 추가라는 기계적(S1) 형태가 되므로 보조로 S1을 표기.
- **K-Domain** — django migrations / schema editor 내부 지식이 병목. unique 제약이 DB introspection 레벨에서 index로 카운트된다는 사실, `_constraint_names`의 메타 필터 시맨틱, 그리고 `alter_unique_together`/`alter_index_together` 한 쌍이 각각 `unique`/`index` 차원에서 대칭으로 좁혀야 한다는 설계 관례 — 모두 프레임워크 내부 지식. 일반 파이썬 추론(K-Gen)으로는 throw 지점을 무마하는 오답으로 빠지기 쉽다.

**Primary type: T-DomainBound** — localize는 L0로 거저 풀리고 픽스 줄 수도 4줄에 불과하다. 진짜 병목은 "어디"가 아니라 django schema-editor의 도메인 불변식(unique⊂index in introspection, 대칭 필터 관례)을 아는지다. S2 추론을 올바른 방향으로 가게 만드는 게 K-Domain이므로 dominant 축은 knowledge. (T-ConstraintReason과 경합하나, 추론의 난점이 일반 제약합성이 아니라 프레임워크 특유 사실에 종속되므로 T-DomainBound가 더 방어적.)

## 난이도 티어
**Tier: T4 (약간 어려움).** 공식 라벨은 "1-4 hours"인데 구조적 피처로 재조정해도 T4에 수렴한다.

- T4로 미는 피처: **K-Domain이 dominant**(루브릭 T4 프로파일 "L1/L2 + ... 또는 K-Domain ... 도메인지식 중 하나"). 단일 파일·4줄이라 scope는 작지만, unique-as-index introspection 불변식을 모르면 정답에 도달 못 한다. 또한 **regression-trap**: PASS_TO_PASS 101개가 전부 `migrations.test_operations`/`test_base`의 인접 동작(`test_alter_index_together`, `test_alter_index_together_remove`, `test_alter_unique_together_remove`, `test_remove_index` 등)이라, 필터를 잘못 넓혀 순수 index-only 삭제 경로나 unique 삭제 경로를 깨면 광범위하게 회귀한다.
- T5로 안 가는 이유: multi-site(L3)도, overfit 고위험(S4)도, 깊은 멀티헌크 design-refactor(S6)도 아니다. 수정은 한 헌크의 dict 한 키.
- T1~T3으로 안 내려가는 이유: L0 + has-repro라 T1/T2의 localize 거저성은 충족하지만, 픽스가 S1 자명(throw 무마/None 가드 류)이 아니다. 도메인 불변식 이해 없이는 오답(throw 지점 완화, try/except 삼킴, `_delete_composed_index` 시그니처 변경)으로 새기 쉬워 T2/T3보다 위. has-repro가 easiness를 끌어내리지만 K-Domain 병목이 그걸 상쇄해 T4 유지.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/backends/base/schema.py` : `BaseDatabaseSchemaEditor.alter_index_together()` (Deleted indexes 루프, line ~393).
- **근본 원인**: `alter_index_together`가 삭제 대상 인덱스에 대해 `self._delete_composed_index(model, fields, {'index': True}, self.sql_delete_index)`를 호출하면서 제약 조회 메타를 `index=True`만으로 지정했다. `_delete_composed_index`는 내부적으로 `_constraint_names(... **constraint_kwargs)`로 매칭되는 제약을 모은 뒤 정확히 1개가 아니면 `ValueError("Found wrong number (N) of constraints ...")`를 던진다. 그런데 DB introspection 상 unique 제약도 index 속성을 만족하므로, 같은 필드 집합 위의 `_uniq` 제약까지 함께 매칭되어 N=2가 되고 "정확히 1개" 불변식이 깨진다.
- **수정 요지**: 조회 메타 딕셔너리를 `{'index': True}` → `{'index': True, 'unique': False}`로 확장(멀티라인 포맷팅으로 펼침). `unique=False`가 추가되어 unique 제약(`unique=True`)은 후보에서 배제되고 순수 index 제약 1개만 남아 정상 삭제된다. 대칭 호출부 `alter_unique_together`는 이미 `{'unique': True}`로 unique 차원을 좁히고 있었으므로, 이 패치로 index 차원도 대칭이 맞춰진다(각 메서드가 자기 차원만 책임지고 상대 제약을 배제).

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_alter_index_together_remove_with_unique_together (migrations.test_operations.OperationTests)` — 같은 필드(`pink`, `weight`)에 `unique_together`와 `index_together`를 모두 건 모델에서 `index_together`만 제거하는 시나리오.
- **픽스 증명**: `set_up_test_model(app_label, unique_together=True)`로 먼저 unique 제약을 만들고 `assertUniqueConstraintExists` 확인 → `AlterIndexTogether('Pony', [('pink','weight')])`로 index 추가 후 `assertIndexExists` 확인 → `AlterIndexTogether('Pony', set())`로 index 제거. 픽스 전이면 이 제거 단계에서 `_delete_composed_index`가 2개 제약을 잡아 `ValueError`로 죽는다. 픽스 후에는 `assertIndexNotExists`(index 사라짐) + `assertUniqueConstraintExists`(unique는 생존)가 통과. `@skipUnlessDBFeature('allows_multiple_constraints_on_same_fields')`로 동일 필드 다중 제약을 지원하는 백엔드(예: PostgreSQL)에서만 실행 — 미지원 백엔드의 false fail을 방지.
- **테스트 헬퍼 보강**: `assertIndexExists`에 `not c['unique']` 조건이 추가되어 unique 제약을 index로 오집계하던 헬퍼 자신의 버그도 교정(테스트가 unique를 index로 세면 픽스를 가려버림). 신규 `assertUniqueConstraintExists` 헬퍼는 unique 제약 생존을 index 검증과 독립적으로 단언.
- **overfit·regression 관점**: FAIL_TO_PASS는 1개로 얇지만(overfit-risk 후보) 픽스 형태가 정확히 도메인 불변식을 좁히는 1키이고 special-case 분기가 아니라 overfit-risk 플래그는 달지 않았다 — special-case로 통과시킬 자유도가 거의 없다. 진짜 안전망은 **regression-trap**: PASS_TO_PASS 101개가 index/unique 변경 경로 전반을 커버하므로, 필터를 잘못 만져 순수 index 삭제나 unique 삭제를 깨면 즉시 잡힌다. `test_alter_index_together_remove`(unique 없는 순수 index 제거)와 `test_alter_unique_together_remove`가 양 끝 회귀 가드 역할.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement가 `django/db/backends/base/schema.py` line 378 `_delete_composed_index()` + `ValueError: Found wrong number (2) of constraints`를 직접 준다 → 해당 파일을 열어 `_delete_composed_index` 정의와 그 호출자 두 곳(`alter_index_together`, `alter_unique_together`)을 동시에 본다. has-repro(2필드 unique+index → index 삭제) 시나리오를 그대로 재현 테스트로 박는다.

2. **픽스와 왜 올바른 일반화인가**: 두 호출자를 나란히 보면 비대칭이 드러난다 — `alter_unique_together`는 `{'unique': True}`로 좁히는데 `alter_index_together`는 `{'index': True}`만 준다. unique 제약이 introspection 상 index로도 카운트되므로 index 삭제 시 `{'index': True}`는 unique까지 끌어와 N=2를 만든다. 따라서 `{'index': True, 'unique': False}`로 unique를 명시 배제한다. 이것이 올바른 일반화인 이유: 각 alter 메서드가 "자기 차원(index/unique)만 책임지고 상대 차원을 배제"하는 대칭 규칙을 완성하는 것이라, special-case가 아니라 누락된 불변식의 복원이다. unique-only, index-only, both 세 조합 전부에서 일관되게 동작한다.

3. **regression 안전**: `test_alter_index_together_remove`(unique 없는 순수 index 제거)는 여전히 통과해야 한다 — `unique: False`는 순수 index 제약(`unique=False`)을 그대로 매칭하므로 안전. `test_alter_unique_together_remove`/`test_alter_unique_together`도 건드리지 않는다(`alter_unique_together` 미수정). 101개 P2P 전반이 migrations operations 회귀 가드. 절대 하지 말 것: `_delete_composed_index`의 카운트 검증 완화나 시그니처 변경 — 다른 모든 composed-index 삭제 경로(FK/unique 포함)의 안전장치를 동시에 약화시켜 광범위 회귀.

4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 오답 — (a) throw 지점(`_delete_composed_index` 내부 ValueError)을 try/except로 삼키거나 카운트 검증을 완화 → 증상 무마, 실제로는 엉뚱한 제약을 지우거나 무음 실패. (b) `_constraint_names` 반환을 후처리로 첫 번째만 취함 → 비결정적, unique를 지울 수 있음. (c) `alter_index_together` 양쪽 루프(삭제/생성) 모두에 unique:False를 뿌림 → 생성 경로는 무관해 불필요. 회피법: "왜 N=2인가"를 introspection이 unique를 index로 집계한다는 도메인 사실로 설명하고, 대칭 호출부 `alter_unique_together`를 참조 패턴으로 삼아 최소 침습(호출자의 조회 필터 1키)으로 수렴한다.
