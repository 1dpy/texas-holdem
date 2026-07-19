'use strict';

const RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT = ['♠', '♥', '♦', '♣']; // ♠ ♥ ♦ ♣
const SUIT_RED = { 1: true, 2: true };

const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
const ws = new WebSocket(wsProto + location.host);

let myId = null;
let myUserId = null;
let myName = null;
let myHost = false;
let currentRoom = null;
let lastState = null;
let myIsAdmin = false;

const $ = (id) => document.getElementById(id);
const screens = { auth: $('auth'), lobby: $('lobby'), game: $('game'), stats: $('stats'), admin: $('admin') };

function showScreen(name) {
  for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
}

// 恢复本地会话
try {
  const saved = JSON.parse(localStorage.getItem('th_user') || 'null');
  if (saved && saved.userId) { myUserId = saved.userId; myName = saved.name; }
} catch {}
if (myUserId) showScreen('lobby'); else showScreen('auth');

// 预填房间码
const params = new URLSearchParams(location.search);
if (params.get('room')) $('roomInput').value = params.get('room').toUpperCase();

ws.onopen = () => {
  if (myUserId) ws.send(JSON.stringify({ type: 'resume', userId: myUserId }));
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'auth') {
    myUserId = m.userId; myName = m.name; myIsAdmin = !!m.isAdmin;
    localStorage.setItem('th_user', JSON.stringify({ userId: m.userId, name: m.name }));
    $('who').textContent = '已登录：' + m.name + (myIsAdmin ? ' 🛡' : '');
    $('adminBtn').classList.toggle('hidden', !myIsAdmin);
    if (screens.game.classList.contains('hidden')) showScreen('lobby');
  } else if (m.type === 'joined') {
    myId = m.playerId; myHost = m.host; currentRoom = m.roomId;
    resetRenderCache();
    showScreen('game');
    $('roomCode').textContent = m.roomId;
  } else if (m.type === 'state') {
    lastState = m.state; render(m.state);
  } else if (m.type === 'advice') {
    renderCoach(m.advice);
  } else if (m.type === 'error') {
    // 会话失效 / 未登录类错误：清除本地旧登录态，回到登录界面（部署后服务器数据重置时常见）
    const authKw = ['会话已失效', '请重新登录', '请先登录', '账号不存在', '密码错误'];
    if (authKw.some(k => (m.msg || '').includes(k))) {
      try { localStorage.removeItem('th_user'); } catch {}
      myUserId = null; myName = null; myId = null; myHost = false; currentRoom = null;
      showScreen('auth');
      $('authMsg').textContent = m.msg || '请重新登录';
    } else {
      flash(m.msg);
    }
  } else if (m.type === 'analytics') {
    renderAnalytics(m.report, m.forName);
  } else if (m.type === 'accounts') {
    renderAccounts(m.list);
  } else if (m.type === 'invite') {
    $('inviteCodeOut').textContent = m.code;
    $('inviteCodeOut').classList.remove('hidden');
    $('copyInviteBtn').classList.remove('hidden');
  } else if (m.type === 'accountCreated') {
    flash('已创建账号：' + m.name);
    sendObj({ type: 'listAccounts' });
  } else if (m.type === 'ok') {
    flash(m.msg || '操作成功');
    if (m.msg && m.msg.indexOf('管理员') >= 0) sendObj({ type: 'listAccounts' });
  }
};
ws.onclose = () => {
  // 自动重连
  setTimeout(() => location.reload(), 1500);
};

function sendObj(o) { ws.send(JSON.stringify(o)); }

// ===== 账号 =====
$('authBtn').onclick = () => {
  const name = $('authName').value.trim();
  const pass = $('authPass').value;
  if (!name) { $('authMsg').textContent = '请输入昵称'; return; }
  const invite = ($('authInvite').value || '').trim().toUpperCase();
  sendObj({ type: 'auth', name, pass, invite });
};
$('logoutBtn').onclick = () => {
  localStorage.removeItem('th_user');
  location.reload();
};

