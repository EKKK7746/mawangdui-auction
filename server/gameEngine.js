// ============================================================
// gameEngine.js — 马王堆·宝物拍卖 服务端权威游戏逻辑
// 规则：佣金竞标 → 拍卖师选卡 → 租骰 → 掷骰 → 佣金结算 → 发卡
// ============================================================

const crypto = require('crypto');

// -------------------- 卡牌数据（10 张马王堆文物） --------------------

const CARDS = [
  { id: 'ssdc', name: '素纱襌衣',    score: 3, effect: null },
  { id: 'mfl',  name: '皿方罍',      score: 3, effect: null },
  { id: 'slj',  name: '双鸾双兽镜',  score: 2, effect: 'duel' },
  { id: 'ssyz', name: '神兽玉樽',    score: 2, effect: null },
  { id: 'yulb', name: '御龙帛画',    score: 2, effect: 'dragonPhoenix' },
  { id: 'lfh',  name: '龙凤帛画',    score: 1, effect: 'dragonPhoenix' },
  { id: 'jxsp', name: '君幸食漆盘',  score: 1, effect: 'rerollDice' },
  { id: 'jxjeb',name: '君幸酒耳杯',  score: 2, effect: 'rerollDice' },
  { id: 'dsy',  name: '对书俑',      score: 1, effect: 'upgradeDice' },
  { id: 'sq',   name: '市券',        score: 1, effect: 'doubleCommission' },
];

// -------------------- 常量 --------------------

const MAX_ROUNDS = 10;
const STARTING_FUNDS = 12;
const DICE_TYPES = ['d4', 'd6', 'd12', 'd20'];
const VALID_COMMISSIONS = [10, 20, 30, 40, 50];

/** 骰子费用 */
const DICE_COSTS = { d4: 1, d6: 2, d12: 4, d20: 6, pass: 0 };

/** 骰子升级映射 */
const DICE_UPGRADE = { d4: 'd6', d6: 'd12', d12: 'd20' };

// -------------------- 内部状态 --------------------

const games = new Map();
let _io = null;
let _onBroadcast = null; // bot 调度钩子

// 决策倒计时
const TURN_TIMEOUT = 30000;  // 30 秒决策时间
const _turnTimers = new Map();  // roomId → timeoutId

// -------------------- 工具函数 --------------------

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rollDice(sides) {
  return crypto.randomInt(1, sides + 1);
}

function playerIndex(state, playerId) {
  return state.players.findIndex(p => p.id === playerId);
}

function allBidsIn(state) {
  return state.players.every(p => state.bids.some(b => b.playerId === p.id));
}

function allDiceIn(state) {
  return state.players.every(p =>
    (state.auctioneerId && p.id === state.auctioneerId) || state.diceSelections.hasOwnProperty(p.id)
  );
}

// -------------------- 广播（同步版，修复竞态） --------------------

function setIO(ioInstance) {
  _io = ioInstance;
}

function setOnBroadcast(fn) {
  _onBroadcast = fn;
}

function broadcast(roomId) {
  const state = games.get(roomId);
  if (!state || !_io) {
    console.warn(`[Broadcast] 跳过: state=${!!state}, _io=${!!_io}`);
    return;
  }
  const room = _io.sockets.adapter.rooms.get(roomId);
  if (!room) {
    console.warn(`[Broadcast] 房间 ${roomId} 在 adapter.rooms 中不存在（可能还没 join 完成）`);
    return;
  }
  console.log(`[Broadcast] 房间 ${roomId} 广播给 ${room.size} 个 socket:`, [...room]);
  let ok = 0, fail = 0;
  for (const sid of room) {
    try {
      const view = getPlayerView(state, sid);
      _io.to(sid).emit('game_state_update', view);
      ok++;
    } catch (err) {
      fail++;
      console.error(`[Broadcast] getPlayerView 失败 sid=${sid}:`, err.message);
    }
  }
  console.log(`[Broadcast] 完成 roomId=${roomId}, ok=${ok}, fail=${fail}, phase=${state.phase}`);
  // 触发 bot 调度
  if (_onBroadcast) _onBroadcast(roomId);
}

// -------------------- 倒计时辅助 --------------------

function clearTurnTimer(roomId) {
  const tid = _turnTimers.get(roomId);
  if (tid) {
    clearTimeout(tid);
    _turnTimers.delete(roomId);
  }
}

/**
 * 设置决策倒计时，到期自动 pass
 */
function setTurnTimer(roomId, duration, phase, onTimeout) {
  clearTurnTimer(roomId);
  const deadline = Date.now() + duration;
  const state = games.get(roomId);
  if (state) state.turnDeadline = deadline;

  const tid = setTimeout(() => {
    _turnTimers.delete(roomId);
    console.log(`[计时器] 房间 ${roomId} ${phase} 阶段 ${duration/1000}s 超时，自动 pass`);
    onTimeout();
  }, duration);
  _turnTimers.set(roomId, tid);
}

// -------------------- 1. 初始化游戏 --------------------

function initGame(roomId, players) {
  const deck = shuffle(CARDS);
  const state = {
    roomId,
    round: 1,
    maxRounds: MAX_ROUNDS,
    phase: 'auction',
    deck,
    revealedCard: null,
    auctioneerId: null,
    lastAuctioneerId: null,       // 上轮拍卖师（决定竞标起点）
    commissionRate: 0,
    auctioneerStreak: 0,
    turnDeadline: null,
    biddingOrder: [],             // 本轮竞标顺序
    currentBidderIdx: 0,          // 当前轮到谁
    playersDone: new Set(),       // 选骰+升级确认完毕的玩家
    bids: [],
    diceSelections: {},
    diceResults: {},
    players: players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      isBot: !!p.isBot,
      isHost: !!p.isHost,
      strategy: p.strategy || 'greedy',
      funds: STARTING_FUNDS,
      cards: [],
    })),
  };

  initBiddingOrder(state);
  games.set(roomId, state);
  console.log(`[引擎] 房间 ${roomId} 游戏初始化，${players.length} 人，牌堆 ${deck.length} 张`);
  broadcast(roomId);
  return state;
}

// --- 竞标顺序初始化 ---
function initBiddingOrder(state) {
  const players = state.players;
  let startIdx = 0;
  if (state.lastAuctioneerId) {
    const found = players.findIndex(p => p.id === state.lastAuctioneerId);
    if (found >= 0) startIdx = (found + 1) % players.length;
  } else {
    // 首轮：资金最少的先开始
    const minFunds = Math.min(...players.map(p => p.funds));
    startIdx = players.findIndex(p => p.funds === minFunds);
  }
  state.biddingOrder = [
    ...players.slice(startIdx).map(p => p.id),
    ...players.slice(0, startIdx).map(p => p.id),
  ];
  state.currentBidderIdx = 0;

  // ★ 设置首位报价者的倒计时
  const roomId = [...games.entries()].find(([, s]) => s === state)?.[0];
  if (roomId) {
    setTurnTimer(roomId, TURN_TIMEOUT, 'auction', () => {
      const s = games.get(roomId);
      if (!s || s.phase !== 'auction') return;
      const nextPid = s.biddingOrder[s.currentBidderIdx];
      if (nextPid && !s.bids.some(b => b.playerId === nextPid)) {
        submitBid(roomId, nextPid, null);
      }
    });
  }
}

