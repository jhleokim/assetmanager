/** 가계부 계산 — 순수 함수. DOM·저장소·시간에 의존하지 않는다 (today는 인자로 받는다).
 *
 *  설계 근거: docs/LEDGER.md. 요약하면
 *   1. 거래는 하나의 표(entries)에 날짜·금액·대분류·소분류로 기록한다. 월별 화면은 그 표를 잘라 보는 뷰다.
 *   2. 종류(kind)는 수입·저축·지출 셋 + 이체. 저축은 지출이 아니다. 이체(카드대금 결제, 내 계좌 간 이동)는
 *      어느 합계에도 들어가지 않는다 — 넣으면 이중 계산이 된다.
 *   3. 항등식  수입 − 지출 − 저축 = 잔여  가 항상 성립한다. 화면은 이 식을 그대로 보여준다.
 *   4. 회계월은 시작일(startDay)로 정한다. 25일 시작이면 1/25~2/24 가 "2026-01" 기간이다.
 *   5. 예비비는 별도 주머니다. 넣는 돈은 저축(저축/예비비), 쓰는 돈은 지출(예비비/분류)로 적되
 *      월 지출과 분리해 보여주고, 순저축 = 저축 − 예비비 지출 로 되돌린다.
 *   6. 고정지출은 매달 다시 치지 않는다. 규칙(recurring)에서 기간별로 한 번만 만든다. */
import { dOf, isoOf, addDays, daysBetween } from "./date.js";

export const KINDS = ["income", "saving", "expense", "transfer"];
export const KIND_LABEL = { income: "수입", saving: "저축", expense: "지출", transfer: "이체" };
export const FUND_CAT = "예비비";          // 예비비 지출의 대분류 (소분류 = 예비비 분류)
export const FUND_SUB = "예비비";          // 예비비 입금 = 저축/예비비
export const TRANSFER_SUBS = ["카드대금", "계좌 간 이동", "기타"];

/** 디어나 가계부 ver7.1.0 [설정] 시트의 기본 분류를 그대로 옮긴 초기값 */
export function defaultSettings(){
  return {
    startDay: 1,
    methods: ["신용카드", "체크카드", "현금", "계좌이체"],
    tags: ["소비", "투자", "반성"],
    cats: [
      { name: "수입",     kind: "income",  subs: ["월급", "상여금", "부수입"] },
      { name: "저축",     kind: "saving",  subs: ["적금", "예금", "투자통장", "대출상환", FUND_SUB] },
      { name: "고정지출", kind: "expense", fixed: true, subs: ["주거비", "보험료", "통신비", "교통비"] },
      { name: "식비",     kind: "expense", subs: ["마트", "편의점", "외식"] },
      { name: "용돈",     kind: "expense", subs: ["A용돈", "B용돈"] },
      { name: "생활용품", kind: "expense", subs: ["생필품/소모품", "수리비", "주방/욕실"] },
      { name: "의복/미용", kind: "expense", subs: ["의류", "뷰티", "헤어"] },
      { name: "육아비",   kind: "expense", subs: ["분유", "기저귀", "의류", "소모품"] },
      { name: "건강",     kind: "expense", subs: ["병원/약국", "영양제", "운동비"] },
      { name: "자기계발", kind: "expense", subs: ["강의", "책", "응시료 등"] },
      { name: "경조사",   kind: "expense", subs: ["가족", "지인"] },
      { name: FUND_CAT,   kind: "expense", fund: true, subs: ["건강", "여행", "경조사"] }
    ],
    budgets: {},        // 월 예산 { "식비": 600000, "_expense": 2500000, "_saving": 3000000, "_income": 7700000 }
    fundBudgets: {}     // 예비비 분류별 연 예산 { "여행": 2000000 }
  };
}

/* ── 분류 ─────────────────────────────────────────────────────────────── */
export const catOf = (settings, name) => (settings.cats || []).find(c => c.name === name) || null;
export function kindOf(settings, catName){
  if(catName === "이체") return "transfer";
  const c = catOf(settings, catName);
  return c ? c.kind : null;
}
export const isFixedCat = (settings, catName) => !!(catOf(settings, catName) || {}).fixed;
export const isFundCat = (settings, catName) => !!(catOf(settings, catName) || {}).fund;
export const expenseCats = s => (s.cats || []).filter(c => c.kind === "expense" && !c.fund);

