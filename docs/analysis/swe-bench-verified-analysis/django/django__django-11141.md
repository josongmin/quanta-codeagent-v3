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
---

# django__django-11141

## 문제 요약
Python 3에서 `__init__.py`가 없는 디렉터리는 암묵적 namespace package가 되어 `__file__` 속성이 없다. `migrate` 명령이 마이그레이션 패키지에 대해 `__file__` 존재 여부를 체크하기 때문에, namespace package로 된 migrations 디렉터리는 "unmigrated"로 잘못 분류되어 마이그레이션이 전혀 로드되지 않는다. 사용자는 `__init__.py` 없는 migrations 디렉터리도 정상적으로 로드되기를 기대한다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (stale 가드로 인한 false-negative)
- 서브시스템: django migrations loader (`MigrationLoader.load_disk`)
- 증상 타입: silent-wrong (예외 없이 마이그레이션을 그냥 무시함)
- 로컬라이제이션 신호: problem_statement이 직접 `__file__` 체크와 `pkgutil.iter_modules()`, 그리고 #21015/#23406 이슈 번호를 언급 → `loader.py`의 `load_disk`로 바로 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/loader.py:MigrationLoader.load_disk`
- 근본 원인: `__file__` 체크는 #21015에서 파일 시스템 직접 접근을 위해 도입됐지만, #23406에서 discovery가 `pkgutil.iter_modules(module.__path__)`로 바뀌면서 `__file__`은 더 이상 필요 없어졌다. namespace package는 `__path__`는 가지지만 `__file__`은 없으므로, 남아있던 `__file__` 체크가 정상적인 namespace migrations를 `unmigrated_apps`로 밀어넣었다.
- 수정 요지:
  1. `getattr(module, '__file__', None) is None`이면 unmigrated로 처리하던 분기(빈 디렉터리=namespace 가정)를 통째로 제거.
  2. `migrated_apps.add()`를 무조건 호출하던 위치를 `migration_names` 계산 이후로 이동.
  3. 실제 마이그레이션이 있거나 `self.ignore_no_migrations`일 때만 `migrated_apps`에 추가하고, 그 외엔 `unmigrated_apps`에 추가하도록 변경 → "비어있음" 판정을 `__file__`이 아니라 실제 migration 모듈 존재 여부로 결정.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_loading_namespace_package` — "Migration directories without an __init__.py file are loaded."
- 증명 방식: `__init__.py`가 없는 새 fixture `tests/migrations/test_migrations_namespace_package/`(0001_initial.py만 존재)를 `MIGRATION_MODULES`로 지정한 뒤 `MigrationLoader(connection)`를 만든다. `graph.forwards_plan(('migrations', '0001_initial'))`가 `[('migrations', '0001_initial')]`을 반환하는지 확인 → 패치 전이면 namespace package가 unmigrated 처리되어 그래프에 노드가 없어 실패, 패치 후엔 정상 로드되어 plan이 채워진다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement의 `__file__` + `pkgutil.iter_modules` 키워드로 `loader.py`를 grep → `load_disk` 내 `__file__` 체크 블록이 유일한 후보다. 거의 단일 지점.
- 함정/난이도 메모: 단순히 `__file__` 체크만 지우면 "정말 빈 migrations 디렉터리"가 migrated로 잘못 분류되는 회귀가 생긴다. 골드처럼 `migrated_apps.add()`를 `migration_names` 계산 뒤로 옮기고 빈 경우를 unmigrated로 처리해야 `test_load_empty_dir`/`test_marked_as_unmigrated` 등 PASS_TO_PASS가 유지된다. 단일 파일 수정이지만 분기 순서 재배치가 핵심.
- 우리 에이전트 관점: `__file__` 한 줄만 삭제하는 naive 픽스로 끝낼 위험이 크다. `ignore_no_migrations` 플래그와 빈 디렉터리 의미론을 함께 고려하지 않으면 PASS_TO_PASS 회귀로 드러난다. 또한 테스트가 fixture 디렉터리 생성(파일 추가)을 요구하므로, 재현 환경 구성 시 `__init__.py` 없는 패키지를 만들어야 한다는 점을 놓치기 쉽다.
