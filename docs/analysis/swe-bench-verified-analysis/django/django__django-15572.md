---
instance_id: django__django-15572
repo: django/django
base_commit: 0b31e024873681e187b574fe1c4afe5e48aeeecf
version: "4.1"
difficulty: <15 min fix
created_at: 2022-04-09T09:38:31Z
fail_to_pass: 1
pass_to_pass: 10
gold_files: [django/template/autoreload.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15572

## 문제 요약
Django 3.2.4+ 에서 템플릿 디렉터리를 `pathlib.Path`로 정규화하도록 바뀌면서, `TEMPLATES`의 `DIRS`에 빈 문자열(`""`)이 들어 있으면 autoreload가 깨진다. 빈 문자열이 `cwd / ""` 정규화로 프로젝트 루트가 되어버려, `template_changed()`가 모든 파일 변경을 템플릿 변경으로 오인하고 항상 `True`를 반환한다. 그 결과 앱 코드를 고쳐도 서버가 리로드되지 않는다(autoreload가 막힘). 흔한 트리거는 `os.getenv("TEMPLATES_DIRS", "").split(",")` 처럼 빈 환경변수가 `[""]`를 만드는 경우. 사용자는 빈 `DIRS` 항목이 그냥 무시되기를 기대한다.

## 유형 (정형화)
- **L0 (Pinpointed)** — problem_statement가 파일(`django/template/autoreload.py`), 증상 함수(`template_changed`), 회귀를 만든 정규화 커밋(`68357b2`)까지 직접 지목한다. grep 한 방으로 `get_template_directories()`에 도달. localize는 사실상 공짜.
- **S1 (Direct-Map) +S2 (Constraint-Reasoning)** — 결함 클래스가 정형(누락된 falsy 입력 가드)이라 픽스가 "빈 값 필터 추가"로 기계적으로 매핑된다(S1). 다만 *어느 표현식에* 가드를 넣어야 watch 집합 오염이 멈추는지, 그리고 `cwd / "" == cwd`(루트)라는 pathlib 의미를 따져 "최소 수정 = 정규화 *전* falsy 스킵"이라는 결론에 닿으려면 약간의 불변식 추론이 필요(S2 보조). 다수 후보를 테스트로 굴리는 G&V가 아니라 생각으로 도출하는 구조.
- **K-Domain** — django template engine/autoreload 내부 구조(`backend.engine.dirs`, loader의 `get_dirs()`, `is_django_path`, `to_path` 정규화)를 알아야 두 수집 경로를 모두 식별할 수 있다. 순수 파이썬 추론만으로는 loader 경로 누락 위험.
- **primary type = T-DirectMap** — 위치가 명확하고(L0) 픽스가 정형 결함클래스(falsy 입력 미필터링)에 대한 기계적 가드 추가(S1). T-DirectMap 정의("위치 명확 + S1 기계적 픽스: 가드")에 정확히 부합. T-DomainBound로 안 본 이유: 도메인지식은 *수집 지점 두 곳을 빠짐없이 식별*하는 데만 쓰이고, 픽스 자체의 본질(가드 추가)을 지배하지 않음.

## 난이도 티어
**T2 (쉬움).** 공식 라벨은 `<15 min fix`(T1~T2 prior)이며 그대로 수용한다.
- 이 티어로 미는 구조적 피처: 단일 파일(`autoreload.py`) / 골드 patch 2줄(2 헌크) / has-repro(`DIRS=[""]`로 명세된 재현 입력 + 기대값 `set()`) / L0 직접 localize / S1 기계적 픽스.
- T1로 더 내리지 않은 이유: (1) **regression-trap** — PASS_TO_PASS 10개 중 정상 DIRS 경로 정규화(`test_template_dirs_normalized_to_paths`, `test_get_template_directories`)와 변경 감지(`test_template_changed`, `test_non_template_changed`)를 동시에 안 깨야 한다. (2) **수정 지점이 2곳**(`engine.dirs` 제너레이터 + loader `get_dirs()` 제너레이터) — 한 곳만 고치면 절반 픽스가 되어 FAIL_TO_PASS는 통과해도 다른 입력 경로에 구멍이 남는 함정. (3) K-Domain(loader 경로 식별)이 K-Gen 대비 약간의 지식 부담. 즉 "이슈가 픽스를 거의 적어주는 T1"보다 한 단계 위, 가벼운 엣지추론·약한 regression trap이 있는 T2.

## 골드패치 분석
- **건드린 파일·함수:** `django/template/autoreload.py :: get_template_directories()` (2 헌크).
- **근본 원인:** `get_template_directories()`가 watch 대상 집합을 만들 때 두 소스를 순회한다 — (a) `backend.engine.dirs`, (b) 각 loader의 `get_dirs()`. 각 항목을 `cwd / to_path(dir)`로 정규화하는데, `dir`이 빈 문자열이면 `cwd / "" == cwd`(프로젝트 루트 Path)가 집합에 들어간다. 이후 `template_changed(sender, file_path)`가 변경 파일의 조상 디렉터리를 이 집합과 매칭할 때, 루트가 모든 파일의 조상이므로 항상 매칭되어 무조건 `True` 반환 → autoreload가 앱 코드 변경을 "템플릿 변경"으로 오인해 정상 리로드를 막는다.
- **수정 요지:** 정규화 *전에* falsy 디렉터리 항목을 건너뛰도록 두 제너레이터 표현식에 가드 추가.
  - `items.update(cwd / to_path(dir) for dir in backend.engine.dirs if dir)` — `if dir` 추가.
  - loader 측: `if not is_django_path(directory)` → `if directory and not is_django_path(directory)` — `directory and` 선행 추가.
  - 빈 문자열(falsy)을 루트로 정규화하지 않고 스킵하므로 watch 집합에 루트가 섞이지 않음. 정상(비어있지 않은) 경로는 영향 없음.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_template_dirs_ignore_empty_path` — `@override_settings`로 `DjangoTemplates` 백엔드에 `"DIRS": [""]`만 둔 상태에서 `autoreload.get_template_directories()`가 빈 집합 `set()`을 반환하는지 단언.
- **픽스 증명:** 재현 입력 `DIRS=[""]` → 기대 출력 `set()`. 픽스 전에는 `cwd`(루트 Path)가 집합에 들어가 비어있지 않아 실패. `if dir` 가드가 빈 항목을 정규화 전에 거르면 집합이 비어 통과. 인과(빈 문자열 → `cwd / "" == cwd` → 루트 watch → 항상 매칭)가 출력 단언으로 직접 닫힘.
- **overfit 관점:** FAIL_TO_PASS가 `engine.dirs` 경로(`DIRS=[""]`)만 직접 검증하고 loader `get_dirs()` 경로의 빈 항목은 별도 케이스로 안 잡는다 → 골드는 loader 측도 함께 고쳤지만(올바른 일반화), 테스트만 보면 `engine.dirs`만 고쳐도 FAIL_TO_PASS는 통과하는 약한 명세. 다만 결함 클래스가 단순(falsy 필터)이라 special-case 과적합 유인은 낮음. `overfit-risk` 플래그는 달지 않되, "절반만 고치기"가 실질 함정.
- **regression 관점:** PASS_TO_PASS 10개가 정상 경로를 방어한다 — `test_template_dirs_normalized_to_paths`/`test_get_template_directories`(비어있지 않은 DIRS의 Path 정규화 유지), `test_template_changed`/`test_non_template_changed`/`test_non_template_changed_in_template_directory`(변경 감지 로직 불변), `test_watch_for_template_changes`/`test_reset_all_loaders`(Jinja2 + Django 양쪽). `if dir` 가드는 truthy 경로를 건드리지 않으므로 전부 그대로 통과. regression-trap은 존재하나 픽스가 좁아 안전.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 `django/template/autoreload.py::template_changed`와 "빈 문자열 → 루트 정규화" 인과, 그리고 정규화 도입 커밋(`68357b2`)을 명시 → 파일 오픈. 증상은 `template_changed`지만, watch 집합을 *생성*하는 곳이 `get_template_directories()`임을 읽고 두 update 호출(`engine.dirs`, loader `get_dirs()`)이 정규화 소스임을 확인.
2. **픽스와 올바른 일반화 이유:** `cwd / to_path("") == cwd`라는 pathlib 동작이 근본. 따라서 *증상 함수(`template_changed`)를 고치는 게 아니라* 오염 소스에서 falsy 항목을 정규화 전에 제거하는 게 최소·정확 수정. 두 제너레이터 모두에 `if dir` / `directory and` 가드 → 빈 문자열이 어느 입력 경로로 들어오든 일관되게 무시. 이게 과적합이 아닌 이유: 결함의 정의가 "falsy DIRS 항목"이고, 두 수집 경로 모두 동일 정의를 공유하므로 둘 다 막는 것이 결함의 일반형을 정확히 덮는다.
3. **regression 안전:** 가드는 falsy에만 작동하므로 정상 경로(비어있지 않은 DIRS, loader 디렉터리)는 byte-identical 동작 유지 → `test_template_dirs_normalized_to_paths`, `test_template_changed`, `test_non_template_changed*` 전부 보존. `is_django_path` 필터를 `directory and ...`로 *선행* AND하여 short-circuit하므로 기존 django-path 제외 로직도 불변.
4. **함정 회피:** (a) 증상 위치(`template_changed`)에 비교 로직 패치를 넣는 오답 — 거기서 막으면 정상 템플릿 변경 감지까지 망가져 PASS_TO_PASS 회귀. 원인은 watch 집합 생성부임을 인과로 이어야 함. (b) `engine.dirs` 한 곳만 고치고 loader `get_dirs()` 경로를 빠뜨리는 절반-픽스 — FAIL_TO_PASS는 통과해도 loader가 빈 경로를 반환하는 케이스에 구멍. 두 제너레이터를 *모두* 패치해야 일반화 완성. 오라클 없는 에이전트는 FAIL_TO_PASS만 보고 `engine.dirs`만 고친 채 종료하기 쉬움.
