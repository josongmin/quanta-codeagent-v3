---
instance_id: sphinx-doc__sphinx-8721
repo: sphinx-doc/sphinx
base_commit: 82ef497a8c88f0f6e50d84520e7276bfbf65025d
version: "3.5"
difficulty: "<15 min fix"
created_at: 2021-01-21T15:36:24Z
fail_to_pass: 1
pass_to_pass: 3
gold_files: [sphinx/ext/viewcode.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`sphinx.ext.viewcode`가 `make html epub`로 빌드할 때, `viewcode_enable_epub=False`(기본값)임에도 epub용 모듈 소스 페이지(`_modules/*.xhtml`)를 생성한다. 기대 동작은 기본적으로 epub에는 viewcode 페이지를 만들지 않는 것이다. 이슈는 재현 명령(`make html epub`)과 기대 동작을 명확히 적어주고 있어 결함 위치가 좁다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `viewcode`/`viewcode_enable_epub`/`epub`을 직접 지목 → `sphinx/ext/viewcode.py` 단일 파일로 즉시 수렴. 다만 "페이지 생성"의 진입점이 `doctree_read`인지 `collect_pages`인지는 약간의 코드 독해가 필요하므로 L0가 아닌 L1.
- **S1 Direct-Map (+S5 보조)**: 픽스는 `collect_pages` 진입부에 빌더명 기반 early-return 가드를 추가하는 기계적 패턴. 동일 가드가 같은 파일 `doctree_read`(line 57~59)에 이미 존재하므로, 올바른 조건식을 새로 *합성*할 필요 없이 그대로 미러링하면 됨. "기본값이면 epub 제외"라는 의도는 코드만으로 자명하지 않고 config 기본값·관례에서 읽어야 해 S5를 보조로 표기.
- **K-Domain**: Sphinx 빌더 lifecycle(`doctree-read` 이벤트 vs `html-collect-pages`로 호출되는 `collect_pages`)과 빌더명 규약(`"singlehtml"`, `"epub"` prefix)을 알아야 정확히 어디에 가드를 둘지 판단 가능.
- **primary = T-DirectMap**: 위치가 좁고(L1) 픽스가 기존 가드 미러링이라는 기계적 매핑(S1)이라 dominant는 DirectMap. APR 관점에서 "동일 결함클래스의 정합성 패치"(PAR/TBar류 template) — 다른 진입점에 누락된 동일 가드를 복제.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일·실질 4줄 추가, has-repro 존재, localize 직접성 높음. 공식 라벨 `<15 min fix`와 일치. T1이 아닌 이유는 두 가지: (1) 픽스 위치가 이슈가 적은 `doctree_read`가 아니라 페이지를 실제로 *yield*하는 `collect_pages`라서 "두 진입점이 있다"는 도메인 사실을 알아야 함(순진하게 `doctree_read`만 보면 이미 가드가 있어 false-negative), (2) `singlehtml` 케이스까지 동시에 막는 가드를 함께 넣는 게 정답이라 PASS_TO_PASS(`test_viewcode_epub_enabled`)를 깨지 않는 조건 정밀도가 요구됨(약한 regression-trap).

## 골드패치 분석
- **건드린 파일·함수**: `sphinx/ext/viewcode.py` 의 `collect_pages(app)` 진입부.
- **근본원인**: `doctree_read`는 `app.builder.name == "singlehtml"` / `epub prefix && not viewcode_enable_epub`일 때 early-return해 viewcode 참조 노드 주입을 막지만, 실제 소스 페이지를 생성·yield하는 `collect_pages`에는 그 가드가 **누락**되어 있었다. 그래서 epub 빌드 시 페이지 생성 경로가 그대로 실행됨.
- **수정요지**: `env._viewcode_modules` 존재 체크 직후에
  ```python
  if app.builder.name == "singlehtml":
      return
  if app.builder.name.startswith("epub") and not env.config.viewcode_enable_epub:
      return
  ```
  두 가드를 추가. `doctree_read`의 조건식과 byte-identical하게 미러링해 두 진입점의 정책을 일치시킴.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_viewcode_epub_default`: `epub` 빌더로 `build_all()` 후 `_modules/spam/mod1.xhtml`이 **존재하지 않아야** 통과. 패치 전엔 파일이 생성되어 실패, 가드 추가 후 early-return으로 생성 안 되어 통과 → 픽스가 정확히 페이지 생성 억제를 증명.
- **PASS_TO_PASS** `test_viewcode_epub_enabled`(confoverride `viewcode_enable_epub=True`)는 파일이 **존재해야** 통과 — `and not env.config.viewcode_enable_epub` 절 덕분에 enable 시엔 가드를 통과해 정상 생성. `test_linkcode`/`test_local_source_files`는 html 경로라 영향 없음.
- **overfit 관점**: 두 epub 테스트가 default-off/override-on 양방향을 검증하므로 "무조건 epub 막기" 같은 과적합 패치는 `test_viewcode_epub_enabled`에서 즉시 적발됨. overfit-risk 낮음. 다만 `singlehtml` 가드는 추가 테스트 없이 들어가 직접 검증은 안 됨(이슈 본문 의도 기반).

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `viewcode` + `viewcode_enable_epub` 키워드 → `sphinx/ext/viewcode.py` grep. `viewcode_enable_epub` 사용처를 찾으면 `doctree_read`엔 이미 가드가 있음을 발견. "그런데 왜 페이지가 생기지?" → 페이지를 실제로 만드는 `collect_pages`(html-collect-pages 콜백)로 추적해 거기엔 가드가 없음을 확인.
2. **픽스 & 일반화**: `doctree_read`의 조건식을 `collect_pages` 진입부에 그대로 복제. 이게 올바른 일반화인 이유 — 정책(어떤 빌더에서 viewcode를 끌지)이 한 군데(`doctree_read`)에만 있어 진입점 간 불일치가 버그의 본질이므로, 동일 조건을 미러링하는 게 ad-hoc 특수처리가 아니라 정책 정합화다.
3. **regression 안전**: `and not env.config.viewcode_enable_epub`를 반드시 포함해야 `viewcode_enable_epub=True`(P2P `test_viewcode_epub_enabled`)에서 페이지가 살아남는다. html 빌더는 두 조건 모두 거짓이라 영향 0 → 일반 viewcode 테스트 불변.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답 — (a) `doctree_read`에 이미 가드가 있는 걸 보고 "이미 처리됨"으로 오판하고 종료(실제 페이지 생성 경로 `collect_pages`를 못 찾음), (b) `viewcode_enable_epub` 절을 빠뜨려 enable 케이스까지 막아 P2P 깨짐, (c) `singlehtml` 가드를 누락(테스트엔 안 잡히나 이슈 의도엔 어긋남). 회피법: config 사용처가 아니라 *페이지를 yield하는 경로*를 기준으로 localize하고, 기존 가드 조건식을 정확히 복제할 것.
