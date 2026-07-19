'use strict';
// ===== 德州扑克 AI：决策引擎 + 教练分析 =====
// 设计目标：
//  - decide()：一个"有性格"的对手，会按位置开池、按胜率下注/跟注/弃牌、并做少量诈唬以平衡范围（GTO 风格）。
//  - analyze()：给人类玩家的"教练"，输出胜率估算、底池赔率、建议动作与可解释的 GTO 概念。
// 两者共享底层估算（起手牌强度、蒙特卡洛胜率），但 decide 带风格扰动，analyze 保持确定性便于学习。

const { evaluate7, evaluate5, compareHands, makeDeck, shuffle, CATEGORY_NAMES } = require('./engine');

// ---------- 通用工具 ----------
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function r2(v) { return Math.round(v); }

// 风格：aggr 越大越激进；bluff 为诈唬频率；openAdj/callAdj 调整开池/跟注门槛（正=更松）
const PROFILES = {
  tight:    { aggr: 0.75, bluff: 0.10, openAdj:  0.10, callAdj:  0.05 },
  balanced: { aggr: 1.00, bluff: 0.20, openAdj:  0.00, callAdj:  0.00 },
  loose:    { aggr: 1.30, bluff: 0.30, openAdj: -0.10, callAdj: -0.05 },
};

// 不同位置的翻前开池强度门槛（posQuality: 0=前位 1=按钮）
const OPEN_THRESHOLDS = [0.85, 0.80, 0.72, 0.58, 0.48];

// 教练风格：bias 影响建议的松紧（负=更保守弃牌、正=更激进下注/加注）；
// bluffProb 控制半诈唬频率；betProb 控制中等牌力时下注vs过牌的倾向。
const COACH_STYLES = {
  conservative: { label: '保守', bias: -1, bluffProb: 0.12, betProb: 0.30,
    note: '（保守风格：优先保住筹码，弱牌果断弃掉，少做边缘诈唬）' },
  standard:     { label: '标准', bias: 0,  bluffProb: 0.50, betProb: 0.50,
    note: '（标准 GTO 风格：按胜率与底池赔率理性决策）' },
  aggressive:   { label: '激进', bias: 1,  bluffProb: 0.85, betProb: 0.72,
    note: '（激进风格：更倾向用下注/加注施压，敢于半诈唬与薄价值）' },
};

// ---------- 起手牌强度（基于真实单挑胜率的百分位，连续精确 0..1）----------
// 旧版用 Chen 公式（整数分/10），只能给出 0.1 档位（显示成 10/20/30…），
// 且 AA 与 KK 会被并到同一档。现在改为：
//   1) 用一次性缓存的蒙特卡洛，算出 169 种同型起手牌“单挑对随机牌”的胜率；
//   2) 按组合数加权换算成“强于全部起手牌的比例”（百分位）作为强度值。
// 固定随机种子 -> 每次运行结果一致（确定性，便于教学），且精确到 1%/1 分。
function _mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _seededShuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
const _PF_NAMES = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' };
function _pfRankName(r) { return _PF_NAMES[r] || String(r); }
function _canonicalKey(c1, c2) {
  const [hi, lo] = c1.r >= c2.r ? [c1, c2] : [c2, c1];
  if (hi.r === lo.r) return _pfRankName(hi.r) + _pfRankName(hi.r);
  return _pfRankName(hi.r) + _pfRankName(lo.r) + (hi.s === lo.s ? 's' : 'o');
}
let _PF_TABLE = null; // canonicalKey -> { eq:单挑胜率, pct:百分位强度 }
function _buildPreflopTable() {
  if (_PF_TABLE) return _PF_TABLE;
  const rnd = _mulberry32(0x9E3779B9); // 固定种子
  const ranks = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const ITER = 2500;
  const rows = [];
  for (let i = 0; i < ranks.length; i++) {
    for (let j = i; j < ranks.length; j++) {
      const pair = (i === j);
      const variants = pair ? [true] : [true, false]; // suited? 
      for (const suited of variants) {
        const c1 = { r: ranks[i], s: 0 };
        const c2 = { r: ranks[j], s: pair ? 1 : (suited ? 0 : 1) };
        const key = _canonicalKey(c1, c2);
        const known = new Set([c1.r * 4 + c1.s, c2.r * 4 + c2.s]);
        const baseDeck = makeDeck().filter(c => !known.has(c.r * 4 + c.s));
        let wins = 0, ties = 0;
        for (let it = 0; it < ITER; it++) {
          const d = _seededShuffle(baseDeck.slice(), rnd);
          const board = [d[2], d[3], d[4], d[5], d[6]];
          const me = evaluate7([c1, c2, ...board]);
          const ev = evaluate7([d[0], d[1], ...board]);
          const cmp = compareHands(me, ev);
          if (cmp > 0) wins++; else if (cmp === 0) ties++;
        }
        rows.push({ key, eq: (wins + ties / 2) / ITER, combos: pair ? 6 : (suited ? 4 : 12) });
      }
    }
  }
  const total = rows.reduce((a, r) => a + r.combos, 0);
  _PF_TABLE = {};
  for (const r of rows) {
    let below = 0;
    for (const o of rows) {
      if (o.eq < r.eq) below += o.combos;
      else if (o.eq === r.eq && o.key !== r.key) below += o.combos * 0.5;
    }
    _PF_TABLE[r.key] = { eq: +r.eq.toFixed(4), pct: +clamp(below / total, 0, 1).toFixed(4) };
  }
  return _PF_TABLE;
}
// 返回 0..1 连续强度（= 强于全部随机起手牌的比例，百分位）
function preflopStrength(c1, c2) {
  const t = _buildPreflopTable();
  const e = t[_canonicalKey(c1, c2)];
  return e ? e.pct : 0.3;
}
// 该起手牌的真实单挑胜率（教练展示用）
function preflopEquityHU(c1, c2) {
  const t = _buildPreflopTable();
  const e = t[_canonicalKey(c1, c2)];
  return e ? e.eq : 0.4;
}

// 起手牌文字描述，如 "AKs" / "T9o" / "22"
function describePreflop(c1, c2) {
  const names = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' };
  const rn = (r) => names[r] || String(r);
  const [hi, lo] = c1.r >= c2.r ? [c1, c2] : [c2, c1];
  const pair = hi.r === lo.r;
  const suited = hi.s === lo.s;
  if (pair) return rn(hi.r) + rn(hi.r);
  return rn(hi.r) + rn(lo.r) + (suited ? 's' : 'o');
}

// ---------- 位置质量（0=最早行动 1=最后行动/按钮）----------
function positionQuality(game, idx) {
  const act = game.seats.map((s, i) => i).filter(i => !game.seats[i].folded);
  if (act.length <= 1) return 1;
  const bi = game.buttonIndex;
  const order = [];
  for (let k = 1; k <= act.length; k++) {
    const i = (bi + k) % game.seats.length;
    if (!game.seats[i].folded) order.push(i);
  }
  const pos = order.indexOf(idx);
  return clamp(pos / (order.length - 1 || 1), 0, 1);
}

// ============================================================
//  增强工具：听牌检测 / 牌面纹理 / 对手范围命中
//  （用于让教练建议与读牌更"看牌面"，而非只靠固定阈值）
// ============================================================

