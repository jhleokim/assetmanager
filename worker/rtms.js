/** 국토교통부 실거래가 중계 + 월별 캐시.
 *  - serviceKey는 env.RTMS_KEY(secret). 클라이언트는 키를 모른다 (P0-4 해결)
 *  - 지난달 이전은 불변이므로 D1에 영구 캐시, 이번 달은 TTL (NETWORK.md N5)
 *  - 월별 동시 조회 (N6), totalCount 기반 페이지네이션 (N7)
 *  - 추정은 평균이 아니라 IQR 이상치 제거 후 중위값 (P1-7) */
import { parseRtms, normalizeDeal } from "./xml.js";
import { pool, fetchWithTimeout, isClosedMonth, recentMonths } from "../core/pool.js";

export const RTMS_PATH = {
  "아파트":     "RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade",
  "오피스텔":   "RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade",
  "연립다세대": "RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade",
  "단독/다가구": "RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade",
  "토지":       "RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade"
};
export const OPEN_MONTH_TTL_MS = 6 * 3600_000;
const ROWS = 1000;

/** 한 달치를 API에서 전부 받는다 (페이지네이션 포함) */
export async function fetchMonthFromApi({ lawd, ym, kind, key, fetchImpl = fetch, timeoutMs = 10_000 }){
  if(!key) throw new Error("서버에 RTMS_KEY가 설정되지 않았습니다");
  const path = RTMS_PATH[kind] || RTMS_PATH["아파트"];
  const base = `https://apis.data.go.kr/1613000/${path}?serviceKey=${encodeURIComponent(key)}` +
               `&LAWD_CD=${encodeURIComponent(lawd)}&DEAL_YMD=${ym}&numOfRows=${ROWS}`;
  const deals = [];
  for(let page = 1; page <= 20; page++){          // 안전 상한
    const res = await fetchWithTimeout(base + "&pageNo=" + page, { timeoutMs, cf: { cacheTtl: 0 } });
    if(!res.ok) throw new Error("실거래가 API HTTP " + res.status);
    const { items, totalCount } = parseRtms(await res.text());
    for(const it of items){ const d = normalizeDeal(it, ym); if(d) deals.push(d); }
    if(page * ROWS >= totalCount || items.length === 0) break;   // ← 프로토타입은 500건에서 잘렸다
  }
  deals.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return deals;
}

/** 캐시를 거쳐 한 달치를 얻는다 */
export async function getMonth({ db, lawd, ym, kind, key, today, fetchImpl, now = Date.now() }){
  const cacheKey = `${lawd}:${ym}:${kind}`;
  const closed = isClosedMonth(ym, today) ? 1 : 0;
  const row = await db.prepare("SELECT deals, closed, fetched_at FROM rtms_cache WHERE cache_key = ?")
                      .bind(cacheKey).first();
  if(row && (row.closed || now - row.fetched_at < OPEN_MONTH_TTL_MS))
    return { deals: JSON.parse(row.deals), cached: true };

  const deals = await fetchMonthFromApi({ lawd, ym, kind, key, fetchImpl });
  await db.prepare(`INSERT INTO rtms_cache (cache_key, lawd, ym, kind, deals, n, closed, fetched_at)
                    VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(cache_key) DO UPDATE SET deals=excluded.deals, n=excluded.n,
                      closed=excluded.closed, fetched_at=excluded.fetched_at`)
          .bind(cacheKey, lawd, ym, kind, JSON.stringify(deals), deals.length, closed, now).run();
  return { deals, cached: false };
}

/** 최근 n개월을 동시에 (실패한 달은 건너뛰되 첫 오류를 보고) */
export async function getMonths({ db, lawd, kind, months, key, today, fetchImpl, concurrency = 3 }){
  const yms = recentMonths(today, months);
  const results = await pool(yms, ym => getMonth({ db, lawd, ym, kind, key, today, fetchImpl }), concurrency);
  const deals = [], errors = [];
  let cachedMonths = 0;
  results.forEach((r, i) => {
    if(r.ok){ deals.push(...r.value.deals); if(r.value.cached) cachedMonths++; }
    else errors.push({ ym: yms[i], error: r.error.message });
  });
  // 인증 오류처럼 전부 실패하면 첫 오류를 그대로 올린다
  if(!deals.length && errors.length) throw new Error(errors[0].error);
  deals.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { deals, errors, months: yms, cachedMonths };
}

/* ── 추정 ─────────────────────────────────────────────────────────────── */
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** IQR 밖의 값을 이상치로 뺀다 (급매·증여성 거래 방어) */
export function trimOutliers(values){
  if(values.length < 4) return values;
  const s = [...values].sort((a, b) => a - b);
  const q1 = s[Math.floor(s.length * 0.25)], q3 = s[Math.floor(s.length * 0.75)];
  const iqr = q3 - q1, lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  return values.filter(v => v >= lo && v <= hi);
}

/**
 * 단지명·면적으로 매칭해 시세를 추정한다.
 * 프로토타입(단순 평균)과 달리: 이상치 제거 → 중위값. 표본 수·범위도 함께 돌려준다.
 */
export function estimate(deals, { complex = "", area = 0, areaTol = 3 } = {}){
  const key = complex.replace(/\s/g, "");
  let matched = deals.filter(d =>
    (!key || d.name.replace(/\s/g, "").includes(key)) &&
    (!area || Math.abs(d.area - area) <= areaTol));
  if(!matched.length && key) matched = deals.filter(d => d.name.replace(/\s/g, "").includes(key));
  if(!matched.length) return { summary: null, matched: [], msg: "단지명·면적이 일치하는 거래를 찾지 못했습니다 (조회 " + deals.length + "건)" };

  const units = matched.map(d => d.unit).filter(u => u > 0);
  const kept = trimOutliers(units);
  const unit = median(kept.length ? kept : units);
  const value = area ? unit * 10000 * area : median(matched.map(d => d.amount));
  return {
    matched,
    summary: {
      value: Math.round(value / 10000) * 10000,
      n: matched.length, outliers: units.length - kept.length,
      unitMedian: unit,
      unitMin: Math.min(...(kept.length ? kept : units)),
      unitMax: Math.max(...(kept.length ? kept : units)),
      lastDate: matched[0].date, lastAmount: matched[0].amount
    },
    msg: ""
  };
}
