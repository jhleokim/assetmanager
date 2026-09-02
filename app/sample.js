/** 샘플 가족 자산 — 프로토타입 loadSample()과 동일한 값. 구조를 살펴보는 용도. */
export function sample(nextId){
  const t = Date.now(), assets = [], trades = [], hist = {};
  const A = o => { o.id = nextId(); o.active = 1; o.updatedAt = t; assets.push(o); return o.id; };
  const T = (aid, date, side, qty, price, memo) => trades.push({ id: nextId(), asset: aid, date, side, qty, price, amount: qty * price, memo: memo || "", updatedAt: t });
  const H = (key, pairs) => { hist[key] = {}; pairs.forEach(([d, p]) => hist[key][d] = p); };

  const tiger = A({ owner:"본인", cls:"금융자산", cat:"ETF", name:"TIGER 미국S&P500", code:"360750", market:"KR", inst:"삼성증권", acct:"****1234", qty:1139, avg:20147, mode:"AUTO", cur:"KRW", memo:"개인연금 계좌" });
  const kodex = A({ owner:"본인", cls:"금융자산", cat:"ETF", name:"KODEX 미국나스닥100TR", code:"379810", market:"KR", inst:"삼성증권", acct:"****1234", qty:1180, avg:19671, mode:"AUTO", cur:"KRW" });
  A({ owner:"본인", cls:"금융자산", cat:"ETF", name:"KODEX 200", code:"069500", market:"KR", inst:"미래에셋", acct:"****5678", qty:210, avg:32220, mode:"AUTO", cur:"KRW" });
  const sam = A({ owner:"배우자", cls:"금융자산", cat:"주식", name:"삼성전자", code:"005930", market:"KR", inst:"삼성증권", acct:"****4321", qty:50, avg:160500, mode:"AUTO", cur:"KRW" });
  A({ owner:"배우자", cls:"금융자산", cat:"주식", name:"SK하이닉스", code:"000660", market:"KR", inst:"삼성증권", acct:"****4321", qty:20, avg:185000, mode:"AUTO", cur:"KRW" });
  A({ owner:"본인", cls:"금융자산", cat:"ETF", name:"KODEX 골드선물(H)", code:"132030", market:"KR", inst:"미래에셋", acct:"****5678", qty:500, avg:15200, mode:"AUTO", cur:"KRW" });
  A({ owner:"본인", cls:"금융자산", cat:"주식", name:"Apple", code:"AAPL", market:"US", inst:"삼성증권", acct:"****1234", qty:15, avg:195, mode:"AUTO", cur:"USD", fxAtCost:1320 });
  A({ owner:"자녀", cls:"금융자산", cat:"ETF", name:"Vanguard S&P500 (VOO)", code:"VOO", market:"US", inst:"미래에셋", acct:"****9012", qty:8, avg:480, mode:"AUTO", cur:"USD", memo:"자녀 증여 계좌" });
  A({ owner:"공동", cls:"금융자산", cat:"예금", name:"하나 정기예금 12M", inst:"하나은행", acct:"****7788", principal:80000000, mode:"RATE", rate:3.45, start:"2025-09-01", end:"2026-09-01" });
  A({ owner:"배우자", cls:"금융자산", cat:"예금", name:"주거래 정기예금", inst:"하나은행", acct:"****2211", principal:44200000, mode:"RATE", rate:3.2, start:"2026-01-15", end:"2027-01-15" });
  A({ owner:"본인", cls:"금융자산", cat:"적금", name:"청년 적금", inst:"하나은행", acct:"****3300", monthly:500000, mode:"INSTALLMENT", rate:4.0, start:"2026-01-10", end:"2027-01-10" });
  A({ owner:"본인", cls:"금융자산", cat:"청약저축", name:"주택청약종합저축", inst:"하나은행", acct:"****3344", principal:17800000, mode:"RATE", rate:2.8, start:"2018-03-05" });
  A({ owner:"본인", cls:"금융자산", cat:"연금저축", name:"연금저축펀드 계좌", inst:"삼성증권", acct:"****1234", principal:109447085, value:131837985, mode:"MANUAL", start:"2020-02-01", memo:"ETF 편입분 별도 관리" });
  A({ owner:"배우자", cls:"금융자산", cat:"퇴직연금IRP", name:"IRP 계좌", inst:"하나은행", acct:"****5566", principal:10251820, value:14391590, mode:"MANUAL", start:"2021-06-01" });
  A({ owner:"본인", cls:"금융자산", cat:"펀드", name:"글로벌테크 주식형 펀드", inst:"미래에셋", acct:"****5678", principal:34086140, value:104015511, mode:"MANUAL", start:"2019-03-01" });
  A({ owner:"본인", cls:"금융자산", cat:"보험", name:"종신보험(해지환급금)", inst:"하나생명", principal:39079200, value:35936997, mode:"MANUAL", start:"2017-01-01", memo:"보장성 - 해지환급금 기준" });
  A({ owner:"자녀", cls:"금융자산", cat:"보험", name:"어린이 저축보험", inst:"하나생명", principal:14299200, value:14299200, mode:"MANUAL", start:"2022-01-01" });
  A({ owner:"본인", cls:"금융자산", cat:"현금성", name:"CMA (원금 미기록)", inst:"삼성증권", value:5000000, mode:"MANUAL" });
  const re1 = A({ owner:"공동", cls:"부동산", cat:"아파트", name:"송도 자택 아파트", principal:780000000, value:920000000, mode:"QUOTE", start:"2019-06-20", addr:"인천 연수구 송도동", lawd:"28185", complex:"송도더샵", area:84.98, floor:"12", memo:"실거주" });
  const re2 = A({ owner:"본인", cls:"부동산", cat:"오피스텔", name:"구월동 오피스텔(임대)", principal:210000000, value:235000000, mode:"QUOTE", start:"2022-04-11", addr:"인천 남동구 구월동", lawd:"28200", complex:"구월", area:34.5, floor:"8", deposit:20000000, rent:800000, memo:"월세 80만원" });
  A({ owner:"배우자", cls:"부동산", cat:"전세보증금", name:"부모님 거주 전세보증금", principal:180000000, value:180000000, mode:"MANUAL", start:"2025-03-01", end:"2027-03-01" });
  A({ owner:"공동", cls:"실물자산", cat:"금/은", name:"골드바 500g", principal:45000000, value:62000000, mode:"MANUAL", start:"2021-11-01" });
  A({ owner:"본인", cls:"실물자산", cat:"차량", name:"승용차(감가상각 반영)", principal:48000000, value:27000000, mode:"MANUAL", start:"2023-05-01" });
  A({ owner:"공동", cls:"부채", cat:"주택담보대출", name:"자택 주담대", inst:"하나은행", acct:"****9900", principal:320000000, value:248500000, mode:"MANUAL", rate:3.85, start:"2019-06-20", end:"2049-06-20", secures:re1, memo:"원리금균등 30년" });
  A({ owner:"본인", cls:"부채", cat:"신용대출", name:"마이너스 통장", inst:"하나은행", acct:"****9911", principal:30000000, value:12000000, mode:"MANUAL", rate:5.4 });
  A({ owner:"본인", cls:"부채", cat:"보증금(임대)", name:"오피스텔 임대보증금", principal:20000000, value:20000000, mode:"MANUAL", memo:"반환의무 보증금" });

  [["2025-02-05","매수",417,21613,"개인연금 증권사 전환"],["2025-02-24","매수",25,21560,"25년 2월 개인연금"],["2025-06-27","매수",300,19875,"적립매수"],
   ["2025-11-14","매수",297,22380,"적립매수"],["2026-03-20","매수",100,25120,"적립매수"]].forEach(x => T(tiger, ...x));
  [["2024-08-12","매수",30,152000,""],["2025-03-27","매수",30,165800,""],["2025-09-15","매도",10,178500,"일부 차익실현"]].forEach(x => T(sam, ...x));
  [["2024-11-05","매수",600,17400,""],["2025-05-19","매수",580,21900,""]].forEach(x => T(kodex, ...x));

  H("RE:" + re1, [["2023-06-30",760000000],["2024-06-30",812000000],["2025-06-30",875000000],["2026-04-26",920000000]]);
  H("RE:" + re2, [["2023-06-30",205000000],["2024-06-30",214000000],["2025-06-30",226000000],["2026-04-26",235000000]]);
  return { assets, trades, hist };
}
