---
instance_id: django__django-16819
repo: django/django
base_commit: 0b0998dc151feb77068e2387c34cc50ef6b356ae
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-05-01T15:20:04Z
fail_to_pass: 1
pass_to_pass: 38
gold_files: [django/db/migrations/operations/models.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, underspecified]
---

# django__django-16819

## 문제 요약
마이그레이션 연산을 최적화할 때 `AddIndex` 뒤에 같은 인덱스에 대한 `RemoveIndex`가 오면 두 연산이 서로를 상쇄하므로 둘 다 reduce되어 사라져야 한다. 현재 optimizer는 이 쌍을 줄이지 못해 "추가했다 바로 지우는" 불필요한 연산 쌍이 마이그레이션에 그대로 남는다. 기대 동작은 해당 입력이 빈 리스트(`[]`)로 최적화되는 것. 이슈 본문은 단 두 줄("We should reduce AddIndex/RemoveIndex operations when optimizing")로, *무엇을* 원하는지만 말하고 *어디에 어떤 조건으로* 구현해야 하는지는 명시하지 않는다.

## 유형 (정형화)

- **L1 (Traceable)** — 이슈가 `AddIndex`/`RemoveIndex`라는 심볼은 직접 지목하지만, 정작 픽스가 들어갈 지점은 "optimizer가 연산 상쇄를 어떻게 호출하는가"라는 메커니즘 이해를 거쳐야 수렴한다. 키워드(`AddIndex`, `RemoveIndex`, `optimizing`)로 `operations/models.py` + `MigrationOptimizer`로 좁혀지지만, "어느 클래스의 어느 메서드(`reduce`)냐"는 약간의 탐색이 필요. grep 한 방의 L0는 아니다.
- **S2 (Constraint-Reasoning) +S1** — 픽스 위치를 잡은 뒤 핵심은 *올바른 상쇄 조건식*을 추론으로 합성하는 것이다: `isinstance(operation, RemoveIndex) and self.index.name == operation.name`. 비교 키가 `operation.index`가 아니라 `operation.name`이라는 점(`RemoveIndex`는 Index 객체가 아니라 이름 문자열만 보유), 그리고 `model_name`을 추가로 비교하면 *안 되는* 점(optimizer가 이미 동일 모델 범위 내에서만 인접 reduce를 시도하므로)은 불변식·도메인 계약을 따져야 결정된다. 결과 코드량은 5줄로 작아 S1(template: "AddX+RemoveX→상쇄")의 형태도 강하게 띠지만, 조건식의 정확성이 단순 가드 삽입을 넘어서므로 S2가 dominant.
- **K-Domain** — django migrations optimizer 내부 계약(`Operation.reduce(operation, app_label)` 프로토콜, optimizer가 인접 연산을 어떻게 짝짓고 `[]` 반환의 의미가 "둘 다 제거"라는 약속)을 알아야 픽스가 가능하다. 일반 파이썬 추론(K-Gen)만으로는 `reduce` 시맨틱과 `RemoveIndex.name` vs `AddIndex.index` 비대칭을 도출할 수 없다. 이것이 진짜 병목 → **primary type = T-DomainBound**.

primary type 근거: 위치는 비교적 명확하고(L1) 코드도 짧지만, 정답을 막는 결정적 요인은 "django optimizer의 reduce 관례"라는 프레임워크 내부지식이다. 따라서 T-ConstraintReason이 아니라 K-Domain이 dominant인 **T-DomainBound**. repair strategy를 S2로 잡은 이유(APR 관점): 테스트를 여러 번 돌려 후보를 고르는 G&V(S3)가 아니라, 선례(`AddField.reduce`, `RenameIndex.reduce`)의 불변식을 읽고 조건식을 *생각으로* 합성해 단번에 맞히는 SemFix/Angelix류 semantic repair에 해당한다.