// -------------------- 2. 拍卖 — submitBid --------------------

/**
 * submitBid(roomId, playerId, percentage|null)
 * 
 * 佣金竞标：报价 10/20/30/40/50，数字最低者当选拍卖师
 * 后报价者必须低于当前最低
 * 拍卖师收取佣金（非支付），全员Pass则随机选拍卖师（10%）
 */
function submitBid(roomId, playerId, percentage) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'auction') return { error: '当前不是拍卖阶段' };
  if (state.bids.some(b => b.playerId === playerId)) return { error: '你已经报过价了' };

  const idx = playerIndex(state, playerId);
  if (idx === -1) return { error: '你不是本局玩家' };

  // 强制竞标顺序
  if (!state.biddingOrder || state.biddingOrder.length === 0) {
    initBiddingOrder(state);
  }
  const currentTurn = state.biddingOrder[state.currentBidderIdx];
  if (currentTurn !== playerId) {
    const currentPlayer = state.players.find(p => p.id === currentTurn);
    return { error: `还没轮到你报价，当前轮到 ${currentPlayer?.nickname || '?'}` };
  }

  // 校验 percentage
  if (percentage !== null) {
    const pct = Number(percentage);
    if (!VALID_COMMISSIONS.includes(pct)) {
      return { error: '佣金比例必须为 10/20/30/40/50 之一' };
    }
    percentage = pct;

    // 必须低于当前最低有效报价
    const validBids = state.bids.filter(b => b.percentage !== null);
    if (validBids.length > 0) {
      const currentMin = Math.min(...validBids.map(b => b.percentage));
      if (percentage >= currentMin) {
        return { error: `报价必须低于当前最低 ${currentMin}%` };
      }
    }
  }

  state.bids.push({ playerId, percentage });
  state.currentBidderIdx++;
  console.log(`[引擎] ${state.players[idx].nickname} 报价: ${percentage !== null ? percentage + '%' : '跳过'} (第${state.currentBidderIdx}/${state.biddingOrder.length}人)`);

  // 未报完 → 等待
  if (!allBidsIn(state)) {
    // ★ 设置下一位玩家的倒计时
    setTurnTimer(roomId, TURN_TIMEOUT, 'auction', () => {
      const s = games.get(roomId);
      if (!s || s.phase !== 'auction') return;
      const nextPid = s.biddingOrder[s.currentBidderIdx];
      if (nextPid && !s.bids.some(b => b.playerId === nextPid)) {
        submitBid(roomId, nextPid, null);  // 自动 pass
      }
    });
    broadcast(roomId);
    return { ok: true, waiting: true };
  }

  // --- 结算拍卖 ---
  const validBids = state.bids.filter(b => b.percentage !== null);

  if (validBids.length === 0) {
    // 全员 Pass → 无拍卖师，随机翻牌
    state.lastAuctioneerId = null;
    state.auctioneerId = null;
    state.commissionRate = 0;
    state.auctioneerStreak = 0;
    const idx = crypto.randomInt(0, state.deck.length);
    state.revealedCard = state.deck[idx];
    state.deck.splice(idx, 1);
    console.log(`[引擎] 全员跳过，无拍卖师，随机翻牌: ${state.revealedCard.name}`);
    state.phase = 'rentDice';
    state.bids = [];
    state.diceSelections = {};

    // ★ 租骰阶段倒计时（无拍卖师路径）
    setTurnTimer(roomId, TURN_TIMEOUT, 'rentDice', () => {
      const s = games.get(roomId);
      if (!s || s.phase !== 'rentDice') return;
      for (const p of s.players) {
        if (!s.diceSelections.hasOwnProperty(p.id)) {
          s.diceSelections[p.id] = 'pass';
        }
      }
      s.phase = 'rollDice';
      _computeAllRolls(s);
      broadcast(roomId);
      setTimeout(() => resolveRoll(roomId), 5000);
    });

    broadcast(roomId);
    return { ok: true, auctioneerId: null, noAuctioneer: true };
  }

  const winner = validBids.reduce((min, b) =>
    b.percentage < min.percentage ? b : min
  );
  const winnerId = winner.playerId;
  const commissionRate = winner.percentage;

  // 连任追踪
  if (state.auctioneerId === winnerId) {
    state.auctioneerStreak++;
  } else {
    state.auctioneerStreak = 1;
  }
  state.lastAuctioneerId = winnerId;
  state.auctioneerId = winnerId;
  state.commissionRate = commissionRate;

  const winnerNick = state.players.find(p => p.id === winnerId).nickname;
  console.log(`[引擎] 拍卖师: ${winnerNick} 佣金${commissionRate}% (连任${state.auctioneerStreak}次)`);

  state.phase = 'selectCard';
  state.bids = [];
  broadcast(roomId);
  return { ok: true, auctioneerId: state.auctioneerId };
}

// -------------------- 3. 拍卖师选卡 — selectCard --------------------

function selectCard(roomId, playerId, cardIndex) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'selectCard') return { error: '当前不是选卡阶段' };
  if (state.auctioneerId !== playerId) return { error: '只有本轮拍卖师可以选卡' };
  if (cardIndex < 0 || cardIndex >= state.deck.length) return { error: '无效的卡牌序号' };

  const card = state.deck[cardIndex];
  state.revealedCard = card;
  state.deck.splice(cardIndex, 1);

  const auctioneer = state.players.find(p => p.id === playerId);
  console.log(`[引擎] 拍卖师 ${auctioneer.nickname} 选中: ${card.name}`);

  state.phase = 'rentDice';
  state.diceSelections = {};

  // ★ 租骰阶段倒计时
  setTurnTimer(roomId, TURN_TIMEOUT, 'rentDice', () => {
    const s = games.get(roomId);
    if (!s || s.phase !== 'rentDice') return;
    for (const p of s.players) {
      if (p.id !== s.auctioneerId && !s.diceSelections.hasOwnProperty(p.id)) {
        s.diceSelections[p.id] = 'pass';
      }
    }
    s.phase = 'rollDice';
    _computeAllRolls(s);
    broadcast(roomId);
    setTimeout(() => resolveRoll(roomId), 5000);
  });

  broadcast(roomId);
  return { ok: true, card };
}

// -------------------- 4. 选骰子 — selectDice --------------------

function selectDice(roomId, playerId, diceType) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'rentDice') return { error: '当前不是选骰子阶段' };
  if (state.auctioneerId && state.auctioneerId === playerId) return { error: '拍卖师不参与掷骰' };
  if (state.diceSelections.hasOwnProperty(playerId)) return { error: '你已经选过骰子了' };

  if (!DICE_TYPES.includes(diceType) && diceType !== 'pass') {
    return { error: '骰子类型无效，可选: d4, d6, d12, d20, pass' };
  }

  const p = state.players.find(p => p.id === playerId);

  // --- 扣费 ---
  let expense = 0;
  if (diceType !== 'pass') {
    const cost = DICE_COSTS[diceType];
    if (p.funds < cost) {
      return { error: `资金不足，${diceType} 需要 $${cost}（当前 $${p.funds}）` };
    }
    p.funds -= cost;
    expense = cost;
  }

  if (!state._roundExpense) state._roundExpense = {};
  state._roundExpense[playerId] = expense;

  state.diceSelections[playerId] = diceType;
  console.log(`[引擎] ${p.nickname} 选择骰子: ${diceType} 扣费 $${expense}`);

  // 自动标记 done：pass / 拍卖师 / 无对书俑 → 自动确认
  const isPass = diceType === 'pass';
  const hasUpgradeAvail = p.cards.some(c => c.id === 'dsy' && !c.used);
  if (isPass || !hasUpgradeAvail) {
    state.playersDone.add(playerId);
  }

  // 全部选完 → 检查是否所有人 done
  if (allDiceIn(state)) {
    _markPlayerDone(roomId, playerId);
    return { ok: true };
  }

  broadcast(roomId);
  return { ok: true, waiting: true };
}

