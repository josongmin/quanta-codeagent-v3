---
instance_id: django__django-16662
repo: django/django
base_commit: 0eb3e9bd754e4c9fac8b616b705178727fc8031e
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-03-18T18:07:18Z
fail_to_pass: 1
pass_to_pass: 51
gold_files: [django/db/migrations/writer.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-16662

## 문제 요약
`makemigrations`로 생성되는 마이그레이션 파일의 import가 모듈 이름순으로만 정렬되어, `import ...` 문과 `from ... import ...` 문이 뒤섞인다. 예: `import datetime` / `from django.db import migrations, models` / `import time` 순으로 나온다. Django 코딩 스타일과 isort 기본값은 각 섹션에서 모든 `import module` 문을 `from module import objects` 문보다 앞에 두도록 요구하므로, 생성된 마이그레이션이 isort 검사를 실패한다. 사용자는 `import datetime` / `import time` / `from django.db import migrations, models` 처럼 `import` 문이 먼저, `from` 문이 나중에 오는 정렬을 기대한다. problem_statement에 before/after 출력 예시가 그대로 적혀 있어 사실상 재현 케이스를 명시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement이 "New migration files are generated", "imports sorted by module"라는 강한 포인터를 준다. `grep`으로 `sorted(imports`, `i.split()`, 또는 `MigrationWriter`/`as_string`을 찾으면 단번에 `writer.py`의 단일 정렬 라인에 도달한다. cross-module 추적 불필요, 후보 1곳.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 위치(정렬 키)는 자명하지만, 픽스는 상수/기본값 교체 같은 기계적 작업이 아니다. "import는 먼저, from은 나중, 그룹 내부는 모듈명순 유지"라는 **2-단계 순서 불변식을 정렬 키로 정확히 인코딩**해야 한다. 부등호 방향(`== "from"` vs `!= "from"`)과 튜플 1차/2차 키 구성을 추론으로 맞춰야 통과하므로 S1(Direct-Map)이 아닌 S2다. 후보를 마구 던져 테스트로 거르는 G&V도 아니다 — "생각으로" 키를 합성하는 전형적 semantic repair.
- **K (Knowledge) = K-Domain**: 정렬 로직 자체는 일반 파이썬이지만, "어디를 고치면 생성 import 순서가 바뀌는가"는 django migrations writer(`as_string`이 imports를 모아 직렬화하는 파이프라인)와 isort/Django 코딩 스타일 규약 지식에 의존한다. 순수 K-Gen으로 보기엔 프레임워크 코드 생성 맥락이 본질.
- **Primary type = T-ConstraintReason**: 위치는 명확(L0)하나 dominant 난점이 S2의 "올바른 정렬 식 합성"에 있다. T-DirectMap이 아닌 이유는 픽스가 단일 상수/가드 추가가 아니라 정렬 키의 구조(튜플)와 비교 방향을 의미적으로 추론해야 하기 때문이다.

## 난이도 티어
**Tier = T2 (쉬움)**. 공식 difficulty 라벨은 "15 min - 1 hour"(T3급 prior)지만, 구조적 피처로 재조정하면 T2가 맞다:
- **파일/줄수**: 1파일 `django/db/migrations/writer.py`, 실질 1라인 변경(정렬 호출만 2-튜플 키로 교체). 1파일·<5줄은 가장 쉬운 구조 컷.
- **localize 직접성**: L0 — 이슈가 키워드와 before/after 출력을 모두 줘서 grep 한 방. localization 에러 위험이 거의 없다.
- **repro**: has-repro — problem_statement에 잘못된 출력과 기대 출력이 명시되어 픽스 정오답을 즉시 판별 가능(가장 강한 easiness 신호).
- **추론 부담**: 가벼운 엣지 추론(boolean 정렬 키의 우선순위 + 2차 키 보존)만 필요. constraint-reasoning이 있지만 작은 규모.
- **T2를 넘기지 않는 이유 / regression-trap 주의**: PASS_TO_PASS 51개 중 다수가 `test_serialize_*` 직렬화 스냅샷이라 import 정렬을 깨면 인접 동작이 무너질 수 있다. 다만 2차 키로 모듈명을 보존하는 정답은 기존 그룹 내부 순서를 그대로 유지하므로 trap이 현실화되지 않는다. P2P가 넓어 잠재 regression-trap 플래그는 달지만, 정답 패치 형태가 안전해 T4로 밀 정도는 아니다.
- 공식 라벨이 더 높게 잡힌 건 "개발자 구현·PR 왕복 시간"(티켓 논의, 코딩 스타일 합의)을 반영하기 때문이고, 에이전트 관점의 localize+픽스 난이도는 낮다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/migrations/writer.py` : `MigrationWriter.as_string()`
- **근본 원인**: import 목록을 `sorted(imports, key=lambda i: i.split()[1])` 즉 "두 번째 토큰(모듈명)" 단일 키로만 정렬했다. `import datetime`의 두 번째 토큰은 `datetime`, `from django.db import ...`는 `django.db`, `import time`은 `time` → 모듈명 알파벳순으로 섞여 정렬되어 `import`/`from` 구문 종류 구분이 완전히 무시된다.
- **수정 요지**: 정렬 키를 2-튜플 `(i.split()[0] == "from", i.split()[1])`로 변경.
  - 1차 키 `i.split()[0] == "from"`: 순수 `import` 문이면 `False(=0)`, `from ... import ...` 문이면 `True(=1)`. 따라서 모든 `import` 그룹이 `from` 그룹보다 먼저 배치된다.
  - 2차 키 `i.split()[1]`: 기존과 동일한 모듈명. 같은 구문 그룹 내부에서는 종전대로 모듈명 알파벳순을 보존한다.
  - 결과: `import datetime` / `import time` / `from django.db import migrations, models` 처럼 Django 코딩 스타일과 isort 기본 규약을 만족하는 출력.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `#24155 - Tests ordering of imports.` (`tests/migrations/test_writer.py`의 `test_sorted_imports`)
- **픽스 증명 방식**: 테스트가 기존 마이그레이션에 `migrations.AddField("mymodel", "myfield2", models.FloatField(default=time.time))`를 추가하고 모듈 상단에 `import time`을 들여온다. `default=time.time`은 writer가 `import time`을 생성하도록 강제하는데, 이 `time`은 알파벳순상 `datetime`과 `django.db` 사이에 끼는 결정적 케이스다. `MigrationWriter(migration).as_string()` 출력에 대해 기대값을 `"import datetime\nimport time\nfrom django.db import migrations, models\n"`로 단언한다. 버그 상태에서는 `import time`이 `from django.db ...` 뒤로 밀려 단언 실패, 픽스 후에는 두 `import` 문이 앞에 묶여 통과한다.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이지만 테스트가 고른 입력(`time`이 from 모듈명 사이에 끼는 케이스)이 정확히 구별용 입력이라, special-case 패치로는 통과하기 어렵다. 그래도 단일 테스트라 `overfit-risk`를 완전히 배제하긴 어렵지만, 정답이 자연스러운 일반화(튜플 키)라 위험은 낮아 플래그는 달지 않았다.
- **regression 관점**: P2P 51개 중 `test_serialize_*`, `test_custom_operation`, "Tests serializing a simple migration." 등 직렬화/출력 스냅샷이 import 정렬에 민감하다. 2차 키로 모듈명 순서를 보존하지 않으면 이들이 깨질 수 있어 `regression-trap` 플래그 부여. 정답 패치는 그룹 내부 순서를 보존하므로 P2P를 통과한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "New migration files are generated", "imports sorted by module", before/after 출력 예시 → 마이그레이션을 소스 문자열로 직렬화하는 코드. `grep -rn "sorted(imports\|MigrationWriter\|as_string" django/db/migrations/writer.py`로 `MigrationWriter.as_string()` 내부의 `sorted_imports = sorted(imports, key=lambda i: i.split()[1])` 한 줄에 직행한다.
2. **픽스와 일반화 근거**: 정렬 키를 모듈명 단일 키에서 `(구문종류, 모듈명)` 2-튜플로 승격한다. `i.split()[0] == "from"`을 1차 키로 두어 `import`(False) < `from`(True) 순서를 강제하고, 2차로 모듈명을 유지한다. 이는 특정 입력(`time`)에 맞춘 hack이 아니라 "import 섹션은 module-import 먼저, from-import 나중, 각 그룹 내부 알파벳순"이라는 isort/Django 규약 **그 자체를 정렬 키로 표현**한 것이라 임의 모듈 조합에 대해 일반적으로 올바르다.
3. **regression 안전**: 2차 키로 모듈명을 그대로 보존하는 게 핵심. 이로써 같은 구문 그룹 내부 순서는 종전과 동일해 `test_serialize_*` 류 직렬화 스냅샷(P2P 51개)이 깨지지 않는다. 1차 키만 바꾸고 2차를 빠뜨리면 그룹 내부 순서가 불안정해져 인접 테스트가 회귀한다.
4. **함정 회피**: (a) 불리언 방향 역전 — `!= "from"`이나 `== "import"`로 쓰면 `from`이 먼저 오는 정반대 결과. `== "from"`이 0/1로 매핑되어 import가 앞서는지 직접 확인해야 한다. (b) 토큰 인덱스 혼동 — `import X`는 토큰 2개, `from A import B`는 4개지만 키는 `[0]`(구문종류)과 `[1]`(모듈명)만 쓴다는 점을 정확히 지킬 것. (c) over-engineering — isort 완전호환을 노려 별도 파서/정규식/그룹핑 로직을 추가하면 hints의 "small tweak" 의도를 벗어나고 P2P 회귀 위험만 키운다. 오라클 없는 에이전트는 (a)와 (c)에서 가장 잘 틀린다.
