'use strict';
// 验证「对手读牌」功能：结构正确 + 长期统计(teaching 含长期数据) 在多手后生效
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.TPORT || 8255);
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('  ✗ FAIL:', m); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  ws.name = name; ws.userId = null; ws.roomId = null; ws.state = null; ws.auth = null; ws.joined = null;
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'auth') ws.auth = m;
    else if (m.type === 'joined') { ws.roomId = m.roomId; ws.playerId = m.playerId; ws.joined = m; }
    else if (m.type === 'state') ws.state = m.state;
    else if (m.type === 'error') log(`   [${name}] error:`, m.msg);
  });
  return ws;
}
const send = (ws, o) => ws.send(JSON.stringify(o));
function waitFor(ws, pred, timeout = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(ws.state); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('timeout')); }
    }, 25);
  });
}

(async () => {
  const H = client('H');
  await new Promise(r => H.on('open', r));
  send(H, { type: 'register', name: '读牌员A', pass: '' });
  await waitFor(H, () => H.auth);
  ok(H.auth && H.auth.userId, 'A 注册成功');

  send(H, { type: 'create', userId: H.userId, bots: 2, botProfile: 'balanced', coach: true });
  await waitFor(H, () => H.joined);
  log('房间已创建:', H.roomId);

  const seenReads = [];
  let longTermSeen = false;
  let structureOk = false;

  async function driveHand(label) {
    send(H, { type: label });
    await waitFor(H, () => H.state && ['preflop', 'flop', 'turn', 'river'].includes(H.state.stage), 8000);
    for (let i = 0; i < 400; i++) {
      const st = H.state;
      if (!st) break;
      if (st.stage === 'handover') break;
      if (st.opponentReads && st.opponentReads.length) {
        for (const r of st.opponentReads) {
          if (r.id === H.playerId) continue;
          seenReads.push(r);
          if (r.id && r.name && typeof r.summary === 'string' &&
              Array.isArray(r.signals) && r.read && typeof r.read.strength === 'string' &&
              Array.isArray(r.teaching)) structureOk = true;
          if (r.teaching && r.teaching.some(t => t.includes('长期数据'))) longTermSeen = true;
        }
      }
      const me = st.seats.find(s => s.id === H.playerId);
      if (me && me.isToAct && ['preflop', 'flop', 'turn', 'river'].includes(st.stage)) {
        const toCall = st.currentBet - me.roundContribution;
        send(H, { type: 'action', action: toCall > 0 ? 'call' : 'check' });
      }
      await sleep(20);
    }
    // 等进入 handover
    await waitFor(H, () => H.state && H.state.stage === 'handover', 8000).catch(() => {});
  }

  for (let h = 1; h <= 5; h++) {
    await driveHand(h === 1 ? 'start' : 'next');
    log(`第 ${h} 手结束`);
  }

  ok(structureOk, '读牌结构完整（name/summary/signals/read/teaching 均存在）');
  ok(seenReads.length > 0, `过程中收集到对手读牌数据（${seenReads.length} 条）`);
  ok(longTermSeen, '多手后教学出现「长期数据」风格分析');

  // 抽样打印一条读牌，便于人工确认质量
  const sample = seenReads.find(r => r.signals && r.signals.length);
  if (sample) {
    log('\n--- 抽样读牌 ---');
    log('对手:', sample.name, '| 判定:', sample.read.strength);
    log('摘要:', sample.summary);
    for (const s of sample.signals) log('  ·', s.label, '-', s.text);
    for (const t of sample.teaching) log('  💡', t);
  }

  log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  H.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });
