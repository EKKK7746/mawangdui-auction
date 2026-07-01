// ============================================================
// gameEngine.js — 琳琅·华夏文物拍卖 服务端权威游戏逻辑
// 规则：佣金竞标 → 拍卖师选卡 → 租骰 → 掷骰 → 佣金结算 → 发卡
// ============================================================

const crypto = require('crypto');

// -------------------- 卡牌数据（20 张华夏文明代表性文物） --------------------

const CARDS = [
  // --- 3分·国之重器（4张）---
  { id: 'sxqts', name: '青铜神树',    score: 3, effect: null },            // 三星堆·商
  { id: 'qsbmy', name: '兵马俑',      score: 3, effect: null },            // 秦·始皇陵
  { id: 'qmht',  name: '清明上河图',  score: 3, effect: 'extraScore' },    // 宋·终局+2分
  { id: 'syfz',  name: '四羊方尊',    score: 3, effect: null },            // 商·青铜巅峰
  // --- 2分·珍品雅器（8张）---
  { id: 'slj',   name: '双鸾双兽镜',  score: 2, effect: 'duel' },          // 汉·镜中决斗
  { id: 'jlyy',  name: '金缕玉衣',    score: 2, effect: null },            // 汉·中山靖王
  { id: 'ltsx',  name: '兰亭序',      score: 2, effect: 'dragonPhoenix' }, // 晋·与快雪时晴帖联动
  { id: 'zhybz', name: '曾侯乙编钟',  score: 2, effect: null },            // 战国·礼乐重器
  { id: 'yqz',   name: '影青盏',      score: 2, effect: null },            // 宋·景德镇青白瓷
  { id: 'yqh',   name: '元青花',      score: 2, effect: 'soloReroll' },    // 元·独立重掷
  { id: 'dhmh',  name: '敦煌壁画',    score: 2, effect: 'streakShield' },  // 唐·连任惩罚减半
  { id: 'rytqy', name: '汝窑天青釉',  score: 2, effect: 'rerollDice' },    // 宋·重掷骰子
  // --- 1分·文明遗珍（8张）---
  { id: 'kxqt',  name: '快雪时晴帖',  score: 1, effect: 'dragonPhoenix' }, // 晋·与兰亭序联动
  { id: 'jgpx',  name: '甲骨卜辞',    score: 1, effect: 'rerollDice' },    // 商·与天青釉联动重掷
  { id: 'dhft',  name: '敦煌飞天',    score: 1, effect: 'upgradeDice' },   // 唐·骰子升级
  { id: 'sq',    name: '市券',        score: 1, effect: 'doubleCommission' }, // 汉·佣金翻倍
  { id: 'sxtc',  name: '三彩驼',      score: 1, effect: 'passiveIncome' }, // 唐·每轮+$1
  { id: 'cjgb',  name: '鸡缸杯',      score: 1, effect: null },            // 明·成化斗彩
  { id: 'jofjg', name: '金瓯永固杯',  score: 1, effect: null },            // 清·乾隆御制
  { id: 'dhcxb', name: '沉香雕笔',    score: 1, effect: null },            // 明·文房珍宝
];

// -------------------- 模式配置 --------------------

const MODE_CONFIGS = {
  speed:    { rounds: 5,  initialCash: 8,  label: '极速对决' },
  classic:  { rounds: 10, initialCash: 12, label: '经典竞拍' },
  fulldeck: { rounds: 20, initialCash: 20, label: '完整对局' },
};

// 默认常量（向后兼容，实际由 mode 决定）
let MAX_ROUNDS = 10;
let STARTING_FUNDS = 12;
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

/**
 * 判断玩家是否拥有重掷能力
 * - rerollDice：汝窑天青釉 + 甲骨卜辞 组合
 * - soloReroll：元青花（独立生效）
 */
