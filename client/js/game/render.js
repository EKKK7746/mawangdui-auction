// ============================================================
// game/render.js — 游戏界面渲染（所有 _render* 函数 + UI 组件）
// 依赖: game/data.js, game/animation.js, game/actions.js
// ============================================================

// ==================== 总渲染调度 ====================

function renderGame(view) {
  // P0-1 + P2-2: 回合切换横幅 — 检测新回合开始（phase=auction 且 round 变化）
  if (view.phase === 'auction' && (!_lastView || _lastView.round !== view.round)) {
    _showRoundTransition(view);
  }

  _renderPhaseBar(view);
  _renderActionArea(view);
  _renderMyStatus(view);
  _renderPlayerList(view);

  // ★ 同步托管按钮状态
  const me = view.players.find(p => p.id === socket.id);
  if (me) {
    const actuallyManaged = !!me.managed;
    if (_autoPlayEnabled !== actuallyManaged) {
      _autoPlayEnabled = actuallyManaged;
      const btn = document.getElementById('btnAutoPlay');
      if (btn) {
        btn.textContent = actuallyManaged ? '已开启' : '已关闭';
        btn.className = actuallyManaged ? 'btn btn-sm btn-warning' : 'btn btn-sm btn-outline';
      }
    }
  }

  // 观战者：显示观战标识和退出按钮
  if (view.isSpectator) {
    _renderSpectatorBar();
  } else {
    const oldBar = document.getElementById('spectatorBar');
    if (oldBar) oldBar.remove();
  }
}

// ==================== 观战者标识 ====================

function _renderSpectatorBar() {
  let bar = document.getElementById('spectatorBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'spectatorBar';
    bar.className = 'spectator-bar';
    bar.innerHTML = `
      <span class="spectator-badge">👁️ 观战中</span>
      <button class="btn btn-danger btn-sm" onclick="leaveSpectate()">退出观战</button>
    `;
    const container = document.querySelector('.game-container');
    if (container) container.insertBefore(bar, container.firstChild);
  }
}

// ==================== 顶部相位栏 + 视觉展示区 ====================

function _renderPhaseBar(view) {
  document.getElementById('gameRoundLabel').textContent =
    `第 ${view.round}/${view.maxRounds} 轮`;
  const phaseLabel = PHASE_LABELS[view.phase] || view.phase;
  const spectatorTag = view.isSpectator ? ' · 👁️观战' : '';
  document.getElementById('gamePhaseLabel').textContent = phaseLabel + spectatorTag;

  const normalVisual = document.getElementById('phaseVisualNormal');
  const duelVisual = document.getElementById('phaseVisualDuel');
  const visualWrap = document.querySelector('.game-phase-visual');
  const phaseBar = document.querySelector('.game-phase-bar');

  // 阶段切换动效
  const prevPhase = _lastView?.phase;
  const phaseChanged = prevPhase && prevPhase !== view.phase;
  if (phaseChanged) {
    if (visualWrap) {
      visualWrap.classList.remove('phase-change-active');
      void visualWrap.offsetWidth;
      visualWrap.classList.add('phase-change-active');
      setTimeout(() => visualWrap.classList.remove('phase-change-active'), 500);
    }
    if (phaseBar) {
      phaseBar.classList.remove('phase-label-change');
      void phaseBar.offsetWidth;
      phaseBar.classList.add('phase-label-change');
      setTimeout(() => phaseBar.classList.remove('phase-label-change'), 400);
    }
  }

  // 决斗阶段：在顶部视觉区展示 VS 动效
  if (view.phase === 'duel' && view.duel && normalVisual && duelVisual) {
    normalVisual.style.display = 'none';
    duelVisual.style.display = 'flex';
    duelVisual.classList.add('active');
    const lastDuel = _lastView?.duel;
    const changed = !lastDuel || lastDuel.initiatorId !== view.duel.initiatorId || lastDuel.targetId !== view.duel.targetId;
    if (changed) {
      _renderDuelPhaseVisual(view, duelVisual);
    }
    return;
  }

  // 非决斗阶段
  if (normalVisual) normalVisual.style.display = 'flex';
  if (duelVisual) {
    duelVisual.style.display = 'none';
    duelVisual.classList.remove('active');
  }

  const iconEl = document.getElementById('phaseIcon');
  const cardMiniEl = document.getElementById('phaseCardMini');
  const cardNameEl = document.getElementById('phaseCardName');
  const cardScoreEl = document.getElementById('phaseCardScore');
  const cardFramedEl = document.getElementById('phaseCardFramed');

  const card = view.revealedCard;
  const phaseIcon = PHASE_ICONS[view.phase] || '🏛️';

  if (card && !card.hidden) {
    iconEl.style.display = 'none';
    cardMiniEl.style.display = 'flex';
    cardFramedEl.innerHTML = typeof getCardFramedImageHtml === 'function'
      ? getCardFramedImageHtml(card.id || card.name, 'frame-lg')
      : `<img src="assets/cards/${card.id || card.name}.png" alt="${card.name}" style="width:82px;height:82px;border-radius:8px;object-fit:cover;" onerror="this.style.display='none'" />`;
    cardNameEl.textContent = card.name || '';
    cardScoreEl.textContent = `★ ${card.score} 分`;
  } else if (card && card.hidden) {
    iconEl.style.display = 'flex';
    cardMiniEl.style.display = 'none';
    iconEl.textContent = '❓';
    cardNameEl.textContent = '待揭示';
    cardScoreEl.textContent = '';
  } else {
    iconEl.style.display = 'flex';
    cardMiniEl.style.display = 'none';
    iconEl.textContent = phaseIcon;
    cardNameEl.textContent = '';
    cardScoreEl.textContent = '';
  }

  const wrap = document.getElementById('phaseIconWrap');
  if (wrap) wrap.style.display = 'flex';
}

function _renderDuelPhaseVisual(view, container) {
  const duel = view.duel;
  if (!duel) return;

  const initiator = view.players.find(p => p.id === duel.initiatorId);
  const target = view.players.find(p => p.id === duel.targetId);
  const initName = initiator?.nickname || '?';
  const targetName = target?.nickname || '?';

  const playersEl = document.getElementById('phaseDuelPlayers');
  if (playersEl) {
    playersEl.innerHTML = `
      <div class="phase-duel-player" style="animation-delay: 0.1s;">
        <div class="pdp-avatar">🪞</div>
        <div class="pdp-name">${initName}</div>
        <div class="pdp-role">发起者</div>
      </div>
      <div class="phase-duel-vs">VS</div>
      <div class="phase-duel-player" style="animation-delay: 0.2s;">
        <div class="pdp-avatar">🪞</div>
        <div class="pdp-name">${targetName}</div>
        <div class="pdp-role">被挑战</div>
      </div>
    `;
  }
}

// ==================== 操作区调度 ====================

function _renderActionArea(view) {
  const container = document.getElementById('gameActionArea');
  const prevPhase = _lastView ? _lastView.phase : '';
  const newPhase = view.phase;
  const thisVersion = ++_renderVersion;

  _stopTurnCountdown();
  _clearSettleTimer();

  if (view.isSpectator) {
    _renderSpectatorAction(view, container);
    return;
  }

  if (_duelIntroTimer && newPhase === 'duel') {
    return;
  }

  if (_auctionResultTimer && newPhase !== 'selectCard') {
    clearTimeout(_auctionResultTimer);
    _auctionResultTimer = null;
  }

  if (_auctionResultTimer && newPhase === 'selectCard') {
    return;
  }

  if (newPhase === 'selectCard' && prevPhase === 'auction' && !_auctionResultShown && view.lastBidResults) {
    _auctionResultShown = true;
    _renderAuctionResult(view, container);
    _auctionResultTimer = setTimeout(() => {
      _auctionResultTimer = null;
      if (_lastView && _lastView.phase !== 'selectCard') {
        return;
      }
      _renderActionContent(view, container);
      container.classList.add('phase-enter');
      setTimeout(() => container.classList.remove('phase-enter'), 300);
    }, 2800);
    return;
  }

  if (newPhase === 'duel' && prevPhase !== 'duel' && view.duel && !_duelIntroTimer) {
    _showDuelIntro(view, container);
    return;
  }

  if (newPhase === 'auction') {
    _auctionResultShown = false;
    _collectionSaved = false;  // 新游戏开始，重置收集保存标记
  }

  if (prevPhase && prevPhase !== newPhase) {
    // 离开交易阶段时清理提案缓存
    if (prevPhase === 'trade') {
      _pendingTradeProposal = null;
      if (_tradeCountdownInterval) { clearInterval(_tradeCountdownInterval); _tradeCountdownInterval = null; }
    }
    container.classList.add('phase-leave');
    setTimeout(() => {
      if (_renderVersion !== thisVersion) return;
      container.classList.remove('phase-leave');
      _renderActionContent(view, container);
      container.classList.add('phase-enter');
      setTimeout(() => container.classList.remove('phase-enter'), 300);
    }, 200);
  } else {
    _renderActionContent(view, container);
  }
}

function _renderActionContent(view, container) {
  if (GameState._tutorial && GameState._tutorial.active) {
    const tHtml = renderTutorialPanel(view.phase);
    container.innerHTML = tHtml + '<div id="tut-phase-inner"></div>';
    const inner = document.getElementById('tut-phase-inner');
    _renderPhaseContent(view, inner);
    return;
  }
  _renderPhaseContent(view, container);
}

function _renderPhaseContent(view, container) {
  switch (view.phase) {
    case 'auction':     _renderAuction(view, container); break;
    case 'selectCard':  _renderSelectCard(view, container); break;
    case 'rentDice':    _renderRentDice(view, container); break;
    case 'rollDice':    _renderRollDice(view, container); break;
    case 'settle':      _renderSettle(view, container); break;
    case 'trade':       _renderTrade(view, container); break;
    case 'duel':
      if (_lastView && _lastView.phase !== 'duel') {
        _renderDuel._playedSound = false;
      }
      _renderDuel(view, container);
      break;
    case 'finished':    _renderFinished(view, container); break;
    default:            container.innerHTML = '';
  }
}

// ==================== 观战者操作区 ====================