## 난이도 티어
**T3 (중간).** 공식 라벨은 "15 min - 1 hour"(T3~T4 경계). 구조적 피처로 재조정:

- **파일 1개 / +5줄 / 단일 헌크** → patch scope는 T1~T2급으로 매우 작다. 이 축만 보면 쉽다.
- **localize 직접성은 L1** → 이슈가 심볼은 줬지만 "어느 클래스의 `reduce`"인지는 메커니즘 탐색이 필요. T1(L0+자명)은 아님.
- **repro 없음** → `has-repro` 미충족. 네이티브 스택트레이스/재현코드 없이 "should reduce"라는 요구만 있어, 가장 강한 easiness 신호가 빠져 티어를 위로 민다.
- **K-Domain 병목** → reduce 프로토콜·`RemoveIndex.name` 비대칭이라는 도메인지식이 정답을 게이팅. 루브릭상 K-Domain이 dominant면 최소 T4 후보지만, 코드량이 극소이고 선례가 코드베이스에 풍부(`AddField`/`AlterField`/`RenameIndex`의 `reduce`)해 패턴 이식이 직선적이라 T4까지 가지 않는다.
- **underspecified** → 2줄짜리 이슈. 의도는 명확하나 구현 명세는 비어 있어 스펙을 코드 관례에서 메워야 함(티어 상향 요인이지만 의미상 자명해 약하게 작용).

따라서 공식 라벨의 상단(1h 근처)보다는 약간 낮은 **T3**가 적정. 작은 patch scope가 K-Domain·no-repro의 상향 압력을 상쇄해 T3에 안착. 공식 difficulty와 큰 괴리는 없으며, 차이가 있다면 "구현 난이도는 낮으나 reduce 관례 지식 게이팅 + repro 부재"를 시간라벨이 일부 과대평가한 정도.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/migrations/operations/models.py` — `AddIndex` 클래스에 `reduce(self, operation, app_label)` 메서드 신규 추가(`migration_name_fragment` 프로퍼티 바로 뒤, `RemoveIndex` 클래스 정의 직전).
- **근본 원인:** `MigrationOptimizer`는 각 연산의 `reduce(operation, app_label)`를 호출해 뒤따르는 연산과 상쇄·병합 가능한지 묻는다. `AddIndex`에는 이 메서드 오버라이드가 없어 기본 `Operation.reduce`만 타고, 그 기본 구현에는 "동일 인덱스를 지우는 `RemoveIndex`와 상쇄" 규칙이 없다. 결과적으로 `AddIndex` 직후 같은 인덱스 `RemoveIndex`가 와도 두 연산이 모두 보존되어 최적화 누락(silent inefficiency).
- **수정 요지:**
  ```python
  def reduce(self, operation, app_label):
      if isinstance(operation, RemoveIndex) and self.index.name == operation.name:
          return []
      return super().reduce(operation, app_label)
  ```
  뒤 연산이 `RemoveIndex`이고 인덱스 이름이 일치(`self.index.name == operation.name`)하면 `[]`를 반환해 두 연산을 모두 제거. 그 외에는 `super().reduce(...)`로 위임해 기존 동작 보존. 비교 키가 `operation.name`인 이유: `RemoveIndex`는 Index 객체가 아니라 이름 문자열만 들고 있음. `model_name` 비교를 생략한 이유: optimizer가 이미 동일 모델 범위에서만 인접 reduce를 시도하므로 중복 가드.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_add_remove_index` (`migrations.test_optimizer.OptimizerTests`). `assertOptimizesTo([AddIndex("Pony", Index(fields=["weight","pink"], name="idx_pony_weight_pink")), RemoveIndex("Pony", "idx_pony_weight_pink")], [])` — 추가+제거 쌍이 빈 리스트로 최적화됨을 단언.