// -------------------- 4b. 对书俑升级 — upgradeDice --------------------

function upgradeDice(roomId, playerId) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'rentDice') return { error: '当前不是租骰阶段' };

  const p = state.players.find(p => p.id === playerId);
  if (!p) return { error: '玩家不存在' };

  const currentDice = state.diceSelections[playerId];
  if (!currentDice || currentDice === 'pass') return { error: '你还未选骰子或已放弃' };

  const dsyCard = p.cards.find(c => c.id === 'dsy');
  if (!dsyCard) return { error: '你没有对书俑' };
  if (dsyCard.used) return { error: '对书俑已使用过' };

  const upgraded = DICE_UPGRADE[currentDice];
  if (!upgraded) return { error: `${currentDice} 不可升级` };

  dsyCard.used = true;
  state.diceSelections[playerId] = upgraded;
  state.playersDone.add(playerId);

  console.log(`[引擎] ${p.nickname} 使用对书俑升级骰子：${currentDice} → ${upgraded}`);
  broadcast(roomId);
  return { ok: true, from: currentDice, to: upgraded };
}

// -------------------- 4c-bis. 选骰 + 升级组合接口 --------------------

function selectDiceWithUpgrade(roomId, playerId, diceType, useUpgrade) {
  const res1 = selectDice(roomId, playerId, diceType);
  if (res1.error) return res1;

  if (useUpgrade) {
    const res2 = upgradeDice(roomId, playerId);
    if (res2.error) return res2;
  } else {
    // 不使用升级 → 手动标记 done（selectDice 在有可用升级时不会自动标记）
    _markPlayerDone(roomId, playerId);
  }
  return { ok: true };
}

// -------------------- 4c. 确认完毕 / 同步投骰 --------------------

function _markPlayerDone(roomId, playerId) {
  const state = games.get(roomId);
  if (!state || state.phase !== 'rentDice') return;

  state.playersDone.add(playerId);

  const allDone = state.players.every(p => {
    if (state.auctioneerId && p.id === state.auctioneerId) return true;
    if (state.diceSelections[p.id] === 'pass') return true;
    return state.playersDone.has(p.id);
  });

  if (!allDone) { broadcast(roomId); return; }

  // ★ 全员选完，清除租骰倒计时
  clearTurnTimer(roomId);

  // 全 Pass 检测
  const allPass = state.players.every(p => {
    if (state.auctioneerId && p.id === state.auctioneerId) return true;
    return state.diceSelections[p.id] === 'pass';
  });

  if (allPass) {
    state.diceResults = {};
    for (const p of state.players) {
      if (p.id === state.auctioneerId) continue;
      state.diceResults[p.id] = null;
    }
    state.phase = 'rollDice';
    console.log('[引擎] 全员放弃掷骰，自动进入结算');
    broadcast(roomId);
    setTimeout(() => resolveRoll(roomId), 1500);
    return;
  }

  _computeAllRolls(state);
  state.phase = 'rollDice';
  console.log('[引擎] 所有人确认完毕，同步投骰');
  broadcast(roomId);
  setTimeout(() => resolveRoll(roomId), 5000);
}

function _computeAllRolls(state) {
  state.diceResults = {};
  for (const playerId of Object.keys(state.diceSelections)) {
    const choice = state.diceSelections[playerId];
    if (choice === 'pass' || choice === 'auctioneer') {
      state.diceResults[playerId] = null;
      continue;
    }
    const sides = parseInt(choice.slice(1));
    const p = state.players.find(p => p.id === playerId);
    const hasReroll = p && p.cards.some(c => c.id === 'jxsp') && p.cards.some(c => c.id === 'jxjeb');
    if (hasReroll) {
      const v1 = rollDice(sides);
      const v2 = rollDice(sides);
      const value = Math.max(v1, v2);
      state.diceResults[playerId] = { value, v1, v2, reroll: true };
      console.log(`[引擎] ${p.nickname} 掷 ${choice}: ${v1}/${v2} → ${value} (rerollDice)`);
    } else {
      const value = rollDice(sides);
      state.diceResults[playerId] = value;
      console.log(`[引擎] ${p.nickname} 掷 ${choice}=${value}`);
    }
  }
}

// -------------------- 5. 掷骰 — rollOneDice（向后兼容） --------------------

/**
 * rollOneDice(roomId, playerId)
 * 每个玩家各自点击掷骰，广播结果。全部掷完后自动 resolveRoll。
 */
function rollOneDice(roomId, playerId) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'rentDice') return { error: '当前不在选骰阶段' };
  if (!state.diceSelections.hasOwnProperty(playerId)) return { error: '你还没选骰子' };
  if (state.diceSelections[playerId] === 'pass') return { error: '你已放弃本轮' };
  if (state.diceResults && state.diceResults.hasOwnProperty(playerId)) return { error: '你已经掷过骰了' };

  if (!state.diceResults) state.diceResults = {};

  const choice = state.diceSelections[playerId];
  const sides = parseInt(choice.slice(1));
  const p = state.players.find(p => p.id === playerId);

  // rerollDice 效果
  const hasReroll = p.cards.some(c => c.id === 'jxsp') && p.cards.some(c => c.id === 'jxjeb');
  if (hasReroll) {
    const v1 = rollDice(sides);
    const v2 = rollDice(sides);
    const value = Math.max(v1, v2);
    console.log(`[引擎] ${p.nickname} 掷 ${choice}: ${v1}/${v2} → ${value} (rerollDice)`);
    state.diceResults[playerId] = { value, v1, v2, reroll: true };
  } else {
    const value = rollDice(sides);
    console.log(`[引擎] ${p.nickname} 掷 ${choice}=${value}`);
    state.diceResults[playerId] = value;
  }

  // 给 pass 玩家补 null
  for (const [pid, sel] of Object.entries(state.diceSelections)) {
    if (sel === 'pass' && !state.diceResults.hasOwnProperty(pid)) {
      state.diceResults[pid] = null;
    }
  }

  // 检查是否所有非拍卖师/pass 玩家都已掷骰
  const allRolled = state.players.every(p => {
    if (p.id === state.auctioneerId) return true;
    if (state.diceSelections[p.id] === 'pass') return true;
    return state.diceResults && state.diceResults.hasOwnProperty(p.id);
  });

  if (allRolled) {
    state.phase = 'rollDice';
    broadcast(roomId);
    // 延迟让客户端渲染结果动画
    setTimeout(() => resolveRoll(roomId), 1500);
    return { ok: true, allRolled: true };
  }

  broadcast(roomId);
  return { ok: true, waiting: true };
}