// ===== 大厅 =====
if (myName) $('who').textContent = '已登录：' + myName;
$('createBtn').onclick = () => {
  sendObj({
    type: 'create', userId: myUserId,
    bots: Number($('botCount').value) || 0,
    botProfile: $('botProfile').value,
    coach: $('coachOn').checked,
    coachStyle: $('coachStyle').value,
    opts: { botAutoRebuy: $('botAutoRebuy').checked },
  });
};
$('joinBtn').onclick = () => {
  const room = ($('roomInput').value || '').trim().toUpperCase();
  if (room.length !== 4) { $('lobbyMsg').textContent = '请输入 4 位房间码'; return; }
  sendObj({ type: 'join', roomId: room, userId: myUserId });
};

// ===== 战绩 / 管理后台 =====
$('statsBtn').onclick = () => {
  sendObj({ type: 'getAnalytics' });
  showScreen('stats');
  $('statsBody').innerHTML = '<p class="reads-hint">加载中…</p>';
};
$('adminBtn').onclick = () => {
  showScreen('admin');
  sendObj({ type: 'listAccounts' });
  $('acctBody').innerHTML = '<p class="reads-hint">加载中…</p>';
};
$('statsBack').onclick = () => showScreen('lobby');
$('adminBack').onclick = () => showScreen('lobby');
$('genInviteBtn').onclick = () => {
  $('inviteCodeOut').textContent = '生成中…';
  $('copyInviteBtn').classList.add('hidden');
  sendObj({ type: 'createInvite' });
};
$('copyInviteBtn').onclick = () => {
  const code = $('inviteCodeOut').textContent;
  if (code && code !== '生成中…') navigator.clipboard?.writeText(code).then(() => flash('邀请码已复制：' + code), () => flash('邀请码：' + code));
};
$('createAccBtn').onclick = () => {
  const name = $('newAccName').value.trim();
  const pass = $('newAccPass').value;
  if (!name) { flash('请输入昵称'); return; }
  sendObj({ type: 'createAccount', name, pass });
  $('newAccName').value = ''; $('newAccPass').value = '';
};

// ===== 游戏交互 =====
$('copyLink').onclick = () => {
  const link = `${location.origin}/?room=${currentRoom}`;
  navigator.clipboard?.writeText(link).then(
    () => flash('邀请链接已复制：' + link),
    () => flash('链接：' + link)
  );
};
$('leaveBtn').onclick = () => {
  sendObj({ type: 'leave' });
  location.reload();
};
$('foldBtn').onclick = () => sendAction('fold');
$('checkBtn').onclick = () => sendAction('check');
$('callBtn').onclick = () => sendAction('call');
$('betRaiseBtn').onclick = () => {
  const cur = lastState; if (!cur) return;
  const amount = Number($('raiseRange').value);
  const action = cur.currentBet > 0 ? 'raise' : 'bet';
  sendAction(action, amount);
};
$('allinBtn').onclick = () => sendAction('allin');
$('revealShowBtn').onclick = () => sendObj({ type: 'reveal', show: true });
$('revealHideBtn').onclick = () => sendObj({ type: 'reveal', show: false });
$('startBtn').onclick = () => sendObj({ type: 'start' });
$('nextBtn').onclick = () => sendObj({ type: 'next' });
$('addBotBtn').onclick = () => sendObj({ type: 'addbot' });
$('adviceBtn').onclick = () => sendObj({ type: 'advice' });
$('coachStyle').onchange = () => sendObj({ type: 'coachStyle', style: $('coachStyle').value });
$('botRebuyBtn').onclick = () => {
  const on = !$('botRebuyBtn').dataset.on || $('botRebuyBtn').dataset.on !== '1';
  $('botRebuyBtn').dataset.on = on ? '1' : '0';
  $('botRebuyBtn').textContent = on ? '🤖 自动补码：开' : '🤖 自动补码：关';
  $('botRebuyBtn').classList.toggle('on', on);
  sendObj({ type: 'botRebuy', on });
};

