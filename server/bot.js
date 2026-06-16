// ============================================================
// bot.js — AI 机器人决策逻辑 + BotManager 调度器
// ============================================================

const BOT_NAMES = [
  '辛追夫人', '利苍侯爷', '轪侯家臣', '长沙丞相', '汉墓守灵',
  '马王守将', '轪侯少主', '湘江渔翁', '长沙令尹', '太仓令史',
  '帛书官', '铜器匠',
];
const BOT_STRATEGIES = ['greedy', 'frugal'];

// 全局计数器，用于生成唯一编号
let _botCounter = 0;

// -------------------- 工具函数 --------------------

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randDelay() {
  return rand(800, 2000);
}

// -------------------- BotManager --------------------

class BotManager {
  constructor(io, gameEngine) {
    this._io = io;
    this._engine = gameEngine;
    this._timers = {}; // roomId -> { [playerId]: timerId }
  }

  // 在 game_state_update 广播后调用
  processBots(roomId) {
    const state = this._engine.getGame(roomId);
    if (!state || state.phase === 'finished') return;

    const bots = state.players.filter(p => p.isBot);
    if (bots.length === 0) return;

    for (const bot of bots) {
      this.scheduleBot(roomId, bot, state);
    }
  }

  scheduleBot(roomId, player, state) {
    // 防止重复调度
    this._cancelTimer(roomId, player.id);

    // 检查该 bot 是否需要行动
    const action = this._getAction(player.id, state);
    if (!action) return;

    const delay = randDelay();
    const timerId = setTimeout(() => {
      // 重新获取最新状态（可能已被其他 bot 改变）
      const currentState = this._engine.getGame(roomId);
      if (!currentState || currentState.phase === 'finished') {
        this._clearTimers(roomId, player.id);
        return;
      }

      // 重新校验行动是否仍有效（防止过期操作）
      const currentAction = this._getAction(player.id, currentState);
      if (!currentAction) {
        this._clearTimers(roomId, player.id);
        return;
      }

      // 执行操作
      const result = currentAction.fn(roomId, player.id, currentState);
      if (result && result.error) {
        console.log(`[Bot] ${player.nickname} 操作失败: ${result.error}`);
      }

      // ★ C1 修复：不再 _clearTimers！
      // action.fn() 内部的 broadcast → processBots 已经重新调度了本 bot，
      // 此处调用 _clearTimers 会误删 processBots 刚设的新定时器。
      // 旧定时器已到期，自动 GC。下次 processBots 的 _cancelTimer 会清理残留。
    }, delay);

    this._ensureRoom(roomId);
    this._timers[roomId][player.id] = timerId;
    console.log(`[Bot] ${player.nickname} 将在 ${delay}ms 后行动 (${action.label})`);
  }

  removeBot(roomId, botId) {
    this._cancelTimer(roomId, botId);
    this._clearTimers(roomId, botId);
    console.log(`[Bot] 移除 Bot ${botId} 从房间 ${roomId}`);
  }

  cancelRoom(roomId) {
    if (!this._timers[roomId]) return;
    for (const pid of Object.keys(this._timers[roomId])) {
      clearTimeout(this._timers[roomId][pid]);
    }
    delete this._timers[roomId];
    console.log(`[Bot] 房间 ${roomId} 所有定时器已清除`);
  }

  _cancelTimer(roomId, playerId) {
    if (this._timers[roomId] && this._timers[roomId][playerId]) {
      clearTimeout(this._timers[roomId][playerId]);
      delete this._timers[roomId][playerId];
    }
  }

  _clearTimers(roomId, playerId) {
    if (this._timers[roomId]) {
      delete this._timers[roomId][playerId];
      if (Object.keys(this._timers[roomId]).length === 0) {
        delete this._timers[roomId];
      }
    }
  }

  _ensureRoom(roomId) {
    if (!this._timers[roomId]) this._timers[roomId] = {};
  }

