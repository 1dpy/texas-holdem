'use strict';
/*
 * 引擎单元测试（node 自带 assert，无第三方依赖）
 * 运行: node test/engine.test.js
 */
const assert = require('assert');
const { Game, evaluate5, compareHands, CATEGORY_NAMES } = require('../engine');

const c = (r, s) => ({ r, s });

let passed = 0;
function check(name, cond) {
  assert.ok(cond, 'FAILED: ' + name);
  passed++;
  console.log('  ✓ ' + name);
}

console.log('== 牌型判定 (evaluate5) ==');
check('同花顺 category=8', evaluate5([c(14,0),c(13,0),c(12,0),c(11,0),c(10,0)]).category === 8);
check('四条 category=7', evaluate5([c(9,0),c(9,1),c(9,2),c(9,3),c(2,0)]).category === 7);
check('葫芦 category=6', evaluate5([c(9,0),c(9,1),c(9,2),c(2,0),c(2,1)]).category === 6);
check('同花 category=5', evaluate5([c(14,0),c(11,0),c(8,0),c(5,0),c(2,0)]).category === 5);
check('顺子 category=4', evaluate5([c(9,0),c(8,1),c(7,2),c(6,3),c(5,0)]).category === 4);
check('轮子 A-2-3-4-5 为顺子 category=4', evaluate5([c(14,0),c(2,1),c(3,2),c(4,3),c(5,0)]).category === 4);
check('三条 category=3', evaluate5([c(9,0),c(9,1),c(9,2),c(4,0),c(2,1)]).category === 3);
check('两对 category=2', evaluate5([c(9,0),c(9,1),c(4,2),c(4,3),c(2,0)]).category === 2);
check('一对 category=1', evaluate5([c(9,0),c(9,1),c(5,2),c(4,3),c(2,0)]).category === 1);
check('高牌 category=0', evaluate5([c(14,0),c(11,1),c(8,2),c(5,3),c(2,0)]).category === 0);

console.log('== 牌力比较 (compareHands) ==');
check('同花顺 > 四条', compareHands(
  evaluate5([c(14,0),c(13,0),c(12,0),c(11,0),c(10,0)]),
  evaluate5([c(9,0),c(9,1),c(9,2),c(9,3),c(2,0)])) > 0);
check('一对 > 高牌', compareHands(
  evaluate5([c(9,0),c(9,1),c(5,2),c(4,3),c(2,0)]),
  evaluate5([c(14,0),c(11,1),c(8,2),c(5,3),c(2,0)])) > 0);
check('同分牌型平局返回0', compareHands(
  evaluate5([c(9,0),c(9,1),c(5,2),c(4,3),c(2,0)]),
  evaluate5([c(9,2),c(9,3),c(5,0),c(4,1),c(2,1)])) === 0);

console.log('== 边池分层 (_computePots) ==');
{
  const g = new Game();
  g.seats = [
    { totalContribution: 10 },
    { totalContribution: 10 },
    { totalContribution: 50 },
  ];
  const pots = g._computePots();
  const total = pots.reduce((a, p) => a + p.amount, 0);
  check('边池总额守恒 (10+10+50=70)', total === 70);
  check('两层边池 (主池30 + 侧池40)', pots.length === 2 && pots[0].amount === 30 && pots[1].amount === 40);
}

console.log('== 发牌正确性 ==');
{
  const g = new Game({ startingChips: 1000, botAutoRebuy: false });
  g.addPlayer('a', 'A', 1000);
  g.addPlayer('b', 'B', 1000);
  const r = g.startHand();
  check('startHand 成功', !r.error);
  check('每人发到 2 张底牌', g.seats.every(s => s.cards.length === 2));
  // 收集所有发出去的牌（2人底牌 + 翻牌前公共牌未发），验证 52 张牌不重复
  const all = [];
  g.seats.forEach(s => s.cards.forEach(x => all.push(x.r + '-' + x.s)));
  const uniq = new Set(all.map(x => x));
  check('底牌无重复', uniq.size === all.length);
  check('牌堆剩余 48 张', g.deck.length === 48);
  check('牌堆无重复', new Set(g.deck.map(x => x.r + '-' + x.s)).size === 48);
}

console.log('\n所有测试通过 ✅ 共 ' + passed + ' 项');
