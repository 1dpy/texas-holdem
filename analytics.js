// analytics.js —— 根据账号历史牌局计算战绩指标与中文建议
// 输入：hands = loadHands(userId) 返回的数组，每条记录字段见 server.js recordHandHistory
// 输出：report 对象，字段对齐 public/client.js 的 renderAnalytics

const CATEGORY_EN = ['highcard', 'pair', 'two_pair', 'three_of_a_kind', 'straight', 'flush', 'full_house', 'four_of_a_kind', 'straight_flush'];

function num(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

function computeAnalytics(hands) {
  const list = Array.isArray(hands) ? hands : [];
  const n = list.length;
  if (n === 0) {
    return {
      empty: true, n: 0, net: 0, avgNet: 0, best: 0, worst: 0,
      pct: { winR: 0, vpipR: 0, pfrR: 0, pfrVpip: 0, af: 0, showedR: 0, sdR: 0 },
      catCount: new Array(9).fill(0),
      suggestions: [],
    };
  }

  let net = 0, best = -Infinity, worst = Infinity;
  let winCnt = 0, vpipCnt = 0, pfrCnt = 0;
  let postAggrSum = 0, postPassSum = 0;
  let showedCnt = 0, sdWinCnt = 0;
  const catCount = new Array(9).fill(0);

  for (const h of list) {
    const netH = num(h.net);
    net += netH;
    if (netH > best) best = netH;
    if (netH < worst) worst = netH;
    if (h.result === 'win') winCnt++;
    if (h.vpip) vpipCnt++;
    if (h.pfr) pfrCnt++;
    postAggrSum += num(h.postAggr);
    postPassSum += num(h.postPass);
    if (h.showed) {
      showedCnt++;
      if (h.result === 'win') sdWinCnt++;
    }
    const c = num(h.category);
    if (c >= 0 && c < 9) catCount[c]++;
  }

  best = best === -Infinity ? 0 : best;
  worst = worst === Infinity ? 0 : worst;

  const vpipR = vpipCnt / n;
  const pfrR = pfrCnt / n;
  const pfrVpip = vpipCnt > 0 ? pfrCnt / vpipCnt : 0;
  const af = postPassSum > 0 ? postAggrSum / postPassSum : (postAggrSum > 0 ? postAggrSum : 0);
  const showedR = showedCnt / n;
  const sdR = showedCnt > 0 ? sdWinCnt / showedCnt : 0;
  const winR = winCnt / n;

  const pct = { winR, vpipR, pfrR, pfrVpip, af, showedR, sdR };
  const suggestions = buildSuggestions({ n, net, best, worst, vpipR, pfrR, pfrVpip, af, showedR, sdR, winR });

  return {
    empty: false,
    n,
    net,
    avgNet: net / n,
    best,
    worst,
    pct,
    catCount,
    suggestions,
  };
}

function buildSuggestions(s) {
  const out = [];
  const pct = (x) => Math.round(x * 100) + '%';

  if (s.n < 10) {
    out.push({ level: 'warn', text: '对局样本还太少（仅 ' + s.n + ' 手），统计仅供参考。多玩几十手后结论会更准。' });
  }
  if (s.net < 0) {
    out.push({ level: 'bad', text: '当前净盈亏为 ' + Math.round(s.net) + '，整体在输筹码。重点检查入池选择与下注尺度。' });
  } else if (s.net > 0) {
    out.push({ level: 'good', text: '净盈亏 +' + Math.round(s.net) + '，目前是赢的，保持纪律。' });
  }

  if (s.vpipR > 0.45) {
    out.push({ level: 'bad', text: '入池率 VPIP 高达 ' + pct(s.vpipR) + '，偏松。休闲局可放宽，但长期看会被好牌剥削，建议前位紧、后位可宽。' });
  } else if (s.vpipR < 0.15) {
    out.push({ level: 'warn', text: '入池率仅 ' + pct(s.vpipR) + '，偏紧。若桌上多是紧手，可适当用更宽的范围偷池。' });
  }

  if (s.pfrR < 0.12 && s.vpipR > 0.2) {
    out.push({ level: 'warn', text: '入池多但加注少（PFR ' + pct(s.pfrR) + '），大量平跟（limp）易被加注打压。能用加注入池就别平跟。' });
  }

  if (s.af < 1.2 && s.showedR > 0.3) {
    out.push({ level: 'warn', text: '翻后激进度 AF 仅 ' + s.af.toFixed(2) + '，偏被动。拿到好牌时多下注/加注建立底池，别只跟注。' });
  } else if (s.af > 3.5) {
    out.push({ level: 'warn', text: '翻后激进度 AF ' + s.af.toFixed(2) + ' 偏高，诈唬/加注偏多，注意别被读穿。' });
  }

  if (s.sdR > 0 && s.sdR < 0.42) {
    out.push({ level: 'bad', text: '摊牌胜率仅 ' + pct(s.sdR) + '，说明打到摊牌的牌往往不够强。减少用边缘牌跟到河牌。' });
  } else if (s.sdR >= 0.55) {
    out.push({ level: 'good', text: '摊牌胜率 ' + pct(s.sdR) + ' 不错，说明你摊牌的牌力够硬。' });
  }

  if (out.length === 0) {
    out.push({ level: 'good', text: '各项指标都比较均衡，继续保持。可以挑战更高盲注或加 AI 对手练技术。' });
  }
  return out;
}

module.exports = { computeAnalytics, CATEGORY_EN };