// 给定 hole+board，检测当前听牌与成牌情况
function detectDraws(hole, board) {
  const all = [...hole, ...board];
  const made = evaluate7(all);
  const madeName = CATEGORY_NAMES[made.category];
  const suits = [0, 0, 0, 0];
  for (const c of all) suits[c.s]++;
  const boardSuits = [0, 0, 0, 0];
  for (const c of board) boardSuits[c.s]++;

  let flushDraw = false, flushOuts = 0;
  for (let s = 0; s < 4; s++) {
    if (suits[s] === 4 && boardSuits[s] < 5) {
      flushDraw = true;
      flushOuts = 13 - suits[s];
    }
  }

  const ranks = new Set(all.map(c => c.r));
  const has = (r) => ranks.has(r) || (r === 1 && ranks.has(14));
  let straightDraw = 'none', straightOuts = 0;
  for (let lo = 1; lo <= 10; lo++) {
    const need = [lo, lo + 1, lo + 2, lo + 3, lo + 4].map(x => x > 14 ? x - 13 : x);
    let have = 0; const missing = [];
    for (const r of need) { if (has(r)) have++; else missing.push(r); }
    if (have === 4) {
      const open = (missing[0] === need[0] || missing[0] === need[4]);
      const o = open ? 8 : 4;
      if (o > straightOuts) { straightOuts = o; straightDraw = open ? 'open' : 'gutshot'; }
    }
  }

  const boardMax = board.length ? Math.max(...board.map(c => c.r)) : 0;
  let overOuts = 0;
  for (const c of hole) if (c.r > boardMax) overOuts += (4 - all.filter(x => x.r === c.r).length);

  const outs = Math.min(21, flushOuts + straightOuts + (overOuts > 0 && made.category < 2 ? overOuts : 0));
  const drawNames = [];
  if (flushDraw) drawNames.push(`同花听牌(${flushOuts}outs)`);
  if (straightDraw !== 'none') drawNames.push(`${straightDraw === 'open' ? '两端' : '内嵌'}顺子听牌(${straightOuts}outs)`);
  if (overOuts > 0 && made.category < 2) drawNames.push(`高牌Overcard(${overOuts}outs)`);

  return { made: made.category, madeName, flushDraw, straightDraw, outs, drawNames };
}

// 牌面纹理：湿润度越高越容易出现听牌/强牌
function boardTexture(board) {
  if (!board.length) return { wet: 0, flushPossible: false, straightPossible: false, paired: false, highCards: 0 };
  const suits = [0, 0, 0, 0];
  const ranks = board.map(c => c.r);
  for (const c of board) suits[c.s]++;
  const flushPossible = Math.max(...suits) >= 3;
  const rset = new Set(ranks);
  let straightPossible = false;
  for (let lo = 1; lo <= 10; lo++) {
    const need = [lo, lo + 1, lo + 2, lo + 3, lo + 4].map(x => x > 14 ? x - 13 : x);
    let have = 0; for (const r of need) if (rset.has(r)) have++;
    if (have >= 3) { straightPossible = true; break; }
  }
  const paired = new Set(ranks).size < ranks.length;
  const highCards = ranks.filter(r => r >= 11).length;
  let wet = 0;
  if (flushPossible) wet += 0.4;
  if (straightPossible) wet += 0.3;
  if (paired) wet += 0.1;
  if (highCards >= 2) wet += 0.2;
  return { wet: Math.min(1, wet), flushPossible, straightPossible, paired, highCards };
}

// ============================================================
//  隐含赔率（Implied Odds）
//  纯底池赔率（pot odds）只看“当前底池”，会低估听牌价值——
//  因为没算“买中听牌后还能在后续街从对手身上额外榨到的筹码”。
//  结构性听牌（同花、顺子、连张同花）成牌后常为坚果/接近坚果，
//  对手很难读出、又不愿弃顶对/A 踢脚，于是隐藏赔率（隐含赔率）远高于普通高牌听牌。
// ============================================================
function computeImpliedOdds(game, seat, draws, tex) {
  const pot = game.pot;
  const toCall = Math.max(0, game.currentBet - seat.roundContribution);
  const myStack = seat.chips;
  const opps = game.seats.filter(s => !s.folded && s.id !== seat.id);
  const oppChipsTotal = opps.reduce((a, s) => a + s.chips, 0);
  // 你能实际赢到的额外筹码上限 = min(自己剩余, 对手剩余之和)
  const maxExtractable = Math.min(myStack, oppChipsTotal);

  // 隐蔽性倍数：成牌后对手是否愿意继续往池里塞钱
  let conceal = 0.55;                                               // 默认（高牌/边缘听牌，隐蔽性差）
  if (draws.flushDraw) conceal = Math.max(conceal, 1.25);           // 同花：成坚果，对手的顶对/A 踢脚不愿弃
  if (draws.straightDraw === 'open') conceal = Math.max(conceal, 1.35); // 两端顺：强且隐蔽
  if (draws.straightDraw === 'gutshot') conceal = Math.max(conceal, 0.85); // 内嵌顺：隐蔽但常被更大顺反超
  // 仅有 overcard 高牌、无同花/顺子听牌时，隐蔽性低、对手易读，支付少
  if (!draws.flushDraw && draws.straightDraw === 'none' && draws.outs > 0 && draws.outs <= 6) {
    conceal = Math.min(conceal, 0.5);
  }
  // 牌面越湿润，对手越可能有牌/听牌、越愿意投入 -> 隐含额外更高
  conceal *= (1 + (tex ? tex.wet : 0) * 0.4);

  // 隐含额外 = 可榨取 × 隐蔽性（不超过对手实际能给的筹码，也不为负）
  let impliedExtra = Math.min(maxExtractable * conceal, Math.max(0, oppChipsTotal));
  if (impliedExtra < 0) impliedExtra = 0;

  const directReqEq = toCall > 0 ? toCall / (pot + toCall) : 0;                 // 纯底池赔率要求的赢率
  const impliedReqEq = toCall > 0 ? toCall / (pot + toCall + impliedExtra) : 0; // 含隐含赔率要求的赢率

  // 命中概率（买中听牌）：flop 还有两张牌机会、turn 仅剩一张
  const outs = draws.outs;
  let hitProb;
  if (game.stage === 'flop') hitProb = 1 - ((47 - outs) / 47) * ((46 - outs) / 46);
  else if (game.stage === 'turn') hitProb = outs / 46;
  else hitProb = 0;

  return { toCall, pot, impliedExtra, directReqEq, impliedReqEq, hitProb, conceal, maxExtractable, oppChipsTotal, outs };
}

// 根据对手公开行为推断其起手范围（代表牌组，按 Chen 强度筛选）
function buildRange(seat, opts = {}) {
  let floor = 0.5;
  if (opts.threeBet) floor = 0.90;
  else if (opts.pfRaise) floor = 0.70;
  else if (opts.pfCall) floor = 0.50;
  else floor = 0.35;

  const ranks = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const range = [];
  for (let i = 0; i < ranks.length; i++) {
    for (let j = i; j < ranks.length; j++) {
      const r1 = ranks[i], r2r = ranks[j];
      const pairs = (i === j);
      for (let s1 = 0; s1 < 4; s1++) {
        for (let s2 = 0; s2 < 4; s2++) {
          if (pairs && s1 >= s2) continue;
          if (!pairs && i === j) continue;
          const c1 = { r: r1, s: s1 }, c2 = { r: r2r, s: s2 };
          const str = preflopStrength(c1, c2);
          if (str >= floor - 0.001) range.push({ c1, c2, str });
        }
      }
    }
  }
  return range;
}