/* ── 회계월 ───────────────────────────────────────────────────────────── */
/** 시작일은 1~28만 허용 — 29~31은 달마다 없는 날이 생겨 기간 경계가 흔들린다 */
export const normStartDay = d => Math.min(28, Math.max(1, Math.round(Number(d) || 1)));

/** iso 가 속한 기간의 키 "YYYY-MM" (= 기간 시작일의 연·월) */
export function periodKey(iso, startDay = 1){
  const sd = normStartDay(startDay), d = dOf(iso);
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if(sd > 1 && d.getUTCDate() < sd){ m -= 1; if(m === 0){ m = 12; y -= 1; } }
  return y + "-" + String(m).padStart(2, "0");
}
/** 키 → {key, start, end, days, label} */
export function periodOf(key, startDay = 1){
  const sd = normStartDay(startDay);
  const [y, m] = key.split("-").map(Number);
  const start = y + "-" + String(m).padStart(2, "0") + "-" + String(sd).padStart(2, "0");
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const end = addDays(ny + "-" + String(nm).padStart(2, "0") + "-" + String(sd).padStart(2, "0"), -1);
  const days = daysBetween(start, end) + 1;
  const label = sd === 1 ? y + "년 " + m + "월" : y + "년 " + m + "월 (" + start.slice(5).replace("-", "/") + "~" + end.slice(5).replace("-", "/") + ")";
  return { key, start, end, days, label };
}
export function shiftPeriod(key, n){
  const [y, m] = key.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return Math.floor(t / 12) + "-" + String((t % 12 + 12) % 12 + 1).padStart(2, "0");
}
export const yearPeriods = year => Array.from({ length: 12 }, (_, i) => year + "-" + String(i + 1).padStart(2, "0"));

/* ── 검증 ─────────────────────────────────────────────────────────────── */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function validate(e, settings){
  const err = [];
  if(!e || typeof e !== "object") return ["항목이 없습니다"];
  if(!ISO.test(e.date || "") || isoOf(dOf(e.date)) !== e.date) err.push("날짜 형식 (YYYY-MM-DD)");
  const amt = Number(e.amount);
  if(!Number.isFinite(amt) || amt === 0 || Math.round(amt) !== amt) err.push("금액은 0이 아닌 정수(원)");
  if(!KINDS.includes(e.kind)) err.push("종류");
  if(e.kind === "transfer") return err;
  const c = catOf(settings, e.cat);
  if(!c) err.push("대분류 없음: " + (e.cat || "(빈칸)"));
  else{
    if(c.kind !== e.kind) err.push("대분류 [" + c.name + "]는 " + KIND_LABEL[c.kind] + "입니다");
    if(!e.sub) err.push("소분류");
    else if(!c.subs.includes(e.sub)) err.push("소분류 없음: " + e.sub);
    if(!!e.fund !== !!c.fund) err.push("예비비 표시가 대분류와 맞지 않습니다");
  }
  return err;
}
/** 대분류로부터 kind·fund 를 채운 항목 (UI는 종류를 따로 고르지 않는다) */
export function fromCat(settings, e){
  if(e.cat === "이체") return { ...e, kind: "transfer", fund: false };
  const c = catOf(settings, e.cat);
  return { ...e, kind: c ? c.kind : e.kind, fund: !!(c && c.fund) };
}

/* ── 집계 ─────────────────────────────────────────────────────────────── */
const inRange = (e, from, to) => e.date >= from && e.date <= to;
const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

/**
 * 기간 요약. 항등식 income − expense − saving = unallocated 를 보장한다.
 * @param {Array} entries
 * @param {object} settings
 * @param {{from:string,to:string,today?:string}} o
 */
