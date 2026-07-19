'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game } = require('./engine');
const { decide, analyze, readOpponents } = require('./ai');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
// 数据目录：默认项目内的 data/（本地/测试用）；线上指向 Railway 持久卷挂载点（如 /data）
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
      : path.join(__dirname, 'data'));

// 牌局历史（按账号持久化）与邀请制
const HANDS_DIR = path.join(DATA_DIR, 'hands');

// 启动诊断：确认数据目录可写（持久卷是否真的可用）
console.log('[boot] DATA_DIR =', DATA_DIR, '| RAILWAY_VOLUME_MOUNT_PATH =', process.env.RAILWAY_VOLUME_MOUNT_PATH);
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.mkdirSync(HANDS_DIR, { recursive: true }); } catch (_) {}
  try { fs.unlinkSync(path.join(DATA_DIR, '_probe.txt')); } catch (_) {} // 清理早期诊断遗留
  console.log('[boot] DATA_DIR ready -> 持久卷可写');
} catch (e) {
  console.error('[boot] DATA_DIR init FAILED:', e.message);
}
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
let invites = loadJSON(INVITES_FILE, {});
const { computeAnalytics } = require('./analytics');

function saveInvites() { saveJSON(INVITES_FILE, invites); }
function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (invites[c]);
  return c;
}
function loadHands(userId) { return loadJSON(path.join(HANDS_DIR, userId + '.json'), []); }
function appendHandRecord(userId, rec) {
  const file = path.join(HANDS_DIR, userId + '.json');
  let arr = loadJSON(file, []);
  arr.push(rec);
  if (arr.length > 3000) arr = arr.slice(-3000);
  saveJSON(file, arr);
}
// 每手结束时，把各真实玩家的对局写入其账号历史
function recordHandHistory(room) {
  const g = room.game;
  const res = g.lastResult;
  if (!res) return;
  const winMap = {};
  if (res.byFold) { for (const id of (res.winners || [])) winMap[id] = (winMap[id] || 0) + res.amount; }
  else { for (const r of (res.results || [])) winMap[r.id] = (winMap[r.id] || 0) + (r.amount || 0); }
  for (const s of g.seats) {
    if (s.isBot || !accounts[s.id]) continue;          // 只记录真实账号
    const contributed = s.totalContribution || 0;
    const won = winMap[s.id] || 0;
    const net = won - contributed;
    const acts = s.handActions || [];
    const pf = acts.filter(a => a.stage === 'preflop');
    const post = acts.filter(a => a.stage !== 'preflop');
    const foldedPre = pf.some(a => a.action === 'fold');
    const vpip = !foldedPre;                            // 翻前未弃牌 = 自愿入池
    const pfr = pf.some(a => ['raise', 'bet', 'allin'].includes(a.action));
    const postAggr = post.filter(a => ['bet', 'raise', 'allin'].includes(a.action)).length;
    const postPass = post.filter(a => ['call', 'check'].includes(a.action)).length;
    const showed = !s.folded && !res.byFold;
    let category = null;
    if (!s.folded && res.results) { const r = res.results.find(x => x.id === s.id); if (r) category = r.category; }
    appendHandRecord(s.id, {
      t: Date.now(), room: g.roomId, handNumber: g.handNumber,
      board: g.board.map(c => ({ r: c.r, s: c.s })),
      contributed, won, net, category, vpip, pfr, postAggr, postPass,
      showed, result: net > 0 ? 'win' : (net < 0 ? 'lose' : 'tie'),
    });
  }
}
function hasAnyAdmin() { return Object.values(accounts).some(a => a.isAdmin); }
function ensureAdminBootstrap() {
  const envName = process.env.ADMIN_NAME;
  if (envName && !hasAnyAdmin()) {
    let acc = Object.values(accounts).find(a => a.name === envName);
    if (!acc) {
      const userId = 'u_' + crypto.randomBytes(6).toString('hex');
      acc = { userId, name: envName, pass: '', chips: 1000, isAdmin: true, invitedBy: null };
      accounts[userId] = acc;
    } else acc.isAdmin = true;
    saveAccounts();
  }
}

