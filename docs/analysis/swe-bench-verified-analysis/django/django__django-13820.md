---
instance_id: django__django-13820
repo: django/django
base_commit: 98ad327864aed8df245fd19ea9d2743279e11643
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-12-28T22:07:57Z
fail_to_pass: 1
pass_to_pass: 24
gold_files: [django/db/migrations/loader.py]
---

# django__django-13820

## 문제 요약
마이그레이션 로더는 PEP-420 네임스페이스 패키지를 마이그레이션 대상에서 제외하기 위해 "`__file__`이 없는 모듈은 건너뛴다"는 검사를 쓴다. 그런데 `__file__`이 없는 모듈이 네임스페이스 패키지만은 아니다. frozen Python 환경(예: 임베디드/동결 배포)은 일반 정규 패키지에도 `__file__`을 설정하지 않을 수 있어서, 이런 환경에서는 멀쩡한 마이그레이션 패키지가 통째로 무시된다. 요청자는 네임스페이스 패키지 허용이 아니라, 네임스페이스 판별을 Python 문서 기준에 맞게 더 정확히 하자고 제안한다.

## 유형 분류
- 버그 카테고리: edge-case / API-contract (Python import 규약 오해)
- 서브시스템: django db migrations loader (마이그레이션 디스크 로딩)
- 증상 타입: silent-wrong (예외 없이 마이그레이션을 그냥 못 찾고 unmigrated로 처리)
- 로컬라이제이션 신호: problem_statement가 `django.db.migrations.loader.MigrationLoader.load_disk`와 `getattr(m, '__file__', None)` 검사를 명시적으로 지목 → 파일/함수가 거의 직접 주어짐

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/loader.py` : `MigrationLoader.load_disk`
- 근본 원인: 네임스페이스 패키지 판별을 `__file__` 부재 하나만으로 했는데, `__file__`은 Python import 규약상 선택 속성이라 정규 패키지(특히 frozen 환경)에서도 없을 수 있다. 즉 판별 기준이 너무 넓어 정상 패키지까지 오탐(false positive)으로 걸렀다.
- 수정 요지:
  - "module이 package가 아님(`__path__` 없음)" 검사를 `__file__` 검사보다 앞으로 옮겨 순서를 정리.
  - 네임스페이스 판별 조건을 `getattr(module, '__file__', None) is None` 단독에서 `... and not isinstance(module.__path__, list)` 로 강화.
  - 근거: 진짜 네임스페이스 패키지는 `__path__`가 일반 `list`가 아니라 커스텀 iterable(`_NamespacePath`)을 쓴다. 따라서 `__file__`이 없어도 `__path__`가 list면 정규 패키지로 보고 로드한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_loading_package_without__file__` — `__file__`이 없지만 정규 패키지인 마이그레이션 모듈에서 마이그레이션이 정상 로드되는지 확인.
- 증명 방식: `migrations.test_migrations`를 import한 뒤 frozen 환경을 흉내내어 `test_module.__file__`을 `del`하고 `__spec__.origin = None`, `__spec__.has_location = False`로 만든다. 그 상태에서 `loader.load_disk()`를 호출하고, `migrations` 앱에서 로드된 마이그레이션 목록이 `['0001_initial', '0002_second']`와 일치하는지(`assertCountEqual`) 확인한다. `finally`에서 `__file__`/`__spec__` 속성을 원복해 전역 모듈 상태 오염을 막는다. 픽스 전이라면 `__file__` 부재만으로 네임스페이스로 오인해 빈 목록이 나오므로 실패한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 파일·함수·해당 라인 코드까지 직접 알려주므로 거의 곧장 `loader.py`의 `load_disk` 내 `__file__` 검사 블록으로 진입하면 된다.
- 함정/난이도 메모: 핵심 통찰은 "네임스페이스 패키지의 진짜 시그니처는 `__path__`가 list가 아니라는 점"이라는 것. 단순히 `__file__` 검사를 제거하면 진짜 네임스페이스 패키지까지 로드해 회귀가 난다(`test_loading_namespace_package` 류 PASS_TO_PASS가 깨짐). 두 조건의 AND 결합과 `__path__` 없는 케이스(비-패키지 migrations.py) 분기 순서까지 같이 맞춰야 한다. 멀티파일 아님(단일 파일 수정).
- 우리 에이전트 관점: 막힐 지점은 "왜 `__file__`만으론 안 되는가"의 정확한 대체 판별식을 떠올리는 부분. Python import 규약(네임스페이스 패키지의 `__path__` 타입)을 모르면 `__spec__` 기반 등 다른 방향으로 새거나, `__file__` 검사를 그냥 빼서 네임스페이스 회귀를 일으키기 쉽다. 정답은 좁고 규약 지식 의존도가 높다.