export function summarize(entries, settings, { from, to, today }){
  const S = { from, to, days: daysBetween(from, to) + 1, count: 0,
    income: 0, saving: 0, expense: 0, fixed: 0, variable: 0, fundSpend: 0, fundDeposit: 0, transfer: 0,
    byCat: new Map(), bySub: new Map(), byMethod: new Map(), byTag: new Map(), byKind: new Map() };
  const spendDay = new Set();
  for(const e of entries){
    if(!e || !inRange(e, from, to)) continue;
    const a = Number(e.amount) || 0;
    if(e.kind === "transfer"){ S.transfer += a; continue; }
    S.count++;
    add(S.byKind, e.kind, a);
    add(S.byCat, e.cat, a);
    add(S.bySub, e.cat + "/" + e.sub, a);
    if(e.tag) add(S.byTag, e.tag, a);
    if(e.kind === "income") S.income += a;
    else if(e.kind === "saving"){ S.saving += a; if(e.sub === FUND_SUB) S.fundDeposit += a; }
    else if(e.kind === "expense"){
      if(e.method) add(S.byMethod, e.method, a);
      if(e.fund){ S.fundSpend += a; continue; }
      S.expense += a;
      if(isFixedCat(settings, e.cat)) S.fixed += a;
      else { S.variable += a; if(a > 0) spendDay.add(e.date); }
    }
  }
  S.out = S.expense + S.fundSpend;
  S.netSaving = S.saving - S.fundSpend;
  S.unallocated = S.income - S.expense - S.saving;
  S.savingRate = S.income > 0 ? S.saving / S.income : null;
  // 무지출 Day: 변동지출이 없는 날. 오늘 이후는 세지 않는다 (아직 오지 않은 날은 성과가 아니다)
  const last = today && today < to ? today : to;
  S.noSpendDays = [];
  if(last >= from) for(let d = from; d <= last; d = addDays(d, 1)) if(!spendDay.has(d)) S.noSpendDays.push(d);
  S.elapsedDays = last >= from ? daysBetween(from, last) + 1 : 0;
  return S;
}

/** 예산 대비. pace > 1 이면 남은 날을 감안해도 초과 속도. */
export function budgetStatus(sum, budgets = {}, settings){
  const ratio = sum.days ? Math.min(1, sum.elapsedDays / sum.days) : 1;
  const row = (name, budget, spent) => {
    const expected = budget * ratio;
    return { name, budget, spent, remain: budget - spent, pct: budget ? spent / budget : null,
      pace: budget && expected > 0 ? spent / expected : null };
  };
  const cats = expenseCats(settings).filter(c => budgets[c.name] > 0).map(c => row(c.name, +budgets[c.name], sum.byCat.get(c.name) || 0));
  const kinds = [];
  if(budgets._income > 0) kinds.push({ ...row("수입", +budgets._income, sum.income), goal: true });
  if(budgets._saving > 0) kinds.push({ ...row("저축", +budgets._saving, sum.saving), goal: true });
  if(budgets._expense > 0) kinds.push(row("지출", +budgets._expense, sum.expense));
  return { cats, kinds, elapsedRatio: ratio };
}

/** 예비비 잔액 = 입금(저축/예비비) − 예비비 지출, asOf 까지 */
export function fundBalance(entries, asOf = "9999-12-31"){
  let dep = 0, spend = 0;
  for(const e of entries){
    if(!e || e.date > asOf) continue;
    if(e.kind === "saving" && e.sub === FUND_SUB) dep += Number(e.amount) || 0;
    else if(e.kind === "expense" && e.fund) spend += Number(e.amount) || 0;
  }
  return { deposit: dep, spend, balance: dep - spend };
}
/** 예비비 분류별 연간 현황 */
export function fundStatus(entries, settings, year){
  const keys = yearPeriods(year, settings.startDay), from = periodOf(keys[0], settings.startDay).start, to = periodOf(keys[11], settings.startDay).end;
  const c = (settings.cats || []).find(x => x.fund) || { subs: [] };
  const spent = new Map();
  for(const e of entries) if(e && e.kind === "expense" && e.fund && inRange(e, from, to)) add(spent, e.sub, Number(e.amount) || 0);
  const subs = [...new Set([...c.subs, ...spent.keys()])];
  return subs.map(s => { const b = +(settings.fundBudgets || {})[s] || 0, v = spent.get(s) || 0;
    return { name: s, budget: b, spent: v, remain: Math.max(0, b - v), pct: b ? v / b : null, unknown: !c.subs.includes(s) }; });
}

