/** 과거 시계열 재구성 — 프로토타입의 P0-2 / P0-3 / P0-6 수정본. */
import { addDays, daysBetween, minISO } from "./date.js";
import { evaluate, accrued, accruedInstallment, priceKey, FLAG } from "./valuation.js";

const SELL = new Set(["매도", "출금"]);
const isSell = t => SELL.has(t.side);
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** {key:{iso:price}} → {key:[[iso,price],...]} (정렬 1회만) */
export function indexHistory(history){
  const out = new Map();
  for(const k in (history || {})){
    const rows = Object.entries(history[k])
      .map(([d, p]) => [d, Number(p)])
      .filter(([, p]) => isFinite(p))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if(rows.length) out.set(k, rows);
  }
  return out;
}

/** dateISO 시점의 가장 최근 종가. 그 이전 기록이 없으면 null (앞의 값으로 채우지 않는다). */
export function priceAt(index, key, dateISO){
  const rows = index.get(key);
  if(!rows || !rows.length) return null;
  let lo = 0, hi = rows.length - 1, found = null;
  while(lo <= hi){
    const mid = (lo + hi) >> 1;
    if(rows[mid][0] <= dateISO){ found = rows[mid][1]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;                       // dateISO가 첫 기록보다 이르면 null
}

/**
 * dateISO 시점의 보유수량.
 *
 * 프로토타입 버그(P0-6) 수정: 거래기록 합계가 현재 수량과 다를 때 과거 전체에 배수를
 * 곱하던 것을 없앴다. 대신 차이를 "최초 거래 이전부터 보유하던 수량(opening)"으로 해석한다.
 * 이 편이 거래를 일부만 입력한 실제 사용자에게 정확하다.
 */
export function quantityAt(asset, dateISO, trades){
  const nowQty = Number(asset.qty) || 0;
  const ts = trades.filter(t => t.asset === asset.id).sort(byDate);
  if(!ts.length) return { qty: nowQty, opening: nowQty, consistent: true };

  const net = ts.reduce((s, t) => s + (isSell(t) ? -1 : 1) * (Number(t.qty) || 0), 0);
  const opening = nowQty - net;       // 기록되지 않은 기초 보유분

  // 기초 보유분에서 출발해 시간순으로 굴린다
  let running = opening, atDate = opening, dipped = false;
  for(const t of ts){
    running += (isSell(t) ? -1 : 1) * (Number(t.qty) || 0);
    if(running < -1e-9) dipped = true;          // 그 시점 보유분보다 많이 판 기록
    if(t.date <= dateISO) atDate = running;
  }

  return {
    qty: Math.max(0, atDate),
    opening,
    // opening 음수 = 매수 기록이 현재 보유량을 초과 / dipped = 중간에 보유량이 음수
    consistent: opening >= -1e-9 && !dipped
  };
}

/**
 * dateISO 시점의 투입원금(이동평균 취득원가).
 * 프로토타입은 이 함수 없이 "오늘 원금"을 과거 전 구간에 그대로 꽂았다(P0-2).
 */
export function costBasisAt(asset, dateISO, trades){
  const { opening } = quantityAt(asset, dateISO, trades);
  const ts = trades.filter(t => t.asset === asset.id && t.date <= dateISO).sort(byDate);

  let qty = Math.max(0, opening);
  let cost = qty * (Number(asset.avg) || 0);

  for(const t of ts){
    const q = Number(t.qty) || 0, px = Number(t.price) || 0;
    if(isSell(t)){
      const unit = qty > 0 ? cost / qty : 0;
      const sold = Math.min(q, qty);
      qty -= sold;
      cost -= sold * unit;            // 매도분은 취득원가에서 비례 차감
    }else{
      qty += q;
      cost += q * px;
    }
  }
  return Math.max(0, cost);
}

/**
 * 한 자산의 [기준일 시점] 평가액·원금. 시세 이력이 없으면 정직하게 추정 표시를 남긴다.
 * @returns {{value:number, basis:number, flags:string[]}}
 */
export function valueAtDate(a, dateISO, ctx){
  const { index, trades, fx, todayISO, taxRate } = ctx;
  const mode = String(a.mode || "MANUAL").toUpperCase();
  const cur = String(a.cur || "KRW").toUpperCase();
  const fxr = cur === "KRW" ? 1 : (Number(fx && fx[cur]) || 0);
  const flags = [];

  // 취득일 이전에는 자산이 존재하지 않는다
  if(a.start && dateISO < a.start) return { value: 0, basis: 0, flags };

  if(mode === "AUTO" && a.code){
    const px = priceAt(index, priceKey(a), dateISO);
    const { qty, consistent } = quantityAt(a, dateISO, trades);
    if(!consistent) flags.push("INCONSISTENT_TRADES");
    if(px == null){
      // 그 시점 시세 기록이 없다 — 값을 지어내지 않고 추정으로 표시한다
      flags.push(FLAG.ESTIMATED);
      const cur0 = evaluate(a, { quotes: {}, fx, ref: dateISO, taxRate });
      return { value: cur0.value, basis: costBasisAt(a, dateISO, trades) * fxr, flags };
    }
    return { value: qty * px * fxr, basis: costBasisAt(a, dateISO, trades) * fxr, flags };
  }

  if(mode === "RATE"){
    const p = Number(a.principal) || 0;
    const { interest, flags: f } = accrued({
      principal: p, ratePct: a.rate, start: a.start, end: a.end,
      ref: dateISO, compound: a.compound, taxRate
    });
    flags.push(...f);
    return { value: (p + interest) * fxr, basis: p * fxr, flags };
  }

  if(mode === "INSTALLMENT"){
    const r = accruedInstallment({
      monthly: a.monthly, ratePct: a.rate, start: a.start, end: a.end,
      ref: dateISO, taxRate
    });
    flags.push(...r.flags);
    return { value: (r.principal + r.interest) * fxr, basis: r.principal * fxr, flags };
  }

  // QUOTE(부동산) — 기록된 시세 이력을 그대로 쓴다
  if(a.cls === "부동산" || mode === "QUOTE"){
    const px = priceAt(index, priceKey(a), dateISO);
    if(px != null) return { value: px, basis: Number(a.principal) || 0, flags };
    flags.push(FLAG.ESTIMATED);
  }

  /* MANUAL — 프로토타입은 과거 전 구간에 "오늘 값"을 그대로 넣었다(P0-3).
     취득일과 취득가를 알면 취득가 → 현재가치로 선형 보간하는 편이 훨씬 정직하다.
     보간값임을 ESTIMATED로 표시해 UI가 점선 등으로 구분할 수 있게 한다. */
  const basis = Number(a.principal) || 0;
  const now = Number(a.value) || basis;
  if(a.start && basis > 0 && now !== basis && dateISO < todayISO){
    const span = daysBetween(a.start, todayISO);
    const done = daysBetween(a.start, dateISO);
    if(span > 0){
      const t = Math.min(1, Math.max(0, done / span));
      flags.push(FLAG.ESTIMATED);
      return { value: (basis + (now - basis) * t) * fxr, basis: basis * fxr, flags };
    }
  }
  if(dateISO < todayISO) flags.push(FLAG.ESTIMATED);
  return { value: now * fxr, basis: basis * fxr, flags };
}

/**
 * 전체 포트폴리오의 시계열을 재구성한다.
 * @returns {{dates:string[], asset:number[], debt:number[], net:number[],
 *            basis:number[], byCat:Map<string,number[]>, flags:Set<string>}}
 */
export function reconstruct({ assets, trades = [], history = {}, fx = {}, today,
                              years = 3, stepDays = 7, taxRate = 0 }){
  const index = indexHistory(history);
  const ctx = { index, trades, fx, todayISO: today, taxRate };

  const dates = [];
  let d = addDays(today, -Math.round(365 * years));
  while(d < today){ dates.push(d); d = addDays(d, stepDays); }
  dates.push(today);

  const n = dates.length;
  const asset = new Array(n).fill(0);
  const debt = new Array(n).fill(0);
  const basis = new Array(n).fill(0);
  const byCat = new Map();
  const flags = new Set();

  const live = assets.filter(a => a.active !== 0);
  for(const a of live){
    const isDebt = a.cls === "부채";
    const cat = a.cat || "미분류";
    const arr = isDebt ? null : (byCat.get(cat) || new Array(n).fill(0));

    for(let i = 0; i < n; i++){
      const r = valueAtDate(a, dates[i], ctx);
      r.flags.forEach(f => flags.add(f));
      if(isDebt){
        debt[i] += r.value;
      }else{
        asset[i] += r.value;
        basis[i] += r.basis;          // ← P0-2: 시점별 실제 투입원금
        arr[i] += r.value;
      }
    }
    if(arr) byCat.set(cat, arr);
  }

  return { dates, asset, debt, basis, byCat, flags,
           net: asset.map((v, i) => v - debt[i]) };
}