// rollAllDice 保留兼容（服务端批量调用），但正常流程应使用 rollOneDice
function rollAllDice(roomId) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'rentDice') return { error: '当前不是选骰子阶段' };

  state.phase = 'rollDice';
  state.diceResults = {};

  for (const playerId of Object.keys(state.diceSelections)) {
    const choice = state.diceSelections[playerId];
    if (choice === 'pass') {
      state.diceResults[playerId] = null;
      continue;
    }
    const sides = parseInt(choice.slice(1));
    const p = state.players.find(p => p.id === playerId);
    const hasReroll = p.cards.some(c => c.id === 'jxsp') && p.cards.some(c => c.id === 'jxjeb');
    if (hasReroll) {
      const v1 = rollDice(sides);
      const v2 = rollDice(sides);
      const value = Math.max(v1, v2);
      state.diceResults[playerId] = { value, v1, v2, reroll: true };
      console.log(`[引擎] ${p.nickname} 掷 ${choice}: ${v1}/${v2} → ${value} (rerollDice)`);
    } else {
      const value = rollDice(sides);
      state.diceResults[playerId] = value;
      console.log(`[引擎] ${p.nickname} 掷 ${choice}=${value}`);
    }
  }

  broadcast(roomId);
  return resolveRoll(roomId);
}

// -------------------- 6. 掷骰结算 — resolveRoll --------------------

function resolveRoll(roomId) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'rollDice') return { error: '当前不是掷骰结算阶段' };

  // --- 佣金结算 ---
  _settleCommission(state);

  // 找出有效参与者（兼容 reroll 对象格式）
  const participants = {};
  for (const [pid, val] of Object.entries(state.diceResults)) {
    if (val !== null) {
      participants[pid] = (typeof val === 'object' && val.value != null) ? val.value : val;
    }
  }

  // 无有效参与者
  if (Object.keys(participants).length === 0) {
    state.phase = 'settle';
    if (state.auctioneerId) {
      console.log('[引擎] 无人掷骰，拍卖师自动获得卡牌');
      return awardCard(roomId, state.auctioneerId);
    } else {
      console.log('[引擎] 无人掷骰且无拍卖师，卡牌丢弃 → 自动推进回合');
      state.revealedCard = null;
      broadcast(roomId);
      setTimeout(() => endRound(roomId), 2000);
      return { ok: true, discarded: true };
    }
  }

  // 递归比较（平局重掷）
  const result = _resolveRecursive(participants, state.diceSelections, 0, state);
  const winnerId = result.winnerId;

  const winner = state.players.find(p => p.id === winnerId);
  console.log(`[引擎] 掷骰胜者: ${winner.nickname}${result.tieDepth > 0 ? ` (经过${result.tieDepth}次平局重掷)` : ''}`);

  state.phase = 'settle';
  return awardCard(roomId, winnerId);
}

/**
 * 佣金结算：
 * 收入 = 其他玩家骰子总支出 × 佣金比例（向上取整）
 * doubleCommission → ×2
 * 连任惩罚 → -(streak-1)
 */
function _settleCommission(state) {
  const auctioneer = state.players.find(p => p.id === state.auctioneerId);
  if (!auctioneer) return;

  // 其他玩家骰子总支出（从 _roundExpense 取，精确到扣费金额）
  let totalDiceCost = 0;
  if (state._roundExpense) {
    totalDiceCost = Object.entries(state._roundExpense)
      .filter(([pid]) => pid !== state.auctioneerId)
      .reduce((sum, [, cost]) => sum + cost, 0);
  }

  // 佣金收入
  let commission = Math.ceil(totalDiceCost * state.commissionRate / 100);

  // doubleCommission（市券）
  if (auctioneer.cards.some(c => c.id === 'sq')) {
    commission *= 2;
    console.log(`[引擎] 市券生效！佣金翻倍 → $${commission}`);
  }

  // 连任惩罚
  const penalty = Math.max(0, state.auctioneerStreak - 1);

  const net = commission - penalty;
  auctioneer.funds += net;
  console.log(`[引擎] 拍卖师 ${auctioneer.nickname} 佣金结算: 总支出$${totalDiceCost}×${state.commissionRate}%=$${commission} | 惩罚-$${penalty} | 净收入 $${net}`);

  // 清理本轮支出记录
  state._roundExpense = {};
}

function _resolveRecursive(participants, diceSelections, depth, state) {
  const maxVal = Math.max(...Object.values(participants));
  const tied = Object.entries(participants)
    .filter(([, v]) => v === maxVal)
    .map(([pid]) => pid);

  if (tied.length === 1) {
    return { winnerId: tied[0], tieDepth: depth };
  }

  // 平局 → 重掷（保留 rerollDice 效果）
  console.log(`[引擎] 平局! ${tied.length} 人重掷 (深度 ${depth + 1})`);
  const reRolled = {};
  for (const pid of tied) {
    const choice = diceSelections[pid];
    const sides = parseInt(choice.slice(1));
    const p = state.players.find(p => p.id === pid);
    const hasReroll = p && p.cards.some(c => c.id === 'jxsp') && p.cards.some(c => c.id === 'jxjeb');
    let value;
    if (hasReroll) {
      value = Math.max(rollDice(sides), rollDice(sides));
    } else {
      value = rollDice(sides);
    }
    reRolled[pid] = value;
  }
  return _resolveRecursive(reRolled, diceSelections, depth + 1, state);
}

// -------------------- 6b. 终局决斗 — Duel（重做版：选对手→选卡→租骰→掷骰→结算）--------------------

/**
 * 决斗：选择对手
 */
function duelSelectTarget(socket, io, roomId, targetId) {
  const state = games.get(roomId);
  if (!state) return;
  const pid = socket.id;

  // 验证：只能是持镜者发起
  const me = state.players.find(p => p.id === pid);
  if (!me || !me.cards.some(c => c.id === 'slj' && !c.used)) {
    socket.emit('game_error', { msg: '你没有双鸾双兽镜技能！' });
    return;
  }

  // 验证：目标必须是对手（不能选自己）
  if (targetId === pid) {
    socket.emit('game_error', { msg: '不能选择自己作为决斗对手！' });
    return;
  }

  const target = state.players.find(p => p.id === targetId);
  if (!target) {
    socket.emit('game_error', { msg: '对手不存在！' });
    return;
  }

  // 验证：目标必须有卡牌
  if (!target.cards.length) {
    socket.emit('game_error', { msg: '该对手没有卡牌可以争夺！' });
    return;
  }

  state.duel = {
    initiatorId: pid,
    targetId: targetId,
    targetCardId: null,
    step: 'select_card',
    diceSelections: {},
    diceResults: {},
    playersDone: new Set(),
    winnerId: null,
    loserId: null,
    done: false
  };

  // 标记技能已使用
  const myCard = me.cards.find(c => c.id === 'slj');
  if (myCard) myCard.used = true;

  console.log(`[引擎] 🪞 决斗对手选定: ${target.nickname}`);
  broadcast(roomId);
}

/**
 * 决斗：选择争夺的卡牌（发起者从对手手牌中指定）
 */
