---
instance_id: django__django-11141
repo: django/django
base_commit: 5d9cf79baf07fc4aed7ad1b06990532a65378155
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-03-28T20:49:53Z
fail_to_pass: 1
pass_to_pass: 24
gold_files: [django/db/migrations/loader.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, underspecified]
---

# django__django-11141

## 문제 요약
Python 3에서 `__init__.py`가 없는 디렉터리는 암묵적 namespace package가 되어 `__file__` 속성이 없다. `MigrationLoader.load_disk`가 마이그레이션 패키지에 대해 `getattr(module, '__file__', None) is None` 체크를 수행하고, 이 경우 곧바로 `unmigrated_apps`로 분류한다. 이 `__file__` 체크는 #21015에서 파일시스템 직접 접근을 위해 도입됐으나, #23406에서 discovery가 `pkgutil.iter_modules(module.__path__)`로 바뀐 뒤로는 불필요해졌다. 결과적으로 namespace package(또는 명시적 namespace package)로 구성된 migrations 디렉터리는 `__path__`는 멀쩡히 가지고 있음에도 "unmigrated"로 잘못 분류되어 마이그레이션이 전혀 로드되지 않는다. 이슈는 이 stale 가드의 제거를 요청한다.

## 유형 (정형화)
- **L0 (Pinpointed)** — problem_statement이 `__file__` 체크, `pkgutil.iter_modules()`, 그리고 #21015/#23406 티켓번호를 직접 명시한다. `migrations/loader.py`에서 `__file__`을 grep하면 `load_disk` 내 단일 블록으로 곧바로 수렴한다. 후보 탐색이 사실상 0이다.
- **S2 (Constraint-Reasoning) +S6 (Design-Refactor)** — 고칠 지점은 명확하지만, `__file__` 가드를 단순 삭제하는 것만으로는 옳지 않다. 삭제하면 "진짜로 빈 migrations 디렉터리"가 `migrated_apps`로 잘못 들어간다(가드가 빈-디렉터리=namespace를 우연히도 unmigrated로 걸러주던 부수효과). 따라서 "패키지가 migrated인가"의 불변식을 `__file__` 존재 → `migration_names`(실제 마이그레이션 모듈) 존재 또는 `self.ignore_no_migrations`로 **재합성**해야 한다(S2). 그리고 이를 위해 `migrated_apps.add()` 호출을 `migration_names` 계산 **이후로 옮기는** 작은 구조 재배치가 필요하다(S6 보조). 이는 G&V로 후보를 난사해 푸는 문제가 아니라, 정확한 조건식을 추론으로 합성하는 SemFix/Angelix 계열이다.
- **K-Domain** — django migrations 로더의 namespace package 의미론, `ignore_no_migrations` 플래그의 역할, `unmigrated_apps` vs `migrated_apps` 분류 규약, `pkgutil.iter_modules`와 `__path__`의 관계를 알아야 올바른 조건을 세울 수 있다. 일반 파이썬 추론만으로는 `ignore_no_migrations`를 조건에 포함시키지 못한다.
- **primary type = T-ConstraintReason** — 위치는 명확(L0)하나 진짜 난점은 "올바른 분류 조건식을 추론으로 합성"하는 데 있다. T-DirectMap(기계적 가드 추가/삭제)으로 보이지만, 단순 삭제는 회귀를 부른다는 점에서 S1이 아니라 S2가 dominant다.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(개발자 구현시간 기준 prior). 구조 피처로 재조정해도 같은 방향이지만 에이전트 관점에서 T4로 미는 이유:
- **파일/줄수는 작다** — 단일 파일 `loader.py`, 헌크 2개, 순삭/순증 합쳐 ~10줄. 이것만 보면 T2~T3.
- **localize는 매우 직접적(L0)** — 이슈가 심볼·티켓번호까지 지목. 이 축은 난이도를 낮춘다.
- **그러나 S2+S6 + regression-trap이 티어를 올린다** — naive한 "`__file__` 한 줄 삭제"가 plausible하지만 incorrect다. 올바른 픽스는 `migration_names or self.ignore_no_migrations` 조건과 `migrated_apps.add()`의 위치 재배치를 동시에 요구한다. PASS_TO_PASS 24개 중 `test_load_empty_dir`, `test_marked_as_unmigrated`, `test_marked_as_migrated` 등 빈/unmigrated 분류 동작을 직접 검증하는 테스트가 다수라 **P2P trap이 넓다**.
- **underspecified** — 이슈는 "`__file__` 체크가 불필요하니 제거하라"고만 하고, 빈 디렉터리 분류 보존이라는 제약은 명시하지 않는다. 그 제약은 도메인지식·기존 테스트로부터 에이전트가 스스로 도출해야 한다.
따라서 L0의 쉬움이 S2+regression-trap+K-Domain에 의해 상쇄되어 T3가 아닌 T4가 적정.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/migrations/loader.py` — `MigrationLoader.load_disk`
- **근본 원인:** `__file__` 가드(`if getattr(module, '__file__', None) is None: ... unmigrated_apps.add(); continue`)는 #21015에서 파일시스템 기반 discovery용으로 도입됐으나, #23406에서 discovery가 `pkgutil.iter_modules(module.__path__)`로 전환되며 obsolete가 됐다. namespace package는 `__path__`는 있고 `__file__`은 없으므로, 이 stale 가드가 정상 namespace migrations를 `unmigrated_apps`로 오분류한다.
- **수정 요지:**
  1. `getattr(module, '__file__', None) is None` 분기(빈 디렉터리=namespace 가정으로 unmigrated 처리)를 **통째로 제거**.
  2. 무조건 호출되던 `self.migrated_apps.add(app_config.label)`을 `migration_names` 집합 계산 **이후로 이동**.
  3. `if migration_names or self.ignore_no_migrations:` 일 때만 `migrated_apps`에, 그 외엔 `unmigrated_apps`에 추가 → "migrated 여부"의 판정 기준을 `__file__` 존재가 아니라 **실제 migration 모듈 존재(또는 ignore_no_migrations)** 로 교체. `not hasattr(module, '__path__')`(패키지 아님: migrations.py) 가드는 그대로 유지.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_loading_namespace_package` — "Migration directories without an __init__.py file are loaded."
