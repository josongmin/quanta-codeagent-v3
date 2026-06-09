# E2E 헬게이트 확장 계획 (2026-06-10)

베이스라인: [e2e-test-catalog.md](e2e-test-catalog.md) (195개 전수).
4개 렌즈(미커버 모듈 / 조합 매트릭스 / 표면 격차 / 적대 패턴 비대칭)로 갭 사냥 후,
상위 후보의 사실 주장을 grep으로 직접 검증해 false-gap을 걸러낸 결과.

각 항목: **기능** + **왜**(어떤 버그 클래스를 잡나) + **ROI**.

## Tier 1 — 즉시 (보안·데이터손실, 사실 검증 완료)

### 1. trust-scope 파일 레지스트리 — 2-프로세스 동시 grant 레이스
- **기능**: `src/permission/trust-scope-store.ts` 두 프로세스가 동시에 `grant()` → flush 시 last-write-wins로 승인 유실/오염 검증. 기존 hell 테스트는 순차 50회뿐, `Promise.all`/멀티프로세스 없음(검증됨).
- **왜**: 승인 결정 유실 = 권한 게이트 우회 또는 불필요 재확인. session-envelope에는 10k 동시쓰기 패턴이 있는데 **권한 저장소에는 없음** — 비대칭.
- **ROI**: 높음. 보안 데이터의 TOCTOU. 기존 jsonl-retention-hell의 멀티프로세스 하네스 재사용 가능 → 구현 싸다.

### 2. config-migration — 적대적 symlink `.claude` 트리
- **기능**: `.claude/` 내부 파일이 `~/.ssh/` 등으로 symlink된 트리에서 detect→convert→persist 수행 시 jail 검증.
- **왜**: fs-jail·mention은 symlink 탈출을 닫았는데 **migration write 경로는 미적용** — path-traversal write로 임의 파일 덮어쓰기 가능성.
- **ROI**: 높음. 외부(경쟁사) 설정 트리는 본질적으로 불신 입력. fs-jail-e2