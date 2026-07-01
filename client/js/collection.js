// ============================================================
// collection.js — 收集系统数据层（localStorage CRUD）
// 说文物品收集、对局统计、成就解锁、皮肤装备
// ============================================================

const COLLECTION_KEY = 'mwCollection';

// 10 张文物卡牌定义（与 server/gameEngine.js CARDS 对应）
const ARTIFACT_IDS = [
  'sxqts','qsbmy','qmht','syfz','slj',
  'jlyy','ltsx','zhybz','yqz','yqh',
  'dhmh','rytqy','kxqt','jgpx','dhft',
  'sq','sxtc','cjgb','jofjg','dhcxb'
];

// ==================== 成就定义 ====================
const ACHIEVEMENTS = {
  first_win:       { id:'first_win',       name:'初出茅庐',   desc:'赢得第1局游戏',             icon:'🏆', reward:{ type:'avatarFrame', id:'frame_bronze' } },
  collector_5:     { id:'collector_5',     name:'小有收藏',   desc:'收集5种不同文物',           icon:'📦', reward:{ type:'avatarFrame', id:'frame_silver' } },
  collector_10:    { id:'collector_10',    name:'收藏大家',   desc:'收集10种不同文物',          icon:'🏛️', reward:{ type:'avatarFrame', id:'frame_gold' } },
  collector_all:   { id:'collector_all',   name:'博物君子',   desc:'集齐全部20种文物',          icon:'👑', reward:{ type:'diceEffect', id:'dice_golden' } },
  auctioneer_5:    { id:'auctioneer_5',    name:'拍卖行家',   desc:'担任拍卖师5次',             icon:'🔨', reward:{ type:'avatar',     id:'avatar_auctioneer' } },
  rich_50:         { id:'rich_50',         name:'富可敌国',   desc:'一局游戏结束时拥有50+金币',   icon:'💰', reward:{ type:'avatar',     id:'avatar_merchant' } },
  win_3_streak:    { id:'win_3_streak',    name:'连战连捷',   desc:'连续3局获胜',               icon:'🔥', reward:{ type:'diceEffect', id:'dice_inferno' } },
  play_10_games:   { id:'play_10_games',   name:'身经百战',   desc:'参与10局游戏',              icon:'⚔️', reward:{ type:'avatar',     id:'avatar_veteran' } },
  d4_winner:       { id:'d4_winner',       name:'以小博大',   desc:'用d4骰子赢得一次决斗',       icon:'🎲', reward:{ type:'diceEffect', id:'dice_lucky' } },
  high_score_20:   { id:'high_score_20',   name:'高分猎手',   desc:'单局最终分达到20分',         icon:'⭐', reward:{ type:'avatar',     id:'avatar_star' } },
};

// ==================== 皮肤定义 ====================
const SKINS = {
  avatar: {
    'default':           { name:'默认',        gradient:'linear-gradient(135deg, #8B7B6B, #6B5B4B)' },
    'avatar_auctioneer': { name:'拍卖师',      gradient:'linear-gradient(135deg, #D4AF37, #8B6914)' },
    'avatar_merchant':   { name:'金主',        gradient:'linear-gradient(135deg, #FFD700, #FF6B00)' },
    'avatar_veteran':    { name:'老兵',        gradient:'linear-gradient(135deg, #4A90D9, #1A3A5C)' },
    'avatar_star':       { name:'明星玩家',    gradient:'linear-gradient(135deg, #FF6B9D, #C44569)' },
  },
  avatarFrame: {
    'default':      { name:'默认',    css:'' },
    'frame_bronze': { name:'青铜框',  css:'box-shadow: 0 0 0 3px #CD7F32, 0 0 8px rgba(205,127,50,0.5);' },
    'frame_silver': { name:'白银框',  css:'box-shadow: 0 0 0 3px #C0C0C0, 0 0 10px rgba(192,192,192,0.6);' },
    'frame_gold':   { name:'黄金框',  css:'box-shadow: 0 0 0 3px #FFD700, 0 0 12px rgba(255,215,0,0.7);' },
  },
  diceEffect: {
    'default':      { name:'默认·漆器金',   primary:'#d4a84b', secondary:'#B85C3A', accent:'#F0D78C', particleCount:280 },
    'dice_golden':  { name:'流光溢彩',      primary:'#FFD700', secondary:'#FFA500', accent:'#FFF8DC', particleCount:350 },
    'dice_inferno': { name:'烈焰燎原',      primary:'#FF4500', secondary:'#8B0000', accent:'#FFD700', particleCount:320 },
    'dice_lucky':   { name:'四叶幸运',      primary:'#00CC66', secondary:'#006633', accent:'#AAFFCC', particleCount:260 },
  }
};