- **픽스 증명:** `__init__.py`가 없는 새 fixture `tests/migrations/test_migrations_namespace_package/`(`0001_initial.py`만, `Author` CreateModel)를 `@override_settings(MIGRATION_MODULES=...)`로 지정한 뒤 `MigrationLoader(connection)`를 생성하고 `graph.forwards_plan(('migrations', '0001_initial'))== [('migrations', '0001_initial')]`을 단언한다. 패치 전: namespace package가 `__file__` 가드에 걸려 `unmigrated_apps`로 빠지므로 그래프에 노드가 없어 `forwards_plan`이 KeyError/빈 결과 → 실패. 패치 후: `__path__` 기반으로 정상 로드되어 plan이 채워짐 → 통과.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇아 보이지만, 픽스가 "namespace 특수처리"가 아니라 분류 불변식의 일반화이므로 overfit-risk는 낮다(그래서 플래그에 미포함). special-case로 통과시키는 우회가 어렵다 — fixture는 일반 migration 로드 경로 전체를 탄다.
- **regression 관점:** `regression-trap` 플래그. PASS_TO_PASS 24개가 빈/unmigrated/marked 분류와 squash·prefix·일관성 검사 전반을 커버한다. 단, 새 `migration_names or self.ignore_no_migrations` 분기를 **실제로 통과해 압박하는** P2P는 `test_load_empty_dir`(namespace fixture `migrations.faulty_migrations.namespace`: `__path__`는 있으나 `migration_names`가 비어 `else`로 unmigrated 처리되어야 함)와 `test_marked_as_migrated`(실 migration이 있어 `migration_names` 비어있지 않아 migrated)뿐이다. 반면 `test_marked_as_unmigrated`는 `MIGRATION_MODULES={'migrated_app': None}`이라 `load_disk` 첫 분기 `if module_name is None: self.unmigrated_apps.add(); continue`에서 처리되어 새 분기에 **도달하지 않으며**, `test_explicit_missing_module`(`ignore_no_migrations=True`)은 import 실패가 `(explicit and self.ignore_no_migrations)` 핸들러에서 unmigrated 처리되어 역시 새 분기에 닿지 않는다. 즉 이 둘을 새 분기가 "보존하는" 테스트로 드는 것은 인과 mislocation이다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 `__file__` + `pkgutil.iter_modules` + #21015/#23406 신호 → `django/db/migrations/loader.py`에서 `__file__` grep → `load_disk` 내 `getattr(module, '__file__', None) is None` 블록이 유일 후보(L0). 추가로 같은 함수에서 `migration_names`가 어떻게 모이고 `migrated_apps`/`unmigrated_apps`가 어디서 갈리는지 읽어 분류 흐름을 파악한다.
2. **픽스와 올바른 일반화인 이유:** 단순 삭제가 아니라, "migrated인가"의 정의를 `__file__` 존재에서 **실제 migration 모듈 존재(`migration_names`) 또는 `ignore_no_migrations`** 로 바꾼다. 이는 #23406 이후 discovery가 이미 `__path__` 기반이라는 사실과 정합하며, namespace든 일반 패키지든 동일 규칙을 적용하므로 namespace에 특화된 hack이 아니다 — 올바른 일반화.
3. **regression 안전:** `migrated_apps.add()`를 `migration_names` 계산 뒤로 옮기고 빈 경우를 `unmigrated_apps`로 보내야 `test_load_empty_dir`·`test_marked_as_unmigrated`가 유지된다. `not hasattr(module, '__path__')`(migrations.py = 패키지 아님) 가드와 `ignore_no_migrations` 경로는 손대지 않아 `test_load_module_file`·marked 계열 P2P를 보존한다.
4. **함정 회피:** 오라클 없는 에이전트의 전형적 실패는 **(a)** 이슈 문구 그대로 `__file__` 가드 한 줄만 삭제 → 빈 디렉터리가 migrated로 잘못 분류되어 P2P 회귀. **(b)** `ignore_no_migrations` 플래그를 조건에서 누락 → 골드패치는 이 항을 포함하지만, 나열된 P2P 24개 중 새 분기의 `self.ignore_no_migrations` 항을 실제로 행사하는 테스트는 없다(유일하게 `ignore_no_migrations`를 쓰는 P2P인 `test_explicit_missing_module`은 import 실패 핸들러에서 빠져 새 분기에 닿지 않음). 따라서 이 항은 "명시적 빈 패키지를 `ignore_no_migrations`로 migrated 취급"하는 경우를 위한 정합성 보존이지 listed P2P 회귀를 막는 항이 아니다 — 누락 시 marked 계열이 회귀한다고 보는 것은 인과적으로 부정확하다(이 항을 빼도 나열된 P2P는 통과한다). **(c)** `migrated_apps.add()` 위치 재배치를 빠뜨려 `migration_names`가 비어도 migrated로 표시. **(d)** 재현/검증 시 `__init__.py` 없는 fixture 패키지를 만들어야 한다는 점을 놓침. 회피법: 이슈가 명시 안 한 "빈 디렉터리 분류 보존" 제약을 기존 `test_loader.py`의 unmigrated 계열 테스트에서 역추론하고, 분류 조건을 `migration_names or self.ignore_no_migrations`로 재합성한 뒤 P2P 전체를 돌려 확인한다.