/**
 * 연간표 — 통합시트에 해당. 12개 회계월 × (대분류/소분류) 행렬.
 * 평균은 지난 달 수(오늘이 시작일을 지난 기간 수)로 나눈다. 연도가 끝났으면 12.
 */
export function annual(entries, settings, year, { today } = {}){
  const sd = settings.startDay, keys = yearPeriods(year, sd);
  const periods = keys.map(k => periodOf(k, sd));
  const sums = periods.map(p => summarize(entries, settings, { from: p.start, to: p.end, today }));
  const elapsed = today ? Math.max(1, periods.filter(p => p.start <= today).length) : 12;
  const rows = [];
  const used = new Map();   // cat → Set(sub) — 설정에서 지워진 분류도 표에서 사라지지 않게
  for(const s of sums) for(const k of s.bySub.keys()){ const [c, sub] = k.split("/"); if(!used.has(c)) used.set(c, new Set()); used.get(c).add(sub); }
  const cats = [...(settings.cats || [])];
  for(const c of used.keys()) if(!cats.some(x => x.name === c)) cats.push({ name: c, kind: "expense", subs: [], unknown: true });
  for(const c of cats){
    const subs = [...new Set([...(c.subs || []), ...(used.get(c.name) || [])])];
    const catRow = { type: "cat", kind: c.kind, cat: c.name, fund: !!c.fund, fixed: !!c.fixed, unknown: !!c.unknown, vals: new Array(12).fill(0), subs: [] };
    for(const sub of subs){
      const vals = sums.map(s => s.bySub.get(c.name + "/" + sub) || 0);
      const total = vals.reduce((a, b) => a + b, 0);
      if(!total && !(c.subs || []).includes(sub)) continue;
      catRow.subs.push({ type: "sub", kind: c.kind, cat: c.name, sub, vals, total, avg: total / elapsed });
      vals.forEach((v, i) => catRow.vals[i] += v);
    }
    catRow.total = catRow.vals.reduce((a, b) => a + b, 0); catRow.avg = catRow.total / elapsed;
    rows.push(catRow);
  }
  const line = f => { const vals = sums.map(f); const total = vals.reduce((a, b) => a + b, 0); return { vals, total, avg: total / elapsed }; };
  return { year, keys, periods, elapsed, rows,
    income: line(s => s.income), saving: line(s => s.saving), expense: line(s => s.expense), fixed: line(s => s.fixed),
    variable: line(s => s.variable), fund: line(s => s.fundSpend), out: line(s => s.out), unallocated: line(s => s.unallocated),
    netSaving: line(s => s.netSaving) };
}

/* ── 고정지출 규칙 ────────────────────────────────────────────────────── */
/** 규칙의 결제일을 기간 안의 실제 날짜로. 시작일이 25일이면 결제일 5일은 다음 달 5일이다. */
export function recurringDate(rule, period, startDay = 1){
  const sd = normStartDay(startDay), day = Math.max(1, Math.min(31, Math.round(Number(rule.day) || 1)));
  const s = dOf(period.start);
  let y = s.getUTCFullYear(), m = s.getUTCMonth() + 1;
  if(sd > 1 && day < sd){ m += 1; if(m === 13){ m = 1; y += 1; } }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let iso = y + "-" + String(m).padStart(2, "0") + "-" + String(Math.min(day, last)).padStart(2, "0");
  if(iso < period.start) iso = period.start;
  if(iso > period.end) iso = period.end;
  return iso;
}
/** 기간에 아직 만들지 않은 고정지출 항목을 만든다 (id 없음 — 호출자가 부여). 규칙당 기간당 1건. */
export function expandRecurring(rules, key, settings, entries){
  const p = periodOf(key, settings.startDay);
  const have = new Set(entries.filter(e => e && e.rule != null && inRange(e, p.start, p.end)).map(e => e.rule));
  const out = [];
  for(const r of rules || []){
    if(!r || r.active === false || have.has(r.id)) continue;
    const e = fromCat(settings, { date: recurringDate(r, p, settings.startDay), amount: Math.round(Number(r.amount) || 0),
      cat: r.cat, sub: r.sub, memo: r.name || "", method: r.method || "", tag: r.tag || "", rule: r.id });
    if(!validate(e, settings).length) out.push(e);
  }
  return out;
}
