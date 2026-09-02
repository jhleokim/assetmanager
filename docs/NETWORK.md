# 시세·실거래가 조회 계층 심층 분석

`prototype/index.html` 의 `netFetch()` / `refreshQuotes()` / `estimateProperty()` / `fetchAllHistory()`
네 함수가 체감 속도를 지배한다. **"느리다"의 원인은 회선이 아니라 설계다.**

---

## 1. 왜 느린가 — 왕복 횟수부터 세어보자

### 1-1. `netFetch()` 한 번이 최대 4회 왕복이다

```js
async function netFetch(url){
  const routes = [""].concat(proxyList());        // ["", allorigins, corsproxy, codetabs]
  ...
  for(const p of routes){                          // ← 순차
    const u = p ? (p + encodeURIComponent(url)) : url;
    try{
      const res = await fetch(u, {cache:"no-store", redirect:"follow"});   // ← 타임아웃 없음
      ...
      ST.netRoute = p;
      return t;
    }catch(e){ lastErr = e; }
  }
}
```

브라우저에서 `api.finance.naver.com` 과 `apis.data.go.kr` 직접 호출은 CORS로 **항상** 막힌다.
즉 `routes[0]`(직접)은 매번 확정적으로 실패하는데도 계속 시도한다. 실패한 경로를 기억하는
음성 캐시(negative cache)가 없다.

### 1-2. `refreshQuotes()`는 13개 체인을 순차로 돈다 (샘플 데이터 기준)

```
1 (환율) + 8 (AUTO 종목) + 4 (시장지수) = 13회 순차 netFetch
```

`ST.netRoute` 기억이 첫 성공 후부터 작동하므로 이후 체인은 1왕복으로 줄지만, 그래도
**13번을 하나씩 줄 세워 기다린다.** 프록시 1회 왕복을 1.5초로 잡으면 약 20초.
실사용자가 종목 40개를 등록하면 45체인 → 1분 이상.

동시 실행이 전혀 없다:

```js
for(let i=0; i<list.length; i++){        // ← await 를 루프 안에서
  ...
  const q = ... await krQuote(a.code) : await yQuote(a.code);
}
for(const nm in INDEXES){
  try{ ST.idx[nm] = await yQuote(INDEXES[nm]); }catch(e){}   // ← 지수 4개도 순차
}
```

### 1-3. 실거래가 조회는 6개월 = 6체인 순차 + 매번 전부 재조회

```js
for(let i=0; i<months; i++){
  ...
  const rows = await rtmsTrades(key, lawd, ""+y+String(m).padStart(2,"0"), kind);
  ...
}
```

- 기본 6개월 → **6회 순차**. 각 응답은 `numOfRows=500` XML(강남구급이면 수백 KB).
- **캐시가 전혀 없다.** 2026-03 거래 데이터는 다시는 바뀌지 않는데도, 같은 단지를 두 번
  조회하면 6개월치를 처음부터 다시 받는다. 여기가 가장 크게 낭비되는 지점이다.
- 조기 중단 조건이 인증 오류에만 걸려 있다:
  ```js
  }catch(e){ if(!firstErr){ firstErr = e; } if(/인증|API 오류/.test(e.message)) break; }
  ```
  네트워크 장애면 6개월 × 4경로 = **최대 24회 헛왕복**을 다 돌고서야 실패를 알린다.

### 1-4. `fetchAllHistory()`는 매번 3년치를 통째로 다시 받는다

증분 수신 개념이 없다. 어제 받았어도 오늘 다시 750일치를 처음부터 받는다.
8종목 × 3년치, 역시 순차.

---

## 2. 느린 것보다 나쁜 것 — 세션이 오염된다

`netFetch()`의 성공 판정은 **"HTTP 200이고 본문이 비어있지 않다"** 뿐이다.

```js
if(!res.ok) throw new Error("HTTP " + res.status);
const t = await res.text();
if(!t || !t.trim()) throw new Error("빈 응답");
ST.netRoute = p;        // ← 내용 검증 없이 이 경로를 "성공"으로 확정
```

무료 프록시가 한도 초과 시 흔히 하는 응답이 **`200 OK` + HTML 에러 페이지**다. 그러면:

1. `netFetch`는 성공으로 판정하고 `ST.netRoute = 고장난_프록시` 로 **기억한다.**
2. 호출부의 `jparse(t)` 가 JSON 파싱 실패 → `"시세 없음"` 같은 엉뚱한 메시지로 둔갑한다.
3. 기억된 경로는 매 `netFetch` 앞자리로 재배치되므로, **이후 모든 조회가 고장난 프록시를
   먼저 때린다.** 새로고침 전까지 세션 전체가 오염된다.

실거래가 쪽은 더 조용히 틀린다. `rtmsTrades()`가 HTML을 `DOMParser`로 XML 파싱하면
`parsererror` 검사가 없어 `getElementsByTagName("item")`이 0건을 반환하고, 결국
**"해당 기간 거래 내역이 없습니다"** 라는 사실과 다른 안내가 나간다. 네트워크 장애가
데이터 부재로 보고된다.

