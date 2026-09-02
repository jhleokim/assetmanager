/** 자산 1건의 평가 — 순수 함수. 여기서 절대 new Date()를 부르지 않는다(전부 ref 인자로 받는다). */
import { addMonths, daysBetween, monthsBetween, minISO } from "./date.js";

/** 이자소득세: 소득세 14% + 지방소득세 1.4% */
export const TAX_INTEREST = 0.154;

export const MODES = ["AUTO", "QUOTE", "RATE", "INSTALLMENT", "MANUAL"];

/** 평가액 산출 시 확신도가 떨어지는 지점을 호출부에 알리는 표식 */
export const FLAG = {
  STALE_QUOTE:    "STALE_QUOTE",     // 실시간 시세 없이 저장된 과거 시세를 씀
  NO_QUOTE:       "NO_QUOTE",        // 시세를 못 구해 평균단가/입력값으로 대체
  NO_BASIS:       "NO_BASIS",        // 원금(취득가) 정보가 없어 손익을 낼 수 없음
  MATURED:        "MATURED",         // 만기가 지나 이자 계산을 만기일에서 멈춤
  NO_MATURITY:    "NO_MATURITY",     // 만기일이 없어 계속 이자가 붙는 중
  ASSUMED_FX:     "ASSUMED_FX",      // 취득 시 환율을 몰라 현재 환율로 원금을 환산함
  ESTIMATED:      "ESTIMATED"        // 시계열 재구성에서 보간한 값
};

/* ------------------------------------------------------------------ 이자 계산 */

/**
 * 거치식 예금의 경과이자.
 * 프로토타입 버그 수정: 만기(end)를 반영해 만기 이후에는 이자가 늘지 않는다.
 *
 * @param {object}  o
 * @param {number}  o.principal  원금
 * @param {number}  o.ratePct    연이율(%)
 * @param {string}  o.start      가입일 "YYYY-MM-DD"
 * @param {string} [o.end]       만기일. 있으면 ref가 만기를 넘어도 만기에서 멈춘다
 * @param {string}  o.ref        평가 기준일
 * @param {"simple"|"monthly"} [o.compound="simple"] 단리 / 월복리
 * @param {number} [o.taxRate=0] 이자소득세율 (세후로 보려면 TAX_INTEREST)
 * @returns {{interest:number, flags:string[]}}
 */
export function accrued({ principal, ratePct, start, end, ref, compound = "simple", taxRate = 0 }){
  const flags = [];
  const p = Number(principal) || 0;
  const r = Number(ratePct) || 0;
  if(!start || !ref || p <= 0 || r <= 0) return { interest: 0, flags };

  // ── 핵심 수정: 만기를 넘어선 기간은 이자를 붙이지 않는다 ──
  const effective = minISO(ref, end || null);
  if(end && ref > end) flags.push(FLAG.MATURED);
  if(!end) flags.push(FLAG.NO_MATURITY);

  const days = daysBetween(start, effective);
  if(days <= 0) return { interest: 0, flags };

  let gross;
  if(compound === "monthly"){
    // 완납된 개월수만 월복리로 굴리고, 남은 일수는 그 잔액에 단리로 붙인다
    const months = Math.max(0, monthsBetween(start, effective));
    const balance = p * Math.pow(1 + r / 100 / 12, months);
    const restDays = Math.max(0, daysBetween(addMonths(start, months), effective));
    gross = (balance - p) + balance * (r / 100) * restDays / 365;
  }else{
    gross = p * (r / 100) * days / 365;
  }
  return { interest: gross * (1 - (Number(taxRate) || 0)), flags };
}

/**
 * 적립식(적금)의 경과이자 — 매월 같은 금액을 넣는 정기적금 단리.
 * 프로토타입은 이 구분이 없어 원금 전액이 가입일부터 예치된 것으로 계산했다(약 2배 과대).
 *
 *   원금  = 월납입액 × 납입회차
 *   이자  = 월납입액 × (연이율/12) × n(n+1)/2      (n = 납입회차)
 *
 * @returns {{principal:number, interest:number, months:number, flags:string[]}}
 */