  // 判断该 bot 当前是否需要行动
  _getAction(playerId, state) {
    const hasActed = this._hasPlayerActed(playerId, state);

    switch (state.phase) {
      case 'auction': {
        if (hasActed) return null;
        // 只在自己回合时行动
        const currentBidder = state.biddingOrder && state.biddingOrder[state.currentBidderIdx];
        if (currentBidder !== playerId) return null;
        return { label: '竞标', fn: (rid, pid, s) => {
          const bid = bidStrategy(pid, s);
          return this._engine.submitBid(rid, pid, bid);
        }};
      }

      case 'selectCard': {
        if (state.auctioneerId !== playerId) return null;
        return { label: '选卡', fn: (rid, pid, s) => {
          const idx = selectCardStrategy(pid, s);
          return this._engine.selectCard(rid, pid, idx);
        }};
      }

      case 'rentDice': {
        if (state.auctioneerId === playerId) return null;
        if (hasActed) return null;
        return { label: '选骰子', fn: (rid, pid, s) => {
          const type = selectDiceStrategy(pid, s);
          return this._engine.selectDice(rid, pid, type);
        }};
      }

      case 'rollDice':
        // roll 已自动 resolve，无需 bot 操作
        return null;

      case 'duel': {
        if (!state.duel) return null;

        // --- Bot 是发起者 ---

        // 步骤1：选择对手
        if (state.duel.step === 'select_target' && playerId === state.duel.initiatorId) {
          return { label: '决斗选目标', fn: (rid, pid, s) => {
            const target = duelSelectTargetStrategy(pid, s);
            if (!target) return { error: '无合适决斗目标' };
            return this._engine.duelSelectTargetById(rid, pid, target);
          }};
        }

        // 步骤2：选择争夺卡牌
        if (state.duel.step === 'select_card' && playerId === state.duel.initiatorId) {
          return { label: '决斗选卡', fn: (rid, pid, s) => {
            const cardId = duelSelectCardStrategy(pid, s);
            return this._engine.duelSelectCardById(rid, pid, cardId);
          }};
        }

        // --- Bot 是参与者（发起者或目标都需要选骰子）---

        if (state.duel.step === 'rent_dice') {
          const isParticipant = playerId === state.duel.initiatorId || playerId === state.duel.targetId;
          if (!isParticipant) return null;

          if (state.duel.diceSelections.hasOwnProperty(playerId)) return null;

          return { label: '决斗选骰子', fn: (rid, pid, s) => {
            const type = duelDiceStrategy(pid, s);
            return this._engine.duelRentDiceById(rid, pid, type, false);
          }};
        }

        // roll_dice / resolve 阶段自动结算，Bot 无需操作
        return null;
      }

      case 'settle': {
        const p = state.players.find(p => p.id === playerId);
        const isAuctioneer = state.auctioneerId === playerId;
        const isHost = p && p.isHost;
        if (isHost || isAuctioneer) {
          return { label: '结束回合', fn: (rid) => this._engine.endRound(rid) };
        }
        return null;
      }

      default: return null;
    }
  }

  _hasPlayerActed(playerId, state) {
    if (state.phase === 'auction') {
      return state.bids.some(b => b.playerId === playerId);
    }
    if (state.phase === 'rentDice') {
      return state.diceSelections.hasOwnProperty(playerId);
    }
    return false;
  }
}

// -------------------- 竞标策略 --------------------

function bidStrategy(playerId, state) {
  const p = state.players.find(p => p.id === playerId);
  if (!p) return null;

  const strategy = p.strategy || 'greedy';
  const streak = state.auctioneerStreak || 0;

  // 连任惩罚高 → pass
  if (streak >= 2) return null;

  // 资金不足 → pass
  if (p.funds <= 3) return null;

  // ★ 核心修复：检查当前已有报价
  const validBids = state.bids.filter(b => b.percentage !== null);
  const currentMin = validBids.length > 0
    ? Math.min(...validBids.map(b => b.percentage))
    : null;

  // 已有人报 10%（最低）→ 无法更低 → pass
  if (currentMin === 10) return null;

  // 可选报价：严格低于 currentMin 的合法佣金值
  const VALID_COMMISSIONS = [10, 20, 30, 40, 50];
  const options = currentMin === null
    ? VALID_COMMISSIONS
    : VALID_COMMISSIONS.filter(v => v < currentMin);

  if (options.length === 0) return null;

  if (strategy === 'greedy') {
    // greedy：想当拍卖师，报价尽量低以赢
    // 但加随机性：70% 报最低可选项，30% 报次低
    const sorted = [...options].sort((a, b) => a - b);
    const pick = Math.random() < 0.7
      ? sorted[0]                                    // 报最低
      : sorted[Math.min(1, sorted.length - 1)];      // 次低（或最低如果只有一个选项）
    return pick;
  }

  if (strategy === 'frugal') {
    // frugal：更保守，连任 1 次就 pass
    if (streak >= 1) return null;

    // 60% pass（不想当拍卖师），40% 报价
    if (Math.random() < 0.6) return null;

    // 报最低可选项（当拍卖师拿佣金也是好事）
    return Math.min(...options);
  }

  return null;
}

