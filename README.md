# 가족 통합 자산관리 시스템

가족 단위의 금융자산·부동산·실물자산·부채를 한 화면에서 관리하는 단일 파일 웹 앱.
외부 라이브러리 없이 순수 HTML/CSS/JS + 자체 SVG 차트로 구현되어 있고, 데이터는
브라우저 localStorage에만 저장된다.

## 구성

```
app/          프런트엔드 (ES 모듈, 빌드 도구 없음)      → Workers Assets 로 서빙
  main.js       화면 전체. 표는 core/html.table, 인라인 onclick·innerHTML 없음 (CSP 호환)
  store.js      IndexedDB 원본 + 종단간 암호화 동기화 (병합·묘비)
  api.js        /api 클라이언트 (같은 오리진, CORS 없음)
  charts.js     SVG 차트 (프로토타입에서 추출, innerHTML 제거)
  core/         빌드 시 ../core 에서 복사 (git 제외)
core/         평가·집계·시계열·암호화·안전 DOM — 순수 모듈, 브라우저·Worker 공용
worker/       Cloudflare Worker: Access JWT 검증 · 암호문 봉투 동기화 · 시세/실거래가 중계+캐시
  schema.sql    D1 — 자산 테이블 없음. 가구별 암호문 봉투 + 실거래가 캐시만
tools/        build.js (core→app 복사) · smoke.js (Chromium 종단 검증) · compare-legacy.js
docs/         ANALYSIS · NETWORK · MULTIUSER · DATA-PRIVACY · DEPLOY
prototype/    최초 단일 파일 프로토타입 (기준선, 실사용 비권장)
```

```bash
npm test        # 단위 테스트 121개 (node --test, 의존성 0)
npm run smoke   # 실제 Chromium에서 잠금→E2EE→XSS→렌더 28항목 검증
npm run deploy  # wrangler deploy  (절차: docs/DEPLOY.md)
```

## 구조 한 장

```
브라우저
  ├── IndexedDB        자산 원본 (평문, 이 기기 안에서만)
  ├── core/            평가·집계 — 서버 계산 불필요
  └── AES-GCM          잠금 암호 → PBKDF2 600,000회 → 키 (추출 불가, IndexedDB 보관)
        │  암호문 봉투만
        ▼
  Worker ── Cloudflare Access (Google/이메일 OTP, 비밀번호 저장 없음)
        ├── /api/vault    봉투 저장 · 낙관적 버전     → D1
        ├── /api/quote    시세 중계 (개인정보 없음)   → Cache API
        └── /api/rtms     실거래가 중계 · 월별 캐시   → D1   (인증키는 서버 secret)
```

## 분석 항목 ↔ 처리 현황

| 항목 | 상태 | 어디서 |
|---|---|---|
| P0-1 예금 이자 만기 무시 / 적금 과대 | ✅ | `core/valuation.js` `accrued`·`accruedInstallment` |
| P0-2 투입원금 추이 미계산 | ✅ | `core/timeseries.js` `costBasisAt` |
| P0-3 MANUAL 과거값 = 오늘 값 | ✅ | `valueAtDate` 보간 + `ESTIMATED` 배지 |
| P0-4 인증키 프록시 유출 | ✅ | 서버 secret (`wrangler secret put RTMS_KEY`), 클라이언트 제거 |
| P0-5 localStorage 초과 유실 | ✅ | IndexedDB + 서버 봉투 |
| P0-6 보유수량 임의 재조정 | ✅ | `quantityAt` 기초보유분 해석 + 모순 감지 |
| P1-1 LTV 혼입 | ✅ | `loanToValue` 담보 연결 기준 |
| P1-2 대출 이중계상 | ✅ | `resolveLoanLinks` + 자산 `secures` 필드 |
| P1-3 원금 미상 → 수익 부풀림 | ✅ | `totals.unknownBasis` |
| P1-4 통화 혼재 / 취득 환율 | ✅ | `fxAtCost`, 열에 통화 표기 |
| P1-5 순차 조회·타임아웃 없음 | ✅ | 서버 1회 왕복 + `pool` + `fetchWithTimeout` |
| P1-5b 프록시 오염 | ✅ | 프록시 자체 제거 |
| P1-6 비공식 API 의존 | ⚠️ 유지 | 서버 중계로 격리했으나 출처는 같음. 대체 소스 미확보 |
| P1-7 실거래가 단순 평균 / 500건 잘림 | ✅ | IQR 이상치 제거 → 중위값, `totalCount` 페이지네이션 |
| P1-8 시세 이력 고아 데이터 | ⚠️ 부분 | 삭제 시 RE: 키만 정리. 종목 이력은 공유라 유지 |
| P1-9 셀 편집마다 전체 렌더 | ⚠️ 유지 | 구조는 같음. 자산 수백 건 규모에서 재검토 |
| P1-10 실패 목록 없음 | ✅ | 자산 목록 하단 실패 목록 + 시세 기준일 배지 |
| P2-1 단일 파일·테스트 0 | ✅ | 모듈 분리, 단위 121 + 종단 28 |
| P2-2 스키마 마이그레이션 | ✅ | `store.js migrate` (v1→v2) |
| P2-3 가져오기 검증 부재 | ✅ 부분 | 병합 방식 + 가져오기 전 자동 백업. 필드 타입 검증은 아직 |
| P2-7 → P0 XSS | ✅ | `innerHTML` 0곳, `h()`가 `on*`·`javascript:` 거부, CSP `script-src 'self'` |
| P3 접근성·키보드 | ✅ 부분 | 행 tabindex, Enter/↑↓/Delete, role=tab. 색상 외 표시는 배지로 일부 |
| P3 한국식 금액 입력 | ✅ | `pnum("1.2억")` |
| P3 스냅샷 중복 | ✅ | 하루 1건 |

