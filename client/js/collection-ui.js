// ============================================================
// collection-ui.js — 收藏馆页面渲染（文物图鉴/统计/成就/外观）
// 依赖: collection.js, game/data.js (CARD_NAMES, CARD_LORE)
// ============================================================

let _currentTab = 'artifacts';

function switchCollectionTab(tab) {
  _currentTab = tab;
  document.querySelectorAll('.collection-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  renderCollection();
}

function renderCollection() {
  const container = document.getElementById('collectionContent');
  if (!container) return;

  switch (_currentTab) {
    case 'artifacts':    _renderArtifactsTab(container); break;
    case 'stats':        _renderStatsTab(container); break;
    case 'achievements': _renderAchievementsTab(container); break;
    case 'skins':        _renderSkinsTab(container); break;
    default:             _renderArtifactsTab(container);
  }
}

// ==================== 文物图鉴 ====================
function _renderArtifactsTab(container) {
  const data = getCollection();
  const collected = data.artifacts;
  const uniqueCount = Object.keys(collected).length;

  let cardsHtml = '';
  for (const cardId of ARTIFACT_IDS) {
    const card = collected[cardId];
    const name = (typeof CARD_NAMES !== 'undefined' && CARD_NAMES[cardId]) ? CARD_NAMES[cardId] : cardId;
    const lore = (typeof CARD_LORE !== 'undefined' && CARD_LORE[cardId])
      ? CARD_LORE[cardId].substring(0, 60) + '...'
      : '神秘的古代文物...';
    const collectedClass = card ? 'collected' : 'uncollected';
    const countBadge = card ? `<span class="artifact-count">×${card.count}</span>` : '';
    const overlay = !card ? '<div class="artifact-lock">?</div>' : '';

    cardsHtml += `
      <div class="artifact-card ${collectedClass}">
        ${overlay}
        <div class="artifact-icon">${card ? '🏺' : '🔒'}</div>
        <div class="artifact-name">${name}</div>
        <div class="artifact-lore">${card ? lore : '尚未获得'}</div>
        ${countBadge}
      </div>`;
  }

  container.innerHTML = `
    <div class="collect-summary">
      已收集 <strong>${uniqueCount}</strong> / ${ARTIFACT_IDS.length} 种文物
      <div class="collect-progress-bar">
        <div class="collect-progress-fill" style="width:${(uniqueCount / ARTIFACT_IDS.length) * 100}%"></div>
      </div>
    </div>
    <div class="artifact-grid">${cardsHtml}</div>
  `;
}

// ==================== 对局统计 ====================
function _renderStatsTab(container) {
  const data = getCollection();
  const s = data.stats;
  const games = s.totalGames || 0;
  const winRate = games > 0 ? Math.round((s.totalWins / games) * 100) : 0;

  const stats = [
    { icon:'🎮', label:'参与局数', value: games },
    { icon:'🏆', label:'获胜局数', value: s.totalWins },
    { icon:'📈', label:'胜率', value: winRate + '%' },
    { icon:'📜', label:'收集卡牌', value: s.totalCardsWon },
    { icon:'⭐', label:'最佳分数', value: s.bestScore },
    { icon:'👑', label:'最佳排名', value: s.bestRank < 999 ? '第' + s.bestRank + '名' : '—' },
    { icon:'🔥', label:'最长连胜', value: s.bestWinStreak },
    { icon:'🔨', label:'拍卖师轮次', value: s.totalAuctioneerRounds || 0 },
  ];

  const statsHtml = stats.map(stat => `
    <div class="stat-card">
      <div class="stat-icon">${stat.icon}</div>
      <div class="stat-value">${stat.value}</div>
      <div class="stat-label">${stat.label}</div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="stats-grid">${statsHtml}</div>
    ${games === 0 ? '<div class="collect-empty">还没有对局记录，快去玩一局吧！</div>' : ''}
  `;
}

// ==================== 成就 ====================
function _renderAchievementsTab(container) {
  const data = getCollection();
  const ach = data.achievements;

  let achHtml = '';
  for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
    const unlocked = !!ach[id];
    const progress = _getAchievementProgress(id, data);
    const pct = Math.min(100, progress.pct);

    achHtml += `
      <div class="ach-card ${unlocked ? 'unlocked' : 'locked'}">
        <div class="ach-icon">${def.icon}</div>
        <div class="ach-info">
          <div class="ach-name">${def.name}</div>
          <div class="ach-desc">${def.desc}</div>
          <div class="ach-reward">🎁 解锁：${_getRewardName(def.reward)}</div>
        </div>
        <div class="ach-status">
          ${unlocked
            ? '<span class="ach-badge done">✓ 已解锁</span>'
            : `<span class="ach-progress">${progress.current}/${progress.total}</span>`
          }
        </div>
      </div>
      ${!unlocked ? `<div class="ach-progress-bar"><div class="ach-progress-fill" style="width:${pct}%"></div></div>` : ''}
    `;
  }

  container.innerHTML = `<div class="ach-list">${achHtml}</div>`;
}

function _getAchievementProgress(achId, data) {
  const s = data.stats;
  switch (achId) {
    case 'first_win':       return { current: Math.min(1, s.totalWins), total: 1, pct: s.totalWins >= 1 ? 100 : 0 };
    case 'collector_5':     return { current: Math.min(5, Object.keys(data.artifacts).length), total: 5, pct: (Object.keys(data.artifacts).length / 5) * 100 };
    case 'collector_10':    return { current: Math.min(10, Object.keys(data.artifacts).length), total: 10, pct: (Object.keys(data.artifacts).length / 10) * 100 };
    case 'collector_all':   return { current: Math.min(20, Object.keys(data.artifacts).length), total: 20, pct: (Object.keys(data.artifacts).length / 20) * 100 };
    case 'auctioneer_5':    return { current: Math.min(5, s.totalAuctioneerRounds || 0), total: 5, pct: ((s.totalAuctioneerRounds || 0) / 5) * 100 };
    case 'rich_50':         return { current: 0, total: 1, pct: 0 }; // 单局条件，不追踪进度
    case 'win_3_streak':    return { current: Math.min(3, s.bestWinStreak), total: 3, pct: (s.bestWinStreak / 3) * 100 };
    case 'play_10_games':   return { current: Math.min(10, s.totalGames), total: 10, pct: (s.totalGames / 10) * 100 };
    case 'd4_winner':       return { current: 0, total: 1, pct: 0 };
    case 'high_score_20':   return { current: Math.min(20, s.bestScore), total: 20, pct: (s.bestScore / 20) * 100 };
    default:                return { current: 0, total: 1, pct: 0 };
  }
}

function _getRewardName(reward) {
  if (!reward) return '无';
  const skin = SKINS[reward.type] && SKINS[reward.type][reward.id];
  return skin ? skin.name : reward.id;
}

// ==================== 外观皮肤 ====================
function _renderSkinsTab(container) {
  const catalog = getSkinCatalog();
  const equipped = _loadCollection().equippedSkin;

  let html = '';

  // 头像皮肤
  html += '<div class="skin-section"><h3 class="skin-section-title">🟢 头像底纹</h3><div class="skin-grid">';
  for (const skin of catalog.avatar) {
    const isEq = equipped.avatar === skin.id;
    html += `
      <div class="skin-card ${skin.unlocked ? '' : 'locked'} ${isEq ? 'equipped' : ''}"
        onclick="${skin.unlocked ? `equipSkin('avatar','${skin.id}');renderCollection();` : ''}">
        <div class="skin-preview avatar-preview" style="background:${skin.gradient}"></div>
        <div class="skin-name">${skin.name}</div>
        ${isEq ? '<span class="skin-badge">使用中</span>' : skin.unlocked ? '<span class="skin-badge equip">点击装备</span>' : '<span class="skin-badge lock">🔒</span>'}
      </div>`;
  }
  html += '</div></div>';

  // 头像框
  html += '<div class="skin-section"><h3 class="skin-section-title">🟡 头像框</h3><div class="skin-grid">';
  for (const skin of catalog.avatarFrame) {
    const isEq = equipped.avatarFrame === skin.id;
    html += `
      <div class="skin-card ${skin.unlocked ? '' : 'locked'} ${isEq ? 'equipped' : ''}"
        onclick="${skin.unlocked ? `equipSkin('avatarFrame','${skin.id}');renderCollection();` : ''}">
        <div class="skin-preview frame-preview" style="${skin.css}"></div>
        <div class="skin-name">${skin.name}</div>
        ${isEq ? '<span class="skin-badge">使用中</span>' : skin.unlocked ? '<span class="skin-badge equip">点击装备</span>' : '<span class="skin-badge lock">🔒</span>'}
      </div>`;
  }
  html += '</div></div>';

  // 骰子效果
  html += '<div class="skin-section"><h3 class="skin-section-title">🎲 骰子特效</h3><div class="skin-grid">';
  for (const skin of catalog.diceEffect) {
    const isEq = equipped.diceEffect === skin.id;
    html += `
      <div class="skin-card ${skin.unlocked ? '' : 'locked'} ${isEq ? 'equipped' : ''}"
        onclick="${skin.unlocked ? `equipSkin('diceEffect','${skin.id}');renderCollection();` : ''}">
        <div class="skin-preview dice-preview" style="background:${skin.primary}; box-shadow: 0 0 20px ${skin.accent};"></div>
        <div class="skin-name">${skin.name}</div>
        ${isEq ? '<span class="skin-badge">使用中</span>' : skin.unlocked ? '<span class="skin-badge equip">点击装备</span>' : '<span class="skin-badge lock">🔒</span>'}
      </div>`;
  }
  html += '</div></div>';

  container.innerHTML = html;
}
