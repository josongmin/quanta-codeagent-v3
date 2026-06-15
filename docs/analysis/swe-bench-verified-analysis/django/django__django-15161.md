---
instance_id: django__django-15161
repo: django/django
base_commit: 96e7ff5e9ff6362d9a886545869ce4496ca4b0fb
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2021-12-06T09:06:13Z
fail_to_pass: 3
pass_to_pass: 208
gold_files: [django/db/models/expressions.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-15161

## 문제 요약
`F()` 표현식은 예전에 `django.db.models.expressions.F()`로 deconstruct 되었지만, PR #14047에서 `django.db.models`로도 import 가능하다는 점을 이용해 `django.db.models.F()`로 단순화되었다. 이 단순화는 생성되는 migration 코드를 `from django.db import models` / `models.F()`처럼 짧게 만든다. 이 티켓은 Mariusz의 제안대로 동일한 기법을 나머지 public 표현식(`Func`, `Value`, `ExpressionWrapper`, `When`, `Case`, `OrderBy`)에도 적용해 migration 직렬화 경로를 더 간결하게 만드는 것이다. 로직 버그가 아니라 "일관성 확장(consistency completion)" 과제이며, 의도된 동작은 코드만으론 결정되지 않고 선례 PR과 public API 관례에서 재구성해야 한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 `deconstruct of expressions`, `PR #14047`, `django.db.models.F()`라는 정확한 심볼·경로를 명시한다. `F()`가 이미 단순화됐다는 단서가 곧장 `django/db/models/expressions.py`의 `@deconstructible` 적용 패턴을 가리킨다. grep 한 방으로 수정 지점에 도달.
- **S (Repair Strategy) = S1 Direct-Map (+S5 Spec-Inference)**: 픽스 메커니즘 자체는 기계적·템플릿적이다 — 각 클래스 위에 `@deconstructible(path='django.db.models.X')` 한 줄을 붙이는 정형 패턴 6회 반복(S1). 다만 "어떤 클래스에, 어떤 path 문자열"인지는 코드만으론 결정 안 되고 선례 PR과 public re-export 관례에서 스펙을 재구성해야 한다(S5 보조). RED 신호가 약한 일관성 확장이라 식 합성(S2)이 아니라 명세 추론이 본질.
- **K (Knowledge) = K-Domain**: `@deconstructible(path=...)` 라는 django migration serializer 메커니즘, `Expression.deconstruct()`의 path 산출 규칙, 그리고 `django/db/models/__init__.py`가 이 6개 클래스를 re-export한다는 프레임워크 내부 지식이 병목이다. 일반 파이썬 추론만으론 deconstruct 메서드를 직접 오버라이드하는 장황한 오답으로 샌다.
- **primary type = T-DomainBound**: L0로 위치는 자명하고 픽스도 6줄로 작지만, 진짜 병목은 "django가 deconstruct path를 어떻게 단순화하는가(`@deconstructible(path=)`)"와 "어느 클래스가 public 경로를 갖는가"라는 도메인 지식이다. K-Domain이 dominant이므로 T-LocTrivial/T-DirectMap이 아니라 T-DomainBound로 분류.

왜 S1인가(APR 관점): 결함클래스가 "정형 데코레이터 누락"이고 픽스가 알려진 템플릿(`@deconstructible(path=...)`)을 선례(`F`)에서 그대로 베껴 인접 심볼에 전사하는 PAR/TBar식 template repair에 정확히 매칭된다. 식·조건 합성(S2)이나 테스트 반복 수렴(S3)이 필요 없다. 단, 적용 대상 집합을 결정하는 부분이 코드 외부 스펙(선례 PR + public API 계약)에 의존하므로 S5를 보조로 표기.

## 난이도 티어
**T3 (중간)**. 공식 difficulty 라벨은 `15 min - 1 hour`(T2~T3 경계)인데, 구조적 피처로 보면 T3로 미는 요인이 우세하다:
- localize 직접성은 매우 높음(L0, 1파일, 6 헌크 ≈ 6줄 추가) → 단독으로는 T1~T2를 시사.
- 그러나 **K-Domain 의존**이 티어를 올린다: `@deconstructible(path=)` 메커니즘과 public re-export 보장을 모르면 deconstruct를 직접 오버라이드하는 오답으로 빠진다. 루브릭상 K-Domain은 T3~T4 구간.
- **RED 신호가 약함**: 로직 버그가 아니라 일관성 확장이라 재현 스택트레이스가 없고(has-repro 없음), "어디까지 적용할지" 범위 판단이 필요해 단순 T1/T2보다 한 단계 위.
- **regression-trap**(P2P 208개): migration writer/serializer와 expressions 전반을 안 깨야 함. 특히 path 문자열을 잘못 주면 `test_serialize_*` 다수가 깨질 수 있는 넓은 인접면.
- **cross-file-dep**: 수정은 1파일이지만 정답 검증은 `tests/expressions/`와 `tests/migrations/` 두 디렉터리에 걸치고, path가 `django/db/models/__init__.py`의 re-export에 암묵 의존.

>4시간급 깊은 추론·멀티파일 조율(T5/T6)은 아니다. 픽스 자체가 6줄 템플릿이라 T4(소규모 refactor/constraint추론)에도 못 미친다. 따라서 공식 라벨 하단(T2)이 아니라 도메인지식+약한RED+넓은 P2P 때문에 **T3**로 본다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/expressions.py` — 클래스 데코레이터로 `Func`, `Value`, `ExpressionWrapper`, `When`, `Case`, `OrderBy`에 각각 `@deconstructible(path='django.db.models.<클래스명>')` 추가(총 6 헌크, 순수 추가).
- **근본 원인**: 이 표현식 클래스들은 모두 `django.db.models` 네임스페이스로 re-export 되어 public하게 import 가능하지만, `deconstructible`/`deconstruct`는 클래스의 실제 정의 모듈인 `django.db.models.expressions.*` 전체 경로를 반환했다. 앞선 PR #14047에서 `F`만 `path` 인자로 단순화되었고 형제 표현식들은 일관성 없이 내부 모듈 경로를 노출한 채 남아 있었다.
- **수정 요지**: `@deconstructible` 데코레이터의 `path` 인자로 deconstruct 경로를 public 경로로 오버라이드. 예) `@deconstructible(path='django.db.models.Func')`를 `Func` 위에 붙이면 deconstruct가 `django.db.models.Func`를 반환. 동일하게 `Value`→`django.db.models.Value`, 그리고 `ExpressionWrapper`/`When`/`Case`/`OrderBy`에 적용. 런타임 로직·시그니처 변경 없이 직렬화 경로 문자열만 단축한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (3)**:
  - `expressions.tests.ValueTests.test_deconstruct`: `Value('name').deconstruct()`의 기대 path를 `django.db.models.expressions.Value` → `django.db.models.Value`로 갱신(args/kwargs 불변 동시 확인).
  - `expressions.tests.ValueTests.test_deconstruct_output_field`: `output_field=CharField()` 포함 버전도 동일하게 단순 경로 + kwargs 보존 확인.
  - `migrations.test_writer.WriterTests.test_serialize_complex_func_index`: `Func`/`Case`/`When`/`Value`/`ExpressionWrapper`/`OrderBy`를 한꺼번에 담은 복합 `models.Index`를 `MigrationWriter.serialize`로 직렬화하고, 결과 문자열이 전부 `models.Func(...)`, `models.Case(...)`, `models.OrderBy(...)` 등 단순 경로로 나오며 imports가 `{'from django.db import models'}` 하나뿐인지 확인.
- **픽스 증명**: 패치 전이면 직렬화 문자열에 `django.db.models.expressions.Func` 등 내부 경로가 새어나와 정확 문자열 비교에서 실패. 패치 후엔 6개 클래스 모두 public 경로로 나와 통과. `test_serialize_complex_func_index`가 6개 클래스를 한 입력에 묶어 검증하므로 단일 테스트가 전 헌크를 커버한다.
- **overfit 관점**: F2P가 6개 대상 클래스를 모두 실제로 직렬화해 검증하므로, 일부 클래스만 데코레이트하는 special-case 패치는 통과 못 한다(CEGIS형 과소명세 위험 낮음). 다만 path 문자열을 잘못된 public 경로로 넣어도 string 일치만 맞추면 통과할 여지는 이론상 있으나, 골드 path는 실제 re-export와 일치하므로 정답이 곧 일반해.
- **regression 관점**: P2P 208개가 expressions 동작 전반(`test_equal`/`test_hash`/`test_repr`/연산자/서브쿼리)과 migration writer 직렬화(`test_serialize_*`, `test_deconstruct_class_arguments`)를 광범위 고정. path만 바꾸고 런타임 로직을 안 건드린다는 점이 이 광범위 P2P 통과로 보장된다. 특히 `django.db.models shouldn't be imported if unused.`, `#24155 - Tests ordering of imports.` 같은 import-관리 테스트가 안 깨져야 함.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 `PR #14047` + `F()`가 `django.db.models.F()`로 단순화됐다는 신호 → `django/db/models/expressions.py`에서 `F` 클래스가 어떻게 단순 경로를 얻는지 확인 → `@deconstructible(path='django.db.models.F')` 패턴 발견. 같은 파일에서 형제 표현식 클래스(`Func`/`Value`/`ExpressionWrapper`/`When`/`Case`/`OrderBy`)가 이 데코레이터를 빠뜨린 것을 grep으로 식별.
2. **픽스와 왜 올바른 일반화인가**: 각 클래스에 `@deconstructible(path='django.db.models.<클래스명>')`를 붙인다. 이게 deconstruct 메서드를 직접 오버라이드하는 장황한 코드보다 옳은 이유 — django가 이미 제공하는 표준 메커니즘(`F`에서 검증된 선례)을 재사용해 import 경로 계약만 바꾸고 직렬화 로직은 단일 진실원천에 위임하기 때문. 6개 모두 `django/db/models/__init__.py`에서 re-export 되는 public 클래스이므로 `django.db.models.X`가 실제 import 가능한 정당한 경로 → special-case가 아닌 일반해.
3. **regression 안전**: 런타임 로직·시그니처를 전혀 안 건드리므로 expressions 연산/평가/`__eq__`/`__hash__`/`__repr__` 관련 P2P(예: `test_equal`, `test_hash`, `test_repr`, 연산자/서브쿼리 군)는 영향 없음. migration writer 쪽은 path 문자열만 짧아지므로, import 단일화·미사용 import 제거(`django.db.models shouldn't be imported if unused.`)와 import 순서(`#24155`) 테스트가 오히려 단순 경로로 더 잘 맞는다. path 오타·비-public 경로만 피하면 208개 전부 안전.
4. **함정 회피**: (a) **메커니즘 미인지** — `@deconstructible(path=)`를 모르고 각 클래스에 `deconstruct()`를 손수 오버라이드하면 장황하고 깨지기 쉬운 오답. 선례 `F`를 먼저 읽어 표준 경로를 쓸 것. (b) **범위 과소/과다** — 모든 Expression 서브클래스에 무차별로 붙이면 안 됨; public re-export가 보장되는 6개만 대상. `django/db/models/__init__.py`에서 노출 여부를 확인해 집합을 확정. (c) **path 문자열 오타** — `django.db.models.expressions.X`(내부)나 잘못된 클래스명을 넣으면 F2P 정확 비교에서 즉시 실패. (d) **약한 RED** — 재현 스택트레이스가 없는 일관성 과제라 "어디까지가 끝인지" 판단을 테스트에 의존하기 쉬움; `test_serialize_complex_func_index`가 정확히 6개를 요구한다는 점을 오라클 없이 추론하려면 선례 PR의 동기를 끝까지 일반화해야 한다.