// 对手范围在给定牌面上的“命中”统计（不依赖我的牌，纯看其范围与公共牌）
function rangeHitStats(range, board, iters = 140) {
  if (!board.length || !range.length) return { topPairPlusPct: 0, strongMadePct: 0, flushDrawPct: 0, samples: 0 };
  const known = new Set();
  for (const c of board) known.add(c.r * 4 + c.s);
  const boardRanks = board.map(c => c.r);
  const boardMax = Math.max(...boardRanks);
  const bs = [0, 0, 0, 0]; for (const c of board) bs[c.s]++;

  let topPair = 0, strong = 0, flushDraw = 0, n = 0, guard = 0;
  while (n < iters && guard < iters * 6) {
    guard++;
    const pick = range[(Math.random() * range.length) | 0];
    const h0 = pick.c1, h1 = pick.c2;
    if (known.has(h0.r * 4 + h0.s) || known.has(h1.r * 4 + h1.s)) continue;
    n++;
    const isPair = h0.r === h1.r;
    let pairBoard = 0;
    for (const hr of [h0.r, h1.r]) {
      const cnt = boardRanks.filter(r => r === hr).length;
      if (cnt >= 1) pairBoard++;
      if (isPair && hr > boardMax) strong++;
    }
    if (isPair && pairBoard >= 1) strong++;
    else if (pairBoard >= 2) strong++;
    else if (pairBoard >= 1) topPair++;
    const hs = [0, 0, 0, 0]; hs[h0.s]++; hs[h1.s]++;
    for (let s = 0; s < 4; s++) if (bs[s] + hs[s] === 4) { flushDraw++; break; }
  }
  if (!n) return { topPairPlusPct: 0, strongMadePct: 0, flushDrawPct: 0, samples: 0 };
  return {
    topPairPlusPct: +((topPair + strong) / n).toFixed(2),
    strongMadePct: +(strong / n).toFixed(2),
    flushDrawPct: +(flushDraw / n).toFixed(2),
    samples: n,
  };
}


// ============================================================
//  增强工具（本轮新增）：对“对手范围”的胜率 + 我的行为线 + 对手应对
// ============================================================

// 从预计算范围里按强度加权抽一手牌（避免与已知牌冲突）
function sampleRangeHand(range, used) {
  let total = 0;
  for (const h of range) total += h.str * h.str;
  if (total <= 0) total = range.length;
  let r = Math.random() * total;
  for (const h of range) {
    r -= h.str * h.str;
    if (r <= 0) {
      const c1 = { r: h.c1.r, s: h.c1.s }, c2 = { r: h.c2.r, s: h.c2.s };
      const k1 = c1.r * 4 + c1.s, k2 = c2.r * 4 + c2.s;
      if (used.has(k1) || used.has(k2)) continue;
      return [c1, c2];
    }
  }
  for (const h of range) {
    const k1 = h.c1.r * 4 + h.c1.s, k2 = h.c2.r * 4 + h.c2.s;
    if (!used.has(k1) && !used.has(k2)) return [{ r: h.c1.r, s: h.c1.s }, { r: h.c2.r, s: h.c2.s }];
  }
  return null;
}

// 估算“我对几个对手推断范围”的胜率（而非对随机牌）
function estimateEquityVsRanges(game, seatId, iterations = 200) {
  const idx = game.seats.findIndex(s => s.id === seatId);
  const me = game.seats[idx];
  const hole = me.cards;
  const board = game.board;
  const opps = game.seats.filter(s => !s.folded && s.id !== seatId);
  if (!opps.length) return { equity: 1, win: 1, tie: 0, perOpp: [] };

  const known = new Set();
  for (const c of [...hole, ...board]) known.add(c.r * 4 + c.s);

  const oppRanges = opps.map(s => {
    const acts = (s.handActions || []).filter(a => a.stage === 'preflop');
    const pfRaise = acts.find(a => AGG_ACTIONS.includes(a.action));
    const pfCall = acts.find(a => a.action === 'call');
    const priorAgg = pfRaise ? acts.slice(0, acts.indexOf(pfRaise)).some(a => AGG_ACTIONS.includes(a.action)) : false;
    const range = buildRange(s, { threeBet: priorAgg, pfRaise: !!pfRaise, pfCall: !!pfCall, limp: !pfRaise && !pfCall });
    return { id: s.id, name: s.name, range };
  });

  const need = 5 - board.length;
  let wins = 0, ties = 0, n = 0, guard = 0;
  while (n < iterations && guard < iterations * 8) {
    guard++;
    const deck = makeDeck().filter(c => !known.has(c.r * 4 + c.s));
    shuffle(deck);
    let p = 0;
    const used = new Set(known);
    const oppHands = [];
    let ok = true;
    for (const o of oppRanges) {
      const hh = sampleRangeHand(o.range, used);
      if (!hh) { ok = false; break; }
      for (const c of hh) used.add(c.r * 4 + c.s);
      oppHands.push(hh);
    }
    if (!ok) continue;
    const full = board.slice();
    for (let k = 0; k < need; k++) full.push(deck[p++]);
    const myEval = evaluate7([...hole, ...full]);
    let bestOpp = null;
    for (const oc of oppHands) {
      const e = evaluate7([...oc, ...full]);
      if (!bestOpp || compareHands(e, bestOpp) > 0) bestOpp = e;
    }
    const cmp = compareHands(myEval, bestOpp);
    if (cmp > 0) wins++; else if (cmp === 0) ties++;
    n++;
  }
  if (!n) return { equity: estimateEquity(hole, board, opps.length, 60).equity, win: 0, tie: 0, perOpp: oppRanges };
  return { equity: (wins + ties / 2) / n, win: wins / n, tie: ties / n, perOpp: oppRanges };
}

// 分析“我自己的打法轨迹”
function analyzeMyLine(game, seatId) {
  const seat = game.seats.find(s => s.id === seatId);
  if (!seat) return { summary: '', story: '', aggression: 0 };
  const acts = (seat.handActions || []).slice();
  const pf = acts.filter(a => a.stage === 'preflop');
  const post = acts.filter(a => a.stage !== 'preflop');
  const pfRaise = pf.find(a => AGG_ACTIONS.includes(a.action));
  const pfCall = pf.find(a => a.action === 'call');
  let pfText = '未行动';
  if (pfRaise) pfText = (pf.slice(0, pf.indexOf(pfRaise)).some(a => AGG_ACTIONS.includes(a.action))) ? '翻前 3-bet/再加注' : '翻前加注开池';
  else if (pfCall) pfText = '翻前平跟';
  else if (pf.length) pfText = '翻前过牌/看牌';

  const bets = post.filter(a => AGG_ACTIONS.includes(a.action));
  const checks = post.filter(a => a.action === 'check');
  const calls = post.filter(a => a.action === 'call');
  const aggr = bets.length, pass = checks.length + calls.length;
  let story = '翻后还没行动';
  if (post.length) {
    if (aggr >= 2) story = '翻后持续下注施压，在讲“我有强牌”的故事';
    else if (aggr === 1 && checks.length === 0) story = '翻后下注一次建立底池';
    else if (checks.length >= 1 && bets.length === 0) story = '翻后多次过牌，示弱/控制底池';
    else if (calls.length >= 1 && bets.length === 0) story = '翻后只跟注没下注，牌力偏中等或听牌';
  }
  return { summary: pfText + (post.length ? '；翻后 ' + post.map(a => ACTION_LABELS[a.action]).join('→') : ''), pfText, story, aggression: +(aggr / (aggr + pass || 1)).toFixed(2) };
}