- **픽스 증명:** 픽스 전에는 `AddIndex`가 기본 `reduce`만 타 두 연산이 그대로 남아 결과 길이가 0이 아님 → 단언 실패. 픽스 후 `AddIndex.reduce`가 `RemoveIndex` + 이름 일치를 보고 `[]`를 반환 → optimizer가 두 연산을 모두 제거 → 빈 리스트로 통과.
- **overfit 관점:** FAIL_TO_PASS가 단 1개로 얇아 표면적으로 `overfit-risk` 우려가 있으나, 골드 픽스는 special-case가 아니라 `isinstance(...) and name==name`이라는 *일반 규칙*이라 임의 입력에도 정확. CEGIS(S4)식 과소명세 함정은 아니다(테스트 통과를 위해 하드코딩할 여지가 없음). 따라서 overfit-risk 플래그는 부여하지 않음.
- **regression 관점:** 38개 PASS_TO_PASS가 인접 동작 보호. 특히 `test_rename_index`, `test_alter_alter_index_model`, `test_create_alter_index_*` 계열이 다른 인덱스/필드 최적화 경로가 깨지지 않음을 보장. `else: super().reduce(...)` 위임이 비-RemoveIndex·이름 불일치 케이스에서 기존 동작을 byte-identical하게 유지하므로 회귀 표면이 작다 → `regression-trap`은 광범위 P2P(38개) 때문에 표기하되, 골드 구조상 실제 위험은 낮음.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈의 "reduce AddIndex/RemoveIndex when optimizing" → 키워드 `AddIndex`/`RemoveIndex`로 `django/db/migrations/operations/models.py` 진입. 동시에 "optimizing"이 `MigrationOptimizer`의 reduce 프로토콜을 가리킴을 인지. 코드베이스에서 기존 상쇄 선례(`AddField.reduce`가 `RemoveField`를 흡수, `RenameIndex.reduce`)를 grep해 "먼저 오는 연산 쪽에 `reduce`를 단다"는 Django 관례를 확인 → 픽스 지점을 `AddIndex` 클래스로 확정.

2. **픽스와 일반화 정당성:** `AddIndex`에 `reduce`를 추가하고, 뒤 연산이 `RemoveIndex`이며 `self.index.name == operation.name`일 때 `[]` 반환. 이것이 올바른 일반화인 이유 — (a) 조건이 special-case 하드코딩이 아니라 "같은 이름 인덱스를 추가 후 제거"라는 의미적 불변식; (b) `operation.name`을 비교 키로 쓴 것은 `RemoveIndex`의 실제 데이터 모델(이름 문자열 보유)과 일치; (c) 그 외 케이스는 `super().reduce()` 위임으로 기존 시맨틱 보존. 임의의 추가/제거 조합에도 정확히 동작.

3. **regression 안전:** 38개 P2P 중 `test_rename_index`, `test_alter_alter_index_model`, `test_create_alter_index_field/delete_model`이 "다른 인덱스 또는 비-상쇄 인덱스 연산"이 영향받지 않음을 검증. 핵심은 `if` 가드를 좁게(이름 일치 + `RemoveIndex` 타입) 두고 나머지를 super로 흘려보내, 인접 인덱스/필드 최적화 경로를 건드리지 않는 것.

4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) **방향 오류:** 상쇄 로직을 `RemoveIndex`에 넣으려다 헤맴. 선례(`AddField`→`RemoveField` 흡수)를 먼저 보면 "먼저 오는 연산에 `reduce`"가 관례임이 드러남. (b) **비교 키 오류:** `self.index == operation.index`로 비교하려다 `AttributeError`(`RemoveIndex`에 `index` 없음) — `operation.name`을 봐야 함. (c) **과도한 조건:** `model_name`까지 비교 추가 시 테스트는 통과하나 optimizer가 이미 모델 범위를 보장하므로 불필요·패턴 불일치. (d) **반환값 오류:** `[]`(둘 다 제거)가 아니라 한쪽만 반환하면 상쇄 시맨틱 위반. 정답은 빈 리스트로 "두 연산 모두 소거"를 표현.
