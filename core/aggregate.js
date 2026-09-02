/** 집계 — 프로토타입의 P1-1 / P1-2 / P1-3 수정본. */
import { evaluate } from "./valuation.js";

/** 자산 배열을 평가해 집계용 행으로 만든다 */
export function buildRows(assets, ctx){
  return assets.filter(a => a.active !== 0).map(a => {
    const e = evaluate(a, ctx);
    return { ...a, value: e.value, basis: e.basis, pl: e.pl, plPct: e.plPct,
             flags: e.flags, isDebt: a.cls === "부채" };
  });
}

/**
 * 총계.
 *
 * P1-3 수정: 원금을 모르는 자산(basis 0)의 평가액을 전부 "수익"으로 잡던 것을 막는다.
 * 손익은 원금이 확인된 자산에 대해서만 내고, 나머지 금액은 unknownBasis로 따로 보고한다.
 */
export function totals(rows){
  let asset = 0, debt = 0, basis = 0, valued = 0, unknownBasis = 0;

  for(const r of rows){
    if(r.isDebt){ debt += r.value; continue; }
    asset += r.value;
    if(r.basis > 0){ basis += r.basis; valued += r.value; }
    else unknownBasis += r.value;      // 손익 산출 대상에서 제외
  }

  const pl = basis > 0 ? valued - basis : null;
  return {
    asset, debt, net: asset - debt,
    basis, pl,
    plPct: basis > 0 ? (pl / basis) * 100 : null,
    unknownBasis,
    byClass: sumBy(rows, "cls")
  };
}

function sumBy(rows, key){
  const m = new Map();
  for(const r of rows) m.set(r[key] || "미분류", (m.get(r[key] || "미분류") || 0) + r.value);
  return m;
}

/** 카테고리·소유자별 합계. 상위 n개만 남기고 나머지는 "기타"로 묶는다(잘라 버리지 않는다). */
export function groupSum(rows, key, { includeDebt = false, top = 0 } = {}){
  const m = new Map();
  for(const r of rows){
    if(r.isDebt && !includeDebt) continue;
    const k = r[key] || "미분류";
    const g = m.get(k) || { k, value: 0, basis: 0, count: 0 };
    g.value += r.value;
    g.basis += r.basis;
    g.count++;
    m.set(k, g);
  }
  const list = [...m.values()].sort((a, b) => b.value - a.value);
  if(!top || list.length <= top) return list;

  // 프로토타입은 slice(0,11)로 초과분을 조용히 버려 합계가 맞지 않았다
  const head = list.slice(0, top - 1);
  const rest = list.slice(top - 1);
  head.push(rest.reduce((s, g) => ({
    k: "기타", value: s.value + g.value, basis: s.basis + g.basis, count: s.count + g.count
  }), { k: "기타", value: 0, basis: 0, count: 0 }));
  return head;
}

/**
 * 부채 → 담보 부동산 연결.
 *
 * P1-2 수정: 프로토타입은 "같은 소유자의 주택담보대출"을 부동산 행마다 전액 표시해,
 * 한 사람이 부동산을 2건 가지면 같은 대출이 양쪽에 이중계상됐다.
 * 여기서는 명시적 연결(debt.secures)을 우선하고, 추정이 모호하면 연결하지 않고 보고한다.
 *
 * @returns {Map<debtId, {propertyId:string|null, inferred:boolean, ambiguous:boolean}>}
 */
export function resolveLoanLinks(assets){
  const live = assets.filter(a => a.active !== 0);
  const properties = live.filter(a => a.cls === "부동산");
  const links = new Map();

  for(const d of live){
    if(d.cls !== "부채") continue;

    if(d.secures){
      const hit = properties.find(p => String(p.id) === String(d.secures));
      links.set(d.id, { propertyId: hit ? hit.id : null, inferred: false, ambiguous: !hit });
      continue;
    }
    if(d.cat !== "주택담보대출"){
      links.set(d.id, { propertyId: null, inferred: false, ambiguous: false });
      continue;
    }
    // 소유자로 추정하되, 후보가 정확히 1건일 때만 연결한다
    const cands = properties.filter(p => p.owner === d.owner);
    links.set(d.id, cands.length === 1
      ? { propertyId: cands[0].id, inferred: true, ambiguous: false }
      : { propertyId: null, inferred: false, ambiguous: cands.length > 1 });
  }
  return links;
}

/** 부동산 1건에 연결된 대출 잔액 합계 */
export function loansFor(propertyId, rows, links){
  let sum = 0;
  for(const r of rows){
    if(!r.isDebt) continue;
    const l = links.get(r.id);
    if(l && String(l.propertyId) === String(propertyId)) sum += r.value;
  }
  return sum;
}

/**
 * LTV — 담보대출 / 담보 부동산.
 *
 * P1-1 수정: 프로토타입은 (전체 부채 / 전체 부동산)이라 신용대출·마이너스통장·임대보증금이
 * 분자에, 전세보증금이 분모에 섞여 들어갔다. 연결된 담보만 계산한다.
 *
 * @returns {{overall:number|null, byProperty:Array<{id,name,value,loan,ltv,equity}>}}
 */
export function loanToValue(rows, links){
  const props = rows.filter(r => r.cls === "부동산" && !r.isDebt);
  const byProperty = props.map(p => {
    const loan = loansFor(p.id, rows, links);
    return { id: p.id, name: p.name, value: p.value, loan,
             ltv: p.value > 0 ? loan / p.value * 100 : null,
             equity: p.value - loan };
  });
  const securedValue = byProperty.reduce((s, x) => s + (x.loan > 0 ? x.value : 0), 0);
  const securedLoan = byProperty.reduce((s, x) => s + x.loan, 0);
  return {
    overall: securedValue > 0 ? securedLoan / securedValue * 100 : null,
    byProperty
  };
}