// 分析“对手如何应对我”（基于全局动作时间线 actionLog）
function analyzeResponses(game, seatId) {
  const log = (game.actionLog || []).slice().sort((a, b) => a.seq - b.seq);
  const out = [];
  const meActs = log.filter(a => a.actorId === seatId);
  if (!meActs.length) return out;
  const myLast = meActs[meActs.length - 1];
  const mySeq = myLast.seq;
  for (const opp of game.seats.filter(s => !s.folded && s.id !== seatId)) {
    const resp = log.find(a => a.actorId === opp.id && a.seq > mySeq);
    if (!resp) continue;
    let text = '';
    if (AGG_ACTIONS.includes(myLast.action)) {
      if (resp.action === 'raise' || resp.action === 'allin') text = `${opp.name} 在你下注/加注后反加注，多半是真有强牌，谨慎对待。`;
      else if (resp.action === 'call') text = `${opp.name} 在你下注后只是跟注，其范围多半被封顶（一对或听牌），不太可能是坚果。`;
      else if (resp.action === 'fold') text = `${opp.name} 在你下注后弃牌，说明它大概率没货，你这手下注拿下了底池。`;
    } else if (myLast.action === 'check') {
      if (resp.action === 'bet' || resp.action === 'raise') text = `${opp.name} 在你过牌后主动下注——可能在偷池（尤其你示弱时），若你有一对/听牌可考虑加注反击。`;
      else if (resp.action === 'check') text = `${opp.name} 也过牌，双方都在控制底池，多半都不强。`;
    }
    if (text) out.push({ id: opp.id, name: opp.name, stimulus: myLast.action, response: resp.action, text });
  }
  return out;
}

// ---------- 蒙特卡洛胜率估算 ----------
function estimateEquity(hole, board, numOpp, iterations = 220) {
  if (numOpp <= 0) return { equity: 1, win: 1, tie: 0 };
  const known = new Set();
  for (const c of [...hole, ...board]) known.add(c.r * 4 + c.s);
  const deck = makeDeck().filter(c => !known.has(c.r * 4 + c.s));
  let wins = 0, ties = 0;
  const need = 5 - board.length;
  for (let it = 0; it < iterations; it++) {
    const d = deck.slice();
    shuffle(d);
    let p = 0;
    const opps = [];
    for (let o = 0; o < numOpp; o++) opps.push([d[p++], d[p++]]);
    const full = board.slice();
    for (let k = 0; k < need; k++) full.push(d[p++]);
    const myEval = evaluate7([...hole, ...full]);
    let bestOpp = null;
    for (const oc of opps) {
      const e = evaluate7([...oc, ...full]);
      if (!bestOpp || compareHands(e, bestOpp) > 0) bestOpp = e;
    }
    const cmp = compareHands(myEval, bestOpp);
    if (cmp > 0) wins++;
    else if (cmp === 0) ties++;
  }
  return { equity: (wins + ties / 2) / iterations, win: wins / iterations, tie: ties / iterations };
}

// ---------- 动作规划（把"意图"转成引擎可接受的 action/amount）----------
function planRaise(game, seat, target) {
  const need = target - seat.roundContribution;
  if (need >= seat.chips) return { action: 'allin' };
  if (target <= game.currentBet) return { action: seat.roundContribution >= game.currentBet ? 'check' : 'call' };
  if (need < game.minRaise && seat.chips > need) {
    return { action: seat.roundContribution >= game.currentBet ? 'check' : 'call' };
  }
  return { action: 'raise', amount: target };
}
function planBet(game, seat, size) {
  const target = seat.roundContribution + size;
  if (size >= seat.chips) return { action: 'allin' };
  if (target <= game.currentBet) return { action: seat.roundContribution >= game.currentBet ? 'check' : 'call' };
  return { action: 'bet', amount: target };
}

// 翻前适合诈唬的牌：同花连张/同花 A / 小对子
function isBluffPreflop(hole) {
  const [a, b] = hole[0].r >= hole[1].r ? [hole[0], hole[1]] : [hole[1], hole[0]];
  if (a.s === b.s && (a.r - b.r) <= 4 && a.r <= 13) return true;
  if (a.s === b.s && a.r === 14) return true;
  if (a.r === b.r && a.r <= 9) return true;
  return false;
}

