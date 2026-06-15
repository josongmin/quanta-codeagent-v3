---
instance_id: django__django-15572
repo: django/django
base_commit: 0b31e024873681e187b574fe1c4afe5e48aeeecf
version: 4.1
difficulty: <15 min fix
created_at: 2022-04-09T09:38:31Z
fail_to_pass: 1
pass_to_pass: 10
gold_files: [django/template/autoreload.py]
---

# django__django-15572

## 문제 요약
Django 3.2.4+ 에서 템플릿 디렉터리를 `pathlib.Path`로 정규화하도록 바뀌면서, `TEMPLATES`의 `DIRS`에 빈 문자열(`""`)이 들어 있으면 autoreload가 깨진다. 빈 문자열이 `cwd / ""` 정규화로 프로젝트 루트가 되어버려, `template_changed()`가 모든 파일 변경을 템플릿 변경으로 오인하고 항상 `True`를 반환한다. 그 결과 앱 코드를 고쳐도 서버가 리로드되지 않는다(autoreload가 막힘). 사용자는 빈 `DIRS` 항목이 그냥 무시되기를 기대한다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (빈 문자열 입력 미필터링) + regression (3.2.4 정규화 변경의 부작용)
- 서브시스템: django template autoreload (`django/template/autoreload.py`)
- 증상 타입: silent-wrong (예외 없이 autoreload가 동작하지 않음)
- 로컬라이제이션 신호: problem_statement가 `django/template/autoreload.py::template_changed`와 정규화(`pathlib.Path`) 도입 커밋을 직접 명시. 실제 디렉터리 수집 지점인 `get_template_directories()`가 핵심.

## 골드패치 분석
- 건드린 파일/함수: `django/template/autoreload.py:get_template_directories`
- 근본 원인: `get_template_directories()`가 `backend.engine.dirs`와 각 loader의 `get_dirs()`를 순회하며 `cwd / to_path(dir)`로 정규화할 때, `dir`이 빈 문자열이면 `cwd / ""` == `cwd`(프로젝트 루트)가 watch 대상에 들어간다. 이후 `template_changed()`가 모든 변경 경로의 부모로 루트를 매칭시켜 항상 참이 됨.
- 수정 요지: 두 제너레이터 표현식에 빈 값 필터를 추가한다.
  - `items.update(cwd / to_path(dir) for dir in backend.engine.dirs if dir)` — `if dir` 추가
  - loader 측은 `if not is_django_path(directory)` → `if directory and not is_django_path(directory)` 로 변경
  - 즉 falsy(빈 문자열)인 디렉터리 항목을 정규화 전에 건너뛰어 루트가 watch 집합에 섞이지 않게 한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_template_dirs_ignore_empty_path` — `DjangoTemplates` 백엔드에 `"DIRS": [""]`만 설정한 상태에서 `autoreload.get_template_directories()`가 빈 집합(`set()`)을 반환하는지 확인.
- 증명 방식: 재현 입력 = `DIRS=[""]` (빈 문자열 한 개). 기대 출력 = `set()`. 픽스 전에는 `cwd`(루트 Path)가 집합에 들어가 비어 있지 않으므로 실패하고, `if dir` 필터가 추가되면 빈 항목이 걸러져 빈 집합이 되어 통과한다. PASS_TO_PASS의 `test_get_template_directories`, `test_template_dirs_normalized_to_paths` 등은 정상(비어있지 않은) DIRS 경로 정규화가 그대로 유지됨을 보장.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/template/autoreload.py`의 `get_template_directories()` 한 함수만 보면 된다. problem_statement가 파일·함수·정규화 커밋까지 짚어줘서 로컬라이제이션은 거의 공짜.
- 함정/난이도: 함정은 `template_changed()`를 고치려는 유혹이다. 증상은 거기서 나타나지만 진짜 원인은 watch 집합을 만드는 `get_template_directories()`의 빈 항목 유입. 또한 필터를 한 군데(`engine.dirs`)만 넣고 loader의 `get_dirs()` 경로를 빠뜨리면 절반만 고친 셈 — 두 제너레이터 모두 패치해야 함. 단일 파일 변경이라 멀티파일 위험은 없음.
- 우리 에이전트 관점: 증상(autoreload 안 됨)과 원인(빈 문자열 → 루트 매칭) 사이 인과를 잇지 못하면 엉뚱한 `template_changed` 비교 로직을 손댈 수 있다. `cwd / ""`가 `cwd`가 된다는 pathlib 동작을 이해해야 "빈 값 필터"라는 최소 수정에 도달. 두 군데 동시 수정 누락이 가장 흔한 실수.