function duelSelectCard(socket, io, roomId, cardId) {
  const state = games.get(roomId);
  if (!state || !state.duel) return;

  const pid = socket.id;

  // 验证：只能是发起者选择卡牌
  if (pid !== state.duel.initiatorId) {
    socket.emit('game_error', { msg: '只有发起者可以选择争夺的卡牌！' });
    return;
  }

  // 验证：目标玩家必须有这张卡
  const target = state.players.find(p => p.id === state.duel.targetId);
  if (!target || !target.cards.find(c => c.id === cardId)) {
    socket.emit('game_error', { msg: '目标对手没有这张卡！' });
    return;
  }

  const targetCard = target.cards.find(c => c.id === cardId);

  state.duel.targetCardId = cardId;
  state.duel.targetCardScore = targetCard ? targetCard.score : 0;
  state.duel.step = 'rent_dice';
  state.duel.playersDone = new Set();
  state.duel.diceSelections = {};

  console.log(`[引擎] 🪞 争夺目标卡牌: ${CARD_MAP[cardId] || cardId}`);
  broadcast(roomId);
}

/**
 * 决斗：租用骰子
 */
function duelRentDice(socket, io, roomId, diceType, useUpgrade = false) {
  const state = games.get(roomId);
  if (!state || !state.duel || state.duel.step !== 'rent_dice') return;

  const pid = socket.id;

  // 验证：只能是参与决斗的两人
  if (pid !== state.duel.initiatorId && pid !== state.duel.targetId) {
    socket.emit('game_error', { msg: '你没有参与这场决斗！' });
    return;
  }

  const player = state.players.find(p => p.id === pid);

  // 验证：资金是否足够
  if (diceType !== 'pass' && DICE_COSTS[diceType] > player.funds) {
    socket.emit('game_error', { msg: '资金不足！' });
    return;
  }

  // 升级骰子处理（对书俑）
  let finalDiceType = diceType;
  if (useUpgrade && diceType !== 'pass') {
    const hasScholar = player.cards.some(c => c.id === 'dsy' && !c.used);
    if (hasScholar) {
      const UPGRADE_MAP = { 'd4': 'd6', 'd6': 'd12', 'd12': 'd20', 'd20': 'd20' };
      finalDiceType = UPGRADE_MAP[diceType] || diceType;
      // 标记已使用
      const scholarCard = player.cards.find(c => c.id === 'dsy');
      if (scholarCard) scholarCard.used = true;
      console.log(`[引擎] 🪞 决斗 ${player.nickname} 使用对书俑升级骰子：${diceType} → ${finalDiceType}`);
    }
  }

  // 记录选择（含升级后的实际骰子类型）
  state.duel.diceSelections[pid] = finalDiceType;
  state.duel.playersDone.add(pid);

  // 双方都已完成选择
  const allDone = state.duel.playersDone.has(state.duel.initiatorId)
              && state.duel.playersDone.has(state.duel.targetId);

  if (allDone) {
    // 扣除资金（按原始骰子类型价格扣）
    for (const p of state.players) {
      if (p.id === state.duel.initiatorId || p.id === state.duel.targetId) {
        const sel = state.duel.diceSelections[p.id];
        if (sel && sel !== 'pass') {
          p.funds -= DICE_COSTS[sel];
        }
      }
    }
    // 预计算双方骰子结果（与正常拍卖 _computeAllRolls 一致）
    _computeDuelRolls(state);
    state.duel.step = 'roll_dice';
    state.duel.playersDone = new Set();
  }

  broadcast(roomId);

  // 5秒后自动结算（与正常拍卖 resolveRoll 一致）
  if (allDone) {
    setTimeout(() => {
      if (state.duel && state.duel.step === 'roll_dice') {
        state.duel.step = 'resolve';
        resolveDuel(state);
        broadcast(roomId);
      }
    }, 5000);
  }
}

/**
 * 预计算决斗双方骰子结果（与正常拍卖 _computeAllRolls 一致，含双掷效果）
 */
function _computeDuelRolls(state) {
  const duel = state.duel;
  duel.diceResults = {};

  [duel.initiatorId, duel.targetId].forEach(pid => {
    const sel = duel.diceSelections[pid];
    const player = state.players.find(p => p.id === pid);

    if (sel === 'pass') {
      duel.diceResults[pid] = { value: 0, sides: 0 };
    } else if (sel) {
      const sides = parseInt(sel.replace('d', ''));
      // 双掷效果（君幸食漆盘 + 君幸酒耳杯）
      const hasReroll = player && player.cards.some(c => c.id === 'jxsp') && player.cards.some(c => c.id === 'jxjeb');
      if (hasReroll) {
        const v1 = rollDice(sides);
        const v2 = rollDice(sides);
        duel.diceResults[pid] = { value: Math.max(v1, v2), sides, reroll: true, v1, v2 };
      } else {
        const value = rollDice(sides);
        duel.diceResults[pid] = { value, sides };
      }
    } else {
      duel.diceResults[pid] = { value: 0, sides: 0 };
    }
  });

  console.log(`[引擎] 🪞 决斗预计算掷骰结果: ${JSON.stringify(duel.diceResults)}`);
}

/**
 * 决斗：掷骰子
 */
function duelRollDice(socket, io, roomId) {
  const state = games.get(roomId);
  if (!state || !state.duel || state.duel.step !== 'roll_dice') return;

  const pid = socket.id;

  // 验证：只能是参与决斗的两人
  if (pid !== state.duel.initiatorId && pid !== state.duel.targetId) return;

  // 已掷过
  if (state.duel.diceResults.hasOwnProperty(pid)) return;

  const sel = state.duel.diceSelections[pid];

  if (sel === 'pass') {
    state.duel.diceResults[pid] = { value: 0, sides: 0 };
  } else if (sel) {
    const sides = parseInt(sel.replace('d', ''));
    const player = state.players.find(p => p.id === pid);

    // 检查双掷效果（君幸食漆盘 + 君幸酒耳杯）
    const hasFoodTray = player && player.cards.some(c => c.id === 'jxsp');
    const hasWineCup = player && player.cards.some(c => c.id === 'jxjeb');
    const hasReroll = hasFoodTray && hasWineCup;

    if (hasReroll) {
      const v1 = rollDice(sides);
      const v2 = rollDice(sides);
      const value = Math.max(v1, v2);
      state.duel.diceResults[pid] = { value, sides, reroll: true, v1, v2 };
      console.log(`[引擎] 🪞 决斗 ${player.nickname} 掷 ${sel}: ${v1}/${v2} → ${value} (双掷)`);
    } else {
      const value = rollDice(sides);
      state.duel.diceResults[pid] = { value, sides };
      console.log(`[引擎] 🪞 决斗 ${player?.nickname} 掷 ${sel}=${value}`);
    }
  } else {
    // 未选骰子，默认 d4
    const value = rollDice(4);
    state.duel.diceResults[pid] = { value, sides: 4 };
  }

  // 双方都已掷骰
  const allRolled = state.duel.diceResults.hasOwnProperty(state.duel.initiatorId)
                  && state.duel.diceResults.hasOwnProperty(state.duel.targetId);

  if (allRolled) {
    state.duel.step = 'resolve';
    resolveDuel(state);
  }

  broadcast(roomId);
}

/**
 * 决斗结算
 */