// 确保指定昵称的账号拥有管理员权限（默认含 dpy；可用环境变量 ADMIN_NAMES 扩展，逗号分隔）
function ensureNamedAdmins() {
  const names = (process.env.ADMIN_NAMES || 'dpy').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  let changed = false;
  for (const n of names) {
    for (const acc of Object.values(accounts)) {
      if (acc.name && acc.name.toLowerCase() === n && !acc.isAdmin) { acc.isAdmin = true; changed = true; }
    }
  }
  if (changed) saveAccounts();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ===================== 持久化 =====================
function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJSON(file, obj) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); }
  catch (e) { console.error('[saveJSON] FAILED', file, '->', e.message); }
}

// 账号：userId -> { userId, name, pass(sha256 或 ''), chips }
let accounts = loadJSON(ACCOUNTS_FILE, {});
function saveAccounts() { saveJSON(ACCOUNTS_FILE, accounts); }
// 把房间内人类玩家的当前筹码写回账号（持久化余额，下次登录沿用）
function persistRoomChips(room) {
  if (!room || !room.game) return;
  for (const s2 of room.game.seats) {
    if (s2.isBot) continue;
    if (accounts[s2.id]) accounts[s2.id].chips = s2.chips;
  }
  saveAccounts();
}
function hashPass(p) { return p ? crypto.createHash('sha256').update(String(p)).digest('hex') : ''; }

// 房间：roomId -> { game, clients: Map(userId->ws), hostId, createdAt, lastActive }
const rooms = new Map();
function loadRooms() {
  const obj = loadJSON(ROOMS_FILE, {});
  for (const [id, data] of Object.entries(obj)) {
    try {
      const game = Game.deserialize(data.game);
      game.roomId = id;
      rooms.set(id, {
        game,
        clients: new Map(),
        hostId: data.hostId || null,
        createdAt: data.createdAt || Date.now(),
        lastActive: data.lastActive || Date.now(),
        coach: data.coach !== false,
        botProfile: data.botProfile || 'balanced',
        stats: data.stats || {},
        _stage: data.game ? data.game.stage : null,
      });
    } catch (e) { /* 跳过损坏数据 */ }
  }
}
loadRooms();
ensureAdminBootstrap();
ensureNamedAdmins();

// 重启后，若某房间正轮到机器人行动，则恢复自动出牌
for (const room of rooms.values()) {
  if (['preflop', 'flop', 'turn', 'river'].includes(room.game.stage)) tickBots(room);
}

let saveTimer = null;
function scheduleSaveRooms() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj = {};
    for (const [id, room] of rooms) {
      // 长时间无人在线的空房间不落盘
      const idleEmpty = room.clients.size === 0 && Date.now() - (room.lastActive || room.createdAt) > 1000 * 60 * 60;
      if (idleEmpty) continue;
      obj[id] = {
        hostId: room.hostId,
        createdAt: room.createdAt,
        lastActive: room.lastActive || Date.now(),
        coach: room.coach !== false,
        botProfile: room.botProfile || 'balanced',
        stats: room.stats || {},
        game: room.game.serialize(),
      };
    }
    saveJSON(ROOMS_FILE, obj);
  }, 800);
}

