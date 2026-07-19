'use strict';

// ===== 基础工具 =====
function makeDeck() {
  const deck = [];
  for (let r = 2; r <= 14; r++) {
    for (let s = 0; s < 4; s++) deck.push({ r, s });
  }
  return deck;
}

function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function combos(arr, k) {
  const res = [];
  const idx = [];
  function rec(start, depth) {
    if (depth === k) { res.push(idx.map(i => arr[i])); return; }
    for (let i = start; i <= arr.length - (k - depth); i++) {
      idx[depth] = i;
      rec(i + 1, depth + 1);
    }
  }
  rec(0, 0);
  return res;
}

const CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

// 评估 5 张牌
function evaluate5(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);

  const count = {};
  for (const c of cards) count[c.r] = (count[c.r] || 0) + 1;
  const counts = Object.entries(count).map(([r, c]) => ({ r: +r, c }));
  counts.sort((a, b) => b.c - a.c || b.r - a.r);
  const countsArr = counts.map(c => c.c);
  const ranksArr = counts.map(c => c.r);

  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let isStraight = false, straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) { isStraight = true; straightHigh = uniq[0]; }
    // 轮子 A-2-3-4-5
    if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) {
      isStraight = true; straightHigh = 5;
    }
  }

  if (isStraight && isFlush) return { category: 8, ranks: [straightHigh] };
  if (countsArr[0] === 4) return { category: 7, ranks: ranksArr };
  if (countsArr[0] === 3 && countsArr[1] === 2) return { category: 6, ranks: ranksArr };
  if (isFlush) return { category: 5, ranks };
  if (isStraight) return { category: 4, ranks: [straightHigh] };
  if (countsArr[0] === 3) return { category: 3, ranks: ranksArr };
  if (countsArr[0] === 2 && countsArr[1] === 2) return { category: 2, ranks: ranksArr };
  if (countsArr[0] === 2) return { category: 1, ranks: ranksArr };
  return { category: 0, ranks };
}

// 评估 7 张牌（取最佳 5 张）
function evaluate7(cards) {
  let best = null;
  for (const combo of combos(cards, 5)) {
    const ev = evaluate5(combo);
    if (!best || compareHands(ev, best) > 0) best = ev;
  }
  return best;
}