---

## 3. 그 밖의 구조적 낭비

| 항목 | 현재 | 문제 |
|---|---|---|
| `cache:"no-store"` | 모든 요청에 일괄 적용 | 과거 일별시세·지난달 실거래가는 **불변 데이터**인데 HTTP 캐시를 스스로 꺼버린다 |
| `ST.netRoute` | 전역 단일 값, 세션 메모리 | 오리진별로 되는 프록시가 다른데 하나로 뭉갠다. 네이버용으로 뽑힌 경로가 data.go.kr에 그대로 쓰인다. 새로고침하면 탐색 비용을 처음부터 다시 낸다 |
| `getFx()` | 프록시 경로 상속 | frankfurter.app은 CORS를 직접 허용한다. 그런데 직전에 네이버가 프록시로 성공했으면 환율까지 굳이 프록시를 경유한다 |
| `yQuote()` | 5일치 차트를 받아 마지막 값만 사용 | 현재가 1개 얻으려고 5일 배열 전체를 내려받는다 |
| RTMS 페이지네이션 | `numOfRows=500` 고정 | `totalCount`를 읽지 않는다. 거래 많은 지역은 조용히 잘린다 |
| 진행 표시 | `status()` 한 줄 | 몇 개 중 몇 개인지, 얼마나 남았는지 알 수 없고 **취소 버튼이 없다** |
| 실패 보고 | `errs[0]` 하나만 | 어떤 종목이 왜 실패했는지 목록을 볼 수 없다 |
| 스테일 표시 | 없음 | 조회 실패 시 `lastPrice()`로 조용히 대체한다. 그게 3일 전 값이어도 표에 "현재가"로 표시된다 |

---

## 4. 개선안 — 효과 큰 순서

### N1. 요청 타임아웃 (체감 개선 1위, 난이도 최하)

지금은 프록시가 응답을 안 주면 브라우저 기본 한계까지 무한정 기다린다. 사용자가 느끼는
"멈춤"의 대부분이 이것이다.

```js
async function attempt(u, ms){
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try{ return await fetch(u, {signal: ac.signal, redirect:"follow"}); }
  finally{ clearTimeout(timer); }
}
// 직접 호출 3초, 프록시 8초 정도
```

### N2. 응답 내용 검증 + 경로 오염 차단 (정확성 문제이기도 함)

`netFetch`에 검증 콜백을 받아, 파싱에 실패하면 **그 경로를 실패로 처리하고 다음 경로로
넘어가게** 한다. 성공한 경로만 기억한다.

```js
async function netFetch(url, {validate, timeoutMs} = {}){
  ...
  const t = await res.text();
  if(!t || !t.trim()) throw new Error("빈 응답");
  if(validate && !validate(t)) throw new Error("응답 형식 오류(경로 불량)");
  rememberRoute(originOf(url), p);
  return t;
}
// 호출부
krQuote:  netFetch(url, {validate: t => { try{ return !!jparse(t).now; }catch{ return false; } }})
rtmsTrades: netFetch(url, {validate: t => t.includes("<response") || t.includes("<item>")})
```

`rtmsTrades`에는 `parsererror` 검사도 추가한다:
```js
if(doc.getElementsByTagName("parsererror").length) throw new Error("XML 응답이 아님(중계 서버 오류)");
```

### N3. 오리진별 경로 기억 + 영속화

```js
// DB.set.routes = { "api.finance.naver.com": "https://corsproxy.io/?url=", ... }
function routesFor(origin){
  const known = (DB.set.routes||{})[origin];
  const all = [""].concat(proxyList());
  return known ? [known].concat(all.filter(p => p !== known)) : all;
}
```
저장해 두면 새로고침 후에도 탐색 비용을 다시 내지 않는다. 실패가 누적된 경로는 일정 시간
후보에서 제외하는 음성 캐시도 같이 둔다.

### N4. 동시 실행 (풀 제한)

13체인을 5개씩 병렬로 돌리면 3웨이브로 끝난다. **약 20초 → 약 5초.**

```js
async function pool(items, worker, limit = 5){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while(i < items.length){ const k = i++; out[k] = await worker(items[k], k); }
  }));
  return out;
}
```
동일 호스트 연타는 차단 위험이 있으므로 호스트별 4~5 정도로 제한하고, 종목·환율·지수는
서로 다른 호스트이므로 **세 그룹을 통째로 병렬**로 띄우는 것이 가장 안전하면서 빠르다.

### N5. 실거래가 월별 캐시 (실거래가 조회 개선 1위)

지난달 이전 데이터는 **불변**이다. `{lawd, ym, kind}` 를 키로 캐시한다.

```js
// 이번 달만 TTL(예: 6시간), 지난달 이전은 영구
const cached = await Cache.get(`RTMS:${lawd}:${ym}:${kind}`);
if(cached && (ym < currentYm() || cached.at > Date.now() - 6*3600e3)) return cached.rows;
```