## 진행 상황

- [x] 프로토타입 문제 분석 ([ANALYSIS.md](docs/ANALYSIS.md))
- [x] 시세·실거래가 조회 계층 분석 ([NETWORK.md](docs/NETWORK.md))
- [x] 다중 사용자 전환 설계 ([MULTIUSER.md](docs/MULTIUSER.md)) — 인증은 Cloudflare Access
- [x] 자산 데이터 보관 방식 ([DATA-PRIVACY.md](docs/DATA-PRIVACY.md)) — 로컬 우선 + 종단간 암호화
- [x] 계산 로직 분리 + P0/P1 계산 버그 수정 (`core/`)
- [x] XSS 정리 — `innerHTML` 제거, 안전 DOM 빌더, CSP
- [x] Worker + D1 — Access JWT, 봉투 동기화, 실거래가 월별 캐시, 시세 중계
- [x] 프런트 이전 — IndexedDB, E2EE 동기화, 잠금 화면, 가족 초대
- [ ] 실제 배포 후 네이버·Yahoo 엔드포인트가 Workers 발신 IP에서 응답하는지 확인 (P1-6)
- [ ] 부채 원리금균등 상환 스케줄 (잔액 자동 감소)
- [ ] 구성원별 열람 범위 (현재는 가구 단위 전체 공유)

## 기능

| 탭 | 내용 |
|---|---|
| 대시보드 | 총자산·부채·순자산·손익 카드, 카테고리 도넛/막대, 소유자별 누적막대 |
| 자산 목록 | 빠른 추가, 셀 더블클릭 인라인 편집, 상세 입력 모달 |
| 카테고리별 | 카테고리·소유자별 집계와 드릴다운 |
| 주식·ETF | 계좌 분산 종목 통합, 트리맵, 종목별 시세 차트 + 매매기록 |
| 부동산 | 국토교통부 실거래가 조회(data.go.kr), 시세 반영, 시세 추이 |
| 자산 추이 | 시세 이력 기반 추정 시계열 / 스냅샷 기반 실측 시계열 |
| 시장 지수 | S&P 500, NASDAQ 100, KOSPI, KOSDAQ |
| 설정 | 프록시·인증키, JSON/CSV 내보내기, 샘플 데이터 |

## 실행

```
open prototype/index.html
```

빌드 과정이 없다. 파일을 브라우저로 열면 된다.

## 데이터 취급

가족 자산 정보는 법적 의미의 "민감정보"는 아니지만(개인정보보호법 제23조 목록에 없음),
가족 전체의 순자산·계좌·부동산이 한곳에 모이는 데이터다. 보관 설계는
[`DATA-PRIVACY.md`](docs/DATA-PRIVACY.md)에 정리했다.

**결정**: 자산 원본은 브라우저(IndexedDB)에 두고, 서버에는 **브라우저에서 암호화한
blob만** 올린다. 서버는 내용을 읽을 수 없다. 시세·실거래가 중계는 개인정보를
전혀 다루지 않으므로 서버가 그대로 담당한다.

프로토타입 사용 시 주의:
- 자산 정보는 브라우저 localStorage에만 저장되며 서버로 전송되지 않는다.
- 다만 **시세·실거래가 조회는 외부 CORS 프록시를 경유**하며, 이때 공공데이터포털
  인증키가 그 서버를 통과한다 (ANALYSIS.md P0-4). 서버 중계로 옮기면 해결된다.
- 브라우저 저장소는 캐시 삭제·용량 초과로 사라질 수 있다. JSON 백업을 별도 보관할 것.