// ============================================================
//  decide：机器人决策（带风格扰动）
// ============================================================
function decide(game, seatId, profile = 'balanced') {
  const pf = PROFILES[profile] || PROFILES.balanced;
  const idx = game.seats.findIndex(s => s.id === seatId);
  const seat = game.seats[idx];
  const hole = seat.cards;
  const board = game.board;
  const pot = game.pot;
  const toCall = game.currentBet - seat.roundContribution;
  const myStack = seat.chips;
  const bb = game.opts.bigBlind;
  const numOpp = game.seats.filter(s => !s.folded && s.id !== seatId).length;
  const posQ = positionQuality(game, idx);
  const canCheck = toCall <= 0;

  if (game.stage === 'preflop') {
    const str = preflopStrength(hole[0], hole[1]);
    const raised = game.currentBet > bb;
    if (raised) {
      const potOdds = toCall / (pot + toCall);
      const callThr = 0.55 + (1 - posQ) * 0.10;
      if (str >= 0.90) {
        const t = Math.max(game.currentBet * 3, r2(pot * 0.8));
        return Object.assign(planRaise(game, seat, t), { reason: '强起手牌，3-bet 获取价值' });
      }
      if (str >= callThr && potOdds < 0.34) {
        return { action: 'call', reason: `中等牌力，底池赔率 ${(potOdds * 100).toFixed(0)}% 合适跟注` };
      }
      if (str < 0.22 && pf.bluff > Math.random() && isBluffPreflop(hole)) {
        return Object.assign(planRaise(game, seat, game.currentBet * 3), { reason: '用听牌型起手牌 3-bet 诈唬，平衡范围' });
      }
      return { action: 'fold', reason: '面对加注牌力不足，弃牌保留筹码' };
    }
    const openThr = OPEN_THRESHOLDS[clamp(Math.round(posQ * 4), 0, 4)] + pf.openAdj;
    if (str >= openThr) {
      const size = r2(bb * (2.2 + (1 - posQ) * 0.6));
      return Object.assign(planRaise(game, seat, size), { reason: `位置 ${posQ > 0.66 ? '后位' : posQ > 0.33 ? '中位' : '前位'}，按范围开池加注` });
    }
    if (str >= openThr - 0.12 && posQ >= 0.5 && toCall <= bb) {
      return { action: canCheck ? 'check' : 'call', reason: '边缘牌，后期位置便宜看翻牌' };
    }
    return { action: canCheck ? 'check' : 'fold', reason: '牌力不足，不入池' };
  }

  // ---- 翻后 ----
  const eq = estimateEquity(hole, board, numOpp, 160);
  const equity = eq.equity;
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const drawsD = detectDraws(hole, board);
  const texD = boardTexture(board);

  if (canCheck) {
    if (equity >= 0.72) {
      return Object.assign(planBet(game, seat, r2(pot * (0.55 + Math.random() * 0.2))), { reason: '强牌，下注拿价值' });
    }
    if (equity >= 0.5) {
      if (Math.random() < 0.6) {
        return Object.assign(planBet(game, seat, r2(pot * 0.5)), { reason: '中等牌力，下小注拿价值/保护' });
      }
      return { action: 'check', reason: '中等牌力，过牌控制底池规模' };
    }
    if (pf.bluff > Math.random() && pot < myStack) {
      return Object.assign(planBet(game, seat, r2(pot * 0.5)), { reason: '用弱牌做半诈唬下注施压' });
    }
    return { action: 'check', reason: '牌力弱，过牌' };
  } else {
    if (equity >= 0.72) {
      const r = planRaise(game, seat, r2(game.currentBet + pot * 0.75));
      if (r.action === 'raise') return Object.assign(r, { reason: '强牌加注榨取价值' });
      return { action: 'call', reason: '筹码不足以加注，跟注拿价值' };
    }
    if (equity > potOdds + 0.04) {
      return { action: 'call', reason: `胜率约 ${(equity * 100).toFixed(0)}% 高于底池赔率 ${(potOdds * 100).toFixed(0)}%，跟注为正 EV` };
    }
    // 隐含赔率跟注：听牌当前胜率不足 pot odds，但买中后能榨取额外筹码
    if (drawsD.outs >= 4 && toCall > 0) {
      const io = computeImpliedOdds(game, seat, drawsD, texD);
      if (io.hitProb > io.impliedReqEq - 0.03) {
        return { action: 'call', reason: `听牌隐含赔率跟注：约 ${drawsD.outs} 个补牌，翻后约 ${(io.hitProb * 100).toFixed(0)}% 命中；买中后能榨取约 ${Math.round(io.impliedExtra)} 额外筹码，只需 ${(io.impliedReqEq * 100).toFixed(0)}% 赢率，跟注为正 EV` };
      }
    }
    if (equity >= 0.30 && pf.bluff > Math.random() * 0.8 && pot < myStack * 2) {
      const r = planRaise(game, seat, r2(game.currentBet + pot * 0.6));
      if (r.action === 'raise') return Object.assign(r, { reason: '用听牌半诈唬加注' });
    }
    return { action: 'fold', reason: `胜率约 ${(equity * 100).toFixed(0)}% 低于底池赔率 ${(potOdds * 100).toFixed(0)}%，弃牌省筹码` };
  }
}

// ============================================================
//  analyze：教练分析（确定性，便于学习）
// ============================================================
const ACTION_LABELS = {
  fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注', allin: '全下',
};