// ===================== HTTP =====================
const server = http.createServer((req, res) => {
  const reqPath = req.url.split('?')[0];
  if (reqPath === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  let urlPath = req.url === '/' ? '/index.html' : reqPath;
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ===================== WebSocket =====================
const wss = new WebSocketServer({ server });

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  // 计算对手读牌（同一手对所有观者一致，只算一次）
  let reads = [];
  if (room.coach) {
    try { reads = readOpponents(room.game, room.stats); } catch (e) { reads = []; }
  }
  for (const [userId, ws] of room.clients) {
    const st = room.game.state(userId);
    st.opponentReads = reads;
    send(ws, { type: 'state', state: st });
  }
}

// 每手结束后，累加各玩家的长期风格统计
function updateStats(room) {
  const g = room.game;
  if (!room.stats) room.stats = {};
  for (const s of g.seats) {
    const st = room.stats[s.id] || { hands: 0, vpip: 0, pfr: 0, postAggr: 0, postPass: 0, cbetOpp: 0, cbetHit: 0 };
    const acts = s.handActions || [];
    const participated = acts.length > 0 || s.totalContribution > 0;
    if (!participated) { room.stats[s.id] = st; continue; }
    const pf = acts.filter(a => a.stage === 'preflop');
    const post = acts.filter(a => a.stage !== 'preflop');
    st.hands++;
    if (pf.some(a => ['call', 'raise', 'bet', 'allin'].includes(a.action))) st.vpip++;
    if (pf.some(a => ['raise', 'bet', 'allin'].includes(a.action))) st.pfr++;
    st.postAggr += post.filter(a => ['bet', 'raise', 'allin'].includes(a.action)).length;
    st.postPass += post.filter(a => ['call', 'check'].includes(a.action)).length;
    if (pf.some(a => ['raise', 'bet', 'allin'].includes(a.action))) {
      st.cbetOpp++;
      if (post.some(a => a.stage === 'flop' && ['bet', 'raise', 'allin'].includes(a.action))) st.cbetHit++;
    }
    room.stats[s.id] = st;
  }
}

// 轮到人类行动时，若房间开启教练，则向其推送实时建议
function sendAdviceToActor(room) {
  if (!room.coach) return;
  const g = room.game;
  if (!['preflop', 'flop', 'turn', 'river'].includes(g.stage)) return;
  if (g.toActIndex == null) return;
  const seat = g.seats[g.toActIndex];
  if (!seat || seat.isBot || seat.disconnected) return;
  const ws = room.clients.get(seat.id);
  if (!ws) return;
  try {
    const advice = analyze(g, seat.id, room.coachStyle);
    send(ws, { type: 'advice', advice, seatId: seat.id });
  } catch (e) { /* 教练计算失败不影响牌局 */ }
}

// 机器人自动行动（带思考延迟，状态变化则作废）
function tickBots(room) {
  const g = room.game;
  if (!['preflop', 'flop', 'turn', 'river'].includes(g.stage)) return;
  const idx = g.toActIndex;
  if (idx == null) return;
  const seat = g.seats[idx];
  if (!seat || !seat.isBot || seat.disconnected) return;
  const token = (room.botToken = (room.botToken || 0) + 1);
  const delay = 700 + Math.floor(Math.random() * 900);
  setTimeout(() => {
    if (room.botToken !== token) return;              // 状态已变，作废
    if (room.game.toActIndex !== idx) return;
    const s = room.game.seats[idx];
    if (!s || !s.isBot) return;
    let decision;
    try { decision = decide(room.game, s.id, s.botProfile || 'balanced'); }
    catch (e) { decision = { action: 'fold' }; }
    let r = room.game.act(s.id, decision.action, decision.amount);
    if (r && r.error) room.game.act(s.id, 'fold');    // 兜底弃牌
    emit(room);
  }, delay);
}

// 统一广播入口：广播状态 + 教练建议 + 触发机器人
function emit(room) {
  const prev = room._stage;
  const now = room.game.stage;
  room._stage = now;
  // 本手刚结束（进入 handover）→ 更新长期统计
  if (now === 'handover' && prev && prev !== 'handover') {
    try { updateStats(room); } catch (e) { /* 忽略统计错误 */ }
    try { recordHandHistory(room); } catch (e) { /* 忽略历史记录错误 */ }
    persistRoomChips(room);
  }
  broadcast(room);
  sendAdviceToActor(room);
  tickBots(room);
}

// 把某账号重连归位到它所在的房间（若存在）
function rebindUser(ws, userId) {
  for (const [roomId, room] of rooms) {
    const seat = room.game.seats.find(s => s.id === userId);
    if (!seat) continue;
    // 若该账号已有别的连接，关掉旧连接
    const old = room.clients.get(userId);
    if (old && old !== ws) { try { old.close(); } catch {} }
    ws.userId = userId;
    ws.roomId = roomId;
    room.clients.set(userId, ws);
    seat.disconnected = false;             // 重连成功 → 恢复在线（修复：断线一次就被永久判弃牌）
    if (room._dcGuard) { clearTimeout(room._dcGuard); room._dcGuard = null; } // 取消断线弃牌宽限
    if (room.game.toActIndex != null && room.game.seats[room.game.toActIndex] === seat) {
      // 若重连时正好轮到TA，给服务端一次补推教练建议/驱动机器人的机会
      sendAdviceToActor(room);
      tickBots(room);
    }
    room.lastActive = Date.now();
    send(ws, { type: 'joined', roomId, playerId: userId, host: room.hostId === userId });
    broadcast(room);
    return true;
  }
  return false;
}

function onDisconnect(ws) {
  const { roomId, userId } = ws;
  if (!roomId || !rooms.has(roomId) || !userId) return;
  const room = rooms.get(roomId);
  room.clients.delete(userId);
  const seatIdx = room.game.seats.findIndex(s => s.id === userId);
  if (seatIdx >= 0) room.game.seats[seatIdx].disconnected = true;
  // 若正轮到TA行动：给 5 秒宽限期，期间若重连则不判弃牌（避免"稍微抖一下就被默认弃牌"）
  if (seatIdx >= 0 && room.game.toActIndex === seatIdx &&
      ['preflop', 'flop', 'turn', 'river'].includes(room.game.stage)) {
    const g = room.game;
    if (room._dcGuard) clearTimeout(room._dcGuard);
    room._dcGuard = setTimeout(() => {
      if (room.game !== g) return;                               // 已进入新一手
      if (!g.seats[seatIdx] || !g.seats[seatIdx].disconnected) return; // 已重连在线
      if (g.toActIndex !== seatIdx) return;                      // 行动权已转移
      g.advanceTurn();                                           // 宽限期满仍未重连 → 判弃牌
    }, 5000);
  }
  if (room.clients.size === 0) {
    room.lastActive = Date.now();
  } else {
    // 房主掉线则转移给在线的其他人
    if (room.hostId === userId) {
      const next = [...room.clients.keys()][0];
      if (next) room.hostId = next;
    }
    broadcast(room);
    // 若该玩家的掉线把行动权交给了机器人，则驱动机器人
    tickBots(room);
  }
  // 掉线时把该玩家当前筹码写回账号，下次登录沿用
  if (seatIdx >= 0 && accounts[userId]) {
    accounts[userId].chips = room.game.seats[seatIdx].chips;
    saveAccounts();
  }
  scheduleSaveRooms();
}

wss.on('connection', (ws) => {
  ws.userId = null;
  ws.roomId = null;
  ws.on('message', (msg) => {
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    handle(ws, m);
  });
  ws.on('close', () => onDisconnect(ws));
  ws.on('error', () => {});
});

function handle(ws, m) {
  switch (m.type) {
    // ---------- 账号 ----------
    case 'auth': {
      // 统一入口：昵称已存在 -> 登录；不存在 -> 用邀请码注册（一步到位）
      const name = (m.name || '').trim();
      if (!name) { send(ws, { type: 'error', msg: '请输入昵称' }); return; }
      if (name.length > 12) { send(ws, { type: 'error', msg: '昵称最多 12 字' }); return; }
      const existing = Object.values(accounts).find(a => a.name === name);
      if (existing) {
        if (existing.pass !== hashPass(m.pass)) { send(ws, { type: 'error', msg: '密码错误' }); return; }
        ws.userId = existing.userId;
        send(ws, { type: 'auth', userId: existing.userId, name: existing.name, isAdmin: !!existing.isAdmin });
      } else {
        const userId = 'u_' + crypto.randomBytes(6).toString('hex');
        const bootstrap = !hasAnyAdmin() && Object.keys(accounts).length === 0;
        const code = (m.invite || '').trim().toUpperCase();
        if (!bootstrap) {
          if (!code) { send(ws, { type: 'error', msg: '需要邀请码才能注册（向房主索取）' }); return; }
          const inv = invites[code];
          if (!inv) { send(ws, { type: 'error', msg: '邀请码无效' }); return; }
          if (inv.usedBy) { send(ws, { type: 'error', msg: '该邀请码已被使用' }); return; }
        }
        accounts[userId] = {
          userId, name, pass: hashPass(m.pass), chips: 1000,
          isAdmin: !!bootstrap,
          invitedBy: bootstrap ? null : (invites[code] ? invites[code].createdBy : null),
        };
        saveAccounts();
        if (!bootstrap) { invites[code].usedBy = userId; invites[code].usedAt = Date.now(); saveInvites(); }
        ws.userId = userId;
        send(ws, { type: 'auth', userId, name, isAdmin: !!bootstrap });
      }
      break;
    }
    case 'register': {
      const name = (m.name || '').trim();
      if (!name) { send(ws, { type: 'error', msg: '昵称不能为空' }); return; }
      if (name.length > 12) { send(ws, { type: 'error', msg: '昵称最多 12 字' }); return; }
      if (Object.values(accounts).some(a => a.name === name)) {
        send(ws, { type: 'error', msg: '该昵称已被占用' }); return;
      }
      const userId = 'u_' + crypto.randomBytes(6).toString('hex');
      // 管理员引导：账号库为空时，首个注册者自动成为管理员（免邀请码）
      const bootstrap = !hasAnyAdmin() && Object.keys(accounts).length === 0;
      const code = (m.invite || '').trim().toUpperCase();
      if (!bootstrap) {
        if (!code) { send(ws, { type: 'error', msg: '需要邀请码才能注册（向房主索取）' }); return; }
        const inv = invites[code];
        if (!inv) { send(ws, { type: 'error', msg: '邀请码无效' }); return; }
        if (inv.usedBy) { send(ws, { type: 'error', msg: '该邀请码已被使用' }); return; }
      }
      accounts[userId] = {
        userId, name, pass: hashPass(m.pass), chips: 1000,
        isAdmin: !!bootstrap,
        invitedBy: bootstrap ? null : (invites[code] ? invites[code].createdBy : null),
      };
      saveAccounts();
      if (!bootstrap) { invites[code].usedBy = userId; invites[code].usedAt = Date.now(); saveInvites(); }
      ws.userId = userId;
      send(ws, { type: 'auth', userId, name, isAdmin: !!bootstrap });
      break;
    }
    case 'login': {
      const name = (m.name || '').trim();
      const acc = Object.values(accounts).find(a => a.name === name);
      if (!acc) { send(ws, { type: 'error', msg: '账号不存在，请先注册' }); return; }
      if (acc.pass !== hashPass(m.pass)) { send(ws, { type: 'error', msg: '密码错误' }); return; }
      ws.userId = acc.userId;
      send(ws, { type: 'auth', userId: acc.userId, name: acc.name, isAdmin: !!acc.isAdmin });
      break;
    }
    case 'resume': {
      const acc = m.userId && accounts[m.userId];
      if (!acc) { send(ws, { type: 'error', msg: '会话已失效，请重新登录' }); return; }
      ws.userId = acc.userId;
      send(ws, { type: 'auth', userId: acc.userId, name: acc.name, isAdmin: !!acc.isAdmin });
      rebindUser(ws, acc.userId); // 若在某房间内则直接归位
      break;
    }

    // ---------- 房间 ----------
    case 'create': {
      if (!ws.userId || !accounts[ws.userId]) { send(ws, { type: 'error', msg: '请先登录' }); return; }
      const roomId = genRoomId();
      const game = new Game(m.opts || {});
      game.roomId = roomId;
      const room = {
        game, clients: new Map(), hostId: ws.userId,
        createdAt: Date.now(), lastActive: Date.now(),
        coach: m.coach !== false,            // 默认开启教练
        coachStyle: m.coachStyle || 'standard',
        botProfile: m.botProfile || 'balanced',
        stats: {},                           // 玩家长期风格统计（VPIP/PFR/激进度/Cbet）
        _stage: 'waiting',
      };
      rooms.set(roomId, room);
      ws.userId = ws.userId;
      ws.roomId = roomId;
      const name = accounts[ws.userId].name;
      game.addPlayer(ws.userId, name, accounts[ws.userId] ? (accounts[ws.userId].chips || 1000) : 1000);
      // 人机模式：按请求数量填充机器人
      let botCount = Math.max(0, Math.min(8, parseInt(m.bots, 10) || 0));
      for (let i = 1; i <= botCount; i++) {
        const bid = `bot_${roomId}_${i}`;
        game.addBot(bid, `🤖 机器人${i}`, room.botProfile);
      }
      room.clients.set(ws.userId, ws);
      send(ws, { type: 'joined', roomId, playerId: ws.userId, host: true });
      broadcast(room);
      scheduleSaveRooms();
      break;
    }
    case 'join': {
      if (!ws.userId || !accounts[ws.userId]) { send(ws, { type: 'error', msg: '请先登录' }); return; }
      const roomId = (m.roomId || '').trim().toUpperCase();
      if (!rooms.has(roomId)) { send(ws, { type: 'error', msg: '房间不存在（可能已解散）' }); return; }
      const room = rooms.get(roomId);
      // 已经在房间里（重连）→ 直接归位
      if (room.game.seats.some(s => s.id === ws.userId)) {
        const old = room.clients.get(ws.userId);
        if (old && old !== ws) { try { old.close(); } catch {} }
        ws.roomId = roomId;
        room.clients.set(ws.userId, ws);
        room.lastActive = Date.now();
        send(ws, { type: 'joined', roomId, playerId: ws.userId, host: room.hostId === ws.userId });
        broadcast(room);
        return;
      }
      const ok = room.game.addPlayer(ws.userId, accounts[ws.userId].name, accounts[ws.userId] ? (accounts[ws.userId].chips || 1000) : 1000);
      if (!ok) { send(ws, { type: 'error', msg: '房间已满或牌局已开始' }); return; }
      ws.roomId = roomId;
      room.clients.set(ws.userId, ws);
      send(ws, { type: 'joined', roomId, playerId: ws.userId, host: false });
      broadcast(room);
      scheduleSaveRooms();
      break;
    }
    case 'start':
    case 'next': {
      const room = rooms.get(ws.roomId); if (!room) return;
      if (ws.userId !== room.hostId) { send(ws, { type: 'error', msg: '只有房主能操作' }); return; }
      const r = room.game.startHand();
      if (r && r.error) { send(ws, { type: 'error', msg: r.error }); return; }
      emit(room);
      scheduleSaveRooms();
      break;
    }
    case 'action': {
      const room = rooms.get(ws.roomId); if (!room) return;
      const seat = room.game.seats.find(s => s.id === ws.userId);
      if (!seat || seat.isBot) { send(ws, { type: 'error', msg: '机器人由系统自动操作' }); return; }
      const r = room.game.act(ws.userId, m.action, m.amount);
      if (r && r.error) { send(ws, { type: 'error', msg: r.error }); return; }
      emit(room);
      scheduleSaveRooms();
      break;
    }
    case 'reveal': {
      const room = rooms.get(ws.roomId); if (!room) return;
      const seatIdx = room.game.seats.findIndex(s => s.id === ws.userId);
      if (seatIdx < 0 || (room.game.seats[seatIdx] && room.game.seats[seatIdx].isBot)) return;
      const ok = room.game.revealCards(seatIdx, m.show);
      if (ok) broadcast(room);   // 广播给所有人，让对手看到亮牌结果
      break;
    }
    case 'advice': {
      const room = rooms.get(ws.roomId); if (!room) return;
      const seat = room.game.seats.find(s => s.id === ws.userId);
      if (!seat || seat.isBot) return;
      try {
        const advice = analyze(room.game, ws.userId, room.coachStyle);
        send(ws, { type: 'advice', advice, seatId: ws.userId });
      } catch (e) { /* 忽略 */ }
      break;
    }
    case 'coachStyle': {
      const room = rooms.get(ws.roomId); if (!room) return;
      room.coachStyle = m.style || 'standard';
      sendAdviceToActor(room);   // 立即按新风格刷新当前建议
      break;
    }
    case 'botRebuy': {
      const room = rooms.get(ws.roomId); if (!room) return;
      if (ws.userId !== room.hostId) { send(ws, { type: 'error', msg: '只有房主能切换机器人补码' }); return; }
      room.game.opts.botAutoRebuy = !!m.on;
      broadcast(room);
      scheduleSaveRooms();
      break;
    }
    case 'addbot': {
      const room = rooms.get(ws.roomId); if (!room) return;
      if (ws.userId !== room.hostId) { send(ws, { type: 'error', msg: '只有房主能添加机器人' }); return; }
      if (!['waiting', 'handover'].includes(room.game.stage)) { send(ws, { type: 'error', msg: '牌局进行中无法添加' }); return; }
      const n = room.game.seats.filter(s => s.isBot).length + 1;
      const bid = `bot_${room.roomId || ws.roomId}_${n}_${Date.now().toString(36)}`;
      const ok = room.game.addBot(bid, `🤖 机器人${n}`, room.botProfile || 'balanced');
      if (!ok) { send(ws, { type: 'error', msg: '座位已满' }); return; }
      broadcast(room);
      scheduleSaveRooms();
      break;
    }
    case 'rebuy': {
      const room = rooms.get(ws.roomId); if (!room) return;
      const targetId = (m.targetId && m.targetId !== ws.userId) ? m.targetId : ws.userId;
      const tSeat = room.game.seats.find(s => s.id === targetId);
      if (!tSeat) { send(ws, { type: 'error', msg: '目标座位不存在' }); return; }
      if (ws.userId !== tSeat.id && ws.userId !== room.hostId) {
        send(ws, { type: 'error', msg: '只能给自己补码，房主可帮任何人补' }); return;
      }
      const r = room.game.rebuy(targetId, m.amount);
      if (r && r.error) { send(ws, { type: 'error', msg: r.error }); return; }
      emit(room);
      scheduleSaveRooms();
      break;
    }
    case 'leave': {
      if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        room.clients.delete(ws.userId);
        const lvSeat = room.game.seats.find(s => s.id === ws.userId);
        if (lvSeat && accounts[ws.userId]) { accounts[ws.userId].chips = lvSeat.chips; saveAccounts(); }
        room.game.removePlayer(ws.userId);
        if (room.clients.size === 0) rooms.delete(ws.roomId);
        else {
          if (room.hostId === ws.userId) {
            const next = [...room.clients.keys()][0];
            if (next) room.hostId = next;
          }
          broadcast(room);
        }
        scheduleSaveRooms();
      }
      break;
    }

    // ---------- 战绩 / 邀请制 / 管理员 ----------
    case 'getAnalytics': {
      const acc = accounts[ws.userId];
      if (!acc) { send(ws, { type: 'error', msg: '请先登录' }); return; }
      let target = ws.userId;
      if (m.targetId && m.targetId !== ws.userId) {
        if (!acc.isAdmin) { send(ws, { type: 'error', msg: '仅管理员可查看他人战绩' }); return; }
        if (!accounts[m.targetId]) { send(ws, { type: 'error', msg: '目标账号不存在' }); return; }
        target = m.targetId;
      }
      const report = computeAnalytics(loadHands(target));
      send(ws, { type: 'analytics', report, forName: (accounts[target] || {}).name });
      break;
    }
    case 'createInvite': {
      const acc = accounts[ws.userId];
      if (!acc || !acc.isAdmin) { send(ws, { type: 'error', msg: '仅管理员可生成邀请码' }); return; }
      const code = genInviteCode();
      invites[code] = { code, createdBy: ws.userId, createdAt: Date.now(), usedBy: null, usedAt: null };
      saveInvites();
      send(ws, { type: 'invite', code });
      break;
    }
    case 'createAccount': {
      const acc = accounts[ws.userId];
      if (!acc || !acc.isAdmin) { send(ws, { type: 'error', msg: '仅管理员可创建账号' }); return; }
      const name = (m.name || '').trim();
      if (!name || name.length > 12) { send(ws, { type: 'error', msg: '昵称无效' }); return; }
      if (Object.values(accounts).some(a => a.name === name)) { send(ws, { type: 'error', msg: '昵称已被占用' }); return; }
      const userId = 'u_' + crypto.randomBytes(6).toString('hex');
      accounts[userId] = { userId, name, pass: hashPass(m.pass), chips: 1000, isAdmin: false, invitedBy: ws.userId };
      saveAccounts();
      send(ws, { type: 'accountCreated', userId, name });
      break;
    }
    case 'listAccounts': {
      const acc = accounts[ws.userId];
      if (!acc || !acc.isAdmin) { send(ws, { type: 'error', msg: '仅管理员可查看账号列表' }); return; }
      const list = Object.values(accounts).map(a => ({
        userId: a.userId, name: a.name, isAdmin: !!a.isAdmin,
        invitedBy: a.invitedBy || null, hands: loadHands(a.userId).length,
      }));
      send(ws, { type: 'accounts', list });
      break;
    }
    case 'grantAdmin': {
      const acc = accounts[ws.userId];
      if (!acc || !acc.isAdmin) { send(ws, { type: 'error', msg: '仅管理员可授权' }); return; }
      const t = accounts[m.targetId];
      if (!t) { send(ws, { type: 'error', msg: '目标账号不存在' }); return; }
      t.isAdmin = true; saveAccounts();
      send(ws, { type: 'ok', msg: '已授予管理员权限' });
      break;
    }
    case 'revokeInvite': {
      const acc = accounts[ws.userId];
      if (!acc || !acc.isAdmin) { send(ws, { type: 'error', msg: '仅管理员可操作' }); return; }
      if (invites[m.code]) { delete invites[m.code]; saveInvites(); }
      send(ws, { type: 'ok', msg: '邀请码已撤销' });
      break;
    }
  }
}

// 定期清理长时间无人的空房间（6 小时）
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.clients.size === 0 && now - (room.lastActive || room.createdAt) > 1000 * 60 * 60 * 6) {
      rooms.delete(id);
    }
  }
  scheduleSaveRooms();
}, 1000 * 60 * 30);

server.listen(PORT, () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('🂡 德州扑克服务器已启动（含账号与持久化）');
  console.log(`   本机访问:   http://localhost:${PORT}`);
  if (ips.length) console.log(`   局域网访问: http://${ips[0]}:${PORT}  (把此地址发给朋友)`);
  console.log(`   已加载房间: ${rooms.size} 个，账号: ${Object.keys(accounts).length} 个`);
  console.log('   按 Ctrl+C 停止');
});
