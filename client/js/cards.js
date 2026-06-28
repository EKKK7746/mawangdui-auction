// ============================================================
// cards.js — 卡牌视觉元数据（emoji / 颜色 / 图案类型）
// ============================================================

const CARD_VISUALS = {
  // --- 3分·国之重器 ---
  'sxqts': { emoji: '🌳', color: '#8B6914', label: '树', image: 'assets/cards/sxqts.png' },
  'qsbmy': { emoji: '🗿', color: '#8B7355', label: '俑', image: 'assets/cards/qsbmy.png' },
  'qmht':  { emoji: '📜', color: '#2E5C8A', label: '画', image: 'assets/cards/qmht.png' },
  'syfz':  { emoji: '🐏', color: '#B8860B', label: '尊', image: 'assets/cards/syfz.png' },
  // --- 2分·珍品雅器 ---
  'slj':   { emoji: '🪞', color: '#C0C0C0', label: '镜', image: 'assets/cards/slj.png' },
  'jlyy':  { emoji: '💎', color: '#98FB98', label: '玉', image: 'assets/cards/jlyy.png' },
  'ltsx':  { emoji: '🖌️', color: '#2E5C8A', label: '书', image: 'assets/cards/ltsx.png' },
  'zhybz': { emoji: '🔔', color: '#B8860B', label: '钟', image: 'assets/cards/zhybz.png' },
  'yqz':   { emoji: '🍵', color: '#A0D8E8', label: '盏', image: 'assets/cards/yqz.png' },
  'yqh':   { emoji: '🏺', color: '#4682B4', label: '瓷', image: 'assets/cards/yqh.png' },
  'dhmh':  { emoji: '🛡️', color: '#D4A017', label: '壁', image: 'assets/cards/dhmh.png' },
  'rytqy': { emoji: '🫖', color: '#A0D8E8', label: '窑', image: 'assets/cards/rytqy.png' },
  // --- 1分·文明遗珍 ---
  'kxqt':  { emoji: '❄️', color: '#4682B4', label: '帖', image: 'assets/cards/kxqt.png' },
  'jgpx':  { emoji: '🐢', color: '#8B4513', label: '甲', image: 'assets/cards/jgpx.png' },
  'dhft':  { emoji: '🧚', color: '#D4A017', label: '飞', image: 'assets/cards/dhft.png' },
  'sq':    { emoji: '📜', color: '#F5DEB3', label: '券', image: 'assets/cards/sq.png' },
  'sxtc':  { emoji: '🐪', color: '#D2691E', label: '驼', image: 'assets/cards/sxtc.png' },
  'cjgb':  { emoji: '🍷', color: '#DC143C', label: '杯', image: 'assets/cards/cjgb.png' },
  'jofjg': { emoji: '🏆', color: '#FFD700', label: '杯', image: 'assets/cards/jofjg.png' },
  'dhcxb': { emoji: '✒️', color: '#8B4513', label: '笔', image: 'assets/cards/dhcxb.png' },
};

const EFFECT_LABELS = {
  dragonPhoenix:    '【联动·龙凤】',
  rerollDice:       '【联动·重掷】',
  soloReroll:       '【主动·重掷】',
  upgradeDice:      '【主动·飞升】',
  duel:             '【主动·决斗】',
  doubleCommission: '【被动·特权】',
  extraScore:       '【被动·传世】',
  passiveIncome:    '【被动·通商】',
  streakShield:     '【被动·护佑】',
};

const EFFECT_CATEGORIES = {
  dragonPhoenix:    'synergy',
  rerollDice:       'synergy',
  soloReroll:       'active',
  upgradeDice:      'active',
  duel:             'active',
  doubleCommission: 'passive',
  extraScore:       'passive',
  passiveIncome:    'passive',
  streakShield:     'passive',
};

const PHASE_LABELS = {
  auction: '拍卖阶段',
  selectCard: '拍卖师选卡',
  rentDice: '租骰阶段',
  rollDice: '掷骰中',
  settle: '结算',
  duel: '镜中决斗',
  finished: '游戏结束',
};

const CARD_RARITY = {
  // 3分卡 → 传说
  'sxqts': 'legendary', 'qsbmy': 'legendary', 'qmht': 'legendary', 'syfz': 'legendary',
  // 2分卡 → 珍品
  'slj': 'rare', 'jlyy': 'rare', 'ltsx': 'rare', 'zhybz': 'rare',
  'yqz': 'rare', 'yqh': 'rare', 'dhmh': 'rare', 'rytqy': 'rare',
  // 1分卡 → 普通
  'kxqt': 'common', 'jgpx': 'common', 'dhft': 'common', 'sq': 'common',
  'sxtc': 'common', 'cjgb': 'common', 'jofjg': 'common', 'dhcxb': 'common',
};

function getCardRarity(cardId) {
  return CARD_RARITY[cardId] || 'common';
}

function getCardVisual(cardId) {
  return CARD_VISUALS[cardId] || { emoji: '❓', color: '#CCCCCC', label: '?' };
}

function getEffectLabel(effect) {
  return effect ? (EFFECT_LABELS[effect] || effect) : '';
}

// 返回卡牌图片 HTML（统一尺寸，加载失败回退 emoji）
function getCardImageHtml(cardId, sizeClass) {
  const vis = getCardVisual(cardId);
  const cls = sizeClass || 'card-img-md';
  if (vis.image) {
    return `<img class="card-image ${cls}" src="${vis.image}" alt="${vis.emoji} ${cardId}" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span class=\\'card-emoji-fallback\\'>${vis.emoji}</span>')" />`;
  }
  return `<span class="card-emoji-fallback">${vis.emoji}</span>`;
}