// 筹码档位按钮：把滑条设到对应「加注量 = 倍数 × 底池」的位置
document.querySelectorAll('.chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const cur = lastState; if (!cur) return;
    const range = $('raiseRange');
    const lo = Number(range.min), hi = Number(range.max);
    let target;
    if (btn.dataset.mult === 'allin') target = hi;
    else target = cur.currentBet + Math.round(Number(btn.dataset.mult) * cur.pot);
    target = Math.max(lo, Math.min(hi, target));
    range.value = target;
    range.dataset.touched = '1';
    updateBetLabel();
  });
});
$('raiseRange').addEventListener('input', function () {
  this.dataset.touched = '1';
  updateBetLabel();
});

// ===== 补码（rebuy）=====
$('rebuyBtn').onclick = () => {
  const row = $('rebuyRow');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) $('rebuyInput').focus();
};
$('rebuyCancel').onclick = () => $('rebuyRow').classList.add('hidden');
$('rebuyConfirm').onclick = () => {
  const amt = Math.floor(Number($('rebuyInput').value));
  if (!amt || amt <= 0) { flash('请输入有效的补码数量'); return; }
  sendObj({ type: 'rebuy', amount: amt });
  $('rebuyRow').classList.add('hidden');
};

function sendAction(action, amount) {
  sendObj({ type: 'action', action, amount });
}

let flashTimer = null;
function flash(msg) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = 'var(--gold)';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ''; el.style.color = ''; }, 2600);
}

// ===== 扑克牌（增量更新，不再整体重绘 → 消除闪烁）=====
const CATEGORY = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

// 仅当牌面变化时更新节点；animate=true 时播一次翻牌动画（用于新翻出的公共牌）
function updateCard(node, card, size, animate) {
  const sig = card ? (card.r + ':' + card.s) : 'back';
  if (node._sig === sig && !animate) return; // 未变化 → 不动（不闪烁）
  node._sig = sig;
  node.className = 'card' + (size ? ' ' + size : '');
  if (!card) { node.classList.add('back'); node.innerHTML = ''; return; }
  if (SUIT_RED[card.s]) node.classList.add('red');
  const r = RANK[card.r] || card.r;
  const su = SUIT[card.s];
  node.innerHTML = `<span class="c-idx tl">${r}<br>${su}</span><span class="c-suit">${su}</span><span class="c-idx br">${r}<br>${su}</span>`;
  if (animate) { node.classList.remove('deal'); void node.offsetWidth; node.classList.add('deal'); }
}

// ===== 渲染缓存（座位 / 公共牌节点长期复用）=====
const seatNodes = new Map(); // seatId -> { el, refs, ... }
let boardNodes = [];

function resetRenderCache() {
  seatNodes.clear();
  boardNodes = [];
  boardHandNum = -1;
  const seats = $('seats'); if (seats) seats.innerHTML = '';
  const board = $('board'); if (board) board.innerHTML = '';
}