function _renderSpectatorAction(view, container) {
  container.className = 'game-action-area';
  _clearSettleTimer();

  if (view.phase === 'settle') {
    _renderSettle(view, container);
    return;
  }

  if (view.phase === 'finished') {
    _renderFinished(view, container);
    return;
  }

  const phaseMessages = {
    auction: { icon: '💰', text: '拍卖师竞选中', sub: '玩家们正在秘密报价...' },
    selectCard: { icon: '🃏', text: '拍卖师选卡中', sub: '等待拍卖师从牌堆中选择...' },
    rentDice: { icon: '🎲', text: '玩家租骰中', sub: '玩家们正在选择骰子...' },
    rollDice: { icon: '🎯', text: '掷骰中', sub: '签筒抽签进行中...' },
    settle: { icon: '💰', text: '结算中', sub: '正在结算本轮结果...' },
    trade: { icon: '🔄', text: '交易中', sub: '玩家可在本轮结束后交换文物...' },
    duel: { icon: '🪞', text: '镜中决斗', sub: '决斗正在进行...' },
  };

  const msg = phaseMessages[view.phase] || { icon: '👁️', text: '观战中', sub: '' };

  if (view.phase === 'rollDice') {
    _renderRollDice(view, container);
    return;
  }

  if (view.phase === 'duel' && view.duel) {
    _renderDuel(view, container);
    return;
  }

  container.innerHTML = `
    <div class="spectator-action">
      <div class="spectator-icon">${msg.icon}</div>
      <div class="spectator-text">${msg.text}</div>
      <div class="spectator-sub">${msg.sub}</div>
    </div>
  `;
}

// ==================== 拍卖师公示页 ====================