function hasRerollAbility(player) {
  if (!player) return false;
  return (player.cards.some(c => c.id === 'rytqy') && player.cards.some(c => c.id === 'jgpx'))
      || player.cards.some(c => c.id === 'yqh');
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
    if (_onBroadcast) _onBroadcast(roomId);
    return;
  }
  const room = _io.sockets.adapter.rooms.get(roomId);
  if (!room) {
    // ★ 房间查询失败时的 fallback：遍历玩家逐个 push
    // CloudBase / 某些部署环境下 adapter.rooms 可能不及时同步
    console.warn(`[Broadcast] 房间 ${roomId} adapter.rooms 查询失败，fallback 逐个推送 (${state.players.length} 玩家)`);
    let fallbackOk = 0;
    for (const p of state.players) {
      try {
        const view = getPlayerView(state, p.id);
        _io.to(p.id).emit('game_state_update', view);
        fallbackOk++;
      } catch (e) {
        console.error(`[Broadcast-fallback] 推送失败 p=${p.nickname}:`, e.message);
      }
    }
    console.log(`[Broadcast] fallback 完成: ${fallbackOk}/${state.players.length}`);
    if (_onBroadcast) _onBroadcast(roomId);
    return;
  }
  console.log(`[Broadcast] 房间 ${roomId} 广播给 ${room.size} 个 socket:`, [...room]);
  let ok = 0, fail = 0;
  for (const sid of room) {
    try {
      const isPlayer = state.players.some(p => p.id === sid);
      const view = isPlayer ? getPlayerView(state, sid) : getSpectatorView(state);
      _io.to(sid).emit('game_state_update', view);
      ok++;
    } catch (err) {
      fail++;
      console.error(`[Broadcast] view 生成失败 sid=${sid}:`, err.message);
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

function initGame(roomId, players, modeOpts) {
  // ★ 根据模式决定参数
  const modeId = (modeOpts && modeOpts.mode) || 'classic';
  const cfg = MODE_CONFIGS[modeId] || MODE_CONFIGS.classic;
  const maxRounds = (modeOpts && modeOpts.rounds) || cfg.rounds;
  const startingFunds = (modeOpts && modeOpts.initialCash) || cfg.initialCash;

  const deck = shuffle(CARDS).slice(0, maxRounds);
  const state = {
    roomId,
    round: 1,
    maxRounds,
    _startingFunds: startingFunds,  // ★ 保存用于重开
    phase: 'auction',
    deck,
    originalDeck: [...deck],  // ★ 记录本局初始牌堆，用于牌堆总览
    dealtCardIds: new Set(),  // ★ 记录已翻开的卡牌 id
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
      funds: startingFunds,
      cards: [],
    })),
  };

  initBiddingOrder(state);
  games.set(roomId, state);
  console.log(`[引擎] 房间 ${roomId} 游戏初始化（${cfg.label}），${players.length} 人，牌堆 ${deck.length} 张，初始资金 $${startingFunds}`);
  broadcast(roomId);
  return state;
}

// --- 暗标竞标初始化（所有人同时秘密报价） ---
function initBiddingOrder(state) {
  state.biddingOrder = [];
  state.currentBidderIdx = 0;
  state.bids = [];

  // 设置统一倒计时——所有人同时报价
  const roomId = [...games.entries()].find(([, s]) => s === state)?.[0];
  if (roomId) {
    setTurnTimer(roomId, TURN_TIMEOUT, 'auction', () => {
      const s = games.get(roomId);
      if (!s || s.phase !== 'auction') return;
      // 超时：所有未报价的玩家自动 Pass
      for (const p of s.players) {
        if (!s.bids.some(b => b.playerId === p.id)) {
          s.bids.push({ playerId: p.id, percentage: null });
          console.log(`[引擎] ${p.nickname} 超时自动跳过`);
        }
      }
      _settleAuctionAfterAllBids(s, roomId);
    });
  }
}

// -------------------- 2. 拍卖 — submitBid --------------------

/**
 * submitBid(roomId, playerId, percentage|null)
 * 
 * 暗标制：所有玩家同时秘密报价 10/20/30/40/50
 * 所有人报价完毕后统一结算，最低独占者当选拍卖师
 * 多人报同价 → 随机选一个
 * 全员 Pass → 无拍卖师，随机翻牌
 */
function submitBid(roomId, playerId, percentage) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'auction') return { error: '当前不是拍卖阶段' };
  if (state.bids.some(b => b.playerId === playerId)) return { error: '你已经报过价了' };

  const idx = playerIndex(state, playerId);
  if (idx === -1) return { error: '你不是本局玩家' };

  // 校验 percentage
  if (percentage !== null) {
    const pct = Number(percentage);
    if (!VALID_COMMISSIONS.includes(pct)) {
      return { error: '佣金比例必须为 10/20/30/40/50 之一' };
    }
    percentage = pct;
  }

  state.bids.push({ playerId, percentage });
  console.log(`[引擎] ${state.players[idx].nickname} 暗标报价: ${percentage !== null ? percentage + '%' : '跳过'} (${state.bids.length}/${state.players.length}人)`);

  // 未报完 → 等待
  if (!allBidsIn(state)) {
    broadcast(roomId);
    return { ok: true, waiting: true };
  }

  // --- 所有人报价完毕 → 结算 ---
  _settleAuctionAfterAllBids(state, roomId);
  return { ok: true };
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
  state.dealtCardIds.add(card.id);  // ★ 记录已翻开

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
  const hasUpgradeAvail = p.cards.some(c => c.id === 'dhft' && !c.used);
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

// -------------------- 4b. 敦煌飞天升级 — upgradeDice --------------------