// ==================== 默认数据结构 ====================
function _defaultCollection() {
  return {
    artifacts: {},      // { cardId: { count: N, firstWon: timestamp } }
    stats: {
      totalGames: 0,
      totalWins: 0,
      totalCardsWon: 0,
      totalFundsEarned: 0,
      bestScore: 0,
      bestRank: 999,
      winStreak: 0,
      bestWinStreak: 0,
      totalAuctioneerRounds: 0,
    },
    achievements: {},   // { achievementId: { unlockedAt: timestamp } }
    equippedSkin: {
      avatar: 'default',
      avatarFrame: 'default',
      diceEffect: 'default',
    },
  };
}

// ==================== 基础读写 ====================
function _loadCollection() {
  try {
    const raw = localStorage.getItem(COLLECTION_KEY);
    if (!raw) return _defaultCollection();
    const data = JSON.parse(raw);
    // 深度合并，防止新增字段缺失
    return _deepMerge(_defaultCollection(), data);
  } catch (e) {
    console.warn('[Collection] 数据损坏，重置', e);
    return _defaultCollection();
  }
}

function _saveCollection(data) {
  try {
    localStorage.setItem(COLLECTION_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('[Collection] 保存失败', e);
  }
}

function _deepMerge(defaults, data) {
  const result = { ...defaults };
  for (const key of Object.keys(data)) {
    if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
      result[key] = _deepMerge(defaults[key], data[key] || {});
    } else {
      result[key] = data[key];
    }
  }
  return result;
}

// ==================== 公共 API ====================

/** 获取完整收集数据 */
function getCollection() {
  return _loadCollection();
}

/** 重置收集数据 */
function resetCollection() {
  _saveCollection(_defaultCollection());
}

/** 游戏结束后更新收集数据 */
function updateAfterGame(view, myPlayerId) {
  if (!view || view.phase !== 'finished') return null;

  const data = _loadCollection();
  const results = view.finalResults || [];
  const me = results.find(r => r.id === myPlayerId);
  if (!me) return null;

  // 统计
  data.stats.totalGames++;
  data.stats.totalCardsWon += (me.cards || []).length;
  data.stats.bestScore = Math.max(data.stats.bestScore, me.adjustedScore || 0);
  data.stats.bestRank = Math.min(data.stats.bestRank, me.rank || 999);

  if (me.rank === 1) {
    data.stats.totalWins++;
    data.stats.winStreak++;
    data.stats.bestWinStreak = Math.max(data.stats.bestWinStreak, data.stats.winStreak);
  } else {
    data.stats.winStreak = 0;
  }

  // 文物收集
  if (me.cards) {
    for (const card of me.cards) {
      if (!data.artifacts[card.id]) {
        data.artifacts[card.id] = { count: 0, firstWon: Date.now() };
      }
      data.artifacts[card.id].count++;
    }
  }

  // 成就检查
  const newAchievements = _checkAchievements(data, me, view);

  _saveCollection(data);
  return newAchievements.length > 0 ? newAchievements : null;
}