export function accruedInstallment({ monthly, ratePct, start, end, ref, taxRate = 0 }){
  const flags = [];
  const m = Number(monthly) || 0;
  const r = Number(ratePct) || 0;
  if(!start || !ref || m <= 0) return { principal: 0, interest: 0, months: 0, flags };

  const effective = minISO(ref, end || null);
  if(end && ref > end) flags.push(FLAG.MATURED);
  if(!end) flags.push(FLAG.NO_MATURITY);

  // 가입일에 1회차를 납입한 것으로 본다
  const n = Math.max(0, monthsBetween(start, effective) + 1);
  if(n <= 0) return { principal: 0, interest: 0, months: 0, flags };

  const principal = m * n;
  const gross = r > 0 ? m * (r / 100 / 12) * (n * (n + 1) / 2) : 0;
  return { principal, interest: gross * (1 - (Number(taxRate) || 0)), months: n, flags };
}

/* --------------------------------------------------------------------- 평가 */

/** 시세 조회 키 — 부동산은 자산별, 종목은 시장+코드(여러 계좌가 공유) */
export function priceKey(a){
  if(a.cls === "부동산") return "RE:" + a.id;
  if(a.code) return String(a.market || "KR").toUpperCase() + ":" + a.code;
  return "AS:" + a.id;
}

function fxRate(cur, ctx){
  const c = String(cur || "KRW").toUpperCase();
  if(c === "KRW") return 1;
  const r = ctx.fx && ctx.fx[c];
  return Number(r) || 0;
}

/**
 * 자산 1건을 원화로 평가한다.
 *
 * @param {object} a    자산
 * @param {object} ctx  {quotes:{key:price}, fx:{USD:1380,...}, ref:"YYYY-MM-DD", taxRate?:number}
 * @returns {{value:number, basis:number, pl:number|null, plPct:number|null, flags:string[]}}
 *          basis = 원금(원화). pl/plPct는 원금을 모르면 null(0이 아니다).
 */
export function evaluate(a, ctx){
  const flags = [];
  const ref = ctx.ref;
  const mode = String(a.mode || "MANUAL").toUpperCase();
  const cur = String(a.cur || "KRW").toUpperCase();
  const fxNow = fxRate(cur, ctx);

  // 원금(취득가)의 원화 환산 — 취득 시 환율이 있으면 그것을 쓴다 (P1-4)
  let rawBasis = Number(a.principal) || 0;
  if(!rawBasis && a.qty && a.avg) rawBasis = Number(a.qty) * Number(a.avg);
  let basis = 0;
  if(rawBasis > 0){
    if(cur === "KRW"){
      basis = rawBasis;
    }else if(Number(a.fxAtCost) > 0){
      basis = rawBasis * Number(a.fxAtCost);
    }else{
      basis = rawBasis * fxNow;
      flags.push(FLAG.ASSUMED_FX);
    }
  }

  let value = 0;

  if(mode === "AUTO"){
    const px = ctx.quotes && ctx.quotes[priceKey(a)];
    if(px > 0){
      value = (Number(a.qty) || 0) * px * fxNow;
    }else{
      const fallback = (Number(a.qty) || 0) * (Number(a.avg) || 0) || (Number(a.value) || 0);
      value = fallback * fxNow;
      flags.push(FLAG.NO_QUOTE);
    }

  }else if(mode === "RATE"){
    const { interest, flags: f } = accrued({
      principal: rawBasis, ratePct: a.rate, start: a.start, end: a.end,
      ref, compound: a.compound, taxRate: ctx.taxRate || 0
    });
    flags.push(...f);
    value = (rawBasis + interest) * (cur === "KRW" ? 1 : fxNow);

  }else if(mode === "INSTALLMENT"){
    const res = accruedInstallment({
      monthly: a.monthly, ratePct: a.rate, start: a.start, end: a.end,
      ref, taxRate: ctx.taxRate || 0
    });
    flags.push(...res.flags);
    basis = res.principal * (cur === "KRW" ? 1 : (Number(a.fxAtCost) || fxNow));
    value = (res.principal + res.interest) * (cur === "KRW" ? 1 : fxNow);

  }else{ // QUOTE · MANUAL
    const raw = Number(a.value) || rawBasis;
    value = raw * (cur === "KRW" ? 1 : fxNow);
  }

  const isDebt = a.cls === "부채";
  let pl = null, plPct = null;
  if(isDebt){
    pl = null;                       // 부채에는 평가손익 개념을 쓰지 않는다
  }else if(basis > 0){
    pl = value - basis;
    plPct = pl / basis * 100;
  }else{
    flags.push(FLAG.NO_BASIS);       // P1-3: 원금을 모르면 평가액 전액을 수익으로 잡지 않는다
  }

  return { value, basis, pl, plPct, flags };
}
