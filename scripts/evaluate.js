'use strict';
/*
 * 自对弈量化评估脚本 (headless, no server/ws required)
 * 目的：以实验数据验证博弈 AI 的决策质量，而非仅停留在"算法描述"。
 * 让 AI(balanced) 与三种基线策略 (random / passive / aggressive) 及混合局
 * 在确定性随机数下互打多局，统计各策略的筹码增长率 (ROI)。
 *
 * 运行: node scripts/evaluate.js
 */
const { Game } = require('../engine');
const { decide } = require('../ai');

// ---- 可复现 PRNG：monkey-patch Math.random，保证结果可复现、可写入文档 ----
let _s = 0x9e3779b9;
Math.random = () => {
  _s = (Math.imul(_s, 1664525) + 1013904223) >>> 0;
  return _s / 4294967296;
};

const START_CHIPS = 1000;
const BIG_BLIND = 10;

// 返回当前行动者的合法动作集合与需跟注额
function legalContext(game, seat) {
  const toCall = game.currentBet - seat.roundContribution;
  const canCheck = toCall <= 0;
  const pot = game.pot;
  return { toCall, canCheck, pot };
}

// 基线策略：随机
function moveRandom(game, seat) {
  const { toCall, canCheck } = legalContext(game, seat);
  const opts = [];
  if (canCheck) opts.push('check'); else { opts.push('fold'); opts.push('call'); }
  opts.push('raise');
  const a = opts[Math.floor(Math.random() * opts.length)];
  if (a === 'raise') {
    const want = Math.max(game.currentBet * 2, game.currentBet + game.minRaise);
    if (seat.chips >= want - seat.roundContribution) return { action: 'raise', amount: want };
    return { action: canCheck ? 'check' : 'call', amount: 0 };
  }
  return { action: a, amount: 0 };
}

// 基线策略：被动（能过牌就过牌，从不大注，只在很便宜时跟注）
function movePassive(game, seat) {
  const { toCall, canCheck, pot } = legalContext(game, seat);
  if (canCheck) return { action: 'check', amount: 0 };
  if (toCall <= pot * 0.15 + BIG_BLIND) return { action: 'call', amount: 0 };
  return { action: 'fold', amount: 0 };
}

// 基线策略：激进（高频下注/加注，尺度偏大）
function moveAggressive(game, seat) {
  const { toCall, canCheck, pot } = legalContext(game, seat);
  if (canCheck) {
    const bet = Math.max(BIG_BLIND * 2, Math.round(pot * 0.7));
    if (seat.chips >= bet) return { action: 'bet', amount: bet };
    return { action: seat.chips > 0 ? 'allin' : 'check', amount: 0 };
  }
  const want = Math.max(game.currentBet * 2.5, game.currentBet + game.minRaise);
  if (seat.chips >= want - seat.roundContribution) return { action: 'raise', amount: want };
  return { action: 'call', amount: 0 };
}

// 统一策略分发
function policyMove(game, seat) {
  if (seat.policy === 'ai') {
    const d = decide(game, seat.id, seat.profile || 'balanced');
    return { action: d.action, amount: d.amount || 0 };
  }
  if (seat.policy === 'random') return moveRandom(game, seat);
  if (seat.policy === 'passive') return movePassive(game, seat);
  if (seat.policy === 'aggressive') return moveAggressive(game, seat);
  return { action: legalContext(game, seat).canCheck ? 'check' : 'fold', amount: 0 };
}

// 推进一手牌直至 handover
function playHand(game) {
  const res = game.startHand();
  if (res.error) return;
  let guard = 0;
  while (game.stage !== 'handover' && guard < 10000) {
    if (game.toActIndex === null) break;
    const seat = game.seats[game.toActIndex];
    let mv = policyMove(game, seat);
    let r = game.act(seat.id, mv.action, mv.amount);
    if (r.error) {
      const toCall = game.currentBet - seat.roundContribution;
      r = game.act(seat.id, toCall > 0 ? 'fold' : 'check');
    }
    guard++;
  }
}

// 跑一次 matchup：返回各座位平均筹码增量
function runMatchup(seatConfig, totalHands, repeats) {
  const deltas = seatConfig.map(() => 0);
  for (let r = 0; r < repeats; r++) {
    const game = new Game({ startingChips: START_CHIPS, bigBlind: BIG_BLIND, botAutoRebuy: false });
    seatConfig.forEach((cfg, i) => game.addPlayer('p' + i, 'p' + i, START_CHIPS));
    seatConfig.forEach((cfg, i) => { game.seats[i].policy = cfg.policy; game.seats[i].profile = cfg.profile; });
    const start = game.seats.map(s => s.chips);
    for (let h = 0; h < totalHands; h++) {
      if (game.seats.filter(s => s.chips > 0).length < 2) break;
      playHand(game);
    }
    game.seats.forEach((s, i) => { deltas[i] += (s.chips - start[i]); });
  }
  return deltas.map(d => +(d / repeats).toFixed(1));
}

// 配置：每个 matchup 是一个 seatConfig 数组
const MATCHUPS = [
  { name: 'AI vs 3×随机', seats: [
    { policy: 'ai', profile: 'balanced' }, { policy: 'random' }, { policy: 'random' }, { policy: 'random' } ] },
  { name: 'AI vs 3×被动', seats: [
    { policy: 'ai', profile: 'balanced' }, { policy: 'passive' }, { policy: 'passive' }, { policy: 'passive' } ] },
  { name: 'AI vs 3×激进', seats: [
    { policy: 'ai', profile: 'balanced' }, { policy: 'aggressive' }, { policy: 'aggressive' }, { policy: 'aggressive' } ] },
  { name: '混合局 (AI+保守+激进+随机)', seats: [
    { policy: 'ai', profile: 'balanced' }, { policy: 'ai', profile: 'conservative' },
    { policy: 'aggressive' }, { policy: 'random' } ] },
  { name: '混战 (3×随机+1×被动)', seats: [
    { policy: 'random' }, { policy: 'random' }, { policy: 'random' }, { policy: 'passive' } ] },
];

const TOTAL_HANDS = 400;
const REPEATS = 40;

console.log(`# 自对弈评估结果\n`);
console.log(`- 起始筹码: ${START_CHIPS}，大盲: ${BIG_BLIND}，每人桌 4 人`);
console.log(`- 每局 ${TOTAL_HANDS} 手，重复 ${REPEATS} 次取均值（确定性 PRNG，结果可复现）`);
console.log(`- 指标：平均筹码增减（ROI = 增减 / 起始筹码），正值=稳定盈利\n`);

for (const m of MATCHUPS) {
  const res = runMatchup(m.seats, TOTAL_HANDS, REPEATS);
  console.log(`## ${m.name}`);
  m.seats.forEach((cfg, i) => {
    const label = cfg.policy === 'ai' ? `AI(${cfg.profile})` : cfg.policy;
    const roi = (res[i] / START_CHIPS * 100).toFixed(1) + '%';
    console.log(`- ${label}: 平均筹码 ${res[i] >= 0 ? '+' : ''}${res[i]} (${roi})`);
  });
  console.log('');
}