// a > b 返回正数
function compareHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < a.ranks.length; i++) {
    const av = a.ranks[i] || 0, bv = b.ranks[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ===== 牌局 =====
class Game {
  constructor(opts = {}) {
    this.opts = {
      smallBlind: opts.smallBlind || 5,
      bigBlind: opts.bigBlind || 10,
      startingChips: opts.startingChips || 1000,
      maxSeats: opts.maxSeats || 9,
      botAutoRebuy: opts.botAutoRebuy !== false,                          // 机器人输光后自动补码（默认开）
      botRebuyChips: opts.botRebuyChips || opts.startingChips || 1000,  // 每次自动补码数量
    };
    this.seats = [];
    this.deck = [];
    this.board = [];
    this.buttonIndex = -1;
    this.stage = 'waiting'; // waiting | preflop | flop | turn | river | handover
    this.currentBet = 0;
    this.minRaise = this.opts.bigBlind;
    this.lastAggressor = null;
    this.toActIndex = null;
    this.pot = 0;
    this.log = [];
    this.actionLog = [];  // 全局结构化动作时间线（供读牌/教练分析“对手如何应对”）
    this.lastResult = null;
    this.handNumber = 0;
    this.roomId = null;
  }

  addPlayer(id, name, chipsOverride) {
    if (this.seats.find(s => s.id === id)) return false;
    if (this.seats.length >= this.opts.maxSeats) return false;
    if (!['waiting', 'handover'].includes(this.stage)) return false;
    const startChips = (typeof chipsOverride === 'number' && chipsOverride > 0)
      ? chipsOverride : this.opts.startingChips;
    this.seats.push({
      id, name: name || id,
      chips: startChips,
      cards: [], folded: false, allIn: false, disconnected: false, shown: null,
      totalContribution: 0, roundContribution: 0, actedThisRound: false,
      handEval: null, rebuy: 0,
    });
    return true;
  }

  // 添加机器人座位（人机模式）
  addBot(id, name, profile = 'balanced') {
    if (this.seats.find(s => s.id === id)) return false;
    if (this.seats.length >= this.opts.maxSeats) return false;
    if (!['waiting', 'handover'].includes(this.stage)) return false;
    this.seats.push({
      id, name: name || id, isBot: true, botProfile: profile,
      chips: this.opts.startingChips,
      cards: [], folded: false, allIn: false, disconnected: false, shown: null,
      totalContribution: 0, roundContribution: 0, actedThisRound: false,
      handEval: null, rebuy: 0,
    });
    return true;
  }

  removePlayer(id) {
    const i = this.seats.findIndex(s => s.id === id);
    if (i < 0) return;
    if (this.stage === 'waiting') { this.seats.splice(i, 1); return; }
    const s = this.seats[i];
    if (!s.folded) { s.folded = true; s.actedThisRound = true; }
    s.disconnected = true;
    if (this.toActIndex === i) this.advanceTurn();
    if (this.inHandPlayers().length <= 1) this._onRoundComplete();
  }

  // 补码（rebuy）：给玩家补充筹码，并记录累计补码量
  rebuy(id, amount) {
    const idx = this.seats.findIndex(s => s.id === id);
    if (idx < 0) return { error: '玩家不存在' };
    const s = this.seats[idx];
    if (s.isBot) return { error: '机器人不需要补码' };
    const amt = Math.floor(Number(amount));
    if (!amt || amt <= 0) return { error: '补码数量无效' };
    if (amt > 1000000) return { error: '单笔补码不能超过 100 万' };
    // 不能在轮到自己行动时补码，避免中途加注干扰当前决策
    if (this.toActIndex === idx && ['preflop', 'flop', 'turn', 'river'].includes(this.stage))
      return { error: '请先完成当前行动，再补码' };
    s.chips += amt;
    s.rebuy = (s.rebuy || 0) + amt;
    if (s.chips > 0) s.folded = false; // 补码后复活
    this.log.push({ msg: `${s.name} 补码 +${amt}` });
    return { ok: true, chips: s.chips, rebuyTotal: s.rebuy };
  }

  inHandPlayers() { return this.seats.filter(s => !s.folded); }
  canActPlayers() { return this.seats.filter(s => !s.folded && !s.allIn && s.chips > 0); }

  // ===== 发牌 / 开局 =====
  startHand() {
    if (this.stage !== 'waiting' && this.stage !== 'handover') return { error: '当前牌局进行中' };
    // 机器人自动补码：输光后自动补充，保证对局能持续进行
    if (this.opts.botAutoRebuy) {
      for (const s of this.seats) {
        if (s.isBot && s.chips <= 0) {
          const amt = this.opts.botRebuyChips || this.opts.startingChips || 1000;
          s.chips += amt;
          s.rebuy = (s.rebuy || 0) + amt;
          this.log.push({ msg: `${s.name} 自动补码 +${amt}` });
        }
      }
    }
    const players = this.seats.filter(s => s.chips > 0);
    if (players.length < 2) return { error: '至少需要 2 名有筹码的玩家' };

    this.handNumber++;
    this.board = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.opts.bigBlind;
    this.lastAggressor = null;
    this.lastResult = null;
    this.deck = shuffle(makeDeck());

    for (const s of this.seats) {
      s.cards = [];
      s.folded = s.chips <= 0;
      s.allIn = false;
      s.totalContribution = 0;
      s.roundContribution = 0;
      s.actedThisRound = false;
      s.handEval = null;
      s.handActions = [];   // 本手每次动作的公开行为记录，供读牌/教练分析
      s.disconnected = false; // 每手重置在线状态（防御：避免旧断线标记导致被自动弃牌）
      s.shown = null;       // 每手重置亮牌选择（handover 时再按人机/真人决定）
    }

    this.buttonIndex = this._nextButton();
    const numActive = players.length;
    let sbIdx, bbIdx;
    if (numActive === 2) {
      sbIdx = this.buttonIndex;
      bbIdx = this._nextOccupied(sbIdx);
    } else {
      sbIdx = this._nextOccupied(this.buttonIndex);
      bbIdx = this._nextOccupied(sbIdx);
    }
    this._postBlind(sbIdx, this.opts.smallBlind);
    this._postBlind(bbIdx, this.opts.bigBlind);

    for (let k = 0; k < 2; k++)
      for (const s of this.seats) if (!s.folded) s.cards.push(this.deck.pop());

    this.stage = 'preflop';
    this.currentBet = this.opts.bigBlind;

    let firstIdx;
    if (numActive === 2) firstIdx = sbIdx; // 单挑：小盲（按钮位）翻前先行动
    else firstIdx = this._nextOccupied(bbIdx);
    this.toActIndex = firstIdx;
    return { ok: true };
  }

  _nextButton() {
    let i = this.buttonIndex;
    for (let step = 0; step < this.seats.length; step++) {
      i = (i + 1) % this.seats.length;
      const s = this.seats[i];
      if (s.chips > 0) return i;
    }
    return 0;
  }

  _nextOccupied(fromIdx) {
    let i = fromIdx;
    for (let step = 0; step < this.seats.length; step++) {
      i = (i + 1) % this.seats.length;
      const s = this.seats[i];
      if (s.chips > 0 && !s.folded) return i;
    }
    return fromIdx;
  }

  _postBlind(idx, amount) {
    const s = this.seats[idx];
    const put = Math.min(amount, s.chips);
    s.chips -= put;
    s.roundContribution += put;
    s.totalContribution += put;
    this.pot += put;
    if (s.chips === 0) s.allIn = true;
  }

  _deal(n) {
    for (let i = 0; i < n; i++) this.board.push(this.deck.pop());
  }

  // ===== 玩家动作 =====
  _guardAct(id) {
    if (!['preflop', 'flop', 'turn', 'river'].includes(this.stage)) return { error: '当前不能操作' };
    const idx = this.seats.findIndex(s => s.id === id);
    if (idx < 0) return { error: '玩家不存在' };
    if (this.toActIndex !== idx) return { error: '还没轮到你' };
    return null;
  }

  act(id, action, amount) {
    const g = this._guardAct(id);
    if (g) return g;
    const idx = this.seats.findIndex(s => s.id === id);
    const s = this.seats[idx];
    const toCallDecision = Math.max(0, this.currentBet - s.roundContribution);
    const potBeforeAction = this.pot;
    let display = null;

    if (action === 'fold') {
      this._doFold(idx);
    } else if (action === 'check') {
      if (s.roundContribution !== this.currentBet) return { error: '现在不能过牌（需跟注或加注）' };
      s.actedThisRound = true;
    } else if (action === 'call') {
      const cost = this.currentBet - s.roundContribution;
      display = Math.min(cost, s.chips);
      this._doCall(idx);
    } else if (action === 'bet' || action === 'raise') {
      const target = Number(amount);
      const need = target - s.roundContribution;
      if (!(target > this.currentBet)) return { error: '加注必须大于当前下注' };
      if (need > s.chips) return { error: '筹码不足' };
      if (need < this.minRaise && s.chips > need) return { error: `至少加注 ${this.minRaise}` };
      const oldBet = this.currentBet;
      s.chips -= need;
      s.roundContribution += need;
      s.totalContribution += need;
      this.pot += need;
      if (s.roundContribution > this.currentBet) {
        this.currentBet = s.roundContribution;
        if (s.chips === 0) s.allIn = true;
        else this.minRaise = Math.max(this.minRaise, this.currentBet - oldBet);
      }
      s.actedThisRound = true;
      this.lastAggressor = idx;
      display = target;
    } else if (action === 'allin') {
      const need = s.chips;
      const oldBet = this.currentBet;
      s.chips = 0;
      s.roundContribution += need;
      s.totalContribution += need;
      this.pot += need;
      if (s.roundContribution > this.currentBet) {
        this.currentBet = s.roundContribution;
        this.minRaise = Math.max(this.minRaise, this.currentBet - oldBet);
      }
      s.allIn = true;
      s.actedThisRound = true;
      this.lastAggressor = idx;
      display = s.roundContribution;
    } else {
      return { error: '未知操作' };
    }

    this._logAction(s, action, display, potBeforeAction);

    // 记录公开行为（用于读牌/教练分析）
    if (!s.handActions) s.handActions = [];
    s.handActions.push({
      stage: this.stage,
      action,
      amount: this.pot - potBeforeAction, // 本次动作实际投入的筹码增量（下注尺度用）
      potBefore: potBeforeAction,         // 该动作发生前的底池（用于计算“占底池比例”）
      toCall: toCallDecision,
    });

    if (this._isRoundComplete()) this._onRoundComplete();
    else this.advanceTurn();
    return { ok: true };
  }

  _doFold(idx) {
    const s = this.seats[idx];
    s.folded = true;
    s.actedThisRound = true;
  }

  _doCall(idx) {
    const s = this.seats[idx];
    const cost = this.currentBet - s.roundContribution;
    if (cost <= 0) { s.actedThisRound = true; return; }
    if (cost >= s.chips) {
      const put = s.chips;
      s.chips = 0;
      s.roundContribution += put;
      s.totalContribution += put;
      this.pot += put;
      s.allIn = true;
    } else {
      s.chips -= cost;
      s.roundContribution += cost;
      s.totalContribution += cost;
      this.pot += cost;
    }
    s.actedThisRound = true;
  }

  _isRoundComplete() {
    const remaining = this.inHandPlayers();
    if (remaining.length <= 1) return true;
    const canAct = this.canActPlayers();
    if (canAct.length === 0) return true;
    return canAct.every(s => s.actedThisRound && s.roundContribution === this.currentBet);
  }

  advanceTurn() {
    if (this.inHandPlayers().length <= 1) { this._onRoundComplete(); return; }
    let idx = this.toActIndex == null ? this.buttonIndex : this.toActIndex;
    for (let step = 0; step < this.seats.length; step++) {
      idx = (idx + 1) % this.seats.length;
      const s = this.seats[idx];
      if (s.folded) continue;
      if (s.allIn || s.chips <= 0) continue;
      if (s.disconnected) {
        this._doFold(idx);
        if (this.inHandPlayers().length <= 1) { this._onRoundComplete(); return; }
        continue;
      }
      this.toActIndex = idx;
      return;
    }
    this.toActIndex = null;
    this._onRoundComplete();
  }

  _onRoundComplete() {
    if (this.inHandPlayers().length <= 1) { this._awardFold(); return; }
    if (this.canActPlayers().length === 0) { this._runToShowdown(); return; }
    this._nextStreet();
  }

  _nextStreet() {
    for (const s of this.seats) { s.roundContribution = 0; s.actedThisRound = false; }
    this.currentBet = 0;
    this.minRaise = this.opts.bigBlind;
    this.lastAggressor = null;

    if (this.stage === 'preflop') { this.stage = 'flop'; this._deal(3); }
    else if (this.stage === 'flop') { this.stage = 'turn'; this._deal(1); }
    else if (this.stage === 'turn') { this.stage = 'river'; this._deal(1); }
    else if (this.stage === 'river') { this._showdown(); return; }

    this.toActIndex = this._firstActorPostflop();
    if (this.toActIndex === null) this._runToShowdown();
  }

  _firstActorPostflop() {
    let i = this.buttonIndex;
    for (let step = 0; step < this.seats.length; step++) {
      i = (i + 1) % this.seats.length;
      const s = this.seats[i];
      if (!s.folded && !s.allIn && s.chips > 0) return i;
    }
    return null;
  }

  _runToShowdown() {
    if (this.stage === 'preflop') { this.stage = 'flop'; this._deal(3); }
    if (this.stage === 'flop') { this.stage = 'turn'; this._deal(1); }
    if (this.stage === 'turn') { this.stage = 'river'; this._deal(1); }
    if (this.stage === 'river') this._showdown();
  }

  _awardFold() {
    const winner = this.inHandPlayers()[0];
    const total = this.seats.reduce((a, s) => a + s.totalContribution, 0);
    if (winner) winner.chips += total;
    this.stage = 'handover';
    this._applyHandoverReveal();
    this.toActIndex = null;
    this.pot = 0;
    this.lastResult = {
      winners: winner ? [winner.id] : [],
      amount: total,
      byFold: true,
    };
  }

  // 进入 handover 时决定每个座位的亮牌状态：
  // 弃牌者已盖牌不可选；人机默认亮牌；真人待其自行选择（shown=null）
  _applyHandoverReveal() {
    for (const s of this.seats) {
      if (s.folded) s.shown = false;
      else if (s.isBot) s.shown = true;
      else s.shown = null;
    }
  }

  // 真人选择是否亮牌给所有人看（仅 handover 阶段、未弃牌时有效）
  revealCards(idx, show) {
    const s = this.seats[idx];
    if (!s || s.folded) return false;
    if (this.stage !== 'handover') return false;
    s.shown = !!show;
    return true;
  }

  _computePots() {
    const contribs = [...new Set(this.seats.map(s => s.totalContribution).filter(c => c > 0))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of contribs) {
      const layer = lvl - prev;
      const contributors = this.seats.filter(s => s.totalContribution >= lvl);
      pots.push({ level: lvl, amount: layer * contributors.length });
      prev = lvl;
    }
    return pots;
  }

  _showdown() {
    const contenders = this.seats.filter(s => !s.folded);
    for (const s of contenders) s.handEval = evaluate7([...s.cards, ...this.board]);

    const pots = this._computePots();
    const results = [];
    for (const pot of pots) {
      // 合格赢家 = 未弃牌且投入达到该层级的玩家；
      // 若该层无人合格（弃牌者投入高于所有剩余玩家），则该笔"死钱"归剩余玩家中最佳手牌者
      const eligible = contenders.filter(s => s.totalContribution >= pot.level);
      const pool = eligible.length ? eligible : contenders;
      let best = pool[0];
      for (const s of pool) if (compareHands(s.handEval, best.handEval) > 0) best = s;
      const winners = pool.filter(s => compareHands(s.handEval, best.handEval) === 0);
      let share = Math.floor(pot.amount / winners.length);
      let rem = pot.amount - share * winners.length;
      for (const w of winners) {
        let amt = share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        w.chips += amt;
        results.push({ id: w.id, amount: amt, category: best.handEval.category });
      }
    }
    this.stage = 'handover';
    this._applyHandoverReveal();
    this.toActIndex = null;
    this.pot = 0;
    this.lastResult = { winners: results.map(r => r.id), results, byFold: false };
  }

  _logAction(s, action, amount, potBefore) {
    if (!this.log) this.log = [];
    if (!this.actionLog) this.actionLog = [];  // 反序列化/旧存档可能缺失，兜底初始化
    const names = { fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注', allin: '全下' };
    let msg = `${s.name} ${names[action] || action}`;
    if (amount && (action === 'bet' || action === 'raise' || action === 'allin' || action === 'call')) msg += ` ${amount}`;
    this.log.push({ time: Date.now(), msg });
    // 结构化全局动作时间线（供读牌/教练分析“对手如何应对”）
    this.actionLog.push({
      seq: this.actionLog.length,
      actorId: s.id,
      actorName: s.name,
      stage: this.stage,
      action,
      amount: amount || 0,
      potBefore: (typeof potBefore === 'number') ? potBefore : this.pot,
    });
  }

  // ===== 序列化（持久化）=====
  serialize() {
    return {
      opts: this.opts,
      seats: this.seats,
      deck: this.deck,
      board: this.board,
      buttonIndex: this.buttonIndex,
      stage: this.stage,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      lastAggressor: this.lastAggressor,
      toActIndex: this.toActIndex,
      pot: this.pot,
      log: this.log.slice(-40),
      lastResult: this.lastResult,
      handNumber: this.handNumber,
      roomId: this.roomId,
      actionLog: this.actionLog || [],
    };
  }

  static deserialize(d) {
    const g = Object.create(Game.prototype);
    Object.assign(g, d);
    if (!g.log) g.log = [];
    if (!g.actionLog) g.actionLog = [];
    return g;
  }

  // ===== 序列化（视图）=====
  state(viewId) {
    return {
      stage: this.stage,
      board: this.board,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      buttonIndex: this.buttonIndex,
      toActIndex: this.toActIndex,
      handNumber: this.handNumber,
      lastResult: this.lastResult,
      botAutoRebuy: this.opts.botAutoRebuy,
      log: this.log.slice(-40),
      seats: this.seats.map((s, i) => {
        const viewerOwns = viewId && s.id === viewId;   // 自己的牌始终可见
        const exposed = !s.folded && s.shown === true;   // 已选择亮牌（人机默认、真人手动）
        return {
          id: s.id,
          name: s.name,
          isBot: !!s.isBot,
          botProfile: s.botProfile || null,
          chips: s.chips,
          folded: s.folded,
          allIn: s.allIn,
          disconnected: s.disconnected,
          roundContribution: s.roundContribution,
          totalContribution: s.totalContribution,
          isButton: i === this.buttonIndex,
          isToAct: i === this.toActIndex,
          rebuy: s.rebuy || 0,
          shown: s.shown,   // null=待选择 / true=已亮牌 / false=已盖牌（仅 handover 有意义）
          cards: viewerOwns || exposed ? s.cards : (s.cards.length ? [null, null] : []),
          handEval: (viewerOwns || exposed) ? s.handEval : null,
        };
      }),
    };
  }
}

module.exports = { Game, evaluate7, evaluate5, compareHands, CATEGORY_NAMES, makeDeck, shuffle };