function analyze(game, seatId, coachStyle = 'standard') {
  const CS = COACH_STYLES[coachStyle] || COACH_STYLES.standard;
  const bias = CS.bias;
  const idx = game.seats.findIndex(s => s.id === seatId);
  const seat = game.seats[idx];
  const board = game.board;
  const hole = seat.cards;
  const pot = game.pot;
  const toCall = game.currentBet - seat.roundContribution;
  const myStack = seat.chips;
  const bb = game.opts.bigBlind;
  const numOpp = game.seats.filter(s => !s.folded && s.id !== seatId).length;
  const posQ = positionQuality(game, idx);
  const canCheck = toCall <= 0;
  // 起手牌精确强度（蒙特卡洛单挑胜率百分位），全程可用，用于教练面板进度条
  const pfStr = (hole && hole[0] && hole[1]) ? preflopStrength(hole[0], hole[1]) : null;

  const base = {
    stage: game.stage,
    pot, toCall, myStack, numOpp,
    canCheck,
    isHeadsUp: numOpp === 1,
    position: posQ > 0.66 ? '后位（有利）' : posQ > 0.33 ? '中位' : '前位（不利）',
    positionScore: +posQ.toFixed(2),
  };

  let recommendation;        // 动作意图字符串
  let concept = '';
  let reasoning = '';
  let equity = null, potOdds = null, handStrength = null, handName = null, handCategoryName = null;

  if (game.stage === 'preflop') {
    const str = preflopStrength(hole[0], hole[1]);
    handStrength = +str.toFixed(2);
    handName = describePreflop(hole[0], hole[1]);
    const raised = game.currentBet > bb;
    const openThr = OPEN_THRESHOLDS[clamp(Math.round(posQ * 4), 0, 4)] - bias * 0.07;
    potOdds = toCall > 0 ? +(toCall / (pot + toCall)).toFixed(2) : 0;

    if (raised) {
      const callThr = 0.55 + (1 - posQ) * 0.10 - bias * 0.08;
      if (str >= 0.90) recommendation = 'raise';
      else if (str >= callThr && potOdds < 0.34 + bias * 0.03) recommendation = 'call';
      else recommendation = 'fold';
      concept = '面对加注：用强牌 3-bet 价值、用有赔率的牌跟注、弱牌果断弃掉——别用边缘牌"好奇跟注"。';
      reasoning = `起手牌 ${handName}：单挑胜率约 ${(preflopEquityHU(hole[0], hole[1]) * 100).toFixed(1)}%，强度 ${(str * 100).toFixed(1)}/100（强于约 ${(str * 100).toFixed(0)}% 的起手牌）；底池赔率 ${(potOdds * 100).toFixed(0)}%。`;
    } else {
      if (str >= openThr) recommendation = 'raise';
      else if (str >= openThr - 0.12 && posQ >= 0.5 && toCall <= bb) recommendation = canCheck ? 'check' : 'call';
      else recommendation = canCheck ? 'check' : 'fold';
      concept = `位置 ${base.position}：此位置建议开池范围约为前 ${Math.round((1 - openThr) * 100)}% 起手牌。前位只玩强牌，后位可放宽。`;
      reasoning = `起手牌 ${handName}：单挑胜率约 ${(preflopEquityHU(hole[0], hole[1]) * 100).toFixed(1)}%，强度 ${(str * 100).toFixed(1)}/100（强于约 ${(str * 100).toFixed(0)}% 的起手牌）；该位置开池阈值约 ${(openThr * 100).toFixed(0)}/100。`;
    }
  } else {
    // 核心：用“对手推断范围”而非随机牌估算胜率
    const eqR = estimateEquityVsRanges(game, seatId, 200);
    equity = +eqR.equity.toFixed(2);
    potOdds = toCall > 0 ? +(toCall / (pot + toCall)).toFixed(2) : 0;
    const cat = evaluate7([...hole, ...board]).category;
    handCategoryName = CATEGORY_NAMES[cat];
    base.handStrength = null;
    const draws = detectDraws(hole, board);
    const tex = boardTexture(board);
    const io = computeImpliedOdds(game, seat, draws, tex);
    base.impliedOdds = {
      hitProb: +io.hitProb.toFixed(2),
      directReqEq: +io.directReqEq.toFixed(2),
      impliedReqEq: +io.impliedReqEq.toFixed(2),
      impliedExtra: Math.round(io.impliedExtra),
      outs: io.outs,
    };

    // 每个对手范围在牌面的命中 + 我的顶对是否可能落后
    const oppNotes = [];
    let maxOppHit = 0, maxOppName = '';
    for (const o of (eqR.perOpp || [])) {
      const hit = rangeHitStats(o.range, board, 120);
      o.hit = hit;
      if (hit.topPairPlusPct > maxOppHit) { maxOppHit = hit.topPairPlusPct; maxOppName = o.name; }
      if (hit.topPairPlusPct >= 0.25 || hit.strongMadePct >= 0.12)
        oppNotes.push(`${o.name} 的范围在此牌面约 ${Math.round(hit.topPairPlusPct * 100)}% 中顶对+、${Math.round(hit.strongMadePct * 100)}% 已成两对+`);
    }

    // 我的行为线
    const myLine = analyzeMyLine(game, seatId);
    // 对手如何应对我
    const responses = analyzeResponses(game, seatId);

    // 多人底池更难领先
    const multiPenalty = numOpp > 1 ? (numOpp - 1) * 0.05 : 0;
    // 牌面是否帮到对手范围 -> 调整我方“价值”判断
    const boardHelpedThem = maxOppHit >= 0.4;

    if (canCheck) {
      if (equity >= 0.72 - multiPenalty * 0.3 - bias * 0.06 && !boardHelpedThem) {
        recommendation = 'bet';
        concept = '价值下注：你大概率领先（已按对手可能范围估算），下注让落后牌和听牌都付出代价。';
      } else if (equity >= 0.72 - multiPenalty * 0.3 - bias * 0.06 && boardHelpedThem) {
        recommendation = Math.random() < CS.betProb ? 'bet' : 'check';
        concept = '你虽强，但牌面明显帮到了对手范围（他们常能中顶对+），下注可能被反加注；可小注或控池。';
      } else if (draws.outs >= 8 && Math.random() < CS.bluffProb) {
        recommendation = 'bet';
        concept = `半诈唬：你有约 ${draws.outs} 个补牌（${draws.drawNames.join('、')}），下注既可能直接拿下底池，也常在成牌后获得价值。`;
      } else if (equity >= 0.5) {
        recommendation = (Math.random() < CS.betProb) ? 'bet' : 'check';
        concept = '中等牌力：可小注拿薄价值/保护，也可过牌控池，别把底池搞太大。';
      } else if (draws.outs >= 6 && pot < myStack) {
        recommendation = 'check';
        concept = `你有听牌（约 ${draws.outs} outs），过牌保留权益，等免费或便宜的牌。`;
      } else {
        recommendation = 'check';
        concept = '牌力弱，过牌控制损失。';
      }
    } else {
      const needEq = potOdds + 0.04 + multiPenalty - bias * 0.04;
      if (equity >= 0.72 - multiPenalty * 0.3 - bias * 0.06 && !boardHelpedThem) {
        const r = planRaise(game, seat, r2(game.currentBet + pot * (0.6 + Math.min(0.3, equity - 0.7))));
        if (r.action === 'raise') { recommendation = 'raise'; concept = '强牌加注榨取价值，别只平跟。'; }
        else { recommendation = 'call'; concept = '筹码不足以加注，跟注拿价值。'; }
      } else if (equity >= 0.72 - multiPenalty * 0.3 - bias * 0.06 && boardHelpedThem) {
        recommendation = 'call';
        concept = '你强但牌面帮到对手，谨慎起见先跟注（别在可能被反加注时过度加注送筹码）。';
      } else if (equity > needEq) {
        recommendation = 'call';
        concept = `底池赔率够：对对手范围的胜率 ${(equity * 100).toFixed(0)}% > 需要的 ${(needEq * 100).toFixed(0)}%（含 ${Math.round(multiPenalty * 100)}% 多人惩罚），跟注是正 EV。`;
      } else if (draws.outs >= 4 && io.hitProb > io.impliedReqEq - 0.03 && io.toCall > 0) {
        // 隐含赔率：听牌当前胜率不足 pot odds，但买中后能榨取额外筹码，按隐含赔率仍值得跟
        recommendation = 'call';
        concept = `隐含赔率跟注：你有约 ${draws.outs} 个补牌（${draws.drawNames.join('、')}），翻后约 ${(io.hitProb * 100).toFixed(0)}% 命中。这类结构性听牌（同花/顺子/连张）买中后常成坚果，对手会往池里塞钱；按隐含赔率你只需 ${(io.impliedReqEq * 100).toFixed(0)}% 赢率即可覆盖（纯底池赔率要 ${(io.directReqEq * 100).toFixed(0)}%），命中率足够，跟注是正 EV。`;
      } else if (draws.outs >= 8 && potOdds < 0.35 && pot < myStack) {
        const r = planRaise(game, seat, r2(game.currentBet + pot * 0.6));
        if (r.action === 'raise') { recommendation = 'raise'; concept = `听牌半诈唬：约 ${draws.outs} 个补牌，用加注施压，既可能直接赢也保留成牌权益。`; }
        else { recommendation = 'call'; concept = `听牌跟注：约 ${draws.outs} 个补牌，底池赔率 ${(potOdds * 100).toFixed(0)}% 足够支撑。`; }
      } else {
        recommendation = 'fold';
        concept = `赔率不足：对对手范围的胜率 ${(equity * 100).toFixed(0)}% < 需要的 ${(needEq * 100).toFixed(0)}%，长期跟注是送筹码，应弃掉。`;
      }
    }

    const drawNote = draws.drawNames.length
      ? ` 当前牌型「${draws.madeName}」，听牌：${draws.drawNames.join('、')}（约 ${draws.outs} outs，${game.stage === 'flop' ? '到河牌' : '这一张'}约 ${(io.hitProb * 100).toFixed(0)}% 成牌率）。`
      : ` 当前牌型「${draws.madeName}」。`;
    const wetNote = `牌面湿润度 ${(tex.wet * 100 | 0)}%（${tex.flushPossible ? '有同花可能' : '无同花可能'}${tex.straightPossible ? '、有顺子可能' : ''}）。`;
    const oppNote = oppNotes.length ? ` 对手范围视角：${oppNotes.join('；')}。${boardHelpedThem ? `牌面明显帮到了${maxOppName}等对手的范围，你的顶对/一对可能并非领先，需谨慎。` : ''}` : '';
    const myNote = ` 你的打法：${myLine.summary}——${myLine.story}。`;
    const respNote = responses.length ? ' ' + responses.map(r => r.text).join(' ') : '';
    reasoning = `（胜率已按对手可能的范围估算，而非随机牌）胜率约 ${(equity * 100).toFixed(0)}%${numOpp > 1 ? `（${numOpp} 名对手，多人底池下领先更难）` : ''}。${drawNote} ${wetNote}${oppNote}${myNote}${respNote}样本有限仅供参考。`;
    base.myLine = myLine.summary;
    base.opponentRangeHit = oppNotes;
  }

  // 把意图转成具体动作 + 金额（尺度随教练风格微调：激进更大、保守更小）
  let plan;
  switch (recommendation) {
    case 'raise': plan = planRaise(game, seat, game.stage === 'preflop'
      ? Math.max(game.currentBet * 3, r2(pot * (0.8 + bias * 0.1)))
      : r2(game.currentBet + pot * (0.75 + bias * 0.1))); break;
    case 'bet':   plan = planBet(game, seat, r2(pot * (0.6 + bias * 0.1))); break;
    case 'call':  plan = { action: seat.roundContribution >= game.currentBet ? 'check' : 'call' }; break;
    case 'check': plan = { action: 'check' }; break;
    case 'fold':  plan = { action: 'fold' }; break;
    default:      plan = { action: 'check' };
  }

  if (CS.note && reasoning) reasoning = reasoning + CS.note;

  return {
    ...base,
    equity, potOdds, handStrength, handName, handCategoryName,
    preflopStrength: pfStr != null ? +pfStr.toFixed(3) : null,
    recommendation,
    recommendationLabel: ACTION_LABELS[plan.action] || plan.action,
    suggestion: plan,
    concept,
    reasoning,
    style: coachStyle,
    styleLabel: CS.label,
  };
}

