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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-15987

## 문제 요약
`settings.FIXTURE_DIRS`의 원소가 `pathlib.Path` 인스턴스일 때, `loaddata` 커맨드의 중복 검사가 앱 기본 fixtures 디렉터리(`app/fixtures`)와의 중복을 탐지하지 못한다. 사용자는 `FIXTURE_DIRS`에 문자열을 넣든 `Path`를 넣든 동일하게 "기본 fixtures 디렉터리는 FIXTURE_DIRS에 나열할 수 없다"는 `ImproperlyConfigured` 에러가 발생하길 기대한다. 하지만 `Path`로 넣으면 `str == Path` 비교가 같은 경로여도 `False`라서 검사가 조용히 통과되고, fixture가 중복 로딩될 수 있다.

## 유형 (정형화)
- **L0 (Localization)** — problem_statement이 "FIXTURE_DIRS", "duplicate check in loaddata", "Path instance"를 직접 지목한다. `loaddata.py`에서 `FIXTURE_DIRS`/`ImproperlyConfigured`를 grep하면 `fixture_dirs` property 안의 `if app_dir in fixture_dirs:` 단 한 줄로 즉시 수렴한다. grep 한 방, 후보 단일.
- **S1 (+S2) (Repair Strategy)** — 정형 결함클래스(타입 강제/동등성 비교 양변 타입 불일치)에 템플릿 매칭되는 기계적 픽스라 dominant는 S1이다. `app_dir`(항상 `str`)과 비교되는 리스트 원소를 `str(d)`로 정규화하면 끝. 다만 "리스트를 str로 맞추나 / app_dir를 Path로 맞추나"의 방향 선택과 "정규화 지점이 동등성 양변 타입 불일치다"라는 인식이 필요해 가벼운 constraint 추론(S2)이 보조로 붙는다. realpath/os.path 정규화 같은 과한 우회가 아니라 타입 일치라는 최소 불변식을 잡는 게 정답이라 S2는 보조 수준.
- **K-Domain (Knowledge)** — 일반 파이썬 `str != Path` 동등성 자체는 K-Gen이지만, 결함이 사는 맥락(django management command `loaddata`, `FIXTURE_DIRS` 설정, `apps.get_app_configs()`로 앱 기본 fixtures 디렉터리를 산출하는 규약)을 알아야 "왜 이 비교가 중복 검사인지"가 잡힌다. 그래서 K-Domain으로 본다(경계 사례).
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 S1 기계적 타입강제 한 줄이다. 이슈가 사실상 픽스를 명세하지만 "픽스를 거의 적어준다"는 T-LocTrivial(T1)보다는, 타입 정규화 방향 선택이라는 소량의 결정이 있어 T-DirectMap이 더 방어가능하다.

## 난이도 티어
**T2 (쉬움).** 미는 피처: 1파일·1줄(헌크 1개) 수정, L0 직접 localize, S1 기계적 픽스, 결함클래스가 정형(타입 동등성). 가벼운 엣지 추론(str/Path 정규화 방향)이 있어 T1보다는 T2.

공식 라벨은 `<15 min fix`(가장 쉬운 구간)로, 구조적 tier T2와 사실상 일치한다. T1로 더 내리지 않은 이유: (a) problem_statement에 재현 코드/스택트레이스가 없다(`has-repro` 미충족, hints_text도 빈 문자열) — 가장 강한 easiness 신호가 빠져 있다. (b) PASS_TO_PASS가 52개로 광범위해 `regression-trap`이 약하게나마 존재한다(fixtures_regress 스위트의 인접 중복 검사·경로 처리 동작을 깨면 안 됨). 이 둘이 "이슈가 픽스를 거의 적어준다"는 T1 전형 프로파일을 한 칸 끌어올린다.

