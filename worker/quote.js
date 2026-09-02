/** 시세 중계 — 서버에서 나가는 요청에는 CORS가 없다.
 *  프로토타입의 4단 프록시 탐색·경로 기억·오염 방지 로직이 전부 불필요해진다 (NETWORK.md §1~2).
 *  캐시는 Workers Cache API (엣지 공유, 전 사용자 이득). */
import { fetchWithTimeout } from "../core/pool.js";

const UA = "Mozilla/5.0 (compatible; assetmanager/1.0)";
const jparse = t => JSON.parse(String(t).replace(/^﻿/, ""));

/** Cache API 래퍼. 실패 응답은 캐시하지 않는다. */
export async function cached(cacheKey, ttlSec, fn, cacheStore){
  const store = cacheStore || (globalThis.caches && globalThis.caches.default);
  const req = new Request("https://cache.local/" + encodeURIComponent(cacheKey));
  if(store){
    const hit = await store.match(req);
    if(hit) return { ...(await hit.json()), cached: true };
  }
  const value = await fn();
  if(store){
    await store.put(req, new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json", "cache-control": "s-maxage=" + ttlSec } }));
  }
  return { ...value, cached: false };
}

export async function krQuote(code, fetchImpl = fetch){
  const res = await fetchWithTimeout(
    "https://api.finance.naver.com/service/itemSummary.nhn?itemcode=" + encodeURIComponent(code),
    { timeoutMs: 6000, headers: { "user-agent": UA, referer: "https://finance.naver.com/" } });
  if(!res.ok) throw new Error("네이버 HTTP " + res.status);
  const d = jparse(await res.text());
  if(!d || !d.now) throw new Error("시세 없음");
  return { price: +d.now, diff: +d.diff || 0, rate: +d.rate || 0, name: d.nm || "", src: "naver" };
}

export async function krHistory(code, fromISO, toISO, fetchImpl = fetch){
  const f = s => s.replace(/-/g, "");
  const res = await fetchWithTimeout(
    `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(code)}` +
    `&requestType=1&startTime=${f(fromISO)}&endTime=${f(toISO)}&timeframe=day`,
    { timeoutMs: 10_000, headers: { "user-agent": UA, referer: "https://finance.naver.com/" } });
  if(!res.ok) throw new Error("네이버 HTTP " + res.status);
  const rows = JSON.parse((await res.text()).replace(/'/g, '"'));
  return rows.slice(1).filter(r => r && /^\d{8}$/.test(String(r[0])))
    .map(r => [String(r[0]).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"), +r[4]]);
}

async function yChart(sym, range, fetchImpl){
  const res = await fetchWithTimeout(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`,
    { timeoutMs: 8000, headers: { "user-agent": UA } });
  if(!res.ok) throw new Error("Yahoo HTTP " + res.status);
  const r = jparse(await res.text());
  const out = r && r.chart && r.chart.result && r.chart.result[0];
  if(!out) throw new Error("Yahoo 응답 형식 오류");
  return out;
}

export async function usQuote(sym, fetchImpl = fetch){
  const r = await yChart(sym, "5d", fetchImpl);
  const meta = r.meta || {};
  let px = meta.regularMarketPrice, prev = meta.chartPreviousClose || meta.previousClose;
  if(px == null){
    const cl = ((r.indicators.quote[0] || {}).close || []).filter(v => v != null);
    px = cl[cl.length - 1]; prev = cl.length > 1 ? cl[cl.length - 2] : px;
  }
  const diff = px - (prev || px);
  return { price: +px, diff, rate: prev ? diff / prev * 100 : 0, name: sym, src: "yahoo" };
}

export async function usHistory(sym, range, fetchImpl = fetch){
  const r = await yChart(sym, range, fetchImpl);
  const ts = r.timestamp || [], cl = ((r.indicators.quote[0] || {}).close) || [];
  const out = [];
  ts.forEach((t, i) => {
    if(cl[i] == null) return;
    const d = new Date(t * 1000);
    out.push([d.toISOString().slice(0, 10), +cl[i]]);
  });
  return out;
}

export async function fx(fetchImpl = fetch){
  try{
    const res = await fetchWithTimeout("https://api.frankfurter.app/latest?from=USD&to=KRW", { timeoutMs: 5000 });
    const d = await res.json();
    if(d && d.rates && d.rates.KRW) return { USD: +d.rates.KRW, src: "frankfurter" };
  }catch{}
  const q = await usQuote("USDKRW=X", fetchImpl);
  return { USD: q.price, src: "yahoo" };
}