const stageNames = { waiting: '等待开始', preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌', handover: '本手结束' };

function render(state) {
  $('pot').textContent = state.pot;
  $('stageLabel').textContent = stageNames[state.stage] || '';

  renderBoard(state);
  renderSeats(state);
  const me = state.seats.find(s => s.id === myId);
  renderControls(state, me);
  renderReads(state);

  // 兜底：轮到自己时若未收到教练建议，主动请求一次
  if (me && me.isToAct && ['preflop', 'flop', 'turn', 'river'].includes(state.stage)) {
    const key = state.stage + ':' + state.handNumber + ':' + state.toActIndex;
    if (key !== window.__lastAdviceKey) { window.__lastAdviceKey = key; sendObj({ type: 'advice' }); }
  }

  const hostBar = $('hostBar');
  if (myHost) {
    hostBar.classList.remove('hidden');
    $('startBtn').classList.toggle('hidden', state.stage !== 'waiting');
    $('nextBtn').classList.toggle('hidden', state.stage !== 'handover');
  } else {
    hostBar.classList.add('hidden');
  }

  // 自动补码按钮：按服务器状态同步标签（房主可见）
  const rb = $('botRebuyBtn');
  if (rb) {
    const on = !!state.botAutoRebuy;
    rb.dataset.on = on ? '1' : '0';
    rb.textContent = on ? '🤖 自动补码：开' : '🤖 自动补码：关';
    rb.classList.toggle('on', on);
  }

  if (state.stage === 'handover' && state.lastResult) {
    const r = state.lastResult;
    const names = r.winners.map(id => (state.seats.find(s => s.id === id) || {}).name || '?');
    if (r.byFold) $('status').textContent = `🏆 ${names.join('、')} 赢得底池 ${r.amount}（其他人弃牌）`;
    else $('status').textContent = `🏆 ${names.join('、')} 赢得底池 ${r.amount}`;
  } else {
    if (!$('status').textContent.startsWith('🏆')) $('status').textContent = '';
  }

  // 补码按钮：轮到自己行动时禁用（服务器也会拒绝中途补码）
  const canRebuy = me && !(me.isToAct && ['preflop', 'flop', 'turn', 'river'].includes(state.stage));
  $('rebuyBtn').disabled = !canRebuy;

  const log = $('log');
  log.innerHTML = '';
  for (const e of state.log) {
    const li = document.createElement('li');
    li.textContent = e.msg;
    log.appendChild(li);
  }
}

// 公共牌：节点复用，仅在翻出新牌时播一次翻牌动画
let boardHandNum = -1;
function renderBoard(state) {
  const board = $('board');
  if (boardNodes.length === 0) {
    for (let i = 0; i < 5; i++) {
      const cn = document.createElement('div');
      cn.className = 'card big';
      board.appendChild(cn);
      boardNodes.push(cn);
    }
  }
  // 新手牌开始：清空旧签名，保证每手翻牌都触发翻牌动画
  if (state.handNumber !== boardHandNum) {
    boardHandNum = state.handNumber;
    for (const n of boardNodes) n._sig = undefined;
  }
  for (let i = 0; i < 5; i++) {
    const c = state.board[i];
    const prevSig = boardNodes[i]._sig;
    const newSig = c ? (c.r + ':' + c.s) : 'back';
    const animate = (newSig !== 'back' && (prevSig === 'back' || prevSig === undefined));
    updateCard(boardNodes[i], c, 'big', animate);
  }
}

// 座位：长期复用 DOM 节点，按 id 增量更新，不再整体 innerHTML 重绘
function renderSeats(state) {
  const seatsEl = $('seats');
  const n = state.seats.length;
  const userIdx = state.seats.findIndex(s => s.id === myId);
  const present = new Set();

  // 选手围着长方形牌桌顺时针排列：自己固定底部中央，其余顺时针沿四边均分
  // 参数化：把周长归一化为 [0,1)，k=0(英雄)从底部中央出发，顺时针绕一圈
  for (let i = 0; i < n; i++) {
    const s = state.seats[i];
    present.add(s.id);
    let node = seatNodes.get(s.id);
    if (!node) {
      node = createSeatNode();
      seatNodes.set(s.id, node);
      seatsEl.appendChild(node.el);
    }
    const k = (i - (userIdx < 0 ? 0 : userIdx) + n) % n; // 英雄=k=0
    // 归一化周长位置：0=底边中央 → 0.25=左下角 → 0.5=顶边中点偏左 → 0.75=右上角 → 回到1
    const u = k / Math.max(n - 1, 1);  // [0, 1]，英雄在起点（底部中央）
    let pctX, pctY;
    if (u <= 0.25) {
      // 底边：中央(50%) → 左角(2%)
      pctX = 50 - (u / 0.25) * 48;  pctY = 98;
    } else if (u <= 0.5) {
      // 左边：下角(98%) → 上角(2%)
      pctX = 2;  pctY = 98 - ((u - 0.25) / 0.25) * 96;
    } else if (u <= 0.75) {
      // 顶边：左角(2%) → 右角(98%)
      pctX = 2 + ((u - 0.5) / 0.25) * 96;  pctY = 3;
    } else {
      // 右边：上角(3%) → 下角(98%)
      pctX = 98;  pctY = 3 + ((u - 0.75) / 0.25) * 95;
    }
    node.el.style.left = pctX + '%';
    node.el.style.top = pctY + '%';
    updateSeatNode(node, s, state);
  }
  // 移除已离开的座位
  for (const [id, node] of seatNodes) {
    if (!present.has(id)) { node.el.remove(); seatNodes.delete(id); }
  }
}

function createSeatNode() {
  const el = document.createElement('div');
  el.className = 'seat';
  el.innerHTML = `
    <div class="name"></div>
    <div class="chips"></div>
    <div class="bet"></div>
    <div class="cards"><div class="card"></div><div class="card"></div></div>
    <div class="handname"></div>
    <div class="threat-badge hidden">⚠ 威胁</div>`;
  return {
    el,
    refs: {
      name: el.querySelector('.name'),
      chips: el.querySelector('.chips'),
      bet: el.querySelector('.bet'),
      handname: el.querySelector('.handname'),
      threat: el.querySelector('.threat-badge'),
      cards: [...el.querySelectorAll('.card')],
    },
  };
}

function updateSeatNode(node, s, state) {
  const el = node.el;
  el.className = 'seat';
  if (s.id === myId) el.classList.add('mine');
  if (s.isToAct) el.classList.add('to-act');
  if (s.isButton) el.classList.add('button');
  if (s.folded) el.classList.add('folded');

  let tag = '';
  if (s.isBot) tag = '<span class="tag bot">🤖</span>';
  else if (s.allIn) tag = '<span class="tag allin">ALL-IN</span>';
  else if (s.disconnected) tag = '<span class="tag offline">离线</span>';
  else if (s.chips === 0 && state.stage !== 'waiting') tag = '<span class="tag bust">出局</span>';
  node.refs.name.innerHTML = `<span>${escapeHtml(s.name)}${s.id === myId ? ' (你)' : ''}</span>${tag}`;

  const rebuyTag = s.rebuy ? `<span class="rebuy-tag" title="累计补码">补码 +${s.rebuy}</span>` : '';
  node.refs.chips.innerHTML = `💰 ${s.chips}${rebuyTag}`;
  node.refs.bet.textContent = s.roundContribution ? '本回合下注 ' + s.roundContribution : '';
  node.refs.handname.textContent = s.handEval ? CATEGORY[clamp(s.handEval.category)] : '';

  // ===== 对手牌展示策略（尊重「秀牌」选择）=====
  const mine = s.id === myId;
  let size = mine ? 'big' : 'small';
  let showCards;
  let isThreat = false;
  if (mine) {
    showCards = s.cards;                 // 自己的牌始终可见
  } else if (s.folded) {
    showCards = [null, null];            // 已弃牌：盖牌
  } else if (state.stage === 'handover') {
    // 摊牌阶段：仅当该玩家选择「秀牌」(shown=true) 才亮出，否则盖着
    showCards = (s.shown === true) ? s.cards : [null, null];
    // 已亮牌且能压过我 → 标记为威胁
    const meSeat = state.seats.find(x => x.id === myId);
    if (showCards[0] && meSeat && !meSeat.folded && meSeat.handEval && s.handEval && beats(s.handEval, meSeat.handEval)) {
      isThreat = true; size = 'big';
    }
  } else {
    showCards = s.cards.length ? [null, null] : [];
  }
  for (let k = 0; k < 2; k++) updateCard(node.refs.cards[k], showCards[k], size, false);
  node.refs.threat.classList.toggle('hidden', !isThreat);
  if (isThreat) el.classList.add('threat');
  else el.classList.remove('threat');
}

// a 是否强于 b（用于判断对手是否对我有威胁）
function beats(a, b) {
  if (!a || !b) return false;
  if (a.category !== b.category) return a.category > b.category;
  const ar = a.ranks || [], br = b.ranks || [];
  for (let i = 0; i < Math.max(ar.length, br.length); i++) {
    const x = ar[i] || 0, y = br[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function renderControls(state, me) {
  const bar = $('turnInfo');
  const myTurn = me && me.isToAct && ['preflop', 'flop', 'turn', 'river'].includes(state.stage);

  if (state.stage === 'waiting') bar.innerHTML = '等待房主开始游戏…';
  else if (me && me.isToAct) bar.innerHTML = '轮到 <b>你</b> 行动';
  else {
    const actor = state.seats[state.toActIndex];
    bar.innerHTML = actor ? `等待 <b>${escapeHtml(actor.name)}</b> 行动…` : '';
  }

  const disable = !myTurn || !me;
  for (const id of ['foldBtn', 'checkBtn', 'callBtn', 'betRaiseBtn', 'allinBtn']) $(id).disabled = disable;

  const range = $('raiseRange');
  const hint = $('betHint');
  if (me && myTurn) {
    const cost = state.currentBet - me.roundContribution;
    $('callBtn').textContent = cost > 0 ? `跟注 ${Math.min(cost, me.chips)}` : '跟注';
    $('checkBtn').style.display = (cost <= 0) ? '' : 'none';
    $('callBtn').style.display = (cost > 0) ? '' : 'none';

    const minTarget = state.currentBet + state.minRaise;
    const maxTarget = me.chips + me.roundContribution;
    range.min = minTarget;
    range.max = maxTarget;
    if (!range.dataset.touched) range.value = Math.min(minTarget, maxTarget);
    range.disabled = disable || maxTarget <= minTarget;

    $('betRaiseBtn').textContent = state.currentBet > 0 ? '加注' : '下注';
    hint.textContent = `底池 ${state.pot} · 最小 ${minTarget}`;
    updateBetLabel();
  } else {
    range.disabled = true;
    hint.textContent = '';
  }

  // ===== 秀牌选择（仅 handover 阶段、本人未弃牌时）=====
  const revealBar = $('revealBar');
  const canReveal = state.stage === 'handover' && me && !me.folded && me.shown === null;
  if (me && state.stage === 'handover' && !me.folded && me.shown !== null) {
    // 已做出选择：显示状态，隐藏按钮
    revealBar.classList.remove('hidden');
    $('revealBtns').classList.add('hidden');
    $('revealStatus').classList.remove('hidden');
    $('revealStatus').textContent = me.shown === true ? '🃏 你已秀牌' : '🙈 你已盖牌';
  } else if (canReveal) {
    revealBar.classList.remove('hidden');
    $('revealBtns').classList.remove('hidden');
    $('revealStatus').classList.add('hidden');
  } else {
    revealBar.classList.add('hidden');
  }
}

function updateBetLabel() {
  const range = $('raiseRange');
  const v = Number(range.value);
  const isRaise = lastState && lastState.currentBet > 0;
  $('raiseLabel').textContent = (isRaise ? '加注到 ' : '下注 ') + v;
}

function clamp(v) { return Math.max(0, Math.min(8, v)); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ===== 对手读牌面板 =====
const STRENGTH_CLASS = { '偏强': 's-strong', '中等': 's-mid', '偏弱': 's-weak', '已出局': 's-out', '未知': 's-unk' };
function renderReads(state) {
  const body = $('readsBody');
  if (!body) return;
  const reads = (state.opponentReads || []).filter(r => r.id !== myId);
  if (!reads.length) {
    body.innerHTML = '<p class="reads-hint">进入牌局后，这里会根据每个对手的<b>下注行为</b>实时推断其牌力范围，并教你如何判断。</p>';
    return;
  }
  const inHand = state.stage !== 'waiting' && state.stage !== 'handover';
  const lines = [];
  for (const r of reads) {
    const folded = state.seats.find(s => s.id === r.id)?.folded;
    if (inHand && folded) continue; // 打牌中只显示还在手里的对手
    const sc = STRENGTH_CLASS[r.read.strength] || 's-unk';
    const botTag = r.isBot ? '<span class="tag bot">🤖</span>' : '';
    let html = `<div class="read-card">
      <div class="read-top"><span class="read-name">${escapeHtml(r.name)}</span>${botTag}
        <span class="read-badge ${sc}">${escapeHtml(r.read.strength)}</span></div>
      <div class="read-summary">${escapeHtml(r.summary)}</div>`;
    if (r.signals && r.signals.length) {
      html += '<div class="read-signals">';
      for (const sg of r.signals) {
        html += `<div class="read-sig"><span class="sig-label">${escapeHtml(sg.label)}</span> ${escapeHtml(sg.text)}</div>`;
      }
      html += '</div>';
    }
    html += `<div class="read-strength">${escapeHtml(r.read.text)}</div>`;
    if (r.teaching && r.teaching.length) {
      html += '<div class="read-teach">';
      for (const t of r.teaching) html += `<div class="teach-item">💡 ${escapeHtml(t)}</div>`;
      html += '</div>';
    }
    html += '</div>';
    lines.push(html);
  }
  body.innerHTML = lines.length
    ? lines.join('')
    : '<p class="reads-hint">当前没有可分析的对手行为，等有人下注后这里会出现读牌。</p>';
}

// ===== AI 教练面板（实时更新 + 在按钮上高亮推荐动作）=====
function renderCoach(a) {
  if (!a) return;
  window.__lastAdviceKey = (a.stage + ':' + (lastState ? lastState.handNumber : '') + ':' + (lastState ? lastState.toActIndex : ''));
  const body = $('coachBody');
  const pct = (n) => (n == null ? '—' : Math.round(n * 100) + '%');
  const lines = [];
  if (a.styleLabel) lines.push(`<div class="coach-style">教练风格：<b>${escapeHtml(a.styleLabel)}</b></div>`);
  lines.push(`<div class="coach-rec"><span class="rec-label">建议</span><b class="rec-act">${escapeHtml(a.recommendationLabel)}</b>`);
  if (a.suggestion && a.suggestion.amount) lines.push(` <span class="rec-amt">${a.suggestion.amount}</span>`);
  lines.push(`</div>`);

  // 起手牌精确强度进度条：强于 X% 起手牌
  if (a.preflopStrength != null) {
    const p = Math.round(a.preflopStrength * 100);
    const col = p >= 80 ? 'var(--red-hi)' : p >= 50 ? 'var(--gold)' : 'var(--blue)';
    lines.push(`<div class="coach-strbar">
      <div class="csb-label">起手牌强度：强于 <b>${p}%</b> 的所有起手牌</div>
      <div class="csb-track"><div class="csb-fill" style="width:${p}%;background:${col}"></div></div>
    </div>`);
  }

  const facts = [];
  if (a.handName) facts.push(`起手牌 <b>${escapeHtml(a.handName)}</b>`);
  if (a.handCategoryName) facts.push(`当前牌力 <b>${escapeHtml(a.handCategoryName)}</b>`);
  if (a.position) facts.push(`位置 <b>${escapeHtml(a.position)}</b>`);
  facts.push(`底池 <b>${a.pot}</b>`);
  if (a.toCall > 0) facts.push(`需跟注 <b>${a.toCall}</b>`);
  if (a.numOpp != null) facts.push(`对手 <b>${a.numOpp}</b> 人`);
  lines.push(`<div class="coach-facts">${facts.join(' · ')}</div>`);

  const odds = [];
  odds.push(`你的胜率 ≈ <b>${pct(a.equity)}</b>`);
  if (a.potOdds != null) odds.push(`底池赔率 ≈ <b>${pct(a.potOdds)}</b>`);
  lines.push(`<div class="coach-odds">${odds.join('　|　')}</div>`);

  if (a.concept) lines.push(`<div class="coach-concept"><b>💡 思路</b> ${escapeHtml(a.concept)}</div>`);
  if (a.reasoning) lines.push(`<div class="coach-reason">${escapeHtml(a.reasoning)}</div>`);

  body.innerHTML = lines.join('');

  // 在对应动作按钮上高亮教练推荐，并把建议金额同步到滑条
  highlightCoachAction(a.recommendation, a.suggestion);
}

const COACH_BTN = { fold: 'foldBtn', check: 'checkBtn', call: 'callBtn', bet: 'betRaiseBtn', raise: 'betRaiseBtn', allin: 'allinBtn' };
function highlightCoachAction(rec, suggestion) {
  for (const id of Object.values(COACH_BTN)) $(id).classList.remove('coach-pick');
  if (!rec) return;
  const id = COACH_BTN[rec];
  if (id) $(id).classList.add('coach-pick');
  if ((rec === 'bet' || rec === 'raise') && suggestion && suggestion.amount && lastState) {
    const range = $('raiseRange');
    const lo = Number(range.min), hi = Number(range.max);
    const t = Math.max(lo, Math.min(hi, suggestion.amount));
    range.value = t;
    range.dataset.touched = '1';
    updateBetLabel();
  }
}

// ===== 战绩渲染 =====
function renderAnalytics(report, forName) {
  const el = $('statsBody');
  if (!el) return;
  if (report.empty) { el.innerHTML = '<p class="reads-hint">还没有对局数据。去玩几手，系统会自动记录你的牌局、盈亏和胜率。</p>'; return; }
  const p = report.pct;
  const fmt = (x) => (x >= 0 ? '+' : '') + Math.round(x);
  const cards = [
    ['总手数', report.n],
    ['胜率(按手)', Math.round(p.winR * 100) + '%'],
    ['净盈亏', fmt(report.net)],
    ['平均每手', fmt(report.avgNet)],
    ['入池率 VPIP', Math.round(p.vpipR * 100) + '%'],
    ['加注率 PFR', Math.round(p.pfrR * 100) + '%'],
    ['翻前激进度', Math.round(p.pfrVpip * 100) + '%'],
    ['翻后激进度 AF', p.af.toFixed(2)],
    ['摊牌率', Math.round(p.showedR * 100) + '%'],
    ['摊牌胜率', Math.round(p.sdR * 100) + '%'],
    ['最大单手盈利', '+' + report.best],
    ['最大单手亏损', '' + report.worst],
  ];
  let html = '<h3>' + escapeHtml(forName || '我') + ' 的战绩</h3><div class="stat-grid">';
  for (const kv of cards) html += '<div class="stat-card"><div class="sc-k">' + kv[0] + '</div><div class="sc-v">' + kv[1] + '</div></div>';
  html += '</div>';
  if (report.catCount) {
    const cats = report.catCount.map((c, i) => c ? (CATEGORY[i] + ' ' + c) : null).filter(Boolean);
    if (cats.length) html += '<div class="cat-line">🂡 最终牌型分布：' + cats.join(' · ') + '</div>';
  }
  html += '<div class="sugg"><h4>💡 给你的建议</h4>';
  for (const s of report.suggestions) html += '<div class="sugg-item ' + s.level + '">' + escapeHtml(s.text) + '</div>';
  html += '</div>';
  el.innerHTML = html;
}

function renderAccounts(list) {
  const el = $('acctBody');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<p class="reads-hint">还没有其他账号。</p>'; return; }
  let html = '<table class="acct-table"><thead><tr><th>昵称</th><th>身份</th><th>对局数</th><th>操作</th></tr></thead><tbody>';
  for (const a of list) {
    const badge = a.isAdmin ? '<span class="tag allin">管理员</span>' : '<span class="tag bot">成员</span>';
    html += '<tr><td>' + escapeHtml(a.name) + '</td><td>' + badge + '</td><td>' + a.hands + '</td>';
    html += '<td><button class="mini" data-view="' + a.userId + '">战绩</button>';
    if (!a.isAdmin) html += ' <button class="mini ghost" data-grant="' + a.userId + '">设为管理</button>';
    html += '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
    sendObj({ type: 'getAnalytics', targetId: b.dataset.view });
    showScreen('stats');
    $('statsBody').innerHTML = '<p class="reads-hint">加载中…</p>';
  });
  el.querySelectorAll('[data-grant]').forEach(b => b.onclick = () => {
    if (confirm('确认设为管理员？')) sendObj({ type: 'grantAdmin', targetId: b.dataset.grant });
  });
}