function resolveDuel(state) {
  const duel = state.duel;
  const initResult = duel.diceResults[duel.initiatorId];
  const targetResult = duel.diceResults[duel.targetId];

  let winnerId, loserId;

  if (initResult.value > targetResult.value) {
    winnerId = duel.initiatorId;
    loserId = duel.targetId;
  } else if (targetResult.value > initResult.value) {
    winnerId = duel.targetId;
    loserId = duel.initiatorId;
  } else {
    // 平局：持镜者胜（发起者胜）
    winnerId = duel.initiatorId;
    loserId = duel.targetId;
  }

  // 转移卡牌
  const loser = state.players.find(p => p.id === loserId);
  const winner = state.players.find(p => p.id === winnerId);

  // ★ Fix#2: winnerId/loserId 必须在 if 外层赋值，避免 cardIdx===-1 时显示 undefined
  duel.winnerId = winnerId;
  duel.loserId = loserId;

  const cardIdx = loser.cards.findIndex(c => c.id === duel.targetCardId);
  if (cardIdx !== -1) {
    const [card] = loser.cards.splice(cardIdx, 1);
    winner.cards.push(card);
  }

  duel.done = true;

  console.log(`[引擎] 🪞 决斗结束！${winner.nickname} 获胜，赢得 ${CARD_MAP[duel.targetCardId] || duel.targetCardId}`);

  // 3秒后进入终局
  setTimeout(() => {
    const rid = state.roomId;
    state.phase = 'finished';
    state.duel = null;
    const results = calculateFinalScores(rid);
    state.finalResults = results;
    broadcast(rid);
  }, 3000);

  broadcast(state.roomId);
}

// -------------------- 决斗 Bot 友好版（*ById，不依赖 socket）--------------------

function duelSelectTargetById(roomId, initiatorId, targetId) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };

  const me = state.players.find(p => p.id === initiatorId);
  if (!me || !me.cards.some(c => c.id === 'slj' && !c.used)) {
    return { error: '没有双鸾双兽镜技能' };
  }
  if (targetId === initiatorId) return { error: '不能选择自己' };

  const target = state.players.find(p => p.id === targetId);
  if (!target) return { error: '对手不存在' };
  if (!target.cards.length) return { error: '对手没有卡牌' };

  state.duel = {
    initiatorId,
    targetId,
    targetCardId: null,
    step: 'select_card',
    diceSelections: {},
    diceResults: {},
    playersDone: new Set(),
    winnerId: null,
    loserId: null,
    done: false
  };

  const myCard = me.cards.find(c => c.id === 'slj');
  if (myCard) myCard.used = true;

  console.log(`[引擎] 🪞 Bot决斗对手选定: ${me.nickname} → ${target.nickname}`);
  broadcast(roomId);
  return { ok: true };
}

function duelSelectCardById(roomId, initiatorId, cardId) {
  const state = games.get(roomId);
  if (!state || !state.duel) return { error: '无决斗' };
  if (initiatorId !== state.duel.initiatorId) return { error: '只有发起者可以选卡' };

  const target = state.players.find(p => p.id === state.duel.targetId);
  if (!target || !target.cards.find(c => c.id === cardId)) return { error: '目标对手没有这张卡' };

  const targetCard = target.cards.find(c => c.id === cardId);

  state.duel.targetCardId = cardId;
  state.duel.targetCardScore = targetCard ? targetCard.score : 0;
  state.duel.step = 'rent_dice';
  state.duel.playersDone = new Set();
  state.duel.diceSelections = {};

  console.log(`[引擎] 🪞 Bot决斗争夺卡牌: ${CARD_MAP[cardId] || cardId}`);
  broadcast(roomId);
  return { ok: true };
}

function duelRentDiceById(roomId, playerId, diceType, useUpgrade) {
  const state = games.get(roomId);
  if (!state || !state.duel || state.duel.step !== 'rent_dice') return { error: '当前不是租骰阶段' };

  if (playerId !== state.duel.initiatorId && playerId !== state.duel.targetId) {
    return { error: '你没有参与这场决斗' };
  }

  const player = state.players.find(p => p.id === playerId);
  if (!player) return { error: '玩家不存在' };

  if (diceType !== 'pass' && DICE_COSTS[diceType] > player.funds) {
    return { error: '资金不足' };
  }

  // 升级处理（对书俑）
  let finalDiceType = diceType;
  if (useUpgrade && diceType !== 'pass') {
    const hasScholar = player.cards.some(c => c.id === 'dsy' && !c.used);
    if (hasScholar) {
      finalDiceType = DICE_UPGRADE[diceType] || diceType;
      const scholarCard = player.cards.find(c => c.id === 'dsy');
      if (scholarCard) scholarCard.used = true;
      console.log(`[引擎] 🪞 Bot决斗 ${player.nickname} 对书俑升级：${diceType} → ${finalDiceType}`);
    }
  }

  state.duel.diceSelections[playerId] = finalDiceType;
  state.duel.playersDone.add(playerId);

  const allDone = state.duel.playersDone.has(state.duel.initiatorId)
                && state.duel.playersDone.has(state.duel.targetId);

  if (allDone) {
    for (const p of state.players) {
      if (p.id === state.duel.initiatorId || p.id === state.duel.targetId) {
        const sel = state.duel.diceSelections[p.id];
        if (sel && sel !== 'pass') {
          p.funds -= DICE_COSTS[sel];
        }
      }
    }
    _computeDuelRolls(state);
    state.duel.step = 'roll_dice';
    state.duel.playersDone = new Set();
  }

  broadcast(roomId);

  if (allDone) {
    setTimeout(() => {
      if (state.duel && state.duel.step === 'roll_dice') {
        state.duel.step = 'resolve';
        resolveDuel(state);
        broadcast(roomId);
      }
    }, 5000);
  }

  return { ok: true };
}

// 卡牌 ID → 名称映射（供决斗日志用）
const CARD_MAP = {};
CARDS.forEach(c => { CARD_MAP[c.id] = c.name; });

// -------------------- 7. 发卡 — awardCard --------------------

function awardCard(roomId, winnerId) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };

  const card = state.revealedCard;
  if (!card) return { error: '没有待发放的卡牌' };

  const idx = playerIndex(state, winnerId);
  if (idx === -1) return { error: '胜者不存在' };

  const player = state.players[idx];
  // 存入手牌，upgradeDice 卡牌标记 used:false
  const cardData = { ...card, wonAtRound: state.round };
  if (card.effect === 'upgradeDice') {
    cardData.used = false;
  }
  player.cards.push(cardData);
  console.log(`[引擎] ${player.nickname} 获得卡牌: ${card.name}${card.effect ? ' [' + card.effect + ']' : ''}`);

  state.revealedCard = null;
  broadcast(roomId);
  return { ok: true, winnerId, card };
}

// -------------------- 8. 结束回合 — endRound --------------------

