---
instance_id: django__django-15987
repo: django/django
base_commit: 7e6b537f5b92be152779fc492bb908d27fe7c52a
version: 4.2
difficulty: <15 min fix
created_at: 2022-08-23T10:07:03Z
fail_to_pass: 1
pass_to_pass: 52
gold_files: [django/core/management/commands/loaddata.py]
---

# django__django-15987

## 문제 요약
`settings.FIXTURE_DIRS`에 들어있는 항목이 `Path` 인스턴스일 때, `loaddata`의 중복 검사가 앱 기본 fixtures 디렉터리(`app/fixtures`)와의 중복을 탐지하지 못한다. 사용자는 `FIXTURE_DIRS`에 문자열을 넣든 `pathlib.Path`를 넣든 동일하게 "기본 fixtures 디렉터리는 FIXTURE_DIRS에 나열할 수 없다"는 `ImproperlyConfigured` 에러가 발생하길 기대한다. 하지만 `Path`로 넣으면 검사가 조용히 통과되어 fixture가 중복 로딩될 수 있다.

## 유형 분류
- 버그 카테고리: edge-case / 타입 (str vs Path 동등성 비교 누락)
- 서브시스템: django core management command (`loaddata`)
- 증상 타입: silent-wrong (마땅히 떠야 할 에러가 안 뜸 → 중복 fixture 로딩)
- 로컬라이제이션 신호: problem_statement이 "FIXTURE_DIRS", "duplicate check in loaddata", "Path instance"를 직접 지목 → `loaddata` 커맨드의 fixture_dirs 중복 검사 로직으로 바로 연결.

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/commands/loaddata.py` : `Command.fixture_dirs` (property)
- 근본 원인: 앱 기본 디렉터리 `app_dir`(=`os.path.join(app_config.path, "fixtures")`, 항상 `str`)를 `fixture_dirs`에 대해 `if app_dir in fixture_dirs`로 검사했다. `fixture_dirs`의 원소가 `Path` 인스턴스이면 `str in [Path(...)]` 비교가 같은 경로여도 `False`가 되어 중복이 누락된다.
- 수정 요지: 비교 직전에 `fixture_dirs`의 각 원소를 문자열로 정규화한다. `if app_dir in fixture_dirs:` → `if app_dir in [str(d) for d in fixture_dirs]:`. 이로써 `Path`/`str` 혼용과 무관하게 경로 문자열 기준으로 중복을 탐지한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_fixture_dirs_with_default_fixture_path_as_pathlib` — "settings.FIXTURE_DIRS cannot contain a default fixtures directory" 시나리오를 `Path` 버전으로 추가.
- 테스트가 어떻게 픽스를 증명하는지: `@override_settings(FIXTURE_DIRS=[Path(_cur_dir) / "fixtures"])`로 앱 기본 fixtures 디렉터리를 `Path`로 지정한 뒤 `management.call_command("loaddata", "absolute.json")`를 호출. 기대 출력은 `os.path.join(_cur_dir, "fixtures")`/`"fixtures_regress"`가 박힌 `ImproperlyConfigured` 메시지를 `assertRaisesMessage`로 잡는 것. 픽스 전에는 `str in [Path]`가 False라 에러가 안 떠서 테스트 실패, 픽스 후 정규화로 매칭되어 에러가 떠 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: `loaddata.py`에서 `FIXTURE_DIRS` / `ImproperlyConfigured` / "default fixture directory" 문자열을 grep → `fixture_dirs` property의 `app_dir in fixture_dirs` 한 줄이 유일한 비교 지점.
- 함정/난이도 메모: 단일 파일·단일 라인 수정이라 난이도는 낮다. 다만 "양쪽을 str로 정규화"인지 "양쪽을 Path로 정규화"인지 방향 선택이 있는데, `app_dir`가 항상 str이므로 리스트 쪽을 str로 맞추는 게 최소 변경. property 같은 함수 내 다른 중복 검사(FIXTURE_DIRS 자체 내 중복)도 동일한 str/Path 혼용 위험이 있으니 인접 코드 확인 권장(골드는 기본 디렉터리 비교만 손댐).
- 우리 에이전트 관점: 막힐 지점은 "왜 비교가 실패하는가"의 타입 인식이다. `str == Path`가 같은 경로여도 False라는 점을 놓치면 엉뚱하게 `os.path` 정규화/`realpath`로 우회하려 들 수 있다. 핵심은 동등성 비교 양변의 타입을 일치시키는 것임을 빨리 잡아야 한다.
