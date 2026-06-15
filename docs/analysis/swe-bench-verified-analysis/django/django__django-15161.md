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
---

# django__django-15161

## 문제 요약
`F()` 표현식은 예전에 `django.db.models.expressions.F()`로 deconstruct 되었지만, PR #14047에서 `django.db.models`에서도 import 가능하다는 점을 이용해 `django.db.models.F()`로 단순화되었다. 이 단순화는 생성되는 migration 코드를 `from django.db import models` / `models.F()` 처럼 짧게 만든다. 이 티켓은 Mariusz의 제안대로 동일한 기법을 나머지 표현식(`Func`, `Value`, `ExpressionWrapper`, `When`, `Case`, `OrderBy`)에도 적용해 migration 직렬화 경로를 더 간결하게 만드는 것을 목표로 한다.

## 유형 분류
- 버그 카테고리: API-contract (deconstruct가 노출하는 import 경로 계약 변경) / 일관성 누락처리
- 서브시스템: django ORM query expressions + migration writer/serializer
- 증상 타입: silent-wrong (동작 자체는 정상이나 생성된 migration 코드가 장황하고 내부 모듈 경로 노출)
- 로컬라이제이션 신호: problem_statement가 "deconstruct of expressions", "PR #14047", `django.db.models.F()` 같은 정확한 심볼·경로를 명시. `F()`가 이미 단순화된 점이 곧장 `django/db/models/expressions.py`의 `@deconstructible` 패턴을 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/expressions.py` — 클래스 데코레이터로 `Func`, `Value`, `ExpressionWrapper`, `When`, `Case`, `OrderBy`에 각각 `@deconstructible(path=...)` 추가
- 근본 원인: 이 표현식 클래스들은 모두 `django.db.models` 네임스페이스로도 import 가능하지만, deconstruct는 클래스의 실제 정의 모듈인 `django.db.models.expressions.*` 전체 경로를 반환했다. `F`만 앞선 PR에서 처리되었고 나머지는 빠져 있었다.
- 수정 요지: `@deconstructible` 데코레이터의 `path` 인자를 사용해 deconstruct 경로를 public 경로로 오버라이드한다. 예: `@deconstructible(path='django.db.models.Func')`를 `Func` 클래스 위에 붙이면 deconstruct가 `django.db.models.Func`를 반환한다. 동일하게 `Value`→`django.db.models.Value`, `ExpressionWrapper`, `When`, `Case`, `OrderBy`에 적용. 로직 변경 없이 데코레이터 6줄 추가가 전부.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `expressions.tests.ValueTests.test_deconstruct` / `test_deconstruct_output_field`: `Value('name').deconstruct()`의 path 기대값을 `django.db.models.expressions.Value` → `django.db.models.Value`로 갱신.
  - `migrations.test_writer.WriterTests.test_serialize_complex_func_index`: `Func`/`Case`/`When`/`Value`/`ExpressionWrapper`/`OrderBy`를 모두 담은 복합 `models.Index`를 `MigrationWriter.serialize`로 직렬화하고, 결과 문자열이 전부 `models.Func(...)`, `models.Case(...)` 등 단순 경로로 나오며 imports가 `{'from django.db import models'}` 하나뿐인지 확인.
- 증명 방식: 재현 입력은 위 표현식들로 구성한 Index 객체. 기대 출력은 `expressions.` 내부 경로가 전혀 등장하지 않는 직렬화 문자열. 패치 전이면 `django.db.models.expressions.Func` 등이 새어나와 문자열 불일치로 실패, 패치 후 통과.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement의 "PR #14047"과 `F()` 단순화 언급을 따라 `django/db/models/expressions.py`에서 `F` 클래스가 어떻게 단순 경로를 얻는지 확인 → `@deconstructible(path=...)` 패턴을 발견하면 나머지 public 표현식에 동일 적용.
- 함정/난이도 메모: (1) `path`에 넣을 경로가 클래스가 import 가능한 public 경로(`django.db.models.X`)여야 한다 — `django/db/models/__init__.py`에서 re-export 되는지 확인 필요. (2) 모든 표현식에 무차별로 붙이면 안 됨; 골드는 public import가 보장되는 6개만 선정. (3) 단일 파일 변경이지만 검증 테스트는 두 디렉터리(`tests/expressions/`, `tests/migrations/`)에 걸쳐 있음.
- 우리 에이전트 관점: 로직 버그가 아니라 "일관성 확장" 과제라 RED 신호가 약하다. 어느 클래스까지 적용할지 범위 판단(public 경로 존재 여부 검증)에서 과소·과다 적용하기 쉽다. `@deconstructible(path=...)` 메커니즘 자체를 모르면 deconstruct 메서드를 직접 오버라이드하는 더 장황한 오답으로 빠질 수 있음.