function _checkAchievements(data, me, view) {
  const newAch = [];
  const ach = data.achievements;

  // first_win
  if (!ach.first_win && data.stats.totalWins >= 1) {
    ach.first_win = { unlockedAt: Date.now() };
    newAch.push('first_win');
  }

  // collector_5 / collector_10 / collector_all
  const uniqueCards = Object.keys(data.artifacts).length;
  if (!ach.collector_5 && uniqueCards >= 5) {
    ach.collector_5 = { unlockedAt: Date.now() };
    newAch.push('collector_5');
  }
  if (!ach.collector_10 && uniqueCards >= 10) {
    ach.collector_10 = { unlockedAt: Date.now() };
    newAch.push('collector_10');
  }
  if (!ach.collector_all && uniqueCards >= 20) {
    ach.collector_all = { unlockedAt: Date.now() };
    newAch.push('collector_all');
  }

  // auctioneer_5
  if (!ach.auctioneer_5 && (data.stats.totalAuctioneerRounds || 0) >= 5) {
    ach.auctioneer_5 = { unlockedAt: Date.now() };
    newAch.push('auctioneer_5');
  }

  // rich_50
  if (!ach.rich_50 && (me.funds || 0) >= 50) {
    ach.rich_50 = { unlockedAt: Date.now() };
    newAch.push('rich_50');
  }

  // win_3_streak
  if (!ach.win_3_streak && data.stats.bestWinStreak >= 3) {
    ach.win_3_streak = { unlockedAt: Date.now() };
    newAch.push('win_3_streak');
  }

  // play_10_games
  if (!ach.play_10_games && data.stats.totalGames >= 10) {
    ach.play_10_games = { unlockedAt: Date.now() };
    newAch.push('play_10_games');
  }

  // d4_winner — 需要外部钩子设置 stats._lastDuelWinType = 'd4'
  if (!ach.d4_winner && data.stats._lastDuelWinType === 'd4') {
    ach.d4_winner = { unlockedAt: Date.now() };
    newAch.push('d4_winner');
  }

  // high_score_20
  if (!ach.high_score_20 && (me.adjustedScore || 0) >= 20) {
    ach.high_score_20 = { unlockedAt: Date.now() };
    newAch.push('high_score_20');
  }

  return newAch;
}

/** 标记最近一次决斗使用的骰子类型（用于 d4_winner 成就） */
function recordDuelDice(diceType, won) {
  if (!won) return;
  const data = _loadCollection();
  data.stats._lastDuelWinType = diceType;
  _saveCollection(data);
}

/** 记录拍卖师轮次 */
function recordAuctioneerRound() {
  const data = _loadCollection();
  data.stats.totalAuctioneerRounds = (data.stats.totalAuctioneerRounds || 0) + 1;
  _saveCollection(data);
}

/** 装备皮肤 */
function equipSkin(type, skinId) {
  const validTypes = ['avatar', 'avatarFrame', 'diceEffect'];
  if (!validTypes.includes(type)) return false;
  if (!SKINS[type][skinId]) return false;
  const data = _loadCollection();
  data.equippedSkin[type] = skinId;
  _saveCollection(data);
  return true;
}

/** 获取当前装备的皮肤 */
function getEquippedSkin(type) {
  const data = _loadCollection();
  return data.equippedSkin[type] || 'default';
}

/** 获取皮肤详情 */
function getSkinInfo(type, skinId) {
  return SKINS[type] && SKINS[type][skinId] ? SKINS[type][skinId] : SKINS[type].default;
}

/** 获取所有可用的皮肤列表（含解锁状态） */
function getSkinCatalog() {
  const data = _loadCollection();
  const catalog = { avatar: [], avatarFrame: [], diceEffect: [] };
  for (const type of Object.keys(SKINS)) {
    for (const [id, skin] of Object.entries(SKINS[type])) {
      const unlocked = id === 'default' || _isSkinUnlocked(data, id);
      catalog[type].push({ id, ...skin, unlocked, equipped: data.equippedSkin[type] === id });
    }
  }
  return catalog;
}

function _isSkinUnlocked(data, skinId) {
  // 皮肤通过成就解锁
  for (const ach of Object.values(ACHIEVEMENTS)) {
    if (ach.reward && ach.reward.id === skinId && data.achievements[ach.id]) {
      return true;
    }
  }
  return false;
}

/** 应用当前装备的骰子皮肤到 diceParticles */
function applyDiceSkin() {
  const skinId = getEquippedSkin('diceEffect');
  if (skinId === 'default') return; // 使用默认配置
  const skin = getSkinInfo('diceEffect', skinId);
  if (skin && typeof window.setDiceSkin === 'function') {
    window.setDiceSkin(skin.primary, skin.secondary, skin.accent, skin.particleCount);
  }
}

/** 应用当前装备的头像框样式到 DOM 元素 */
function applyAvatarSkin(el) {
  if (!el) return;
  const frameId = getEquippedSkin('avatarFrame');
  const avatarId = getEquippedSkin('avatar');
  // 头像底色
  if (avatarId !== 'default') {
    const avatarSkin = getSkinInfo('avatar', avatarId);
    if (avatarSkin && avatarSkin.gradient) {
      el.style.background = avatarSkin.gradient;
    }
  }
  // 头像框
  if (frameId !== 'default') {
    const frameSkin = getSkinInfo('avatarFrame', frameId);
    if (frameSkin && frameSkin.css) {
      el.style.cssText += ';' + frameSkin.css;
    }
  }
}