## 골드패치 분석
- **건드린 파일·함수**: `django/core/management/commands/loaddata.py` → `Command.fixture_dirs` (cached property), line 370 부근.
- **근본 원인**: 앱 기본 디렉터리 `app_dir = os.path.join(app_config.path, "fixtures")`(항상 `str`)를 사용자 설정 `fixture_dirs`(= `settings.FIXTURE_DIRS`)에 대해 `if app_dir in fixture_dirs:`로 멤버십 검사했다. 파이썬에서 `in`은 `==`로 원소를 비교하는데, `fixture_dirs`의 원소가 `Path`이면 같은 경로여도 `str.__eq__(Path)`가 `NotImplemented`→`False`가 되어 중복이 누락된다. 결과적으로 떠야 할 `ImproperlyConfigured`가 안 뜨고 fixture가 중복 로딩될 수 있다.
- **수정 요지**: 비교 직전에 리스트 쪽 원소를 문자열로 정규화한다. `if app_dir in fixture_dirs:` → `if app_dir in [str(d) for d in fixture_dirs]:`. `app_dir`가 이미 str이므로 비교 양변을 str로 맞추는 게 최소 변경이며, `Path`/`str` 혼용과 무관하게 경로 문자열 기준으로 중복을 탐지한다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (`"settings.FIXTURE_DIRS cannot contain a default fixtures directory"`, 1개): 신규 테스트 `test_fixture_dirs_with_default_fixture_path_as_pathlib`. 기존 str 버전 `test_fixture_dirs_with_default_fixture_path`의 `Path` 변형으로, `@override_settings(FIXTURE_DIRS=[Path(_cur_dir) / "fixtures"])`로 앱 기본 fixtures 디렉터리를 `Path`로 지정한 뒤 `management.call_command("loaddata", "absolute.json", verbosity=0)`를 호출한다.
- **픽스 증명**: 기대 메시지는 `os.path.join(_cur_dir, "fixtures")`/`"fixtures_regress"`가 박힌 `ImproperlyConfigured`이며 `assertRaisesMessage`로 잡는다. 픽스 전에는 `app_dir(str) in [Path(...)]`가 `False`라 에러가 안 떠 테스트가 실패하고, 픽스 후 `[str(d) for d in fixture_dirs]` 정규화로 매칭되어 에러가 떠 통과한다. 테스트가 정확히 결함 라인의 동작(타입 정규화 멤버십)을 관찰한다.
- **overfit 관점**: 신규 테스트는 `Path` 케이스만 직접 커버하므로 단독으로는 얇다. 그러나 픽스가 special-case(`isinstance(... , Path)` 분기)가 아니라 모든 원소를 `str(d)`로 일률 정규화하는 일반해라 overfit 위험은 낮다. PASS_TO_PASS의 str 버전 `test_fixture_dirs_with_default_fixture_path`와 짝을 이뤄 str/Path 양쪽을 잠근다.
- **regression 관점**: 52개 PASS_TO_PASS(특히 `"settings.FIXTURE_DIRS cannot contain duplicates"`, `test_fixtures_dir_pathlib`, `test_relative_path_in_fixture_dirs`, `test_loaddata_with_valid_fixture_dirs`)가 인접 중복/경로 처리 동작을 안 깨는지 보장한다. `str(d)`는 str 원소에 대해 idempotent라(이미 str→str) 기존 str 경로 동작이 byte-동일하게 유지된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 직접 신호("FIXTURE_DIRS", "duplicate check in loaddata", "Path instance")로 `django/core/management/commands/loaddata.py`를 연다. `FIXTURE_DIRS`/`ImproperlyConfigured`/"default fixture directory"를 grep하면 `fixture_dirs` property에서 앱들을 순회하며 `if app_dir in fixture_dirs:`로 비교하는 단 한 라인이 유일한 중복-검사 지점이다.
2. **픽스와 왜 올바른 일반화인지**: 같은 경로라도 `str == Path`가 `False`임을 인지하고, 비교 양변의 타입을 일치시킨다. `app_dir`가 항상 str이므로 리스트 쪽을 `[str(d) for d in fixture_dirs]`로 정규화하는 게 최소·정확한 변경이다. `isinstance` 분기로 Path만 특수처리하는 건 special-case overfit이고, `str(d)`는 str·Path·os.PathLike 전반을 일률 처리하므로 입력 타입 공간 전체로 일반화된다.
3. **regression 안전**: str 원소에는 `str(d)`가 idempotent라 기존 str 기반 중복 검사/경로 동작(PASS_TO_PASS의 `"...cannot contain duplicates"`, `test_relative_path_in_fixture_dirs`, `test_loaddata_with_valid_fixture_dirs` 등)을 깨지 않는다. 메시지 포맷·예외 타입을 그대로 두는 것도 기존 str 테스트의 `assertRaisesMessage`를 보존하는 핵심이다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `str == Path`가 False라는 타입 인식을 놓치고 `os.path.realpath`/normalize로 우회하려 들면 본질을 벗어나 인접 동작을 깰 수 있다. (b) 정규화 방향을 거꾸로 잡아 `app_dir`를 Path로 바꾸면 비교 상대(사용자 입력)가 여전히 혼용이라 안 맞는다 — str(이미 보장된 타입)로 통일하는 게 맞다. (c) 같은 property 안의 `FIXTURE_DIRS` 자체 내부 중복 검사도 str/Path 혼용 위험이 있어 보이지만, 골드는 기본 디렉터리 비교만 손댄다 — FAIL_TO_PASS가 요구하는 최소 범위를 넘어 과수정하면 다른 P2P를 흔들 수 있으니 범위를 지킨다.