function _renderAuctionResult(view, container) {
  container.className = 'game-action-area';
  const result = view.lastBidResults;
  if (!result) return;

  if (typeof playSound === 'function') playSound('confirm');

  if (!result.allPass) {
    _showCrownBurst(result.winnerName, result.commissionRate);
  }

  if (result.allPass) {
    container.innerHTML = `
      <div class="auction-result-overlay">
        <div class="ar-title">全员放弃</div>
        <div class="ar-subtitle">无拍卖师 · 随机翻牌</div>
        <div class="ar-bids-list">
          ${result.bids.map(b => `
            <div class="ar-bid-row ar-pass">
              <span class="ar-bid-name">${b.nickname}</span>
              <span class="ar-bid-pct">放弃</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    return;
  }

  const tiedMsg = result.tiedCount > 1
    ? `<div class="ar-tied-notice">⚔️ ${result.tiedCount} 人同价 ${result.commissionRate}%！抽签决定 → <strong>${result.winnerName}</strong></div>`
    : '';

  container.innerHTML = `
    <div class="auction-result-overlay ar-bids-only">
      <div class="ar-title">拍卖师诞生</div>
      <div class="ar-winner-name">${result.winnerName}</div>
      <div class="ar-commission">佣金 ${result.commissionRate}%</div>
      ${tiedMsg}
      <div class="ar-bids-list">
        ${result.bids.map(b => `
          <div class="ar-bid-row ${b.isWinner ? 'ar-winner' : ''} ${b.percentage === null ? 'ar-pass' : ''}">
            <span class="ar-bid-name">${b.nickname}${b.isWinner ? ' 👑' : ''}</span>
            <span class="ar-bid-pct">${b.percentage !== null ? b.percentage + '%' : '放弃'}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ==================== 拍卖阶段 ====================

function _renderAuction(view, container) {
  const myBid = view.bids.find(b => b.playerId === socket.id);

  if (myBid && myBid.submitted) {
    const submitted = view.bidsCount || 0;
    const total = view.bidsTotal || view.players.length;

    const playerStatusHtml = view.players.map(p => {
      const bid = view.bids.find(b => b.playerId === p.id);
      const isSubmitted = bid && bid.submitted;
      const isMe = p.id === socket.id;
      return `<div class="bid-status-row ${isSubmitted ? 'bs-done' : 'bs-pending'} ${isMe ? 'bs-me' : ''}">
        <span class="bs-icon">${isSubmitted ? '✅' : '⏳'}</span>
        <span class="bs-name">${p.nickname}${isMe ? ' (你)' : ''}${(p.isBot || p.managed) ? ' 🤖' : ''}</span>
        <span class="bs-state">${isSubmitted ? '已提交' : '思考中'}</span>
      </div>`;
    }).join('');

    container.className = 'game-action-area';
    container.innerHTML = `
      <div class="bid-submitted-view">
        <div class="bs-check">✅</div>
        <div class="bs-title">暗标已提交</div>
        <div class="bs-count">${submitted}/${total} 人已提交</div>
        <div class="bid-status-list">${playerStatusHtml}</div>
        <div class="bs-hint">等待其他玩家报价中...</div>
      </div>
    `;
    return;
  }

  container.className = 'game-action-area my-turn';

  container.innerHTML = `
    <div class="action-title">💰 暗标竞拍 — 秘密报价佣金比例</div>
    <p style="text-align:center;font-size:13px;color:#8B7B6B;margin-bottom:10px;">所有玩家同时秘密报价，佣金最低者当选拍卖师</p>
    <div class="bid-grid">
      <button class="bid-btn" onclick="doBid(10)"><span>10%</span></button>
      <button class="bid-btn" onclick="doBid(20)"><span>20%</span></button>
      <button class="bid-btn" onclick="doBid(30)"><span>30%</span></button>
      <button class="bid-btn" onclick="doBid(40)"><span>40%</span></button>
      <button class="bid-btn" onclick="doBid(50)"><span>50%</span></button>
      <button class="bid-btn pass-btn" onclick="doBid(null)">放弃</button>
    </div>
  `;

  if (view.turnDeadline) {
    _startTurnCountdown(view.turnDeadline);
  }
}

// ==================== 选卡阶段 ====================

function _renderSelectCard(view, container) {
  const isMe = view.auctioneerId === socket.id;

  if (!isMe) {
    const auctioneer = view.players.find(p => p.id === view.auctioneerId);
    const isBot = auctioneer && (auctioneer.isBot || auctioneer.managed);
    const deckSize = view.deckSize || 0;

    const flavorTexts = [
      '拍卖师正在审视牌堆...',
      '每一张卡牌都可能改变战局',
      '智慧的拍卖师，会选择哪张？',
      '牌堆中的珍宝等待揭晓',
      '选择权在拍卖师手中',
    ];
    const flavorIdx = Math.floor(Date.now() / 3000) % flavorTexts.length;

    container.className = 'game-action-area';
    container.innerHTML = `
      <div class="select-card-waiting">
        <div class="scw-icon">🃏</div>
        <div class="scw-title">拍卖师 ${auctioneer?.nickname || ''} 选卡中${isBot ? ' 🤖' : ''}</div>
        <div class="scw-deck-info">📦 牌堆剩余 ${deckSize} 张</div>
        <div class="scw-flavor">${flavorTexts[flavorIdx]}</div>
        <div class="scw-dots"><span>.</span><span>.</span><span>.</span></div>
      </div>
    `;
    return;
  }

  container.className = 'game-action-area my-turn';
  const deck = view.deck || [];
  const cards = deck.map((c, i) => `
    <div class="select-card-item" onclick="doSelectCard(${c.index !== undefined ? c.index : i})">
      <span class="sc-emoji">${getCardImageHtml(c.id || c.name, 'card-img-md')}</span>
      <div class="sc-info">
        <div class="sc-name">${c.name}</div>
        <div class="sc-meta">★ ${c.score}分 ${getEffectLabel(c.effect)}</div>
      </div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="action-title">🃏 选择本轮拍卖卡牌</div>
    <div class="select-card-list">${cards}</div>
  `;
}

// ==================== 租骰阶段 ====================

function _renderRentDice(view, container) {
  const mySelect = view.diceSelections[socket.id];

  if (mySelect === 'auctioneer') {
    _renderWaiting(container, '作为拍卖师，你不参与掷骰');
    return;
  }

  if (mySelect && mySelect !== 'waiting') {
    _renderDiceWaiting(view, container);
    return;
  }

  container.className = 'game-action-area my-turn';

  const isSpeedMode = view._mode === 'speed';
  const costs = view.diceCosts || { d4: 1, d6: 2, d12: 4, d20: 6, pass: 0 };
  const remainingCards = view.deckSize || 0;
  const d4Free = costs.d4 === 0 || remainingCards <= 2;  // 末两轮免费
  const me = view.players.find(p => p.id === socket.id);
  const myFunds = me ? me.funds : 0;
  const hasUpgrade = view.hasUpgrade;

  const UPGRADE_MAP = { d4: 'd6', d6: 'd12', d12: 'd20' };

  const diceTypes = [
    { type: 'd4', sides: 4, ev: 2.5, cost: costs.d4, free: d4Free },
    { type: 'd6', sides: 6, ev: 3.5, cost: costs.d6, free: false },
    { type: 'd12', sides: 12, ev: 6.5, cost: costs.d12, free: false },
    { type: 'd20', sides: 20, ev: 10.5, cost: costs.d20, free: false },
  ];

  const buttons = diceTypes.map(d => {
    const canAfford = d.free || myFunds >= d.cost;
    const costLabel = d.free ? '<span class="dice-free-tag">免费</span>' : `$${d.cost}`;
    const upgraded = UPGRADE_MAP[d.type];
    return `<button class="dice-btn${!canAfford ? ' disabled' : ''}${d.free ? ' dice-free' : ''}"
      onclick="doSelectDiceWithUpgrade('${d.type}')">
      <span class="dice-name">${d.type}<span class="dice-upgrade-preview"></span></span>
      <span class="dice-cost">${costLabel}</span>
      <span class="dice-ev">EV ${d.ev}</span>
    </button>`;
  }).join('');

  const upgradeCheckbox = hasUpgrade ? `
    <label class="upgrade-checkbox">
      <input type="checkbox" id="useUpgradeCheck" onchange="onUpgradeCheckChange()" />
      <span class="upgrade-check-label">⬆️ 使用敦煌飞天升级骰子（本轮限用一次）</span>
    </label>
  ` : '';

  container.innerHTML = `
    <div class="action-title">${isSpeedMode ? '⚡ 极速模式 — 选择骰子' : '🎲 选择你的骰子'}</div>
    <div class="dice-grid">
      ${buttons}
      <button class="dice-btn pass-btn-full"
        onclick="doSelectDiceWithUpgrade('pass')">本轮放弃</button>
    </div>
    ${upgradeCheckbox}
  `;

  if (view.turnDeadline) {
    _startTurnCountdown(view.turnDeadline);
  }

  if (hasUpgrade) {
    setTimeout(() => {
      const cb = document.getElementById('useUpgradeCheck');
      if (cb) cb.checked = false;
      onUpgradeCheckChange();
    }, 0);
  }
}

function _renderDiceWaiting(view, container) {
  container.className = 'game-action-area';

  const others = view.players.filter(p => p.id !== socket.id && p.id !== view.auctioneerId);
  const doneList = view.playersDone || [];
  const mySelect = view.diceSelections[socket.id];
  const myDice = mySelect && mySelect !== 'waiting' ? mySelect : null;

  const statusHtml = others.map(p => {
    const isDone = doneList.includes(p.id);
    return `<div class="ps-item ${isDone ? 'ps-done' : 'ps-waiting'}">
      <span class="ps-nick">${p.nickname}${(p.isBot || p.managed) ? ' 🤖' : ''}</span>
      <span class="ps-dice-icon">${isDone ? '🎲' : '⏳'}</span>
      <span class="ps-state">${isDone ? '已选骰' : '选择中'}</span>
    </div>`;
  }).join('');

  const myDiceDisplay = myDice && myDice !== 'pass'
    ? `<span class="bsm-dice">${myDice}</span>`
    : myDice === 'pass' ? '<span class="bsm-pass">已放弃</span>' : '';

  container.innerHTML = `
    <div class="dice-waiting">
      <div class="waiting-icon">✅</div>
      <p>已准备就绪 ${myDiceDisplay}</p>
      ${others.length > 0 ? `<div class="player-status">${statusHtml}</div>` : ''}
    </div>
  `;
}

// ==================== 掷骰阶段 ====================

function _renderRollDice(view, container) {
  container.className = 'game-action-area';

  const results = view.diceResults || {};
  const selections = view.diceSelections || {};
  const rawResult = results[socket.id];
  const myDiceType = selections[socket.id] || '?';

  const isReroll = rawResult && typeof rawResult === 'object' && rawResult.reroll;
  const myResult = isReroll ? rawResult.value : rawResult;
  const myV2 = isReroll ? rawResult.v2 : null;

  const allNull = Object.values(results).every(v => v === null);
  if (allNull) {
    const auctioneer = view.players.find(p => p.id === view.auctioneerId);
    container.innerHTML = `<div class="settle-result">
      <div class="settle-winner">全员放弃</div>
      <div style="color:#B8A99A;font-size:14px;">拍卖师 ${auctioneer?.nickname||''} 获得卡牌</div>
    </div>`;
    return;
  }

  let maxVal = -1;
  for (const val of Object.values(results)) {
    if (val !== null) {
      const n = (typeof val === 'object' && val.value != null) ? val.value : val;
      if (n > maxVal) maxVal = n;
    }
  }

  let html = '';

  if (myResult !== null && myResult !== undefined) {
    const displayNum = isReroll ? rawResult.v1 : myResult;
    const v2 = isReroll ? rawResult.v2 : null;
    html += `<div class="dice-particle-area" id="diceParticleArea"
      data-dice="${myDiceType}" data-result="${displayNum}"
      data-reroll="${isReroll ? '1' : '0'}"
      data-v2="${v2 != null ? v2 : ''}">
      <div class="dice-label">${myDiceType}${isReroll ? ' 🎲×2' : ''}</div>
    </div>`;
  }

  const _valOf = (v) => v !== null ? ((typeof v === 'object' && v.value != null) ? v.value : v) : -1;

  const entries = view.players
    .filter(p => p.id !== undefined)
    .sort((a, b) => {
      const va = results.hasOwnProperty(a.id) && results[a.id] !== null ? _valOf(results[a.id]) : -999;
      const vb = results.hasOwnProperty(b.id) && results[b.id] !== null ? _valOf(results[b.id]) : -999;
      return vb - va;
    });

  html += '<div class="dice-scoreboard sb-hidden"><div class="sb-title">📊 实时点数统计</div>';
  entries.forEach((p, i) => {
    const hasResult = results.hasOwnProperty(p.id) && results[p.id] !== null;
    const val = hasResult ? _valOf(results[p.id]) : null;
    const dice = selections[p.id] || (p.id === view.auctioneerId ? '👑' : '?');
    const isMe = p.id === socket.id;
    const isAuctioneer = p.id === view.auctioneerId;
    const isWinner = hasResult && val === maxVal && maxVal > 0;
    const medals = ['🥇','🥈','🥉'];
    html += `<div class="sb-row ${isMe?'is-me':''} ${isWinner?'is-winner':''} ${isAuctioneer?'is-auctioneer':''}" style="animation-delay:${i*0.15}s">
      <span class="sb-rank">${i<3?medals[i]:'#'+(i+1)}</span>
      <span class="sb-name">${p.nickname}${isAuctioneer?' 👑':''}</span>
      <span class="sb-dice">${dice}</span>
      <span class="sb-result">${hasResult ? val : (isAuctioneer ? '<span style="color:#888">—</span>' : '<span style="color:#888">—</span>')}</span>
    </div>`;
  });
  html += '</div>';

  container.innerHTML = html;

  if (myResult !== null && myResult !== undefined) {
    const startDelay = 150;
    setTimeout(() => {
      const area = document.getElementById('diceParticleArea');
      if (!area) return;
      const displayNum = isReroll ? rawResult.v1 : myResult;
      const v2 = isReroll ? rawResult.v2 : null;
      if (typeof applyDiceSkin === 'function') applyDiceSkin();
      startDiceAnimation(area, myDiceType, displayNum, isReroll, v2);
    }, startDelay);
  }

  const scoreboardDelay = (myResult !== null && myResult !== undefined) ? 2400 : 500;
  setTimeout(() => {
    const sb = document.querySelector('.dice-scoreboard');
    if (sb) sb.classList.replace('sb-hidden', 'sb-visible');
  }, scoreboardDelay);

  if (typeof playSound === 'function') {
    setTimeout(() => playSound('diceRoll'), 200);
  }
}

// ==================== 交易阶段 ====================

let _tradeCountdownInterval = null;
let _pendingTradeProposal = null;  // 存储 trade:proposal 事件发来的提案详情
let _collectionSaved = false;      // 防止重复保存收集数据

function _renderTrade(view, container) {
  container.className = 'game-action-area';

  const me = view.players.find(p => p.id === socket.id);
  if (!me) return;

  const myQuota = view.tradeQuota ? (view.tradeQuota[socket.id] || 0) : 0;
  const hasQuota = myQuota > 0 && me.cards.length > 0;
  const hasProposal = view.tradeProposal && view.tradeProposal.toId === socket.id && !view.tradeProposal.responded;
  const hasPending = view.tradeProposal && !view.tradeProposal.responded;

  // 清除之前的倒计时
  if (_tradeCountdownInterval) { clearInterval(_tradeCountdownInterval); _tradeCountdownInterval = null; }

  // 其他玩家状态
  const playersHtml = view.players.filter(p => p.id !== socket.id && !p.isBot).map(p => {
    const quota = view.tradeQuota ? (view.tradeQuota[p.id] || 0) : 0;
    const hasCards = (p.cardCount || 0) > 0;
    const canTarget = hasQuota && hasCards && quota > 0 && !hasPending;
    const skipped = view.tradeSkipped && view.tradeSkipped.includes(p.id);
    const isTargetOfProposal = view.tradeProposal && view.tradeProposal.toId === p.id;
    let status = '';
    if (skipped) status = '已跳过';
    else if (quota <= 0) status = '无可交易';
    else if (!hasCards) status = '无卡牌';
    else if (isTargetOfProposal) status = '⏳ 待回应';
    else if (canTarget) status = '可交易';
    else status = '';
    return `<div class="trade-player-item ${canTarget ? 'can-target' : ''}" 
      data-target-id="${p.id}"
      onclick="${canTarget ? `openTradeProposal('${p.id}')` : ''}"
      style="${canTarget ? 'cursor:pointer' : 'cursor:default'}">
      <span class="trade-player-nick">${p.nickname}</span>
      <span class="trade-player-status">${status}</span>
    </div>`;
  }).join('');

  // 提案弹窗（如果目标是自己）
  let proposalHtml = '';
  if (hasProposal) {
    // 优先用 socket 事件缓存，否则回退到 view.tradeProposal（刷新/重连后）
    const pp = _pendingTradeProposal || view.tradeProposal || null;
    const fromNick = pp ? (pp.fromNick || (view.players.find(p => p.id === view.tradeProposal.fromId) || {}).nickname || '玩家') : '玩家';
    let detailsHtml = '';
    if (pp) {
      // 对方出的内容
      const fromParts = [];
      if (pp.fromCards && pp.fromCards.length > 0) {
        fromParts.push(pp.fromCards.map(c => `<span class="trade-prop-card">${c.name} ★${c.score}</span>`).join('、'));
      }
      if (pp.fromGold > 0) fromParts.push(`<span class="trade-prop-gold">$${pp.fromGold}</span>`);
      
      // 对方要的内容
      const toParts = [];
      if (pp.toCards && pp.toCards.length > 0) {
        toParts.push(pp.toCards.map(c => `<span class="trade-prop-card">${c.name} ★${c.score}</span>`).join('、'));
      }
      if (pp.toGold > 0) toParts.push(`<span class="trade-prop-gold">$${pp.toGold}</span>`);

      detailsHtml = `
        <div class="trade-proposal-detail">
          <div class="trade-prop-row">🤝 <strong>${fromNick}</strong> 向你发起交易</div>
          ${fromParts.length > 0 ? `<div class="trade-prop-row">📤 对方出：${fromParts.join(' + ')}</div>` : ''}
          ${toParts.length > 0 ? `<div class="trade-prop-row">📥 要你的：${toParts.join(' + ')}</div>` : ''}
        </div>`;
    } else {
      detailsHtml = `
        <div class="trade-proposal-detail">
          <div class="trade-prop-row">🤝 <strong>${fromNick}</strong> 向你发起交易</div>
          <div class="trade-prop-row" style="opacity:0.7">（详情加载中...）</div>
        </div>`;
    }
    proposalHtml = `<div class="trade-proposal-banner">
      ${detailsHtml}
      <div class="trade-proposal-btns">
        <button class="trade-btn trade-accept" onclick="respondTrade(true)">接受</button>
        <button class="trade-btn trade-reject" onclick="respondTrade(false)">拒绝</button>
      </div>
    </div>`;
  }

  container.innerHTML = `
    <div class="trade-container">
      <div class="trade-header">
        <span class="trade-title">🔄 交易阶段</span>
        <div class="trade-timer-wrap">
          <div class="trade-timer-bar"><div class="trade-timer-fill" id="tradeTimerFill"></div></div>
          <div class="trade-timer-text" id="tradeTimerText">30秒</div>
        </div>
      </div>
      <div class="trade-info">
        <span>你的交易次数剩余：<strong>${myQuota}</strong></span>
        ${!hasQuota ? '<span class="trade-no-quota">（已用完或无可交易卡牌）</span>' : ''}
      </div>
      ${proposalHtml}
      ${hasPending && !hasProposal ? '<div class="trade-info-tip">等待对方回应中...</div>' : ''}
      <div class="trade-players-title">可选交易对象</div>
      <div class="trade-players-list">${playersHtml || '<div class="trade-empty">无其他玩家</div>'}</div>
      <button class="trade-btn trade-skip-btn" onclick="skipTrade()" ${hasPending ? 'disabled' : ''}>
        ${hasQuota ? '跳过交易' : '继续'}
      </button>
    </div>
  `;

  // 倒计时 — 仿照 settle timer：先渲染 DOM，再启动计时器
  const deadline = view.turnDeadline;
  if (deadline) {
    const totalSec = 30; // 服务端 TRADE_PHASE_SECONDS
    let remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const fillEl = document.getElementById('tradeTimerFill');
    const textEl = document.getElementById('tradeTimerText');
    const updateCountdown = () => {
      const pct = (remain / totalSec) * 100;
      if (fillEl) {
        fillEl.style.width = pct + '%';
        if (pct < 30) fillEl.style.background = '#C43A31';
        else if (pct < 60) fillEl.style.background = '#D4A017';
        else fillEl.style.background = '#5B7B5E';
      }
      if (textEl) textEl.textContent = remain === 0 ? '已结束' : `${remain}秒`;
      if (remain <= 0) {
        clearInterval(_tradeCountdownInterval);
        _tradeCountdownInterval = null;
      }
      remain--;
    };
    updateCountdown();
    _tradeCountdownInterval = setInterval(updateCountdown, 1000);
  }

  // 如果无配额也无卡，自动跳过
  if (!hasQuota && !hasProposal) {
    setTimeout(() => { if (typeof skipTrade === 'function') skipTrade(); }, 500);
  }
}

// 打开交易提案面板
function openTradeProposal(targetId) {
  const panel = document.getElementById('tradeProposalPanel');
  if (panel) panel.remove();

  const view = (typeof _lastView !== 'undefined') ? _lastView : null;
  if (!view) return;

  const me = view.players.find(p => p.id === socket.id);
  const target = view.players.find(p => p.id === targetId);
  if (!me || !target) return;

  const myCards = me.cards || [];
  const targetCards = target.cards || [];

  const panelHtml = `
    <div class="trade-proposal-overlay" id="tradeProposalPanel" onclick="event.target===this && closeTradeProposal()">
      <div class="trade-proposal-panel">
        <div class="trade-proposal-title">发起交易 → ${target.nickname}</div>
        <div class="trade-proposal-body">
          <div class="trade-col">
            <div class="trade-col-label">你出的卡</div>
            <div class="trade-card-grid">
              ${myCards.map(c => `<label class="trade-card-option">
                <input type="checkbox" class="trade-from-card" value="${c.id}" />
                <span class="trade-card-name">${c.name || c.id} ★${c.score}</span>
              </label>`).join('')}
            </div>
            <div class="trade-gold-input">
              <span>你的金币：$${me.funds}</span>
              <input type="number" id="tradeFromGold" value="0" min="0" max="${me.funds}" />
            </div>
          </div>
          <div class="trade-arrow">⇄</div>
          <div class="trade-col">
            <div class="trade-col-label">你要对方的卡</div>
            <div class="trade-card-grid">
              ${targetCards.map(c => `<label class="trade-card-option">
                <input type="checkbox" class="trade-to-card" value="${c.id}" />
                <span class="trade-card-name">${c.name || c.id} ★${c.score}</span>
              </label>`).join('')}
            </div>
            <div class="trade-gold-input">
              <span>对方金币：$${target.funds}</span>
              <input type="number" id="tradeToGold" value="0" min="0" max="${target.funds}" />
            </div>
          </div>
        </div>
        <div class="trade-proposal-actions">
          <button class="trade-btn trade-accept" onclick="submitTradeProposal('${targetId}')">发送提案</button>
          <button class="trade-btn trade-reject" onclick="closeTradeProposal()">取消</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', panelHtml);
}

function closeTradeProposal() {
  const panel = document.getElementById('tradeProposalPanel');
  if (panel) panel.remove();
}

function submitTradeProposal(toId) {
  const fromCards = [...document.querySelectorAll('.trade-from-card:checked')].map(el => el.value);
  const toCards = [...document.querySelectorAll('.trade-to-card:checked')].map(el => el.value);
  const fromGold = parseInt(document.getElementById('tradeFromGold')?.value) || 0;
  const toGold = parseInt(document.getElementById('tradeToGold')?.value) || 0;

  if (fromCards.length === 0 && fromGold === 0) {
    alert('你至少要出一些卡牌或金币');
    return;
  }

  const roomId = (typeof GameState !== 'undefined' && GameState.roomId) ? GameState.roomId : '';
  socket.emit('trade:propose', roomId, toId, fromCards, fromGold, toCards, toGold, (result) => {
    if (result && result.error) {
      alert(result.error);
    } else {
      closeTradeProposal();
    }
  });
}

function respondTrade(accepted) {
  const roomId = (typeof GameState !== 'undefined' && GameState.roomId) ? GameState.roomId : '';
  socket.emit('trade:respond', roomId, accepted, (result) => {
    if (result && result.error) alert(result.error);
  });
}

function skipTrade() {
  const roomId = (typeof GameState !== 'undefined' && GameState.roomId) ? GameState.roomId : '';
  socket.emit('trade:skip', roomId);
}

// 监听交易提案
if (typeof socket !== 'undefined') {
  socket.on('trade:proposal', (data) => {
    console.log('[Trade] 收到交易提案:', data);
    _pendingTradeProposal = data;
    // 即时更新 banner 详情（处理 data 比 game_state_update 晚到的情况）
    const detail = document.querySelector('.trade-proposal-detail');
    if (detail && data) {
      const fromParts = [];
      if (data.fromCards && data.fromCards.length > 0) {
        fromParts.push(data.fromCards.map(c => `<span class="trade-prop-card">${c.name} ★${c.score}</span>`).join('、'));
      }
      if (data.fromGold > 0) fromParts.push(`<span class="trade-prop-gold">$${data.fromGold}</span>`);
      const toParts = [];
      if (data.toCards && data.toCards.length > 0) {
        toParts.push(data.toCards.map(c => `<span class="trade-prop-card">${c.name} ★${c.score}</span>`).join('、'));
      }
      if (data.toGold > 0) toParts.push(`<span class="trade-prop-gold">$${data.toGold}</span>`);
      detail.innerHTML = `
        <div class="trade-prop-row">🤝 <strong>${data.fromNick}</strong> 向你发起交易</div>
        ${fromParts.length > 0 ? `<div class="trade-prop-row">📤 对方出：${fromParts.join(' + ')}</div>` : ''}
        ${toParts.length > 0 ? `<div class="trade-prop-row">📥 要你的：${toParts.join(' + ')}</div>` : ''}`;
    }
  });
  socket.on('trade:result', (data) => {
    if (data && data.success) {
      showToast(`✅ ${data.fromNick} 与 ${data.toNick} 交易成功！`, 'info');
    } else {
      const reason = (data && data.reason) || '交易未完成';
      const msg = reason === 'rejected' ? '❌ 对方拒绝了交易' : `❌ ${reason}`;
      showToast(msg, 'error');
    }
    _pendingTradeProposal = null;  // 清除提案缓存
  });
}

// ==================== 镜中决斗阶段 ====================

function _renderDuel(view, container) {
  if (!_renderDuel._playedSound) {
    _renderDuel._playedSound = true;
    if (typeof playSound === 'function') playSound('duel');
  }
  const duel = view.duel;

  if (!duel) {
    container.innerHTML = '<div class="game-action-area"><p style="color:#C43A31;text-align:center;padding:20px;">决斗已结束，等待结算...</p></div>';
    return;
  }

  try {
    switch (duel.step) {
      case 'select_target': _renderDuelSelectTarget(view, container); break;
      case 'select_card':   _renderDuelSelectCard(view, container); break;
      case 'rent_dice':     _renderDuelRentDice(view, container); break;
      case 'roll_dice':     _renderDuelRollDice(view, container); break;
      case 'resolve':       _renderDuelResolved(view, container, duel); break;
      default:
        container.innerHTML = `<div class="game-action-area"><p style="color:#C43A31;text-align:center;padding:20px;">未知决斗步骤: ${duel.step}</p></div>`;
    }
  } catch (err) {
    console.error('[Duel] Render error:', err);
    container.innerHTML = '<div class="game-action-area"><p style="color:#C43A31;text-align:center;padding:20px;">决斗渲染出错，请刷新页面</p></div>';
  }
}

function _renderDuelSelectTarget(view, container) {
  container.className = 'game-action-area';
  const me = view.players.find(p => p.isMe);
  if (!me || !me.cards.some(c => c.id === 'slj' && !c.used)) {
    _renderWaiting(container, '等待决斗发起...', '');
    return;
  }

  const opponents = view.players.filter(p => !p.isMe && p.cards && p.cards.length > 0);

  container.innerHTML = `
    <div class="duel-panel">
      <div class="duel-header">
        <span class="duel-icon">🪞</span>
        <h3>选择决斗对手</h3>
        <p class="duel-desc">你的双鸾双兽镜可以争夺对手的一张卡牌！</p>
      </div>
      <div class="duel-targets">
        ${opponents.map(p => `
          <button class="duel-target-btn" onclick="doDuelSelectTarget('${p.id}')">
            ${p.nickname}（${p.cards.length} 张卡）
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function _renderDuelSelectCard(view, container) {
  container.className = 'game-action-area';
  const duel = view.duel;
  const isInitiator = duel.initiatorId === socket.id;

  if (!isInitiator) {
    const initiator = view.players.find(p => p.id === duel.initiatorId);
    _renderWaiting(container, `等待 ${initiator?.nickname} 选择争夺的卡牌...`, '决斗进行中');
    return;
  }

  const target = view.players.find(p => p.id === duel.targetId);
  const targetCards = target?.cards || [];

  container.innerHTML = `
    <div class="duel-panel">
      <div class="duel-header">
        <span class="duel-icon">🪞</span>
        <h3>选择争夺的卡牌</h3>
        <p class="duel-desc">从 ${target?.nickname} 的手中选择一张卡牌作为争夺目标</p>
      </div>
      <div class="duel-cards">
        ${targetCards.map(c => `
          <button class="duel-card-btn" onclick="doDuelSelectCard('${c.id}')">
            <span class="duel-card-emoji">${getCardFramedImageHtml(c.id, 'frame-sm')}</span>
            <span class="duel-card-name">${c.name}</span>
            <span class="duel-card-score">★${c.score}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function _renderDuelRentDice(view, container) {
  container.className = 'game-action-area';
  const duel = view.duel;
  const isInvolved = duel.initiatorId === socket.id || duel.targetId === socket.id;

  if (!isInvolved) {
    _renderWaiting(container, '决斗进行中...', '双方正在租用骰子');
    return;
  }

  const playersDone = duel.playersDone || [];
  const alreadySelected = playersDone.includes(socket.id);

  if (alreadySelected) {
    _renderWaiting(container, '已选择骰子，等待对手...', '决斗：租用骰子');
    return;
  }

  container.className = 'game-action-area my-turn';

  const costs = { d4: 1, d6: 2, d12: 4, d20: 6 };
  const me = view.players.find(p => p.id === socket.id);
  const myFunds = me?.funds || 0;
  const hasUpgrade = me?.hasUpgrade || false;

  const diceTypes = [
    { type: 'd4', sides: 4, ev: 2.5, cost: costs.d4 },
    { type: 'd6', sides: 6, ev: 3.5, cost: costs.d6 },
    { type: 'd12', sides: 12, ev: 6.5, cost: costs.d12 },
    { type: 'd20', sides: 20, ev: 10.5, cost: costs.d20 },
  ];

  const buttons = diceTypes.map(d => {
    const canAfford = myFunds >= d.cost;
    return `<button class="dice-btn${!canAfford ? ' disabled' : ''}"
      onclick="doDuelRentDice('${d.type}')">
      <span class="dice-name">${d.type}<span class="dice-upgrade-preview"></span></span>
      <span class="dice-cost">$${d.cost}</span>
      <span class="dice-ev">EV ${d.ev}</span>
    </button>`;
  }).join('');

  const upgradeCheckbox = hasUpgrade ? `
    <label class="upgrade-checkbox">
      <input type="checkbox" id="useUpgradeCheck" onchange="onUpgradeCheckChange()" />
      <span class="upgrade-check-label">⬆️ 使用敦煌飞天升级骰子（本轮限用一次）</span>
    </label>
  ` : '';

  const targetCardId = duel.targetCardId;
  const cardVis = targetCardId ? getCardVisual(targetCardId) : { emoji: '❓', color: '#C43A31' };
  const cardName = targetCardId ? (CARD_NAMES[targetCardId] || targetCardId) : '未知';
  const cardScore = duel.targetCardScore ?? '';

  const cardDisplayHtml = `
    <div class="duel-target-card" style="
      background: linear-gradient(135deg, #F8F4F0, #EDE5DA);
      border: 2px solid ${cardVis.color || '#C43A31'};
      border-radius: 12px;
      padding: 12px;
      margin-bottom: 14px;
      text-align: center;
    ">
      <div style="font-size:11px;color:#888;margin-bottom:4px;">🪞 争夺目标</div>
      ${getCardFramedImageHtml(targetCardId, 'frame-lg')}
      <div style="font-weight:bold;color:#C43A31;margin-top:6px;">${cardName}</div>
      ${cardScore ? `<div style="font-size:13px;color:#666;">★ ${cardScore} 分</div>` : ''}
    </div>
  `;

  container.innerHTML = `
    ${cardDisplayHtml}
    <div class="action-title">🪞 决斗选骰</div>
    <div class="dice-grid">
      ${buttons}
      <button class="dice-btn pass-btn-full"
        onclick="doDuelRentDice('pass')">不租用 (Pass)</button>
    </div>
    ${upgradeCheckbox}
  `;

  if (hasUpgrade) {
    setTimeout(() => {
      const cb = document.getElementById('useUpgradeCheck');
      if (cb) cb.checked = false;
      onUpgradeCheckChange();
    }, 0);
  }
}

function _renderDuelRollDice(view, container) {
  container.className = 'game-action-area';
  const duel = view.duel;
  const isInvolved = duel.initiatorId === socket.id || duel.targetId === socket.id;

  if (!isInvolved) {
    _renderWaiting(container, '决斗进行中...', '双方正在掷骰子');
    return;
  }

  const diceResults = duel.diceResults || {};
  const myResult = diceResults[socket.id];
  const myDiceType = duel.diceSelections[socket.id] || 'd6';

  if (!myResult || myResult.value == null) {
    _renderWaiting(container, '准备掷骰...', '等待骰子结果');
    return;
  }

  const isReroll = myResult.reroll;
  const displayNum = isReroll ? myResult.v1 : myResult.value;
  const v2 = isReroll ? myResult.v2 : null;

  const opponentId = duel.initiatorId === socket.id ? duel.targetId : duel.initiatorId;
  const oppResult = diceResults[opponentId];
  const oppName = view.players.find(p => p.id === opponentId)?.nickname || '?';
  const oppVal = oppResult && oppResult.value != null ? oppResult.value : null;
  const oppDiceType = duel.diceSelections[opponentId] || '?';

  const targetCardId = duel.targetCardId;
  const targetCardVis = targetCardId ? getCardVisual(targetCardId) : { emoji: '❓', color: '#C43A31' };
  const targetCardName = targetCardId ? (CARD_NAMES[targetCardId] || targetCardId) : '未知';

  const cardDisplayHtml = `
    <div class="duel-target-card" style="
      background: linear-gradient(135deg, #F8F4F0, #EDE5DA);
      border: 2px solid ${targetCardVis.color || '#C43A31'};
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 12px;
      text-align: center;
    ">
      <div style="font-size:10px;color:#888;">🪞 争夺中</div>
      ${getCardImageHtml(targetCardId, 'card-img-md')}
      <span style="font-weight:bold;color:#C43A31;font-size:14px;vertical-align:middle;margin-left:6px;">${targetCardName}</span>
    </div>
  `;

  let html = cardDisplayHtml + `
    <div class="dice-particle-area" id="diceParticleArea"
      data-dice="${myDiceType}" data-result="${displayNum}"
      data-reroll="${isReroll ? '1' : '0'}"
      data-v2="${v2 != null ? v2 : ''}">
      <div class="dice-label">${myDiceType}${isReroll ? ' 🎲×2' : ''}</div>
    </div>
  `;

  html += '<div class="dice-scoreboard sb-hidden"><div class="sb-title">⚔️ 决斗实时点数</div>';
  const myName = view.players.find(p => p.id === socket.id)?.nickname || '你';
  const isWinner = oppVal != null && myResult.value > oppVal;
  const isDraw = oppVal != null && myResult.value === oppVal;
  html += `<div class="sb-row is-me ${isWinner ? 'is-winner' : ''}">
    <span class="sb-rank">${isWinner ? '🥇' : '🥈'}</span>
    <span class="sb-name">${myName}</span>
    <span class="sb-dice">${myDiceType}</span>
    <span class="sb-result">${myResult.value}</span>
  </div>`;
  html += `<div class="sb-row ${oppVal != null && oppVal > myResult.value ? 'is-winner' : ''}">
    <span class="sb-rank">${oppVal != null && oppVal > myResult.value ? '🥇' : (isDraw ? '🥇' : '🥈')}</span>
    <span class="sb-name">${oppName}</span>
    <span class="sb-dice">${oppDiceType}</span>
    <span class="sb-result">${oppVal != null ? oppVal : '<span style="color:#888">—</span>'}</span>
  </div>`;
  html += '</div>';

  container.innerHTML = html;

  setTimeout(() => {
    const area = document.getElementById('diceParticleArea');
    if (!area) return;
    if (typeof applyDiceSkin === 'function') applyDiceSkin();
    startDiceAnimation(area, myDiceType, displayNum, isReroll, myResult.v2);
  }, 150);
}

function _renderDuelResolved(view, container, duel) {
  container.className = 'game-action-area';

  const winner = view.players.find(p => p.id === duel.winnerId);
  const loser = view.players.find(p => p.id === duel.loserId);
  const isWinner = duel.winnerId === socket.id;
  const isLoser = duel.loserId === socket.id;
  const diceResults = duel.diceResults || {};

  const winnerName = winner?.nickname || '未知玩家';
  const loserName = loser?.nickname || '未知玩家';
  const winnerVal = diceResults[duel.winnerId]?.value || '?';
  const loserVal = diceResults[duel.loserId]?.value || '?';

  if (typeof playSound === 'function') {
    if (isWinner) playSound('victory');
    else if (isLoser) playSound('defeat');
    else playSound('duel');
  }

  container.innerHTML = `
    <div class="duel-panel duel-resolved">
      <div class="duel-header">
        <span class="duel-icon">🪞</span>
        <h3 class="duel-result-title ${isWinner ? 'duel-win' : (isLoser ? 'duel-lose' : '')}">
          ${isWinner ? '🎉 你赢得了决斗！' : isLoser ? '💔 你输掉了决斗...' : `${winnerName} 赢得了决斗！`}
        </h3>
      </div>
      <div class="duel-result">
        <div class="duel-vs duel-vs-result">
          <div class="duel-vs-side ${isWinner ? 'duel-side-win' : ''}">
            <div class="duel-vs-name">${winnerName}</div>
            <div class="duel-vs-dice">🎲 ${winnerVal}</div>
            <div class="duel-vs-tag">👑 胜</div>
          </div>
          <div class="duel-vs-divider duel-vs-pulse">VS</div>
          <div class="duel-vs-side ${isLoser ? 'duel-side-lose' : ''}">
            <div class="duel-vs-name">${loserName}</div>
            <div class="duel-vs-dice">🎲 ${loserVal}</div>
            <div class="duel-vs-tag">負</div>
          </div>
        </div>
        <div class="duel-won-card">
          <p class="duel-won-label">赢得卡牌</p>
          <div class="card-emoji">${getCardFramedImageHtml(duel.targetCardId, 'frame-lg')}</div>
          <div class="card-name">${CARD_NAMES[duel.targetCardId] || duel.targetCardId}</div>
        </div>
      </div>
      <p class="duel-auto-close">3秒后自动关闭...</p>
    </div>
  `;
}

// ==================== 结算阶段 ====================

function _renderSettle(view, container) {
  container.className = 'game-action-area';

  if (_lastView && _lastView.phase === 'rollDice' && typeof playSound === 'function') {
    playSound('victory');
  }

  const results = view.diceResults || {};
  const _val = (v) => v !== null ? ((typeof v === 'object' && v.value != null) ? v.value : v) : -1;
  let maxVal = -1, winnerId = null;
  for (const [pid, val] of Object.entries(results)) {
    if (val !== null && _val(val) > maxVal) { maxVal = _val(val); winnerId = pid; }
  }
  if (!winnerId && Object.values(results).every(v => v === null)) {
    winnerId = view.auctioneerId;
  }

  const winner = view.players.find(p => p.id === winnerId);
  const card = view.revealedCard;
  const auctioneer = view.players.find(p => p.id === view.auctioneerId);

  const tieBanner = (view.tieInfo && view.tieInfo.hadTie)
    ? `<div class="settle-tie-banner">⚔️ 平局！经过 ${view.tieInfo.depth} 次重掷决出胜负</div>`
    : '';

  const diceRows = view.players
    .filter(p => p.id !== undefined)
    .sort((a, b) => {
      const va = results.hasOwnProperty(a.id) && results[a.id] !== null ? _val(results[a.id]) : -999;
      const vb = results.hasOwnProperty(b.id) && results[b.id] !== null ? _val(results[b.id]) : -999;
      return vb - va;
    })
    .map((p, i) => {
      const hasResult = results.hasOwnProperty(p.id) && results[p.id] !== null;
      const val = hasResult ? _val(results[p.id]) : null;
      const dice = view.diceSelections?.[p.id] || (p.id === view.auctioneerId ? '—' : '?');
      const isWinner = p.id === winnerId;
      const isAuctioneer = p.id === view.auctioneerId;
      const medals = ['🥇','🥈','🥉'];
      return `<div class="settle-dice-row ${isWinner ? 'is-winner' : ''} ${isAuctioneer ? 'is-auctioneer' : ''}">
        <span class="sd-rank">${i<3 ? medals[i] : '#'+(i+1)}</span>
        <span class="sd-name">${p.nickname}${isAuctioneer ? ' 👑' : ''}</span>
        <span class="sd-dice">${dice}</span>
        <span class="sd-val">${hasResult ? val : '—'}</span>
      </div>`;
    }).join('');

  const commissionRate = view.commissionRate || 0;
  const auctioneerStreak = view.auctioneerStreak || 0;
  const hasDoubleComm = auctioneer?.cards?.some(c => c.id === 'sq');
  const hasShield = auctioneer?.cards?.some(c => c.id === 'dhmh');
  let penalty = Math.max(0, auctioneerStreak - 1);
  if (hasShield) penalty = Math.floor(penalty / 2);

  const DICE_COSTS = { d4: 1, d6: 2, d12: 4, d20: 6, pass: 0 };
  let totalDiceCost = 0;
  for (const [pid, sel] of Object.entries(view.diceSelections || {})) {
    if (pid !== view.auctioneerId && sel !== 'pass' && sel !== 'auctioneer') {
      totalDiceCost += DICE_COSTS[sel] || 0;
    }
  }
  let commission = Math.ceil(totalDiceCost * commissionRate / 100);
  if (hasDoubleComm) commission *= 2;
  const netIncome = commission - penalty;

  const commDetail = view.auctioneerId ? `
    <div class="settle-comm-detail">
      <div class="sd-comm-row">拍卖师：<strong>${auctioneer?.nickname || '?'}</strong></div>
      <div class="sd-comm-row">佣金率：${commissionRate}%${hasDoubleComm ? ' ×2(市券)' : ''}</div>
      <div class="sd-comm-row">总骰子支出：$${totalDiceCost}</div>
      <div class="sd-comm-row">佣金收入：$${commission}</div>
      ${penalty > 0 ? `<div class="sd-comm-row sd-comm-penalty">连任惩罚(${auctioneerStreak}连)：-$${penalty}${hasShield ? ' (壁画减半)' : ''}</div>` : ''}
      <div class="sd-comm-row sd-comm-net">净收入：<strong style="color:${netIncome >= 0 ? '#5B7B5E' : '#C43A31'}">${netIncome >= 0 ? '+' : ''}$${netIncome}</strong></div>
    </div>
  ` : '<div class="settle-comm-detail"><div class="sd-comm-row">无拍卖师</div></div>';

  container.innerHTML = `
    <div class="settle-result-v2">
      ${tieBanner}
      <div class="settle-three-col">
        <div class="settle-col settle-col-winner">
          <div class="settle-winner-title">🏆 获得卡牌</div>
          <div class="settle-winner-name">${winner?.nickname || '?'}</div>
          ${card ? `<div class="settle-card-display">
            ${card.hidden ? '<span class="card-emoji-fallback">❓</span>' : getCardFramedImageHtml(card.id || card.name, 'frame-lg')}
          </div>` : ''}
          ${card ? `<div class="settle-card-name">${card.hidden ? '？？？' : card.name}</div>` : ''}
          ${card ? `<div class="settle-card-score">★ ${card.hidden ? '?' : card.score} 分</div>` : ''}
        </div>
        <div class="settle-col settle-col-dice">
          <div class="settle-col-title">📊 骰子对比</div>
          <div class="settle-dice-list">${diceRows}</div>
        </div>
        <div class="settle-col settle-col-comm">
          <div class="settle-col-title">💰 佣金结算</div>
          ${commDetail}
        </div>
      </div>
      <div id="settleCountdown" class="settle-countdown">
        <div class="settle-timer-bar"><div class="settle-timer-fill" id="settleTimerFill"></div></div>
        <div class="settle-timer-text" id="settleTimerText">5秒后自动进入下一轮</div>
      </div>
    </div>
  `;

  _clearSettleTimer();
  let remain = 5;
  const fillEl = document.getElementById('settleTimerFill');
  const textEl = document.getElementById('settleTimerText');
  const updateBar = () => {
    if (fillEl) fillEl.style.width = ((remain / 5) * 100) + '%';
    if (textEl) textEl.textContent = remain + '秒后自动进入下一轮';
  };
  updateBar();
  _settleTimer = setInterval(() => {
    remain--;
    if (remain <= 0) {
      _clearSettleTimer();
      doEndRound();
    } else {
      updateBar();
    }
  }, 1000);
}

// ==================== 终局 ====================

function _renderFinished(view, container) {
  container.className = 'game-action-area';

  // 收集系统：保存对局结果（仅触发一次）
  if (!_collectionSaved && typeof updateAfterGame === 'function') {
    _collectionSaved = true;
    const newAch = updateAfterGame(view, socket.id);
    if (newAch && newAch.length > 0) {
      setTimeout(() => {
        newAch.forEach(id => {
          const ach = ACHIEVEMENTS[id];
          if (ach && typeof window.showToast === 'function') {
            window.showToast(`🏆 成就解锁：${ach.icon} ${ach.name}！`);
          }
        });
      }, 500);
    }
  }

  if (GameState._tutorial && GameState._tutorial.active) {
    const completeHtml = renderTutorialComplete();
    if (completeHtml) {
      container.innerHTML = completeHtml;
      return;
    }
  }

  if (typeof playSound === 'function') playSound('gameOver');
  if (typeof SoundManager !== 'undefined') SoundManager.stopAmbient();

  const results = (view.finalResults && view.finalResults.length
    ? view.finalResults
    : _buildFallbackResults(view)).map(r => ({ ...r, isMe: r.id === socket.id }));

  const totalRounds = view.round - 1;

  const allCardIds = new Set();
  for (const r of results) {
    if (r.cards) r.cards.forEach(c => {
      allCardIds.add(c.id || c);
    });
  }

  const html = `
    <div class="finish-overlay">
      <div class="finish-panel">
        <div class="finish-header">
          <h2 class="finish-title">🏆 游戏结束</h2>
          <p class="finish-sub">共 ${totalRounds} 轮 / ${view.maxRounds} 轮完成</p>
        </div>

        <div class="finish-rank-list">
          ${results.map((r, i) => {
            const rank = r.rank || (i + 1);
            const isFirst = rank === 1;
            const isTied = r.cardScore === results[0].cardScore && r.funds === results[0].funds && i > 0;
            const rankClass = isFirst ? 'finish-first' : (rank <= 3 ? 'finish-podium' : '');
            const prevAdjusted = i > 0 ? (results[i-1].adjustedScore || results[i-1].cardScore) : -1;
            const prevFunds = i > 0 ? results[i-1].funds : -1;
            const trulyTied = i > 0 && (r.adjustedScore || r.cardScore) === prevAdjusted && r.funds === prevFunds
              && (r.adjustedScore || r.cardScore) !== (results[0].adjustedScore || results[0].cardScore);

            const cards = r.cards && r.cards.length ? r.cards : [];
            const cardScore = r.cardScore != null ? r.cardScore : cards.reduce((sum, c) => sum + (c.score || 0), 0);
            const adjustedScore = r.adjustedScore != null ? r.adjustedScore : (cardScore + Math.floor((r.funds || 0) / 3));
            const fundsBonus = adjustedScore - cardScore;

            return `<div class="finish-rank-item ${rankClass} ${r.isMe ? 'is-me' : ''} slide-in" style="animation-delay:${i * 0.15}s">
              <div class="finish-rank-badge">${RANK_MEDALS[rank] || rank}</div>
              <div class="finish-rank-body">
                <div class="finish-rank-name">
                  ${r.nickname} ${r.isMe ? '<span class="me-tag">你</span>' : ''}
                  ${cards.some(c => c.id === 'slj' && c.used) ? '<span title="发动过镜中决斗">🪞</span>' : ''}
                  ${isTied ? '🤝<span class="tied-tag">共享胜利</span>' : ''}
                  ${trulyTied ? '<span class="tied-tag">🤝 平局·资金决胜</span>' : ''}
                </div>
                <div class="finish-rank-cards">
                  ${cards.map(c => {
                    const id = c.id || c;
                    const score = c.score != null ? c.score : 1;
                    return `<span class="finish-card-tag" style="color:${CARD_COLORS[score] || '#8B6914'}"><img class="card-image card-img-xs" src="assets/cards/${id}.png" alt="${CARD_NAMES[id]||id}" style="margin-right:3px;vertical-align:middle;" onerror="this.style.display='none'" /> ${CARD_NAMES[id] || id} ${'★'.repeat(score)}</span>`;
                  }).join('')}
                </div>
              </div>
              <div class="finish-rank-score">
                <span class="score-num">${adjustedScore}</span>
                <span class="score-label">分</span>
                ${fundsBonus > 0 ? `<span class="funds-note" style="color:#4CAF50;">+${fundsBonus}折算</span>` : ''}
                <span class="funds-note">$${r.funds}</span>
              </div>
            </div>`;
          }).join('')}
        </div>

        <details class="finish-lore">
          <summary><span class="lore-icon">📜</span> 文物图鉴 <span class="lore-hint">点击展开</span></summary>
          <div class="finish-lore-grid">
            ${[...allCardIds].map(id => {
              const lore = CARD_LORE[id];
              if (!lore) return '';
              return `<div class="finish-lore-item">
                <span class="lore-name">${CARD_NAMES[id] || id}</span>
                <p class="lore-text">${lore}</p>
              </div>`;
            }).join('')}
          </div>
        </details>

        <div class="finish-buttons">
          <button class="finish-btn finish-btn-restart" onclick="doRestartGame()">🔄 再来一局</button>
          <button class="finish-btn finish-btn-lobby" onclick="backToLobby()">🚪 返回大厅</button>
        </div>
      </div>
    </div>
  `;

  container.innerHTML = html;

  const firstCard = container.querySelector('.finish-first');
  if (firstCard) {
    setTimeout(() => spawnConfetti(firstCard), 600);
  }
}

function _buildFallbackResults(view) {
  const scores = [];
  for (const p of view.players) {
    const cards = p.cards || [];
    const cardScore = cards.reduce((sum, c) => sum + (c.score || 0), 0);
    const adjustedScore = cardScore + Math.floor((p.funds || 0) / 3);
    scores.push({
      id: p.id, nickname: p.nickname, cardScore, adjustedScore, funds: p.funds,
      cardCount: p.cardCount, cards, isMe: p.isMe, rank: 0
    });
  }
  scores.sort((a, b) => {
    if (b.adjustedScore !== a.adjustedScore) return b.adjustedScore - a.adjustedScore;
    return b.funds - a.funds;
  });
  for (let i = 0; i < scores.length; i++) {
    if (i > 0 && scores[i].adjustedScore === scores[i-1].adjustedScore && scores[i].funds === scores[i-1].funds) {
      scores[i].rank = scores[i-1].rank;
    } else {
      scores[i].rank = i + 1;
    }
  }
  return scores;
}

// ==================== 我的状态栏 ====================

function _renderMyStatus(view) {
  const myStatus = document.getElementById('gameMyStatus');

  if (view.isSpectator) {
    if (myStatus) myStatus.style.display = 'none';
    return;
  }
  if (myStatus) myStatus.style.display = '';

  const me = view.players.find(p => p.id === socket.id);
  if (!me) return;

  const fundsEl = document.getElementById('myFunds');
  if (_lastFunds === null || _lastFunds !== me.funds) {
    const from = _lastFunds !== null ? _lastFunds : me.funds;
    animateValue(fundsEl, from, me.funds, 600);
    _lastFunds = me.funds;
  }

  document.getElementById('myCardCount').textContent = `${me.cardCount}张`;

  const effects = [];
  if (me.hasDragonPhoenix) effects.push('<span class="effect-tag">🐉🕊️</span>');
  if (me.hasReroll) effects.push('<span class="effect-tag">🎲×2</span>');
  if (me.hasDoubleComm) effects.push('<span class="effect-tag">💰×2</span>');
  if (me.hasUpgrade) effects.push('<span class="effect-tag">⬆️</span>');
  document.getElementById('myEffects').innerHTML = effects.join('');
}

// ==================== 玩家列表 ====================

function _renderPlayerList(view) {
  const allPlayers = view.players || [];
  const list = document.getElementById('otherList');
  const container = document.getElementById('gameOtherPlayers');

  if (!list || !container) {
    console.warn('[Game] 玩家列表 DOM 未找到');
    return;
  }

  container.style.display = 'flex';

  if (allPlayers.length === 0) {
    list.innerHTML = '<div class="player-row-placeholder">等待玩家数据…</div>';
    return;
  }

  let maxScore = -1, maxFunds = -1;
  for (const p of allPlayers) {
    const as = p.adjustedScore || p.cardScore || 0;
    if (as > maxScore) maxScore = as;
    if ((p.funds || 0) > maxFunds) maxFunds = p.funds || 0;
  }

  list.innerHTML = allPlayers.map(p => {
    const isMe = p.isMe || p.id === socket.id;
    const cardScore = p.cardScore || 0;
    const adjustedScore = p.adjustedScore != null ? p.adjustedScore : cardScore;
    const funds = p.funds || 0;
    const nickname = p.nickname || '未知';
    const isTopScore = adjustedScore > 0 && adjustedScore === maxScore && maxScore > 0;
    const isRichest = funds === maxFunds && maxFunds > 0;
    const botTag = p.isBot ? '<span class="pl-tag pl-tag-bot">AI</span>' : '';
    const managedTag = p.managed ? '<span class="pl-tag pl-tag-managed">托管</span>' : '';
    const avatarText = (nickname.charAt(0) || '?').toUpperCase();
    const moneyIcon = isRichest ? '💎' : '💰';
    const scoreIcon = isTopScore ? '👑' : '⭐';
    const scoreDisplay = `${adjustedScore}`;

    return `
      <div class="player-row${isMe ? ' is-me' : ''}" data-player-id="${p.id}" onclick="showPlayerDetailPopup(this, '${p.id}')">
        <div class="pl-avatar-col">
          <div class="pl-avatar">${avatarText}</div>
          <div class="pl-tag-row">${botTag}${managedTag}</div>
        </div>
        <div class="pl-main">
          <div class="pl-nick" title="${nickname}">${nickname}</div>
          <div class="pl-stats">${moneyIcon}$${funds} · ${scoreIcon}${scoreDisplay}</div>
        </div>
        <div class="pl-right">
          <span class="pl-expand-icon">▶</span>
        </div>
      </div>
    `;
  }).join('');

  // 应用装备的头像皮肤（仅限"我"）
  if (typeof applyAvatarSkin === 'function') {
    const myAvatarEl = list.querySelector('.player-row.is-me .pl-avatar');
    if (myAvatarEl) applyAvatarSkin(myAvatarEl);
  }
}

// ==================== 卡牌弹窗 ====================

function showCardPopup(cardId, cardName, isHidden, optScore, optEffect) {
  let popup = document.getElementById('card-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'card-popup';
    popup.className = 'card-popup';
    document.body.appendChild(popup);
  }

  const _ps = optScore !== undefined ? optScore : 0;
  const _pe = optEffect || 'none';

  if (isHidden || !cardId) {
    popup.innerHTML = `<div class="card-popup-content">
      <div class="card-popup-emoji">❓</div>
      <div class="card-popup-name">未揭示</div>
      <div class="card-popup-desc">此卡牌尚未被获得，信息隐藏</div>
    </div>`;
  } else {
    popup.innerHTML = `<div class="card-popup-content rarity-${getCardRarity(cardId)}">
      <div class="card-popup-emoji">${getCardFramedImageHtml(cardId, 'frame-xl')}</div>
      <div class="card-popup-name">${cardName}</div>
      <div class="card-popup-score">★ ${_ps} 分</div>
      <div class="card-popup-effect">${getEffectLabel(_pe)}</div>
      <div class="card-popup-lore">${CARD_LORE[cardId] || ''}</div>
    </div>`;
  }

  popup.style.display = 'block';
  popup._openedAt = Date.now();

  setTimeout(() => {
    const closePopup = (evt) => {
      if (evt.target.closest('.card-icon')) return;
      if (Date.now() - (popup._openedAt || 0) < 300) return;
      popup.style.display = 'none';
      document.removeEventListener('click', closePopup);
      document.removeEventListener('touchstart', closePopup);
    };
    document.removeEventListener('click', closePopup);
    document.removeEventListener('touchstart', closePopup);
    document.addEventListener('click', closePopup);
    document.addEventListener('touchstart', closePopup, { passive: true });
  }, 100);
}

// ==================== 玩家详情浮窗 ====================

function showPlayerDetailPopup(rowEl, playerId) {
  _closePlayerPopup();

  const view = _lastView;
  if (!view) return;
  const p = view.players.find(pp => pp.id === playerId);
  if (!p) return;

  const effectIcons = [];
  if (p.hasDragonPhoenix) effectIcons.push('🐉🐉');
  if (p.hasReroll) effectIcons.push('🎲🎲');
  if (p.hasDoubleComm) effectIcons.push('💰');
  if (p.hasUpgrade) effectIcons.push('⬆️');
  if (p.cards && p.cards.some(c => c.id === 'slj' && !c.used)) effectIcons.push('🪞');
  if (p.cards && p.cards.some(c => c.id === 'qmht')) effectIcons.push('📜');
  if (p.cards && p.cards.some(c => c.id === 'sxtc')) effectIcons.push('🐪');
  if (p.cards && p.cards.some(c => c.id === 'dhmh')) effectIcons.push('🛡️');
  const effects = effectIcons.join(' ');

  let cardDetail = '';
  if (p.cards && p.cards.length) {
    const icons = p.cards.map(c => {
      const scoreClass = 'score-' + (c.score || 1);
      const cardName = CARD_NAMES[c.id] || c.id;
      return `<img class="card-image card-img-xs card-icon ${scoreClass}" src="assets/cards/${c.id}.png" alt="${cardName}" title="${cardName} ★${c.score}"
        data-card-id="${c.id}" data-card-name="${cardName}"
        data-card-score="${c.score || 0}" data-card-effect="${c.effect || 'none'}"
        onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span class=\\'card-icon ${scoreClass}\\' data-card-id=\\'${c.id}\\' data-card-name=\\'${cardName}\\' data-card-score=\\'${c.score||0}\\' data-card-effect=\\'${c.effect||'none'}\\' role=\\'button\\' tabindex=\\'0\\'>★</span>')" />`;
    }).join('');
    const tags = p.cards.map(c => {
      const stars = '★'.repeat(c.score || 0);
      const color = c.score === 3 ? '#C43A31' : c.score === 2 ? '#8B6914' : '#2E5C8A';
      return `<span class="pp-card-tag" style="color:${color}">${CARD_NAMES[c.id] || c.id}${stars}</span>`;
    }).join(' ');
    cardDetail = `<div class="pp-cards">${icons}</div><div class="pp-card-names">${tags}</div>`;
  }

  let skillDetail = [];
  if (p.hasDragonPhoenix) skillDetail.push('【联动·龙凤】');
  if (p.hasReroll) skillDetail.push('【联动·重掷】');
  if (p.hasDoubleComm) skillDetail.push('【被动·特权】');
  if (p.hasUpgrade) skillDetail.push('【主动·飞升】可用');
  else if (p.cards && p.cards.some(c => c.id === 'dhft' && c.used)) skillDetail.push('【主动·飞升】已用');
  if (p.cards && p.cards.some(c => c.id === 'slj')) {
    const sljCard = p.cards.find(c => c.id === 'slj');
    skillDetail.push(sljCard?.used ? '【主动·决斗】已用' : '【主动·决斗】');
  }
  if (p.cards && p.cards.some(c => c.id === 'yqh')) skillDetail.push('【主动·重掷】');
  if (p.cards && p.cards.some(c => c.id === 'qmht')) skillDetail.push('【被动·传世】');
  if (p.cards && p.cards.some(c => c.id === 'sxtc')) skillDetail.push('【被动·通商】');
  if (p.cards && p.cards.some(c => c.id === 'dhmh')) skillDetail.push('【被动·护佑】');
  const skillStr = skillDetail.length ? `<div class="pp-skills">${skillDetail.join(' | ')}</div>` : '';

  const popup = document.createElement('div');
  popup.id = 'playerPopup';
  popup.className = 'player-popup';
  const isMe = p.isMe || p.id === socket.id;
  popup.innerHTML = `
    <span class="pp-close" onclick="_closePlayerPopup()">✕</span>
    <div class="pp-header">${p.nickname || '未知'} ${isMe ? '<span class="me-tag">你</span>' : ''}</div>
    <div class="pp-stats">💰 $${p.funds || 0} · ⭐ ${(p.cardScore||0) + Math.floor((p.funds||0) / 3)}分 · 🃏 ${p.cardCount||0}张 ${effects}</div>
    ${cardDetail ? `<div class="pp-cards-section">${cardDetail}</div>` : ''}
    ${skillStr}
  `;
  document.body.appendChild(popup);

  const rect = rowEl.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  let left = rect.right + 6;
  let top = rect.top;
  if (left + popupRect.width > window.innerWidth - 10) {
    left = rect.left - popupRect.width - 6;
  }
  if (left < 10) {
    left = rect.left;
    top = rect.bottom + 6;
  }
  if (top + popupRect.height > window.innerHeight - 10) {
    top = window.innerHeight - popupRect.height - 10;
  }
  if (top < 10) top = 10;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';

  setTimeout(() => {
    document.addEventListener('click', _onPopupOutsideClick, { once: true });
  }, 10);
}

function _onPopupOutsideClick(e) {
  const popup = document.getElementById('playerPopup');
  if (popup && !popup.contains(e.target) && !e.target.closest('.player-row')) {
    _closePlayerPopup();
  } else if (popup) {
    setTimeout(() => {
      document.addEventListener('click', _onPopupOutsideClick, { once: true });
    }, 10);
  }
}

function _closePlayerPopup() {
  const popup = document.getElementById('playerPopup');
  if (popup) popup.remove();
}

function _onCardIconClick(e) {
  const icon = e.target.closest('.card-icon');
  if (!icon) return;
  e.preventDefault();
  e.stopPropagation();
  const id = icon.dataset.cardId;
  const name = icon.dataset.cardName;
  const score = parseInt(icon.dataset.cardScore) || 0;
  const effect = icon.dataset.cardEffect || 'none';
  if (id && name) showCardPopup(id, name, false, score, effect);
}

function togglePlayerDetail(row) {
  showPlayerDetailPopup(row, row.dataset.playerId);
}

// ==================== 设置模态框 ====================

function toggleSettingsModal() {
  const overlay = document.getElementById('settingsModalOverlay');
  if (overlay) {
    overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
  }
}

// ==================== 本局牌堆总览 ====================

function showCardPool() {
  const modal = document.getElementById('cardPoolModal');
  if (!modal) return;
  modal.style.display = 'flex';

  const grid = document.getElementById('cardPoolGrid');
  const subEl = document.getElementById('cardPoolSub');
  if (!grid || !_cardPoolData) {
    grid.innerHTML = '<p style="color:#8C8C8C;text-align:center;">牌堆数据加载中...</p>';
    return;
  }

  const dealtCount = _cardPoolData.filter(c => c.dealt).length;
  if (subEl) {
    subEl.textContent = `共 ${_totalDeckSize || _cardPoolData.length} 张文物 · 已打出 ${dealtCount} 张`;
  }

  grid.innerHTML = _cardPoolData.map(c => {
    const acquiredClass = c.acquired ? ' acquired' : '';
    const scoreClass = 'score-' + (c.score || 1);
    const emojiHtml = getCardFramedImageHtml(c.id, 'frame-sm');

    let statusText = '';
    let statusClass = '';
    if (c.acquired) {
      statusText = `${c.acquiredBy} 获得`;
      statusClass = 'status-acquired';
    } else if (c.dealt) {
      statusText = '已打出';
      statusClass = 'status-dealt';
    } else {
      statusText = '未翻开';
      statusClass = 'status-hidden';
    }

    return `
      <div class="deck-item ${acquiredClass} ${scoreClass} ${c.dealt ? 'dealt' : ''}">
        <div class="deck-emoji">${emojiHtml}</div>
        <div class="deck-name">${c.name}</div>
        <div class="deck-score">★ ${c.score} 分</div>
        <div class="deck-status ${statusClass}">${statusText}</div>
      </div>`;
  }).join('');
}

function closeCardPool() {
  const modal = document.getElementById('cardPoolModal');
  if (modal) modal.style.display = 'none';
}

// ==================== 设置面板 ====================

function onVolumeChange(val) {
  const vol = parseInt(val) / 100;
  if (typeof SoundManager !== 'undefined') {
    if (vol === 0) {
      SoundManager.enabled = false;
      SoundManager.setVolume(0);
    } else {
      SoundManager.enabled = true;
      SoundManager.setVolume(vol);
    }
  } else if (typeof setMasterVolume === 'function') {
    setMasterVolume(vol);
  }
  const label = document.getElementById('volumeLabel');
  if (label) label.textContent = vol === 0 ? '🔇' : Math.round(vol * 100) + '%';
}

// ==================== 房间等待界面 ====================

function _renderRoomWait(view) {
  const el = document.getElementById('waitRoomId');
  if (el) el.textContent = GameState.roomId || '';

  const listEl = document.getElementById('waitPlayerList');
  if (listEl && view.players) {
    const readySet = view.readyPlayers ? new Set(view.readyPlayers) : null;
    listEl.innerHTML = view.players.map(p => {
      const isMe = p.id === socket.id;
      const isReady = readySet ? readySet.has(p.id) : false;
      const hostTag = GameState.isHost && p.id === socket.id ? ' <span class="bot-tag">房主</span>' : '';
      const meTag = isMe ? ' （你）' : '';
      return `<div class="wait-player-row">
        <span class="wait-player-name">👤 ${p.nickname || '??'}${meTag}${hostTag}</span>
        <span class="wait-player-status">${isReady ? '✅ 已准备' : '⏳ 未准备'}</span>
      </div>`;
    }).join('');
  }

  const hostCtl = document.getElementById('hostControls');
  const guestMsg = document.getElementById('guestMessage');
  const startBtn = document.getElementById('waitStartBtn');
  if (hostCtl && guestMsg) {
    const isHost = GameState.isHost;
    hostCtl.style.display = isHost ? 'block' : 'none';
    guestMsg.style.display = isHost ? 'none' : 'block';

    if (startBtn && isHost) {
      const readySet = view.readyPlayers ? new Set(view.readyPlayers) : new Set();
      const allReady = (view.players || []).every(p =>
        p.isBot || readySet.has(p.id)
      );
      startBtn.disabled = !allReady;
      startBtn.style.opacity = allReady ? '1' : '0.5';
      if (allReady) {
        startBtn.onclick = () => {
          if (typeof playSound === 'function') playSound('click');
          socket.emit('game:start', GameState.roomId);
        };
      }
    }
  }
}

console.log('[Game/Render] 渲染模块已加载');
