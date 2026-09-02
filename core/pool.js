/** 동시 실행 제한 + 타임아웃 — 브라우저와 Worker 양쪽에서 쓴다.
 *  프로토타입의 순차 조회(P1-5)와 무한 대기(타임아웃 없음)를 대체한다. */

/**
 * items를 limit개씩 동시에 처리한다. 입력 순서대로 결과를 돌려준다.
 * 개별 실패가 전체를 중단시키지 않는다 — {ok, value|error} 형태로 감싼다.
 */
export async function pool(items, worker, limit = 5){
  const list = Array.from(items);
  const out = new Array(list.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while(true){
      const i = next++;
      if(i >= list.length) return;
      try{ out[i] = { ok: true, value: await worker(list[i], i) }; }
      catch(e){ out[i] = { ok: false, error: e }; }
    }
  });
  await Promise.all(runners);
  return out;
}

/** AbortController 기반 타임아웃. 프로토타입에는 이게 없어 무한 대기했다. */
export async function fetchWithTimeout(url, { timeoutMs = 8000, ...init } = {}){
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if(init.signal) init.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try{
    return await fetch(url, { ...init, signal: ac.signal });
  }catch(e){
    if(e.name === "AbortError") throw new Error(`요청 시간 초과 (${timeoutMs}ms)`);
    throw e;
  }finally{
    clearTimeout(timer);
    if(init.signal) init.signal.removeEventListener("abort", onAbort);
  }
}

/** 지난달 이전처럼 변하지 않는 자료인지 판단 — 캐시 수명을 정하는 데 쓴다 */
export function isClosedMonth(ym, todayISO){
  const cur = todayISO.slice(0, 7).replace("-", "");
  return String(ym) < cur;
}

/** today 기준으로 최근 n개월의 YYYYMM 목록 (최신순) */
export function recentMonths(todayISO, n){
  const [y0, m0] = todayISO.split("-").map(Number);
  const out = [];
  for(let i = 0; i < n; i++){
    let y = y0, m = m0 - i;
    while(m <= 0){ m += 12; y -= 1; }
    out.push("" + y + String(m).padStart(2, "0"));
  }
  return out;
}