function endRound(roomId) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'settle') return { ok: true, skipped: true };  // ★ 防重入

  // 清除倒计时
  clearTurnTimer(roomId);

  // 全员 +$1
  for (const p of state.players) {
    p.funds += 1;
  }

  state.round += 1;

  // 终局检查
  if (state.round > state.maxRounds || state.deck.length === 0) {
    // 检查是否有玩家持有未使用的双鸾双兽镜 → 触发镜中决斗
    const duelHolder = state.players.find(p => p.cards.some(c => c.id === 'slj' && !c.used));
    if (duelHolder && state.players.some(p => p.id !== duelHolder.id && p.cards.length > 0)) {
      console.log(`[引擎] 🪞 ${duelHolder.nickname} 持有双鸾双兽镜，触发镜中决斗！`);
      state.phase = 'duel';
      state.duel = {
        initiatorId: duelHolder.id,
        targetId: null,
        targetCardId: null,
        step: 'select_target',
        diceSelections: {},
        diceResults: {},
        playersDone: new Set(),
        winnerId: null,
        loserId: null,
        done: false
      };
      broadcast(roomId);
      return { ok: true, duel: true };
    }

    state.phase = 'finished';
    console.log(`[引擎] 游戏结束！共 ${state.round - 1} 轮`);
    const results = calculateFinalScores(roomId);
    state.finalResults = results;
    broadcast(roomId);
    return { ok: true, finished: true, results };
  }

  // 重置下一轮
  state.phase = 'auction';
  state.bids = [];
  state.diceSelections = {};
  state.diceResults = {};
  state.revealedCard = null;
  state.commissionRate = 0;
  state._roundExpense = {};
  state.playersDone = new Set();
  // 重新计算竞标顺序（从上一轮拍卖师开始）
  initBiddingOrder(state);

  console.log(`[引擎] → 第 ${state.round} 轮开始`);
  broadcast(roomId);
  return { ok: true, round: state.round };
}

// -------------------- 9. 终局计分 — calculateFinalScores --------------------

/**
 * 计算单张卡牌分（含 dragonPhoenix 联动）
 * dragonPhoenix：同时持有御龙帛画 + 龙凤帛画 → 所有1分卡按2分计
 */
function calculateCardScore(cards) {
  const hasDragonPhoenix = cards.some(c => c.id === 'yulb') && cards.some(c => c.id === 'lfh');
  let total = 0;
  for (const card of cards) {
    let s = card.score;
    if (hasDragonPhoenix && s === 1) s = 2;
    total += s;
  }
  return total;
}

/**
 * 最终排名：卡牌分 desc → 资金 desc（平局决胜）
 * 资金也相同 → 共享排名
 */
function calculateFinalScores(roomId) {
  const state = games.get(roomId);
  if (!state) return [];

  const scores = state.players.map(p => ({
    id: p.id,
    nickname: p.nickname,
    cardScore: calculateCardScore(p.cards),
    funds: p.funds,
    cardCount: p.cards.length,
    cards: p.cards.map(c => ({
      id: c.id, name: c.name, score: c.score, effect: c.effect, used: c.used || false, wonAtRound: c.wonAtRound,
    })),
  }));

  // 排序：卡牌分降序 → 资金降序
  scores.sort((a, b) => {
    if (b.cardScore !== a.cardScore) return b.cardScore - a.cardScore;
    return b.funds - a.funds;
  });

  // 排名（同分+同资金共享排名）
  for (let i = 0; i < scores.length; i++) {
    if (i > 0 && scores[i].cardScore === scores[i - 1].cardScore && scores[i].funds === scores[i - 1].funds) {
      scores[i].rank = scores[i - 1].rank;
    } else {
      scores[i].rank = i + 1;
    }
  }

  console.log('[引擎] 终局计分：');
  for (const s of scores) {
    console.log(`  #${s.rank} ${s.nickname}: 卡牌${s.cardScore}分 + 资金$${s.funds} | ${s.cardCount}张卡`);
  }

  return scores;
}

// -------------------- 10. 玩家视角裁剪 --------------------

/**
 * 根据卡牌分值和玩家身份决定是否隐藏1分卡信息
 * - 2/3分卡：所有人可见完整信息
 * - 1分卡：只有拍卖师可见完整信息，其他人只看到分值
 */
function sanitizeRevealedCard(card, isAuctioneer) {
  if (!card) return null;
  // 2/3分卡：所有人可见完整信息
  if (card.score >= 2) return { ...card };
  // 1分卡：只有拍卖师可见完整信息，其他人只看到分值
  if (card.score === 1 && !isAuctioneer) {
    return { score: 1, id: card.id, hidden: true };
  }
  return { ...card };
}

function getPlayerView(fullState, playerId) {
  const isAuctioneer = fullState.auctioneerId === playerId;
  const me = fullState.players.find(p => p.id === playerId);
  const hasUpgrade = me && me.cards.some(c => c.id === 'dsy' && !c.used);

  // 基础公开信息
  const base = {
    roomId: fullState.roomId,
    round: fullState.round,
    maxRounds: fullState.maxRounds,
    phase: fullState.phase,
    auctioneerId: fullState.auctioneerId,
    turnDeadline: fullState.turnDeadline || null,
    commissionRate: fullState.commissionRate,
    auctioneerStreak: fullState.auctioneerStreak,
    // 玩家信息 — 卡牌被获得后即公开
    players: fullState.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      funds: p.funds,
      cardCount: p.cards.length,
      isBot: !!p.isBot,
      // 始终发送完整卡牌信息
      cards: p.cards.map(c => ({ id: c.id, name: c.name, score: c.score, effect: c.effect, used: !!c.used })),
      hasDragonPhoenix: p.cards.some(c => c.id === 'yulb') && p.cards.some(c => c.id === 'lfh'),
      hasReroll: p.cards.some(c => c.id === 'jxsp') && p.cards.some(c => c.id === 'jxjeb'),
      hasDoubleComm: p.cards.some(c => c.id === 'sq'),
      hasUpgrade: p.cards.some(c => c.id === 'dsy' && !c.used),
      isMe: p.id === playerId,
    })),
  };

  // 阶段裁剪
  switch (fullState.phase) {
    case 'waiting': {
      base.readyPlayers = fullState.readyPlayers ? [...fullState.readyPlayers] : [];
      break;
    }

    case 'auction': {
      const validBids = fullState.bids.filter(b => b.percentage !== null);
      base.currentMin = validBids.length > 0
        ? Math.min(...validBids.map(b => b.percentage))
        : null;
      base.bids = fullState.players.map(p => {
        const bid = fullState.bids.find(b => b.playerId === p.id);
        return {
          playerId: p.id,
          submitted: !!bid,
          percentage: bid && p.id === playerId ? bid.percentage : null,
        };
      });
      base.biddingOrder = fullState.biddingOrder;
      base.currentBidder = fullState.biddingOrder[fullState.currentBidderIdx] || null;
      base.lastAuctioneerId = fullState.lastAuctioneerId;
      base.deckSize = fullState.deck.length;
      break;
    }

    case 'selectCard': {
      if (isAuctioneer) {
        // 拍卖师看到完整牌堆（含1分卡名称和效果）
        base.deck = fullState.deck.map((c, i) => ({
          index: i,
          id: c.id,
          name: c.name,
          score: c.score,
          effect: c.effect,
        }));
      } else {
        base.deckSize = fullState.deck.length;
        base.deck = fullState.deck.map((_, i) => ({ index: i, hidden: true }));
      }
      break;
    }

    case 'rentDice': {
      base.diceCosts = { ...DICE_COSTS };
      base.hasUpgrade = hasUpgrade;
      base.readyToRoll = allDiceIn(fullState);
      base.playersDone = fullState.playersDone ? [...fullState.playersDone] : [];
      base.isPlayerDone = fullState.playersDone ? fullState.playersDone.has(playerId) : false;

      // 当前玩家是否可以升级骰子
      const mySel = fullState.diceSelections[playerId];
      const alreadyRolled = fullState.diceResults && fullState.diceResults.hasOwnProperty(playerId);
      base.canUpgrade = mySel
        && mySel !== 'pass'
        && mySel !== 'waiting'
        && !alreadyRolled
        && hasUpgrade
        && DICE_UPGRADE.hasOwnProperty(mySel);

      base.diceSelections = {};
      for (const p of fullState.players) {
        if (p.id === fullState.auctioneerId) {
          base.diceSelections[p.id] = 'auctioneer';
        } else if (fullState.diceSelections.hasOwnProperty(p.id)) {
          base.diceSelections[p.id] = p.id === playerId
            ? fullState.diceSelections[p.id]
            : 'selected';
        } else {
          base.diceSelections[p.id] = 'waiting';
        }
      }
      // 1分卡信息隐藏：非拍卖师只看到分值
      base.revealedCard = fullState.revealedCard
        ? sanitizeRevealedCard(fullState.revealedCard, isAuctioneer)
        : null;
      break;
    }

    case 'rollDice':
    case 'settle': {
      base.diceSelections = { ...fullState.diceSelections };
      base.diceResults = { ...fullState.diceResults };
      base.revealedCard = fullState.revealedCard
        ? sanitizeRevealedCard(fullState.revealedCard, isAuctioneer)
        : null;
      break;
    }

    case 'duel': {
      if (fullState.duel) {
        base.duel = {
          initiatorId: fullState.duel.initiatorId,
          targetId: fullState.duel.targetId,
          targetCardId: fullState.duel.targetCardId,
          targetCardScore: fullState.duel.targetCardScore,
          step: fullState.duel.step,
          diceSelections: { ...fullState.duel.diceSelections },
          diceResults: { ...fullState.duel.diceResults },
          playersDone: fullState.duel.playersDone ? [...fullState.duel.playersDone] : [],
          winnerId: fullState.duel.winnerId,
          loserId: fullState.duel.loserId,
          done: fullState.duel.done,
        };
        // 在 rent_dice 阶段，非参与者看不到骰子选择
        if (base.duel.step === 'rent_dice') {
          const isInvolved = playerId === fullState.duel.initiatorId
                          || playerId === fullState.duel.targetId;
          if (!isInvolved) {
            base.duel.diceSelections = {};
          }
        }
      } else {
        base.duel = null;
      }
      break;
    }

    case 'finished': {
      base.revealedCard = null;
      base.finalResults = fullState.finalResults || [];
      break;
    }
  }

  return base;
}

