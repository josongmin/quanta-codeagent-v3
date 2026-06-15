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
---

# django__django-16662

## 문제 요약
`makemigrations`로 생성되는 마이그레이션 파일의 import가 모듈 이름순으로만 정렬되어, `import ...` 문과 `from ... import ...` 문이 뒤섞인다. 예: `import datetime` / `from django.db import migrations, models` / `import time` 순. Django 코딩 스타일과 isort 기본값은 각 섹션에서 모든 `import module` 문을 `from module import objects` 문보다 앞에 두도록 요구하므로, 생성된 마이그레이션이 isort 검사를 실패한다. 사용자는 `import` 문들이 먼저, 그 다음 `from` 문들이 오는 정렬을 기대한다.

## 유형 분류
- 버그 카테고리: logic (정렬 키 결함) / API-contract (코딩 스타일·isort 규약 위반)
- 서브시스템: django migrations writer (마이그레이션 코드 생성)
- 증상 타입: 잘못된 출력 (생성된 소스의 import 정렬 순서가 규약 위반)
- 로컬라이제이션 신호: "New migration files are generated", "imports sorted by module" → 마이그레이션 파일을 문자열로 직렬화/생성하는 곳, 즉 `django/db/migrations/writer.py`의 import 정렬 로직.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/writer.py` : `MigrationWriter.as_string()`
- 근본 원인: import 목록을 `key=lambda i: i.split()[1]` 즉 "두 번째 토큰(모듈명)" 단일 키로만 정렬했다. `import datetime`의 두 번째 토큰은 `datetime`, `from django.db import ...`는 `django.db`, `import time`은 `time` → 모듈명 알파벳순으로만 섞여 정렬되어 `import`/`from` 구분이 무시됨.
- 수정 요지: 정렬 키를 2-튜플 `(i.split()[0] == "from", i.split()[1])`로 변경. 첫 요소는 `from`으로 시작하면 `True(=1)`, 순수 `import`면 `False(=0)`이므로 `import` 문 그룹이 먼저 오고, 그 안에서 기존처럼 모듈명으로 2차 정렬. 결과적으로 모든 `import ...`가 `from ... import ...`보다 앞에 배치된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `#24155 - Tests ordering of imports.` (`migrations.test_writer`의 `test_sorted_imports`)
- 테스트가 어떻게 픽스를 증명하는지: 테스트에 `models.FloatField(default=time.time)`를 쓰는 `AddField`를 추가해 `import time`이 생성되게 만든다(`import datetime`와 `from django.db import migrations, models` 사이에 끼는 케이스). `MigrationWriter(migration).as_string()` 출력에 대해 기대값을 `"import datetime\nimport time\nfrom django.db import migrations, models\n"`로 단언한다. 버그 상태에서는 `time`이 `from django.db` 뒤로 밀려 실패하고, 픽스 후에는 두 `import` 문이 먼저 묶여 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 정렬·생성 키워드가 명확하므로 `grep`으로 `sorted(imports`, `i.split()` 또는 `MigrationWriter`/`as_string`을 찾으면 단번에 `writer.py`의 한 줄 정렬 로직에 도달한다.
- 함정/난이도 메모: 단일 파일·1줄 수정이라 난이도는 낮지만, "import 먼저, from 나중"을 `sort`로 표현하는 방식을 정확히 잡아야 한다. `from`을 우선시키려고 부등호/불리언 방향을 뒤집으면(`!= "from"` 등) 정반대 결과. 또 `i.split()[0]`/`[1]`의 토큰 인덱스를 헷갈리기 쉽다(`import X`는 토큰 2개, `from A import B`는 4개지만 키는 [0],[1]만 사용). isort-완전호환을 노려 과도하게 복잡한 로직을 추가하면 hints의 "small tweak" 의도를 벗어난다.
- 우리 에이전트 관점: 막힐 지점은 거의 없으나, 정렬 안정성(2차 키로 모듈명을 유지)을 빠뜨려 같은 그룹 내 순서를 깨면 PASS_TO_PASS(`test_sorted_imports` 외 기존 직렬화 스냅샷류)와 어긋날 수 있다. 튜플 키로 1차=구문종류, 2차=모듈명을 모두 보존하는 게 정답.