module.exports = { decide, analyze, estimateEquity, estimateEquityVsRanges, analyzeMyLine, analyzeResponses, preflopStrength, preflopEquityHU, describePreflop, positionQuality, PROFILES, COACH_STYLES, readOpponents, readOpponent, detectDraws, boardTexture, buildRange, rangeHitStats };

// ============================================================
//  readOpponent / readOpponents：教练的「读牌」功能
//  根据对手的公开行为（翻前怎么进池、翻后怎么下注/跟注、下注尺度、
//  以及长期风格数据）推断其牌力范围，并用口语化语言讲解「怎么判断」。
//  这是给人类玩家当教练的核心——教 TA 通过行为读牌，而不是替 TA 打。
// ============================================================
const AGG_ACTIONS = ['bet', 'raise', 'allin'];
const PASS_ACTIONS = ['call', 'check'];
const VOLUNTARY_PF = ['call', 'raise', 'bet', 'allin'];

function readOpponent(game, id, styleStats, actionLog) {
  const s = game.seats.find(x => x.id === id);
  if (!s) return null;
  const acts = (s.handActions || []).slice();
  const pf = acts.filter(a => a.stage === 'preflop');
  const post = acts.filter(a => a.stage !== 'preflop');

  const pfRaise = pf.find(a => AGG_ACTIONS.includes(a.action));
  const pfCall = pf.find(a => a.action === 'call');
  const pfFold = pf.find(a => a.action === 'fold');
  const priorAggBeforePfRaise = pfRaise
    ? acts.slice(0, acts.indexOf(pfRaise)).some(a => AGG_ACTIONS.includes(a.action))
    : false;

  const signals = [];

  // ---- 翻前 ----
  let preText = '';
  if (pfFold) {
    preText = '翻前已弃牌';
    signals.push({ label: '翻前', text: '直接弃牌，说明起手牌偏弱，没进池。' });
  } else if (pfRaise) {
    if (priorAggBeforePfRaise) {
      preText = '翻前 3-bet / 再加注';
      signals.push({ label: '翻前', text: '面对加注还再加注（3-bet），范围通常很窄：大对子（JJ+）、AK，偶尔用同花连张做诈唬。' });
    } else {
      preText = '翻前加注开池';
      signals.push({ label: '翻前', text: '主动加注开池，范围含强牌 + 少量诈唬，整体偏强；但里面也混着 22~99、同花连张等投机牌。' });
    }
  } else if (pfCall) {
    preText = '翻前平跟';
    signals.push({ label: '翻前', text: '只跟注没加注，范围偏宽偏弱；若真有超强牌（AA/KK）通常会加注，所以平跟一般不是怪物。' });
  } else {
    preText = '翻前未加注（看牌/平跟大盲）';
    signals.push({ label: '翻前', text: '没用加注建立底池，通常是中小牌或想便宜看翻牌。' });
  }

  // ---- 翻后 ----
  if (post.length) {
    const bets = post.filter(a => AGG_ACTIONS.includes(a.action));
    const calls = post.filter(a => a.action === 'call');
    const checks = post.filter(a => a.action === 'check');
    const last = post[post.length - 1];

    let maxSizePct = 0;
    for (const b of bets) {
      const p = b.potBefore > 0 ? b.amount / b.potBefore : 0; // 下注增量 / 下注前底池
      if (p > maxSizePct) maxSizePct = p;
    }

    const flopBet = post.find(a => a.stage === 'flop' && AGG_ACTIONS.includes(a.action));
    if (flopBet && pfRaise) {
      signals.push({ label: '翻牌', text: '作为翻前加注者又持续下注（C-bet）。这往往是「范围下注」——用整个范围施压，未必真有牌，常常是在诈唬或半诈唬。' });
    } else if (bets.length >= 2) {
      signals.push({ label: '翻后', text: `多次下注/加注（${bets.length} 次），说明持续施压，多数情况是有牌在拿价值。` });
    } else if (calls.length >= 2) {
      signals.push({ label: '翻后', text: `连续跟注（${calls.length} 次），像在抓诈唬或拿着一对/听牌，空气概率偏低——纯诈唬很难打穿这种玩家。` });
    } else if (checks.length && !bets.length) {
      signals.push({ label: '翻后', text: '一直过牌，通常是弱牌或对子不确定，在控制底池规模。' });
    }

    if (last.action === 'allin') {
      signals.push({ label: '全下', text: '直接全下是两极分化：要么坚果牌拿价值，要么是纯空气诈唬，几乎没有中间牌。' });
    } else if (maxSizePct >= 0.75) {
      signals.push({ label: '下注尺度', text: `下注很大（约占底池 ${Math.round(maxSizePct * 100)}%），大概率是真有强牌在榨取价值，别轻易用弱牌跟。` });
    } else if (bets.length && maxSizePct > 0 && maxSizePct < 0.4) {
      signals.push({ label: '下注尺度', text: `下小注（约占底池 ${Math.round(maxSizePct * 100)}%），可能是薄价值、试探，也可能是半诈唬——尺度本身读不出牌力。` });
    } else if (last.action === 'fold' && post.length > 1) {
      signals.push({ label: '翻后', text: '中途跟注后突然弃牌，说明翻牌/转牌帮到了别人，或它本来就是听牌没成。' });
    }
  }

  // ---- 综合牌力判断（行为先验 + 牌面命中证据，融合推断）----
  let strength = '未知', confidence = 0.3, strengthText = '';
  if (pfFold) {
    strength = '已出局'; confidence = 0.95; strengthText = '已弃牌，不再参与本手。';
  } else {
    // 行为先验
    let prior = 0.5;
    if (pfRaise) prior = priorAggBeforePfRaise ? 0.72 : 0.62;
    else if (pfCall) prior = 0.42;
    else prior = 0.4;

    const bets = post.filter(a => AGG_ACTIONS.includes(a.action));
    const calls = post.filter(a => a.action === 'call');
    const checks = post.filter(a => a.action === 'check');
    let behAdj = 0;
    if (bets.length >= 2) behAdj += 0.15;
    else if (bets.length === 1) behAdj += 0.06;
    if (calls.length >= 2) behAdj -= 0.12;
    if (checks.length && !bets.length) behAdj -= 0.1;
    let maxSizePct = 0;
    for (const b of bets) { const p = b.potBefore > 0 ? b.amount / b.potBefore : 0; if (p > maxSizePct) maxSizePct = p; }
    if (maxSizePct >= 0.75) behAdj += 0.08;

    let score = clamp(prior + behAdj, 0.08, 0.95);

    // 牌面命中证据（翻后）：对手范围在此牌面是否真的被帮到
    let hit = null, hitNote = '';
    const boardNow = game.board || [];
    if (boardNow.length >= 3) {
      const range = buildRange(s, {
        threeBet: priorAggBeforePfRaise,
        pfRaise: !!pfRaise,
        pfCall: !!pfCall,
        limp: !pfRaise && !pfCall,
      });
      hit = rangeHitStats(range, boardNow, 140);
      const aggressive = bets.length > 0;
      const hitEvidence = (hit.strongMadePct - 0.18) * 1.1 + (hit.topPairPlusPct - 0.30) * 0.5;
      score = aggressive ? clamp(score + hitEvidence * 0.6, 0.1, 0.95) : clamp(score + hitEvidence * 0.3, 0.1, 0.95);
      hitNote = `其范围在此牌面约 ${Math.round(hit.topPairPlusPct * 100)}% 能命中顶对+、约 ${Math.round(hit.strongMadePct * 100)}% 已成强牌（两对+）。`;
      if (aggressive && hit.strongMadePct < 0.12) {
        signals.push({ label: '牌面', text: `${hitNote} 它在牌面不太可能帮到其范围时还下注，更像是用整个范围施压的“范围下注/半诈唬”，别被吓到。` });
      } else if (aggressive && hit.strongMadePct >= 0.2) {
        signals.push({ label: '牌面', text: `${hitNote} 牌面明显帮到了它的范围，这次下注很可能是真有牌。` });
      }
    }

    strength = score >= 0.62 ? '偏强' : score >= 0.45 ? '中等' : '偏弱';
    const info = Math.min(0.5, post.length * 0.08) + (boardNow.length >= 4 ? 0.15 : 0) + (hit ? 0.15 : 0);
    confidence = +clamp(0.4 + info + Math.abs(score - 0.5) * 0.4, 0.3, 0.92).toFixed(2);
    strengthText = `综合其翻前入池方式、翻后表现${hit ? '与牌面命中程度' : ''}，估计牌力「${strength}」（置信度约 ${Math.round(confidence * 100)}%）。注意：这是基于公开行为的推断，不是确切底牌。${hitNote}`;
  }

  // ---- 教学小结：教你怎么读这种玩家 ----
  const teaching = [];
  if (pfRaise) {
    if (priorAggBeforePfRaise) teaching.push('读牌技巧：遇到 3-bet，除非你拿 JJ+/AK 或强同花连张，否则别用边缘牌跟注——3-bet 范围很窄且偏强。');
    else teaching.push('读牌技巧：面对翻前加注开池，可用「3-bet 反击」它的投机牌部分；但若你只是中等对子，跟注要看赔率。');
  }
  if (pfRaise && post.some(a => a.stage === 'flop' && AGG_ACTIONS.includes(a.action))) {
    teaching.push('读牌技巧：TA 翻牌 C-bet 不等于有牌。若翻牌对你的范围有利（你有顶对/强听牌），可以用加注（check-raise）反击它的范围下注。');
  }
  if (post.filter(a => a.action === 'call').length >= 2) {
    teaching.push('读牌技巧：连续跟注的玩家多半「有点东西」（一对或听牌），纯诈唬很难打穿——要有真实牌力才去下注。');
  }
  if (post.some(a => a.action === 'allin')) {
    teaching.push('读牌技巧：全下是两极分化下注，别凭「感觉它在诈唬」去跟中等牌；要么你有坚果，要么你确信它在偷。');
  }
  if (styleStats && styleStats.hands >= 3) {
    const v = styleStats.hands ? styleStats.vpip / styleStats.hands : 0;
    const p = styleStats.hands ? styleStats.pfr / styleStats.hands : 0;
    const af = styleStats.postPass ? styleStats.postAggr / styleStats.postPass : styleStats.postAggr;
    let style = '标准';
    if (v >= 0.4 && p < 0.2) style = '松弱（爱跟注、少加注）';
    else if (v < 0.25 && p >= 0.18) style = '紧凶（少玩、玩就加注）';
    else if (v >= 0.4 && p >= 0.28) style = '松凶（又玩又凶）';
    else if (v < 0.25 && p < 0.15) style = '紧弱（紧但被动）';
    teaching.push(`长期数据：VPIP ${Math.round(v * 100)}% / PFR ${Math.round(p * 100)}% / 激进度 ${af.toFixed(1)} → 风格「${style}」。多用强牌价值下注对付松弱，小心松凶的诈唬。`);
  }

  // ---- 对手“如何应对上一行动者”的响应信号（基于全局时间线，取紧邻前一动作）----
  if (actionLog && actionLog.length) {
    const alog = actionLog.slice().sort((a, b) => a.seq - b.seq);
    const myActs = alog.filter(a => a.actorId === id);
    if (myActs.length) {
      const last = myActs[myActs.length - 1];
      const prev = alog.find(a => a.seq === last.seq - 1); // 紧邻其前的那一手
      if (prev) {
        const stimulus = prev.action, resp = last.action;
        if (AGG_ACTIONS.includes(stimulus)) {
          if (resp === 'raise' || resp === 'allin') signals.push({ label: '应对', text: `在有人下注/加注后它反加注，多半是真有强牌，谨慎对待。` });
          else if (resp === 'call') signals.push({ label: '应对', text: `在有人下注后它只跟注，其范围多半被封顶（一对/听牌），不太可能是坚果。` });
          else if (resp === 'fold') signals.push({ label: '应对', text: `在有人下注后它弃牌，说明它大概率没货。` });
        } else if (stimulus === 'check') {
          if (resp === 'bet' || resp === 'raise') signals.push({ label: '应对', text: `在有人过牌后它主动下注，可能在偷池；若对方有一对/听牌，可考虑加注反击。` });
          else if (resp === 'check') signals.push({ label: '应对', text: `双方都过牌，都在控制底池，多半都不强。` });
        }
      }
    }
  }

  return {
    id: s.id,
    name: s.name,
    isBot: !!s.isBot,
    summary: preText + (post.length ? '；翻后有 ' + post.map(a => ACTION_LABELS[a.action]).join('→') + ' 行为' : ''),
    signals,
    read: { strength, confidence: +confidence.toFixed(2), text: strengthText },
    teaching,
  };
}

function readOpponents(game, styleMap) {
  const out = [];
  const alog = game.actionLog || [];
  for (const s of game.seats) {
    const r = readOpponent(game, s.id, (styleMap && styleMap[s.id]) || null, alog);
    if (r) out.push(r);
  }
  return out;
}