// -------------------- 查询 / 辅助 --------------------

function getGame(roomId) {
  return games.get(roomId) || null;
}

function destroyGame(roomId) {
  games.delete(roomId);
  console.log(`[引擎] 房间 ${roomId} 游戏数据已清除`);
}

function removePlayer(roomId, playerId) {
  const state = games.get(roomId);
  if (!state) return;

  state.players = state.players.filter(p => p.id !== playerId);
  state.bids = state.bids.filter(b => b.playerId !== playerId);
  delete state.diceSelections[playerId];
  delete state.diceResults[playerId];
  if (state._roundExpense) delete state._roundExpense[playerId];

  if (state.auctioneerId === playerId) {
    state.auctioneerId = state.players.length > 0 ? state.players[0].id : null;
    state.auctioneerStreak = 0;
  }

  if (state.players.length < 2) {
    state.phase = 'finished';
    console.log(`[引擎] 房间 ${roomId} 玩家不足，游戏终止`);
    const fr = calculateFinalScores(roomId);
    state.finalResults = fr;
    broadcast(roomId);
    return fr;
  }

  broadcast(roomId);
  return null;
}

// -------------------- 玩家重新加入（再来一局，单玩家）--------------------

function playerRejoin(socket, io, roomId) {
  const state = games.get(roomId);
  if (!state) return;

  // 确保 readyPlayers 集合存在
  if (!state.readyPlayers) state.readyPlayers = new Set();

  // 找到该玩家并重置
  const player = state.players.find(p => p.id === socket.id);
  if (player) {
    player.funds = STARTING_FUNDS;
    player.cards = [];
    state.readyPlayers.add(socket.id);
  }

  // Bot 自动 ready
  for (const p of state.players) {
    if (p.isBot) state.readyPlayers.add(p.id);
  }

  console.log(`[引擎] 玩家 ${socket.id} 重新加入房间 ${roomId}，ready: ${state.readyPlayers.size}/${state.players.length}`);

  // 只对当前 socket 发送等待状态（带 _isRejoin 标记，告诉客户端只更新自己）
  const view = getPlayerView(state, socket.id);
  view._isRejoin = true;
  socket.emit('game_state_update', view);

  // 通知其他玩家该玩家已 ready（不强制他们切走）
  socket.to(roomId).emit('player:ready', {
    playerId: socket.id,
    readyCount: state.readyPlayers.size,
    total: state.players.length,
  });

  // 触发 bot 调度
  if (_onBroadcast) _onBroadcast(roomId);
}

// -------------------- 重置游戏（再来一局，全体 - 房主强制）--------------------

function restartGame(socket, io, roomId) {
  const state = games.get(roomId);
  if (!state) return;

  // 重置游戏状态但保留房间和玩家 — 回到等待阶段（房主可点击开始游戏）
  state.round = 0;
  state.maxRounds = MAX_ROUNDS;
  state.phase = 'waiting';
  state.deck = shuffle([...CARDS]);
  state.revealedCard = null;
  state.auctioneerId = null;
  state.lastAuctioneerId = null;
  state.commissionRate = 0;
  state.auctioneerStreak = 0;
  state.biddingOrder = [];
  state.currentBidderIdx = 0;
  state.bids = [];
  state.diceSelections = {};
  state.diceResults = {};
  state.playersDone = new Set();
  state.duel = null;
  state.finalResults = null;
  state.readyPlayers = new Set();
  if (state._roundExpense) state._roundExpense = {};

  // 重置玩家资金和手牌
  for (const p of state.players) {
    p.funds = STARTING_FUNDS;
    p.cards = [];
  }

  console.log(`[引擎] 房间 ${roomId} 重新开始！等待房主开始游戏...`);
  broadcast(roomId);
}

// -------------------- 导出 --------------------

module.exports = {
  initGame,
  submitBid,
  selectCard,
  selectDice,
  upgradeDice,
  selectDiceWithUpgrade,
  rollAllDice,
  rollOneDice,
  resolveRoll,
  awardCard,
  endRound,
  calculateFinalScores,

  // Duel（重做版）
  duelSelectTarget,
  duelSelectCard,
  duelRentDice,
  duelRollDice,

  // Duel Bot 友好版（*ById，不依赖 socket）
  duelSelectTargetById,
  duelSelectCardById,
  duelRentDiceById,

  getPlayerView,
  getGame,
  _markPlayerDone,
  setIO,
  setOnBroadcast,
  destroyGame,
  removePlayer,
  restartGame,
  playerRejoin,
};