효과: 6개월 조회가 **첫 회 6요청 → 재조회 1요청**. 같은 단지를 반복 확인하거나 면적만
바꿔 다시 볼 때 사실상 즉시 응답한다. 부동산 탭에서 행을 바꿔 클릭할 때마다 수십 초씩
기다리던 게 사라진다.

용량은 P0-5(localStorage 초과 유실)와 직결되므로 **반드시 IndexedDB에 둔다.**

### N6. 실거래가 월 병렬 + 조기 중단

6개월은 서로 독립적이므로 `pool(months, ..., 3)` 으로 묶는다. 그리고 중단 조건을 넓힌다:

```js
// 인증 오류뿐 아니라, 연속 2개월 실패하면 중단
if(/인증|API 오류/.test(e.message)) break;
if(++consecutiveFails >= 2) break;
```
최대 24회 헛왕복이 4~6회로 줄어든다.

### N7. 페이지네이션

`totalCount`를 읽어 `numOfRows`를 넘으면 추가 페이지를 받는다. 지금은 조용히 잘린 데이터로
시세를 추정하고 있다 — 속도가 아니라 정확성 문제다.

### N8. 일별시세 증분 수신

```js
const have = priceSeries(priceKey(a));
const from = have.length ? addDays(dOf(have[have.length-1][0]), 1) : startOfRange;
if(from >= new Date()) return;            // 오늘치까지 있으면 스킵
const h = await krHistory(a.code, from);  // years → fromISO 로 시그니처 변경
```
3년치 750포인트 재수신이 며칠치로 줄고, P0-5의 용량 압박도 함께 완화된다.

### N9. 불변 응답에 HTTP 캐시 허용

과거 일별시세·지난달 실거래가 요청에서 `cache:"no-store"`를 걷어낸다.
실시간 현재가에만 `no-store`를 남긴다.

### N10. 진행률·취소·실패 목록 UI

- `8/13 · TIGER 미국S&P500` 진행 바 + **취소 버튼**(`AbortController`를 그대로 재사용).
- 조회 후 실패 종목을 표로 보여준다: 종목 / 사유 / 사용된 대체값 / 그 값의 날짜.
- 표의 `현재가` 열에 **기준일**을 함께 표시한다. 3일 전 값이 "현재가"로 보이는 상황을 없앤다.
- 저장된 시세를 먼저 즉시 그리고(이미 `boot()`가 함) 갱신은 백그라운드로 — 즉 첫 화면은
  기다림 없이 뜨게 한다.

### N11. (구조적 해결) 자체 중계 서버

가장 근본적인 해결이자, **P0-4 인증키 유출 문제와 같은 해결책**이다.
Cloudflare Workers / Vercel Edge에 40줄짜리 중계를 두면:

- 홉이 1회로 고정된다 (경로 탐색 자체가 사라짐 → N1·N3 대부분 불필요)
- **인증키를 서버 환경변수에 두고 클라이언트에서 제거**할 수 있다 (P0-4 해결)
- RTMS 월별 응답을 엣지에 캐시해 두면 N5가 사용자 전체에 공유된다
- 무료 프록시의 한도 초과·오염 문제(2절)에서 완전히 벗어난다

---

## 5. 예상 효과

| 작업 | 현재 (순차·캐시 없음) | 개선 후 | 주된 수단 |
|---|---|---|---|
| 시세 갱신 (8종목+환율+지수4) | 13회 순차 ≈ 20초 | 3웨이브 ≈ 5초 | N4 병렬 |
| 시세 갱신 (40종목) | 45회 순차 ≈ 60초+ | ≈ 12초 | N4 |
| 실거래가 6개월 최초 조회 | 6회 순차 ≈ 12~30초 | 2웨이브 ≈ 5초 | N6 병렬 |
| 실거래가 **재조회** | 매번 6회 전체 재수신 | ≈ 0초 (캐시 적중) | **N5 캐시** |
| 일별시세 일괄 수신 | 8종목 × 3년 전체 | 증분 며칠치 | N8 |
| 프록시 무응답 시 | 무한 대기 | 3~8초 후 다음 경로 | N1 타임아웃 |
| 프록시 한도초과 응답 | 세션 전체 오염 | 해당 경로만 제외 | N2 검증 |

*왕복 횟수는 코드에서 그대로 도출한 값이고, 초 단위는 프록시 1왕복 1.5초 가정의 추정치다.*

---

## 6. 착수 순서 제안

1. **N1 타임아웃** + **N2 응답 검증** — 각 20줄 안팎, 위험도 낮고 체감 개선이 가장 크다.
2. **N5 실거래가 캐시** — 부동산 탭 체감이 여기서 결정된다. IndexedDB 도입과 함께.
3. **N4 / N6 병렬화** — 풀 유틸 하나로 시세·실거래가 양쪽에 동시 적용.
4. **N10 진행률·취소·스테일 표시** — 남은 대기 시간을 "설명 가능한" 것으로 바꾼다.
5. **N3 / N8 / N9** — 반복 사용 시 누적 효과.
6. **N11 자체 중계 서버** — 여력이 되면 여기로 수렴시키는 것이 맞다. P0-4도 같이 해결된다.