// -------------------- 选卡策略（简化版）--------------------

function selectCardStrategy(playerId, state) {
  const p = state.players.find(p => p.id === playerId);
  const deck = state.deck;
  if (!deck || deck.length === 0) return 0;

  const strategy = p && p.strategy ? p.strategy : 'greedy';

  if (strategy === 'greedy') {
    // 按分值降序找第一张最高分卡
    let bestIdx = 0;
    let bestScore = deck[0].score || 0;
    for (let i = 1; i < deck.length; i++) {
      if ((deck[i].score || 0) > bestScore) {
        bestScore = deck[i].score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  if (strategy === 'frugal') {
    // 随机选
    return rand(0, deck.length - 1);
  }

  return 0;
}

// -------------------- 租骰策略（简化版）--------------------

function selectDiceStrategy(playerId, state) {
  const p = state.players.find(p => p.id === playerId);
  if (!p) return 'pass';

  const strategy = p.strategy || 'greedy';
  const card = state.revealedCard;
  const score = card ? (card.score || 1) : 1;
  const funds = p.funds;

  if (strategy === 'greedy') {
    if (score >= 3) {
      if (funds >= 6) return 'd20';
      if (funds >= 4) return 'd12';
      if (funds >= 2) return 'd6';
      if (funds >= 1) return 'd4';
      return 'pass';
    }
    if (score === 2) {
      if (funds >= 4) return 'd12';
      if (funds >= 2) return 'd6';
      if (funds >= 1) return 'd4';
      return 'pass';
    }
    // score = 1 → 70% pass，30% d4
    return Math.random() < 0.7 ? 'pass' : (funds >= 1 ? 'd4' : 'pass');
  }

  if (strategy === 'frugal') {
    if (funds <= 3) return 'pass';
    if (funds >= 8) return Math.random() < 0.5 ? 'd6' : 'd12';
    return 'd6';
  }

  return 'pass';
}

// -------------------- 决斗：选目标策略 --------------------

function duelSelectTargetStrategy(playerId, state) {
  if (!state.duel) return null;

  let bestTargetId = null;
  let bestCardScore = 0;

  for (const p of state.players) {
    if (p.id === playerId || p.cards.length === 0) continue;
    for (const c of p.cards) {
      if (c.score > bestCardScore) {
        bestCardScore = c.score;
        bestTargetId = p.id;
      }
    }
  }

  return bestTargetId;
}

// -------------------- 决斗：选卡策略 --------------------

function duelSelectCardStrategy(playerId, state) {
  if (!state.duel || !state.duel.targetId) return null;

  const target = state.players.find(p => p.id === state.duel.targetId);
  if (!target || target.cards.length === 0) return null;

  let bestCardId = target.cards[0].id;
  let bestScore = target.cards[0].score;
  for (const c of target.cards) {
    if (c.score > bestScore) {
      bestScore = c.score;
      bestCardId = c.id;
    }
  }
  return bestCardId;
}

// -------------------- 决斗：选骰策略 --------------------

function duelDiceStrategy(playerId, state) {
  const p = state.players.find(p => p.id === playerId);
  if (!p) return 'pass';

  const score = state.duel ? (state.duel.targetCardScore || 2) : 2;
  const funds = p.funds;

  if (funds >= 6 && score >= 3) return 'd20';
  if (funds >= 4) return 'd12';
  if (funds >= 2) return 'd6';
  if (funds >= 1) return 'd4';
  return 'pass';
}

// -------------------- 创建 Bot 玩家 --------------------

function createBotPlayer(existingNicknames) {
  existingNicknames = existingNicknames || [];

  // 基础名：从未被使用的名字中随机选
  const available = BOT_NAMES.filter(n => !existingNicknames.includes(n));
  const baseName = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];

  // 生成编号（两位数，01-99 循环）
  _botCounter = (_botCounter % 99) + 1;
  const num = String(_botCounter).padStart(2, '0');
  const nickname = `${baseName}${num}`;

  const strategy = BOT_STRATEGIES[rand(0, BOT_STRATEGIES.length - 1)];
  return {
    id: 'bot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    nickname,
    isBot: true,
    strategy, // 'greedy' 或 'frugal'
  };
}

// -------------------- 导出 --------------------

module.exports = { BotManager, createBotPlayer };