function upgradeDice(roomId, playerId) {
  const state = games.get(roomId);
  if (!state) return { error: '游戏不存在' };
  if (state.phase !== 'rentDice') return { error: '当前不是租骰阶段' };

  const p = state.players.find(p => p.id === playerId);
  if (!p) return { error: '玩家不存在' };

  const currentDice = state.diceSelections[playerId];
  if (!currentDice || currentDice === 'pass') return { error: '你还未选骰子或已放弃' };

  const dsyCard = p.cards.find(c => c.id === 'dhft');
  if (!dsyCard) return { error: '你没有敦煌飞天' };
  if (dsyCard.used) return { error: '敦煌飞天已使用过' };

  const upgraded = DICE_UPGRADE[currentDice];
  if (!upgraded) return { error: `${currentDice} 不可升级` };

  dsyCard.used = true;
  state.diceSelections[playerId] = upgraded;
  state.playersDone.add(playerId);

  console.log(`[引擎] ${p.nickname} 使用敦煌飞天升级骰子：${currentDice} → ${upgraded}`);
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
    const hasReroll = hasRerollAbility(p);
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
  const hasReroll = hasRerollAbility(p);
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
    const hasReroll = hasRerollAbility(p);
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

  // 清理已离开玩家的骰子结果
  for (const pid of Object.keys(state.diceResults)) {
    if (!state.players.some(p => p.id === pid)) {
      delete state.diceResults[pid];
    }
  }

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
      // 安全网：2s 后自动推进（discarded 卡牌不需要长展示）
      setTurnTimer(roomId, 2000, 'settle', () => {
        const s = games.get(roomId);
        if (!s || s.phase !== 'settle') return;
        endRound(roomId);
      });
      return { ok: true, discarded: true };
    }
  }

  // 递归比较（平局重掷）
  const result = _resolveRecursive(participants, state.diceSelections, 0, state);
  const winnerId = result.winnerId;

  const winner = state.players.find(p => p.id === winnerId);
  console.log(`[引擎] 掷骰胜者: ${winner.nickname}${result.tieDepth > 0 ? ` (经过${result.tieDepth}次平局重掷)` : ''}`);

  // P0-3: 保存平局重掷信息
  if (result.tieDepth > 0) {
    state.tieInfo = {
      depth: result.tieDepth,
      hadTie: true,
    };
  } else {
    state.tieInfo = null;
  }

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
  let penalty = Math.max(0, state.auctioneerStreak - 1);
  // streakShield（敦煌壁画）：连任惩罚减半（向下取整）
  if (auctioneer.cards.some(c => c.id === 'dhmh')) {
    penalty = Math.floor(penalty / 2);
    console.log(`[引擎] 敦煌壁画生效！连任惩罚减半 → $${penalty}`);
  }

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
    const hasReroll = hasRerollAbility(p);
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
    const hasScholar = player.cards.some(c => c.id === 'dhft' && !c.used);
    if (hasScholar) {
      const UPGRADE_MAP = { 'd4': 'd6', 'd6': 'd12', 'd12': 'd20', 'd20': 'd20' };
      finalDiceType = UPGRADE_MAP[diceType] || diceType;
      // 标记已使用
      const scholarCard = player.cards.find(c => c.id === 'dhft');
      if (scholarCard) scholarCard.used = true;
      console.log(`[引擎] 🪞 决斗 ${player.nickname} 使用敦煌飞天升级骰子：${diceType} → ${finalDiceType}`);
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
      // 双掷效果（君幸食漆盘 + 君幸酒耳杯，或玳瑁樽独立生效）
      const hasReroll = hasRerollAbility(player);
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

    // 检查双掷效果（君幸组合 或 玳瑁樽独立生效）
    const hasReroll = hasRerollAbility(player);

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
    const hasScholar = player.cards.some(c => c.id === 'dhft' && !c.used);
    if (hasScholar) {
      finalDiceType = DICE_UPGRADE[diceType] || diceType;
      const scholarCard = player.cards.find(c => c.id === 'dhft');
      if (scholarCard) scholarCard.used = true;
      console.log(`[引擎] 🪞 Bot决斗 ${player.nickname} 敦煌飞天升级：${diceType} → ${finalDiceType}`);
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

  // 不在此处清除 revealedCard — settle 阶段需要它来展示卡牌信息
  // revealedCard 将在 endRound 中清除

  // 安全网：settle 阶段 8s 超时自动推进（防止客户端 timer 失效卡死）
  setTurnTimer(roomId, 8000, 'settle', () => {
    const s = games.get(roomId);
    if (!s || s.phase !== 'settle') return;
    console.log(`[引擎] settle 阶段 8s 超时，自动推进回合`);
    endRound(roomId);
  });

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

  // 清除本回合卡牌信息（settle 展示完毕）
  state.revealedCard = null;
  state.tieInfo = null;

  // 全员 +$1
  for (const p of state.players) {
    p.funds += 1;
    // passiveIncome（三彩驼）：每轮额外+$1
    if (p.cards.some(c => c.id === 'sxtc')) {
      p.funds += 1;
      console.log(`[引擎] ${p.nickname} 三彩驼生效，额外+$1`);
    }
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
  state.lastBidResults = null;   // 清除上轮暗标结果
  state.tieInfo = null;          // 清除平局信息
  // 重新计算竞标顺序（从上一轮拍卖师开始）
  initBiddingOrder(state);

  console.log(`[引擎] → 第 ${state.round} 轮开始`);
  broadcast(roomId);
  return { ok: true, round: state.round };
}

// -------------------- 9. 终局计分 — calculateFinalScores --------------------

/**
 * 计算单张卡牌分（含 dragonPhoenix 联动）
 * dragonPhoenix：同时持有兰亭序 + 快雪时晴帖 → 所有1分卡按2分计
 */
function calculateCardScore(cards) {
  const hasDragonPhoenix = cards.some(c => c.id === 'ltsx') && cards.some(c => c.id === 'kxqt');
  let total = 0;
  for (const card of cards) {
    let s = card.score;
    if (hasDragonPhoenix && s === 1) s = 2;
    total += s;
  }
  // extraScore（清明上河图）：终局额外+2分
  if (cards.some(c => c.id === 'qmht')) {
    total += 2;
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
  const hasUpgrade = me && me.cards.some(c => c.id === 'dhft' && !c.used);

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
    // 全卡池总览（点击回合标签查看）→ 本局牌堆
    cardPool: (fullState.originalDeck || fullState.deck).map((c, i) => {
      const owner = fullState.players.find(p => p.cards.some(pc => pc.id === c.id));
      const dealt = fullState.dealtCardIds ? fullState.dealtCardIds.has(c.id) : (i < fullState.round);
      return {
        id: c.id,
        name: c.name,
        score: c.score,
        effect: c.effect,
        index: i,
        dealt: dealt,       // 已翻开
        acquired: !!owner,
        acquiredBy: owner ? owner.nickname : null,
      };
    }),
    totalDeckSize: (fullState.originalDeck || fullState.deck).length,  // 本局牌堆总数
    // 玩家信息 — 卡牌被获得后即公开
    players: fullState.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      funds: p.funds,
      cardCount: p.cards.length,
      cardScore: calculateCardScore(p.cards),
      isBot: !!p.isBot,
      managed: !!p.managed,  // 托管标识
      // 始终发送完整卡牌信息
      cards: p.cards.map(c => ({ id: c.id, name: c.name, score: c.score, effect: c.effect, used: !!c.used })),
      hasDragonPhoenix: p.cards.some(c => c.id === 'ltsx') && p.cards.some(c => c.id === 'kxqt'),
      hasReroll: hasRerollAbility(p),
      hasDoubleComm: p.cards.some(c => c.id === 'sq'),
      hasUpgrade: p.cards.some(c => c.id === 'dhft' && !c.used),
      isMe: p.id === playerId,
      isHost: !!p.isHost,
    })),
  };

  // 阶段裁剪
  switch (fullState.phase) {
    case 'waiting': {
      base.readyPlayers = fullState.readyPlayers ? [...fullState.readyPlayers] : [];
      break;
    }

    case 'auction': {
      // 暗标制：不公开当前最低价和报价顺序
      base.bids = fullState.players.map(p => {
        const bid = fullState.bids.find(b => b.playerId === p.id);
        return {
          playerId: p.id,
          submitted: !!bid,
          // 只有自己的报价对自己可见
          percentage: (bid && p.id === playerId) ? bid.percentage : null,
        };
      });
      base.bidsCount = fullState.bids.length;
      base.bidsTotal = fullState.players.length;
      base.lastAuctioneerId = fullState.lastAuctioneerId;
      base.deckSize = fullState.deck.length;
      // 方案B: 返回上一轮暗标结果（如果有）
      if (fullState.lastBidResults) base.lastBidResults = fullState.lastBidResults;
      break;
    }

    case 'selectCard': {
      // 方案B: 返回本轮暗标结果
      if (fullState.lastBidResults) base.lastBidResults = fullState.lastBidResults;
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

    case 'rollDice': {
      base.diceSelections = { ...fullState.diceSelections };
      base.diceResults = { ...fullState.diceResults };
      // 掷骰阶段：1分卡仍对非拍卖师隐藏（竞标信息不对称）
      base.revealedCard = fullState.revealedCard
        ? sanitizeRevealedCard(fullState.revealedCard, isAuctioneer)
        : null;
      // P0-3: 平局重掷信息
      if (fullState.tieInfo) base.tieInfo = fullState.tieInfo;
      break;
    }

    case 'settle': {
      base.diceSelections = { ...fullState.diceSelections };
      base.diceResults = { ...fullState.diceResults };
      // 结算阶段：本轮已结束，卡牌信息对所有人完全揭示
      base.revealedCard = fullState.revealedCard
        ? { ...fullState.revealedCard }
        : null;
      // P0-3: 平局重掷信息
      if (fullState.tieInfo) base.tieInfo = fullState.tieInfo;
      // 暗标竞标结果（结算展示用）
      if (fullState.lastBidResults) base.lastBidResults = fullState.lastBidResults;
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

// -------------------- 10b. 观战者视角 --------------------

function getSpectatorView(fullState) {
  const base = {
    roomId: fullState.roomId,
    round: fullState.round,
    maxRounds: fullState.maxRounds,
    phase: fullState.phase,
    auctioneerId: fullState.auctioneerId,
    commissionRate: fullState.commissionRate,
    auctioneerStreak: fullState.auctioneerStreak,
    isSpectator: true,
    // 本局牌堆
    cardPool: (fullState.originalDeck || fullState.deck).map((c, i) => {
      const owner = fullState.players.find(p => p.cards.some(pc => pc.id === c.id));
      const dealt = fullState.dealtCardIds ? fullState.dealtCardIds.has(c.id) : (i < fullState.round);
      return {
        id: c.id, name: c.name, score: c.score, effect: c.effect,
        index: i,
        dealt: dealt,
        acquired: !!owner,
        acquiredBy: owner ? owner.nickname : null,
      };
    }),
    totalDeckSize: (fullState.originalDeck || fullState.deck).length,
    players: fullState.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      funds: p.funds,
      cardCount: p.cards.length,
      cardScore: calculateCardScore(p.cards),
      isBot: !!p.isBot,
      managed: !!p.managed,  // 托管标识
      cards: p.cards.map(c => ({ id: c.id, name: c.name, score: c.score, effect: c.effect, used: !!c.used })),
      hasDragonPhoenix: p.cards.some(c => c.id === 'ltsx') && p.cards.some(c => c.id === 'kxqt'),
      hasReroll: hasRerollAbility(p),
      hasDoubleComm: p.cards.some(c => c.id === 'sq'),
      hasUpgrade: p.cards.some(c => c.id === 'dhft' && !c.used),
      isMe: false,
    })),
  };

  switch (fullState.phase) {
    case 'auction': {
      base.bids = fullState.players.map(p => {
        const bid = fullState.bids.find(b => b.playerId === p.id);
        return { playerId: p.id, submitted: !!bid, percentage: null };
      });
      base.bidsCount = fullState.bids.length;
      base.bidsTotal = fullState.players.length;
      base.lastAuctioneerId = fullState.lastAuctioneerId;
      base.deckSize = fullState.deck.length;
      // 方案B: 返回上一轮暗标结果（如果有）
      if (fullState.lastBidResults) base.lastBidResults = fullState.lastBidResults;
      break;
    }
    case 'selectCard': {
      base.deckSize = fullState.deck.length;
      base.deck = fullState.deck.map((_, i) => ({ index: i, hidden: true }));
      // 方案B: 返回本轮暗标结果
      if (fullState.lastBidResults) base.lastBidResults = fullState.lastBidResults;
      break;
    }
    case 'rentDice': {
      base.diceCosts = { ...DICE_COSTS };
      base.playersDone = fullState.playersDone ? [...fullState.playersDone] : [];
      base.diceSelections = {};
      for (const p of fullState.players) {
        if (p.id === fullState.auctioneerId) {
          base.diceSelections[p.id] = 'auctioneer';
        } else if (fullState.diceSelections.hasOwnProperty(p.id)) {
          base.diceSelections[p.id] = 'selected';
        } else {
          base.diceSelections[p.id] = 'waiting';
        }
      }
      base.revealedCard = fullState.revealedCard
        ? sanitizeRevealedCard(fullState.revealedCard, false)
        : null;
      break;
    }
    case 'rollDice': {
      base.diceSelections = { ...fullState.diceSelections };
      base.diceResults = { ...fullState.diceResults };
      base.revealedCard = fullState.revealedCard
        ? sanitizeRevealedCard(fullState.revealedCard, false)
        : null;
      // P0-3: 平局重掷信息
      if (fullState.tieInfo) base.tieInfo = fullState.tieInfo;
      break;
    }
    case 'settle': {
      base.diceSelections = { ...fullState.diceSelections };
      base.diceResults = { ...fullState.diceResults };
      // 结算阶段：卡牌对所有人（包括观战者）完全揭示
      base.revealedCard = fullState.revealedCard
        ? { ...fullState.revealedCard }
        : null;
      // P0-3: 平局重掷信息
      if (fullState.tieInfo) base.tieInfo = fullState.tieInfo;
      // 暗标竞标结果（结算展示用）
      if (fullState.lastBidResults) base.lastBidResults = fullState.lastBidResults;
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
          diceSelections: {},
          diceResults: { ...fullState.duel.diceResults },
          playersDone: fullState.duel.playersDone ? [...fullState.duel.playersDone] : [],
          winnerId: fullState.duel.winnerId,
          loserId: fullState.duel.loserId,
          done: fullState.duel.done,
        };
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

function getGame(roomId) {
  return games.get(roomId) || null;
}

function destroyGame(roomId) {
  games.delete(roomId);
  console.log(`[引擎] 房间 ${roomId} 游戏数据已清除`);
}

// -------------------- 阶段修复辅助（玩家断连/离开）--------------------

/**
 * auction 阶段：玩家离开后的修复
 */
function _fixAuctionAfterLeave(state, roomId, leftPlayerId) {
  // 暗标制：移除离开玩家的报价
  state.bids = state.bids.filter(b => b.playerId !== leftPlayerId);

  // 如果所有人报价完毕 → 结算
  if (allBidsIn(state)) {
    _settleAuctionAfterAllBids(state, roomId);
    return;
  }

  // 否则重新设置统一倒计时
  setTurnTimer(roomId, TURN_TIMEOUT, 'auction', () => {
    const s = games.get(roomId);
    if (!s || s.phase !== 'auction') return;
    for (const p of s.players) {
      if (!s.bids.some(b => b.playerId === p.id)) {
        s.bids.push({ playerId: p.id, percentage: null });
      }
    }
    _settleAuctionAfterAllBids(s, roomId);
  });
}

/**
 * 所有人报价完毕后的拍卖结算（从 submitBid 提取的公共逻辑）
 */
function _settleAuctionAfterAllBids(state, roomId) {
  const validBids = state.bids.filter(b => b.percentage !== null);

  if (validBids.length === 0) {
    state.lastAuctioneerId = null;
    state.auctioneerId = null;
    state.commissionRate = 0;
    state.auctioneerStreak = 0;

    // 方案B: 保存全员放弃的暗标结果
    state.lastBidResults = {
      bids: state.bids.map(b => ({
        playerId: b.playerId,
        nickname: state.players.find(p => p.id === b.playerId)?.nickname || '?',
        percentage: b.percentage,
        isWinner: false,
      })),
      winnerId: null,
      winnerName: null,
      commissionRate: 0,
      tiedCount: 0,
      tiedNames: null,
      allPass: true,
    };

    const idx = crypto.randomInt(0, state.deck.length);
    state.revealedCard = state.deck[idx];
    state.deck.splice(idx, 1);
    state.dealtCardIds.add(state.revealedCard.id);  // ★ 记录已翻开
    console.log(`[引擎] 全员跳过，无拍卖师，随机翻牌: ${state.revealedCard.name}`);
    state.phase = 'rentDice';
    state.bids = [];
    state.diceSelections = {};
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
    return;
  }

  const minPct = Math.min(...validBids.map(b => b.percentage));
  const minBidders = validBids.filter(b => b.percentage === minPct);

  // 多人报同价 → 随机选一个
  const winner = minBidders.length === 1
    ? minBidders[0]
    : minBidders[crypto.randomInt(0, minBidders.length)];
  const winnerId = winner.playerId;
  const commissionRate = winner.percentage;

  // 方案B: 保存本轮暗标结果（用于公示页展示）
  const tiedNames = minBidders.length > 1
    ? minBidders.map(b => state.players.find(p => p.id === b.playerId)?.nickname).join(', ')
    : null;

  state.lastBidResults = {
    bids: state.bids.map(b => ({
      playerId: b.playerId,
      nickname: state.players.find(p => p.id === b.playerId)?.nickname || '?',
      percentage: b.percentage,
      isWinner: b.playerId === winnerId,
    })),
    winnerId,
    winnerName: state.players.find(p => p.id === winnerId)?.nickname || '?',
    commissionRate,
    tiedCount: minBidders.length,
    tiedNames,
    allPass: false,
  };

  if (minBidders.length > 1) {
    console.log(`[引擎] 暗标同价(${minPct}%)：${tiedNames} → 随机选中 ${state.players.find(p => p.id === winnerId)?.nickname}`);
  }

  if (state.auctioneerId === winnerId) {
    state.auctioneerStreak++;
  } else {
    state.auctioneerStreak = 1;
  }
  state.lastAuctioneerId = winnerId;
  state.auctioneerId = winnerId;
  state.commissionRate = commissionRate;

  const winnerNick = state.players.find(p => p.id === winnerId)?.nickname || '?';
  console.log(`[引擎] 拍卖师产生: ${winnerNick} (${commissionRate}%)`);

  state.phase = 'selectCard';
  state.bids = [];

  // 安全网：selectCard 超时后自动随机选卡（防止 bot 异常或玩家挂机卡死）
  setTurnTimer(roomId, TURN_TIMEOUT, 'selectCard', () => {
    const s = games.get(roomId);
    if (!s || s.phase !== 'selectCard') return;
    const idx = crypto.randomInt(0, s.deck.length);
    console.log(`[引擎] selectCard 超时，拍卖师 ${s.players.find(p => p.id === s.auctioneerId)?.nickname} 自动随机选卡`);
    selectCard(roomId, s.auctioneerId, idx);
  });

  broadcast(roomId);
}

/**
 * selectCard 阶段：拍卖师离开后的修复
 */
function _fixSelectCardAfterLeave(state, roomId, leftPlayerId) {
  if (state.auctioneerId !== leftPlayerId) return;

  state.auctioneerId = null;
  state.commissionRate = 0;
  const idx = crypto.randomInt(0, state.deck.length);
  state.revealedCard = state.deck[idx];
  state.deck.splice(idx, 1);
  state.dealtCardIds.add(state.revealedCard.id);  // ★ 记录已翻开
  console.log(`[引擎] 拍卖师离开，随机翻牌: ${state.revealedCard.name}`);

  state.phase = 'rentDice';
  state.diceSelections = {};

  for (const p of state.players) {
    state.diceSelections[p.id] = 'pass';
  }
  state.phase = 'rollDice';
  _computeAllRolls(state);
  broadcast(roomId);
  setTimeout(() => resolveRoll(roomId), 2000);
}

/**
 * rentDice 阶段：玩家离开后的修复
 */
function _fixRentDiceAfterLeave(state, roomId, leftPlayerId) {
  if (allDiceIn(state)) {
    const allDone = state.players.every(p => {
      if (state.auctioneerId && p.id === state.auctioneerId) return true;
      if (state.diceSelections[p.id] === 'pass') return true;
      return state.playersDone.has(p.id);
    });
    if (allDone) {
      clearTurnTimer(roomId);
      state.phase = 'rollDice';
      _computeAllRolls(state);
      broadcast(roomId);
      setTimeout(() => resolveRoll(roomId), 5000);
    }
  }
}

/**
 * rollDice 阶段：玩家离开后的修复
 */
function _fixRollDiceAfterLeave(state, roomId, leftPlayerId) {
  const allRolled = state.players.every(p => {
    if (p.id === state.auctioneerId) return true;
    if (state.diceSelections[p.id] === 'pass') return true;
    return state.diceResults && state.diceResults.hasOwnProperty(p.id);
  });

  if (allRolled) {
    setTimeout(() => resolveRoll(roomId), 1000);
  }
}

/**
 * duel 阶段：玩家离开后的修复
 */
function _fixDuelAfterLeave(state, roomId, leftPlayerId) {
  if (!state.duel) return;

  const isParticipant = (state.duel.initiatorId === leftPlayerId ||
                         state.duel.targetId === leftPlayerId);
  if (!isParticipant) return;

  console.log(`[引擎] 决斗参与者 ${leftPlayerId} 离开，决斗取消`);
  state.duel.done = true;
  state.duel.winnerId = null;
  state.duel.loserId = leftPlayerId;
  state.phase = 'finished';
  console.log(`[引擎] 房间 ${roomId} 决斗中断，游戏结束`);
  const fr = calculateFinalScores(roomId);
  state.finalResults = fr;
  broadcast(roomId);
}

// -------------------- 玩家断连 / 主动离开（Bot 托管接管）--------------------

/**
 * 玩家断连/离开 → Bot 托管接管（不删除玩家，标记为 managed）
 */
function disconnectPlayer(roomId, playerId) {
  const state = games.get(roomId);
  if (!state) return null;

  const player = state.players.find(p => p.id === playerId);
  if (!player) return null;
  if (player.isBot) {
    // Bot 断连直接移除
    return removePlayer(roomId, playerId);
  }

  // 标记为托管状态
  player.managed = true;
  player._originalNickname = player.nickname;
  player.managedAt = Date.now();

  // 根据剩余活跃真人数量设置托管 Bot 难度（自动档逻辑）
  const activeHumans = state.players.filter(p => !p.isBot && !p.managed);
  const humanCount = activeHumans.length;
  if (humanCount <= 1) {
    player.strategy = 'hard';
  } else if (humanCount === 2) {
    player.strategy = Math.random() < 0.3 ? 'hard' : 'normal';
  } else if (humanCount === 3) {
    player.strategy = 'normal';
  } else {
    player.strategy = Math.random() < 0.3 ? 'normal' : 'easy';
  }

  console.log(`[引擎] 玩家 ${player.nickname}(${playerId}) 断连，Bot 托管接管 → ${player.strategy} (${humanCount}活跃真人)`);

  // 检查真人数量（不计 managed 玩家）
  if (humanCount === 0) {
    state.phase = 'finished';
    console.log(`[引擎] 房间 ${roomId} 无活跃真人玩家，游戏终止`);
    const fr = calculateFinalScores(roomId);
    state.finalResults = fr;
    broadcast(roomId);
    return fr;
  }

  // 如果托管玩家正在等待操作，清除其等待状态让 Bot 接管
  state.playersDone.delete(playerId);
  delete state.diceSelections[playerId];
  state.bids = state.bids.filter(b => b.playerId !== playerId);

  // 如果托管的是拍卖师，保持不变（Bot 会接管操作）
  // 如果托管的是当前操作者，Bot 自动接管

  broadcast(roomId);
  return null;
}

/**
 * 托管玩家主动操作时退出托管模式
 * @returns {object|null} 被取消托管的玩家，或 null
 */
function unmanagePlayer(roomId, playerId) {
  const state = games.get(roomId);
  if (!state) return null;

  const player = state.players.find(p => p.id === playerId);
  if (!player || !player.managed) return null;

  // 恢复真人身份
  player.managed = false;
  player._originalNickname = undefined;
  player.managedAt = undefined;
  player.strategy = undefined; // 清除托管时设置的策略

  console.log(`[引擎] 玩家 ${player.nickname}(${playerId}) 手动操作，退出托管模式`);
  broadcast(roomId);
  return player;
}

/**
 * ★ 玩家点击"托管"按钮 → 标记为 managed，Bot 接管（玩家保持连接）
 * 与 disconnectPlayer 的区别：不清除 bids/diceSelections（玩家可能已提交），
 * 只清除等待状态让 Bot 接管后续决策
 */
function setPlayerManaged(roomId, playerId) {
  const state = games.get(roomId);
  if (!state) return null;

  const player = state.players.find(p => p.id === playerId);
  if (!player || player.isBot || player.managed) return null;

  // 标记为托管状态
  player.managed = true;
  player._originalNickname = player.nickname;
  player.managedAt = Date.now();

  // 根据剩余活跃真人数量设置托管 Bot 难度
  const humanCount = state.players.filter(p => !p.isBot && !p.managed).length;
  if (humanCount <= 1) {
    player.strategy = 'hard';
  } else if (humanCount === 2) {
    player.strategy = Math.random() < 0.3 ? 'hard' : 'normal';
  } else if (humanCount === 3) {
    player.strategy = 'normal';
  } else {
    player.strategy = Math.random() < 0.3 ? 'normal' : 'easy';
  }

  // 清除该玩家的等待状态，让 Bot 接管
  state.playersDone.delete(playerId);
  delete state.diceSelections[playerId];
  state.bids = state.bids.filter(b => b.playerId !== playerId);

  console.log(`[引擎] 玩家 ${player.nickname}(${playerId}) 主动托管 → ${player.strategy} (${humanCount}活跃真人)`);
  broadcast(roomId);
  return player;
}

/**
 * 玩家重新加入，恢复托管身份
 * @returns {{ success: boolean, player?: object, error?: string }}
 */
function reclaimPlayer(socket, roomId, nickname) {
  const state = games.get(roomId);
  if (!state) return { success: false, error: '游戏不存在' };

  // 找到被托管的玩家（按昵称匹配）
  const managedIdx = state.players.findIndex(p => p.managed && p._originalNickname === nickname);
  if (managedIdx === -1) return { success: false, error: '未找到托管中的玩家' };

  const managed = state.players[managedIdx];

  // 恢复
  managed.managed = false;
  managed._originalNickname = undefined;
  managed.managedAt = undefined;

  console.log(`[引擎] 玩家 ${nickname} 恢复托管身份，旧ID: ${managed.id} → 新ID: ${socket.id}`);

  // 注意：不改变 player.id（保持与游戏数据一致），但需要更新 Socket 映射
  // 实际上，游戏逻辑用 playerId 查找玩家，而 playerId = socket.id（初次加入时）
  // 重连后 socket.id 变了，所以需要用旧 ID 继续操作
  // 解决方案：保持 managed.id 不变，客户端通过另一个字段标识自己

  broadcast(roomId);
  return { success: true, player: managed };
}

/**
 * 移除玩家（原有逻辑，仅用于 Bot 移除或房间销毁）
 */
function removePlayer(roomId, playerId) {
  const state = games.get(roomId);
  if (!state) return;

  if (!state.players.some(p => p.id === playerId)) return;

  const phase = state.phase;

  state.players = state.players.filter(p => p.id !== playerId);
  state.bids = state.bids.filter(b => b.playerId !== playerId);
  delete state.diceSelections[playerId];
  delete state.diceResults[playerId];
  if (state._roundExpense) delete state._roundExpense[playerId];
  state.playersDone.delete(playerId);

  if (state.auctioneerId === playerId) {
    state.auctioneerId = state.players.length > 0 ? state.players[0].id : null;
    state.auctioneerStreak = 0;
  }

  // 真人检查：只剩0个真人 → 游戏结束
  const humanCount = state.players.filter(p => !p.isBot).length;
  if (humanCount === 0) {
    state.phase = 'finished';
    console.log(`[引擎] 房间 ${roomId} 无真人玩家，游戏终止`);
    const fr = calculateFinalScores(roomId);
    state.finalResults = fr;
    broadcast(roomId);
    return fr;
  }

  // 按阶段修复游戏流
  clearTurnTimer(roomId);

  if (phase === 'auction') {
    _fixAuctionAfterLeave(state, roomId, playerId);
  } else if (phase === 'selectCard') {
    _fixSelectCardAfterLeave(state, roomId, playerId);
  } else if (phase === 'rentDice') {
    _fixRentDiceAfterLeave(state, roomId, playerId);
  } else if (phase === 'rollDice') {
    _fixRollDiceAfterLeave(state, roomId, playerId);
  } else if (phase === 'duel') {
    _fixDuelAfterLeave(state, roomId, playerId);
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
    player.funds = state._startingFunds || 12;
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
  state.maxRounds = state.maxRounds;  // 保持原模式
  state.phase = 'waiting';
  state.deck = shuffle([...CARDS]).slice(0, state.maxRounds);
  state.originalDeck = [...state.deck];  // ★ 重洗牌堆后重置初始牌堆记录
  state.dealtCardIds = new Set();        // ★ 清空已翻开记录
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
    p.funds = state._startingFunds || 12;
    p.cards = [];
  }

  console.log(`[引擎] 房间 ${roomId} 重新开始！等待房主开始游戏...`);
  broadcast(roomId);
}

// -------------------- 导出 --------------------

module.exports = {
  getModeConfig: (id) => MODE_CONFIGS[id] || MODE_CONFIGS.classic,
  MODE_CONFIGS,
  initGame,
  getPlayerView,          // ★ 导出供 game:start 直接推送
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
  getSpectatorView,
  getGame,
  _markPlayerDone,
  setIO,
  setOnBroadcast,
  destroyGame,
  removePlayer,
  disconnectPlayer,
  setPlayerManaged,
  reclaimPlayer,
  unmanagePlayer,
  restartGame,
  playerRejoin,
};
