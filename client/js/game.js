// ============================================================
// game.js — 游戏主界面（完全由服务端 gameState 驱动渲染）
// ============================================================

// 缓存上一次状态用于 diff（动画触发等）
let _lastView = null;
let _renderVersion = 0;       // Bug1: 版本号防抖，避免竞态渲染
let _lastFunds = null;        // Bug3: 上次服务端确认的资金值，避免动画中间值污染
let _lastDuelRollAnimPlayed = false;  // 决斗掷骰动画防重复播放
let _settleTimer = null;      // 自动下一轮计时器
let _turnCountdownId = null;  // 客户端倒计时 interval ID
let _auctionResultTimer = null; // 拍卖师公示页计时器
let _auctionResultShown = false; // 当前轮次公示页是否已展示
let _roundTransitionTimer = null; // 回合切换横幅计时器
let _duelIntroTimer = null;       // 决斗开场动画计时器
let _cardRevealTimer = null;      // 卡牌揭晓动画计时器

// ==================== 入口：接收 game:state_update ====================

socket.on('game_state_update', (view) => {
  console.log(`[Game] ✓ 收到 game_state_update! phase=${view.phase}, round=${view.round}, view=${GameState.currentView}`);

  // ★ 已主动退出（托管中）→ 忽略游戏状态更新，防止被拉回游戏
  if (GameState._hasExitedManaged) {
    // 若上把游戏已结束或进入等待大厅，清理托管浮窗与标记
    if (view.phase === 'finished' || view.phase === 'waiting') {
      GameState._hasExitedManaged = false;
      const banner = document.getElementById('managedGameBanner');
      if (banner) banner.style.display = 'none';
      console.log('[Game] 托管对局已结束/重置，清理浮窗');
    } else {
      console.log('[Game] 已主动退出托管，忽略 game_state_update');
    }
    return;
  }

  // 缓存最新玩家列表（供 doRestartGame 使用）
  GameState._lastPlayers = view.players || [];

  // 观战者模式
  if (view.isSpectator) {
    GameState.isSpectator = true;
    if (GameState.currentView !== Views.GAME) {
      showView(Views.GAME);
    }
    renderGame(view);
    _lastView = view;
    return;
  }

  // 检测是否是"再来一局"的重加入响应（_isRejoin 标记）
  if (view._isRejoin) {
    showView(Views.LOBBY);

    // 更新玩家列表（每个玩家各自的状态 reset 后会不同）
    GameState.players = view.players || [];

    const roomIdEl = document.getElementById('roomIdDisplay');
    if (roomIdEl) roomIdEl.textContent = GameState.roomId;

    if (typeof renderPlayerList === 'function') {
      renderPlayerList(view.players);
    }
    if (typeof updateLobbyUI === 'function') {
      updateLobbyUI();
    }
    return;
  }

  // 检测是否是房主重启游戏的等待状态（全员进入大厅）
  if (view.phase === 'waiting') {
    showView(Views.LOBBY);

    const roomIdEl = document.getElementById('roomIdDisplay');
    if (roomIdEl) roomIdEl.textContent = GameState.roomId;

    if (typeof renderPlayerList === 'function') {
      renderPlayerList(view.players);
    }
    if (typeof updateLobbyUI === 'function') {
      updateLobbyUI();
    }
    return;
  }

  // 首次收到游戏状态 → 切到游戏视图
  if (GameState.currentView !== Views.GAME) {
    showView(Views.GAME);
  }

  renderGame(view);
  _lastView = view;
});

socket.on('game_error', (data) => {
  if (typeof showToast === 'function') {
    showToast(data.msg || '操作失败', 'error');
  }
});

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

  // ★ 同步托管按钮状态（服务端可能因游戏操作 unmanage 了玩家）
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
    // 非观战者：移除残留的观战栏
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

// ==================== P0-1 + P2-2: 回合切换横幅 ====================

// 中文数字映射
const _CN_NUMS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾',
  '拾壹', '拾贰', '拾叁', '拾肆', '拾伍', '拾陆', '拾柒', '拾捌', '拾玖', '贰拾'];

function _showRoundTransition(view) {
  if (_roundTransitionTimer) {
    clearTimeout(_roundTransitionTimer);
    _roundTransitionTimer = null;
  }
  const old = document.getElementById('roundTransitionOverlay');
  if (old) old.remove();

  const round = view.round;
  const maxRounds = view.maxRounds;
  const isFirstRound = round === 1;
  const isEndgame = round >= maxRounds - 2;

  const overlay = document.createElement('div');
  overlay.id = 'roundTransitionOverlay';
  overlay.className = 'round-transition-overlay';

  const roundCn = _CN_NUMS[round] || String(round);
  const title = isFirstRound ? '游戏开始' : `第 ${roundCn} 轮`;
  const subtitle = `共 ${maxRounds} 轮`;
  const endgameTag = isEndgame && !isFirstRound ? '<div class="rt-endgame">⚡ 终局倒计时</div>' : '';

  overlay.innerHTML = `
    <div class="rt-scroll">
      <div class="rt-content">
        <div class="rt-title">${title}</div>
        <div class="rt-subtitle">${subtitle}</div>
        ${endgameTag}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  if (typeof playSound === 'function') playSound('confirm');

  // 卷轴展开 ~400ms → 停留 1200ms → 卷轴收起 300ms
  _roundTransitionTimer = setTimeout(() => {
    overlay.classList.add('rt-fade-out');
    _roundTransitionTimer = setTimeout(() => {
      overlay.remove();
      _roundTransitionTimer = null;
    }, 300);
  }, 1600);
}

// ==================== P2-1: 决斗开场动画 ====================

function _showDuelIntro(view, container) {
  // 清除上一次
  if (_duelIntroTimer) {
    clearTimeout(_duelIntroTimer);
    _duelIntroTimer = null;
  }

  const duel = view.duel;
  if (!duel) return;

  const initiator = view.players.find(p => p.id === duel.initiatorId);
  const target = view.players.find(p => p.id === duel.targetId);
  const initName = initiator?.nickname || '?';
  const targetName = target?.nickname || '?';

  // 音效
  if (typeof playSound === 'function') playSound('duel');

  container.innerHTML = `
    <div class="duel-intro-overlay">
      <div class="di-flash"></div>
      <div class="di-scan-line"></div>
      <div class="di-content">
        <div class="di-vs-layout">
          <div class="di-player di-left">
            <div class="di-avatar">🪞</div>
            <div class="di-name">${initName}</div>
            <div class="di-role">发起者</div>
          </div>
          <div class="di-vs-text">VS</div>
          <div class="di-player di-right">
            <div class="di-avatar">🪞</div>
            <div class="di-name">${targetName}</div>
            <div class="di-role">被挑战</div>
          </div>
        </div>
        <div class="di-title">⚔️ 镜中决斗 ⚔️</div>
        <div class="di-subtitle">双鸾双兽镜的神秘力量被激活！</div>
      </div>
    </div>
  `;

  _duelIntroTimer = setTimeout(() => {
    _duelIntroTimer = null;
    // 渲染实际决斗面板
    _renderActionContent(view, container);
    container.classList.add('phase-enter');
    setTimeout(() => container.classList.remove('phase-enter'), 300);
  }, 2200);
}

function leaveSpectate() {
  if (typeof playSound === 'function') playSound('click');
  if (GameState.roomId) {
    socket.emit('spectator:leave', GameState.roomId);
  }
  GameState._justLeftSpectate = true;  // ★ 标记刚退出观战，room:left 处理时回到房间界面
  GameState.isSpectator = false;
  GameState.gameInProgress = false;
  // 清理观战栏
  const sbar = document.getElementById('spectatorBar');
  if (sbar) sbar.remove();
  showView(Views.LOBBY);
}

// ==================== 顶部相位栏 + 视觉展示区 ====================

const PHASE_ICONS = {
  auction: '🏛️',
  selectCard: '👑',
  rentDice: '🎲',
  rollDice: '🎲',
  settle: '📊',
  duel: '🪞',
  finished: '🏆',
};

function _renderPhaseBar(view) {
  // 回合/阶段文字
  document.getElementById('gameRoundLabel').textContent =
    `第 ${view.round}/${view.maxRounds} 轮`;
  const phaseLabel = PHASE_LABELS[view.phase] || view.phase;
  const spectatorTag = view.isSpectator ? ' · 👁️观战' : '';
  document.getElementById('gamePhaseLabel').textContent = phaseLabel + spectatorTag;

  const normalVisual = document.getElementById('phaseVisualNormal');
  const duelVisual = document.getElementById('phaseVisualDuel');
  const visualWrap = document.querySelector('.game-phase-visual');
  const phaseBar = document.querySelector('.game-phase-bar');

  // 阶段切换动效：只在 phase 真正变化时触发一次
  const prevPhase = _lastView?.phase;
  const phaseChanged = prevPhase && prevPhase !== view.phase;
  if (phaseChanged) {
    if (visualWrap) {
      visualWrap.classList.remove('phase-change-active');
      void visualWrap.offsetWidth; // 强制重排，允许重新触发动画
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

  // 决斗阶段：在顶部视觉区也展示 VS 动效
  if (view.phase === 'duel' && view.duel && normalVisual && duelVisual) {
    normalVisual.style.display = 'none';
    duelVisual.style.display = 'flex';
    duelVisual.classList.add('active');
    // 只有首次进入决斗阶段或决斗对象变化时才重新渲染，避免动画重复触发
    const lastDuel = _lastView?.duel;
    const changed = !lastDuel || lastDuel.initiatorId !== view.duel.initiatorId || lastDuel.targetId !== view.duel.targetId;
    if (changed) {
      _renderDuelPhaseVisual(view, duelVisual);
    }
    return;
  }

  // 非决斗阶段：恢复常规视觉区
  if (normalVisual) normalVisual.style.display = 'flex';
  if (duelVisual) {
    duelVisual.style.display = 'none';
    duelVisual.classList.remove('active');
  }

  // 相位图标/卡牌展示
  const iconEl = document.getElementById('phaseIcon');
  const cardMiniEl = document.getElementById('phaseCardMini');
  const cardNameEl = document.getElementById('phaseCardName');
  const cardScoreEl = document.getElementById('phaseCardScore');
  const cardFramedEl = document.getElementById('phaseCardFramed');

  const card = view.revealedCard;
  const phaseIcon = PHASE_ICONS[view.phase] || '🏛️';

  if (card && !card.hidden) {
    // 有卡牌且可见 → 使用与结算区一致的 artifact-frame 框
    iconEl.style.display = 'none';
    cardMiniEl.style.display = 'flex';
    cardFramedEl.innerHTML = typeof getCardFramedImageHtml === 'function'
      ? getCardFramedImageHtml(card.id || card.name, 'frame-lg')
      : `<img src="assets/cards/${card.id || card.name}.png" alt="${card.name}" style="width:82px;height:82px;border-radius:8px;object-fit:cover;" onerror="this.style.display='none'" />`;
    cardNameEl.textContent = card.name || '';
    cardScoreEl.textContent = `★ ${card.score} 分`;
  } else if (card && card.hidden) {
    // 卡牌未揭示
    iconEl.style.display = 'flex';
    cardMiniEl.style.display = 'none';
    iconEl.textContent = '❓';
    cardNameEl.textContent = '待揭示';
    cardScoreEl.textContent = '';
  } else {
    // 无卡牌 → 显示相位图标
    iconEl.style.display = 'flex';
    cardMiniEl.style.display = 'none';
    iconEl.textContent = phaseIcon;
    cardNameEl.textContent = '';
    cardScoreEl.textContent = '';
  }

  // 确保图标容器可见（可能被皇冠动画隐藏）
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

// ==================== 操作区（按阶段） ====================

function _renderActionArea(view) {
  const container = document.getElementById('gameActionArea');
  const prevPhase = _lastView ? _lastView.phase : '';
  const newPhase = view.phase;
  const thisVersion = ++_renderVersion;  // Bug1: 获取版本号

  // ★ 清除倒计时
  _stopTurnCountdown();
  _clearSettleTimer();

  // 观战者：只显示观战提示，不显示操作按钮
  if (view.isSpectator) {
    _renderSpectatorAction(view, container);
    return;
  }

  // 决斗开场动画播放中，跳过渲染（防止覆盖动画）
  if (_duelIntroTimer && newPhase === 'duel') {
    return;
  }

  // 拍卖师公示页展示中 — 如果游戏已推进到其他阶段（bot 快速选卡），取消公示页
  if (_auctionResultTimer && newPhase !== 'selectCard') {
    clearTimeout(_auctionResultTimer);
    _auctionResultTimer = null;
    // 继续渲染新阶段（不 return）
  }

  // 拍卖师公示页展示中且仍在 selectCard 阶段 — 跳过渲染（防止覆盖动画）
  if (_auctionResultTimer && newPhase === 'selectCard') {
    return;
  }

  // 方案B：拍卖师公示页 — 从 auction 进入 selectCard 时先展示 2.8s
  if (newPhase === 'selectCard' && prevPhase === 'auction' && !_auctionResultShown && view.lastBidResults) {
    _auctionResultShown = true;
    _renderAuctionResult(view, container);
    _auctionResultTimer = setTimeout(() => {
      _auctionResultTimer = null;
      // Guard: 如果游戏已经离开 selectCard（bot 快速选卡导致进入 rentDice），
      // 不要用过期的 selectCard view 覆盖当前 UI
      if (_lastView && _lastView.phase !== 'selectCard') {
        return;
      }
      _renderActionContent(view, container);
      container.classList.add('phase-enter');
      setTimeout(() => container.classList.remove('phase-enter'), 300);
    }, 2800);
    return;
  }

  // P2-1: 决斗开场动画 — 首次进入 duel 阶段时播放
  if (newPhase === 'duel' && prevPhase !== 'duel' && view.duel && !_duelIntroTimer) {
    _showDuelIntro(view, container);
    return;
  }

  // 新轮次重置公示页状态
  if (newPhase === 'auction') {
    _auctionResultShown = false;
  }

  if (prevPhase && prevPhase !== newPhase) {
    container.classList.add('phase-leave');
    setTimeout(() => {
      if (_renderVersion !== thisVersion) return;  // Bug1: 被新状态覆盖，跳过
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
  // ★ 教程模式：渲染引导面板 + 阶段内容
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

  // 结束阶段也有自动倒计时（观战者也能看到）
  if (view.phase === 'settle') {
    _renderSettle(view, container);  // 观战者也能看结算页
    return;
  }

  if (view.phase === 'finished') {
    _renderFinished(view, container);  // 观战者也能看终局
    return;
  }

  // 其他阶段：显示观战提示
  const phaseMessages = {
    auction: { icon: '💰', text: '拍卖师竞选中', sub: '玩家们正在秘密报价...' },
    selectCard: { icon: '🃏', text: '拍卖师选卡中', sub: '等待拍卖师从牌堆中选择...' },
    rentDice: { icon: '🎲', text: '玩家租骰中', sub: '玩家们正在选择骰子...' },
    rollDice: { icon: '🎯', text: '掷骰中', sub: '签筒抽签进行中...' },
    duel: { icon: '🪞', text: '镜中决斗', sub: '决斗正在进行...' },
  };

  const msg = phaseMessages[view.phase] || { icon: '👁️', text: '观战中', sub: '' };

  // rollDice 阶段也显示签筒和计分板
  if (view.phase === 'rollDice') {
    _renderRollDice(view, container);
    return;
  }

  // duel 阶段也显示决斗面板
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

// ==================== 方案B：拍卖师公示页 ====================

function _renderAuctionResult(view, container) {
  container.className = 'game-action-area';
  const result = view.lastBidResults;
  if (!result) return;

  if (typeof playSound === 'function') playSound('confirm');

  // 顶部视觉区皇冠动画
  if (!result.allPass) {
    _showCrownBurst(result.winnerName, result.commissionRate);
  }

  // 全员放弃
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

  // 正常公示
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

function _showCrownBurst(winnerName, commissionRate) {
  const burst = document.getElementById('phaseCrownBurst');
  const normalVisual = document.getElementById('phaseVisualNormal');
  const duelVisual = document.getElementById('phaseVisualDuel');
  if (!burst) return;

  // 隐藏上方常规/决斗视觉，只显示皇冠
  if (normalVisual) normalVisual.style.display = 'none';
  if (duelVisual) {
    duelVisual.style.display = 'none';
    duelVisual.classList.remove('active');
  }

  // 重置动画
  burst.classList.remove('burst-active');
  burst.style.display = 'block';
  void burst.offsetWidth;
  burst.classList.add('burst-active');

  // 1.2s 后隐藏皇冠并恢复图标容器（下一状态会重绘内容）
  setTimeout(() => {
    burst.classList.remove('burst-active');
    burst.style.display = 'none';
    if (normalVisual) normalVisual.style.display = 'flex';
  }, 1200);
}

// ==================== 拍卖阶段 ====================

function _renderAuction(view, container) {
  const myBid = view.bids.find(b => b.playerId === socket.id);

  // 我已报价 → P0-2: 显示玩家提交状态列表
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

  // 未报价 → 显示报价按钮（所有人同时可操作）
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

function _bidBtn(pct, currentMin) {
  const disabled = currentMin !== null && pct >= currentMin;
  return `<button class="bid-btn" ${disabled ? 'disabled' : ''}
    onclick="doBid(${pct})">
    <span>${pct}%</span>
    ${disabled ? '<span class="bid-hint">不可用</span>' : ''}
  </button>`;
}

function doBid(percentage) {
  if (typeof playSound === 'function') playSound('bid');
  socket.emit('game:bid', GameState.roomId, percentage, (res) => {
    if (!res.success) {
      showToast(res.error || '出价失败', 'error');
    }
  });
}

// ==================== 选卡阶段 ====================

function _renderSelectCard(view, container) {
  const isMe = view.auctioneerId === socket.id;

  if (!isMe) {
    // P1-1: 旁观者体验 — 牌堆剩余数量 + 文案轮替
    const auctioneer = view.players.find(p => p.id === view.auctioneerId);
    const isBot = auctioneer && (auctioneer.isBot || auctioneer.managed);
    const deckSize = view.deckSize || 0;

    // 轮替文案
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

  // 我是拍卖师 → 选卡
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

function doSelectCard(index) {
  if (typeof playSound === 'function') playSound('click');
  socket.emit('game:select_card', GameState.roomId, index, (res) => {
    if (!res.success) {
      showToast(res.error || '选卡失败', 'error');
    }
  });
}

// ==================== 租骰阶段 ====================

function _renderRentDice(view, container) {
  const mySelect = view.diceSelections[socket.id];

  // 我是拍卖师
  if (mySelect === 'auctioneer') {
    _renderWaiting(container, '作为拍卖师，你不参与掷骰');
    return;
  }

  // 我已选过 / 已确认 done → 等待投骰
  if (mySelect && mySelect !== 'waiting') {
    _renderDiceWaiting(view, container);
    return;
  }

  // 轮到我了 → 选骰子（checkbox 一体化）
  container.className = 'game-action-area my-turn';

  const costs = view.diceCosts || { d4: 1, d6: 2, d12: 4, d20: 6, pass: 0 };
  const me = view.players.find(p => p.id === socket.id);
  const myFunds = me ? me.funds : 0;
  const hasUpgrade = view.hasUpgrade;

  const UPGRADE_MAP = { d4: 'd6', d6: 'd12', d12: 'd20' };

  const diceTypes = [
    { type: 'd4', sides: 4, ev: 2.5, cost: costs.d4 },
    { type: 'd6', sides: 6, ev: 3.5, cost: costs.d6 },
    { type: 'd12', sides: 12, ev: 6.5, cost: costs.d12 },
    { type: 'd20', sides: 20, ev: 10.5, cost: costs.d20 },
  ];

  const buttons = diceTypes.map(d => {
    const canAfford = myFunds >= d.cost;
    const upgraded = UPGRADE_MAP[d.type];
    return `<button class="dice-btn${!canAfford ? ' disabled' : ''}"
      onclick="doSelectDiceWithUpgrade('${d.type}')">
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

  container.innerHTML = `
    <div class="action-title">🎲 选择你的骰子</div>
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

  // 重置 checkbox 状态
  if (hasUpgrade) {
    setTimeout(() => {
      const cb = document.getElementById('useUpgradeCheck');
      if (cb) cb.checked = false;
      onUpgradeCheckChange();
    }, 0);
  }
}

// checkbox 切换时更新骰子按钮预览
function onUpgradeCheckChange() {
  const checked = document.getElementById('useUpgradeCheck')?.checked || false;
  const UPGRADE_MAP = { d4: 'd6', d6: 'd12', d12: 'd20' };
  const previews = document.querySelectorAll('.dice-upgrade-preview');
  const buttons = document.querySelectorAll('.dice-btn');

  // d20 不可升级，勾选时不显示预览
  previews.forEach((preview, i) => {
    const btnText = buttons[i]?.querySelector('.dice-name')?.textContent || '';
    const diceType = btnText.replace(/[^a-z0-9]/gi, '');
    const target = UPGRADE_MAP[diceType];
    if (checked && target) {
      preview.textContent = ` → ${target}`;
      preview.style.color = '#D4A017';
    } else {
      preview.textContent = '';
    }
  });
}

function doSelectDiceWithUpgrade(diceType) {
  if (typeof playSound === 'function') playSound('diceShake');
  const useUpgrade = document.getElementById('useUpgradeCheck')?.checked || false;
  if (diceType === 'd20') {
    // d20 不可升级，忽略 checkbox
    socket.emit('game:select_dice_with_upgrade', GameState.roomId, diceType, false, (res) => {
      if (!res.success) showToast(res.error || '操作失败', 'error');
    });
    return;
  }

  socket.emit('game:select_dice_with_upgrade', GameState.roomId, diceType, useUpgrade, (res) => {
    if (!res.success) {
      showToast(res.error || '操作失败', 'error');
    }
  });
}

function doSelectDice(diceType) {
  // Bug2: 防止点击 disabled 按钮 / 资金不足（手机端兼容）
  if (diceType !== 'pass' && _lastView) {
    const costs = _lastView.diceCosts || { d4: 1, d6: 2, d12: 4, d20: 6 };
    const me = _lastView.players.find(p => p.isMe);
    const myFunds = me ? me.funds : 0;
    if (myFunds < costs[diceType]) {
      showToast('资金不足', 'error');
      return;
    }
  }
  socket.emit('game:select_dice', GameState.roomId, diceType, (res) => {
    if (!res.success) {
      showToast(res.error || '操作失败', 'error');
    }
  });
}

function doRollDice() {
  if (typeof playSound === 'function') playSound('click');
  socket.emit('game:roll_dice', GameState.roomId, (res) => {
    if (!res.success) {
      showToast(res.error || '掷骰失败', 'error');
    }
  });
}

function _renderDiceWaiting(view, container) {
  container.className = 'game-action-area';

  // P1-3: 显示每人选骰状态
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

// ==================== 掷骰阶段（Canvas 粒子骰）====================

function _renderRollDice(view, container) {
  container.className = 'game-action-area';

  const results = view.diceResults || {};
  const selections = view.diceSelections || {};
  const rawResult = results[socket.id];
  const myDiceType = selections[socket.id] || '?';

  // 兼容新格式（reroll: { value, v1, v2, reroll: true }）
  const isReroll = rawResult && typeof rawResult === 'object' && rawResult.reroll;
  const myResult = isReroll ? rawResult.value : rawResult;
  const myV2 = isReroll ? rawResult.v2 : null;

  // 全员 Pass
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

  // ===== 自己骰子区（Canvas 粒子骰）=====
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

  // ===== 计分板（初始隐藏，签筒动画结束后淡入） =====
  const _valOf = (v) => v !== null ? ((typeof v === 'object' && v.value != null) ? v.value : v) : -1;

  // 包含所有玩家（拍卖师显示 —），按得分排序
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

  // Canvas 粒子骰动画（仅在有结果的玩家上播放）
  if (myResult !== null && myResult !== undefined) {
    const startDelay = (myResult !== null && myResult !== undefined) ? 150 : 0;
    setTimeout(() => {
      const area = document.getElementById('diceParticleArea');
      if (!area) return;
      const displayNum = isReroll ? rawResult.v1 : myResult;
      const v2 = isReroll ? rawResult.v2 : null;
      startDiceAnimation(area, myDiceType, displayNum, isReroll, v2);
    }, startDelay);
  }

  // 计分板延迟显示
  const scoreboardDelay = (myResult !== null && myResult !== undefined) ? 2400 : 500;
  setTimeout(() => {
    const sb = document.querySelector('.dice-scoreboard');
    if (sb) sb.classList.replace('sb-hidden', 'sb-visible');
  }, scoreboardDelay);

  if (typeof playSound === 'function') {
    setTimeout(() => playSound('diceRoll'), 200);
  }
}


// ==================== 镜中决斗阶段（重做版）====================

function _renderDuel(view, container) {
  // 决斗音效（仅首次触发）
  if (!_renderDuel._playedSound) {
    _renderDuel._playedSound = true;
    if (typeof playSound === 'function') playSound('duel');
  }
  const duel = view.duel;
  console.log('[Duel] Render called. phase:', view.phase, 'duel:', duel ? JSON.stringify({ step: duel.step, initiatorId: duel.initiatorId, targetId: duel.targetId }) : 'null');

  if (!duel) {
    console.warn('[Duel] view.duel is null/undefined!');
    container.innerHTML = '<div class="game-action-area"><p style="color:#C43A31;text-align:center;padding:20px;">决斗已结束，等待结算...</p></div>';
    return;
  }

  try {
    switch (duel.step) {
      case 'select_target':
        _renderDuelSelectTarget(view, container);
        break;
      case 'select_card':
        _renderDuelSelectCard(view, container);
        break;
      case 'rent_dice':
        _renderDuelRentDice(view, container);
        break;
      case 'roll_dice':
        _renderDuelRollDice(view, container);
        break;
      case 'resolve':
        _renderDuelResolved(view, container, duel);
        break;
      default:
        console.warn('[Duel] Unknown step:', duel.step);
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

  // 与正常拍卖完全一致的骰子选择 UI
  container.className = 'game-action-area my-turn';

  const costs = { d4: 1, d6: 2, d12: 4, d20: 6 };
  const me = view.players.find(p => p.id === socket.id);
  const myFunds = me?.funds || 0;
  const hasUpgrade = me?.hasUpgrade || false;

  const UPGRADE_MAP = { d4: 'd6', d6: 'd12', d12: 'd20' };

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

  // Fix#1: 决斗阶段显示被争夺的卡牌
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

  // 重置 checkbox 状态（与正常拍卖一致）
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

  // 非参与者等待提示
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

  // === Canvas 粒子骰（与正常拍卖一致）===
  const isReroll = myResult.reroll;
  const displayNum = isReroll ? myResult.v1 : myResult.value;
  const v2 = isReroll ? myResult.v2 : null;

  // 对手信息
  const opponentId = duel.initiatorId === socket.id ? duel.targetId : duel.initiatorId;
  const oppResult = diceResults[opponentId];
  const oppName = view.players.find(p => p.id === opponentId)?.nickname || '?';
  const oppVal = oppResult && oppResult.value != null ? oppResult.value : null;
  const oppDiceType = duel.diceSelections[opponentId] || '?';

  // Fix#1: 决斗阶段显示被争夺的卡牌
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

  // 计分板（初始隐藏，签筒动画结束后淡入）
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

  // Canvas 粒子骰动画
  setTimeout(() => {
    const area = document.getElementById('diceParticleArea');
    if (!area) return;
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

  // Fix#2: 防御性 fallback
  const winnerName = winner?.nickname || '未知玩家';
  const loserName = loser?.nickname || '未知玩家';
  const winnerVal = diceResults[duel.winnerId]?.value || '?';
  const loserVal = diceResults[duel.loserId]?.value || '?';

  // 音效
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

// Duel 操作函数
function doDuelSelectTarget(targetId) {
  socket.emit('game:duel_select_target', GameState.roomId, targetId);
}

function doDuelSelectCard(cardId) {
  socket.emit('game:duel_select_card', GameState.roomId, cardId);
}

function doDuelRentDice(diceType) {
  if (typeof playSound === 'function') playSound('diceShake');
  let useUpgrade = false;
  const cb = document.getElementById('useUpgradeCheck');
  if (cb) useUpgrade = cb.checked;
  socket.emit('game:duel_rent_dice', GameState.roomId, diceType, useUpgrade);
}


// ==================== 结算阶段 ====================

function _renderSettle(view, container) {
  container.className = 'game-action-area';

  // 结算音效
  if (_lastView && _lastView.phase === 'rollDice' && typeof playSound === 'function') {
    playSound('victory');
  }

  // 找胜者（上一轮掷骰胜者 = 刚获得卡牌的玩家，兼容 reroll 对象格式）
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

  // P0-3: 平局重掷提示
  const tieBanner = (view.tieInfo && view.tieInfo.hadTie)
    ? `<div class="settle-tie-banner">⚔️ 平局！经过 ${view.tieInfo.depth} 次重掷决出胜负</div>`
    : '';

  // 骰子对比表
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

  // 佣金明细
  const commissionRate = view.commissionRate || 0;
  const auctioneerStreak = view.auctioneerStreak || 0;
  const hasDoubleComm = auctioneer?.cards?.some(c => c.id === 'sq');
  const hasShield = auctioneer?.cards?.some(c => c.id === 'dhmh');
  let penalty = Math.max(0, auctioneerStreak - 1);
  if (hasShield) penalty = Math.floor(penalty / 2);

  // 计算总骰子支出（从 diceSelections 推算）
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

  // 自动下一轮 5s 倒计时
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

function doEndRound() {
  if (typeof playSound === 'function') playSound('click');
  socket.emit('game:end_round', GameState.roomId, (res) => {
    if (!res.success) {
      showToast(res.error || '操作失败', 'error');
    } else if (res.finished) {
      showToast('游戏结束！', 'info');
    }
  });
}

// ==================== 终局 ====================

// 卡牌数据（中文名、介绍、分值色）—— 键与 server/gameEngine.js CARDS[id] 一致
const CARD_NAMES = {
  sxqts:'青铜神树', qsbmy:'兵马俑',
  qmht: '清明上河图', syfz:'四羊方尊',
  slj:  '双鸾双兽镜', jlyy:'金缕玉衣',
  ltsx: '兰亭序', zhybz:'曾侯乙编钟',
  yqz:  '影青盏', yqh:'元青花',
  dhmh: '敦煌壁画', rytqy:'汝窑天青釉',
  kxqt: '快雪时晴帖', jgpx:'甲骨卜辞',
  dhft: '敦煌飞天', sq:'市券',
  sxtc: '三彩驼', cjgb:'鸡缸杯',
  jofjg:'金瓯永固杯', dhcxb:'沉香雕笔'
};

const CARD_LORE = {
  sxqts: '青铜神树，商代古蜀文明遗珍，1986年出土于四川广汉三星堆遗址。树高396cm，分三层九枝，枝头立神鸟，树干盘游龙。是古蜀人"沟通天地"的精神图腾。',
  qsbmy: '兵马俑，秦代陶塑艺术巅峰，1974年发现于陕西临潼秦始皇陵。八千真人大小陶俑组成地下军团，千人千面无一雷同。被誉为"世界第八大奇迹"。',
  qmht: '清明上河图，北宋张择端绘。纵24.8cm、横528.7cm，描摹汴京清明时节的繁华景象。人物逾八百、舟车数十，是中国古代风俗画的巅峰之作。持有此画者终局额外加2分。',
  syfz: '四羊方尊，商代晚期青铜礼器，1938年出土于湖南宁乡。器身四角各铸一羊，寓"吉祥四方"。造型雄奇、铸造精绝，是商代青铜艺术的最高成就之一。',
  slj: '双鸾双兽镜，汉代铜镜精品。镜背铸有双鸾双兽纹饰，造型灵动。镜中世界暗藏玄机——持有此镜者，终局时可发起"镜中决斗"，与对手各押一宝，出价高者夺得对方珍品。',
  jlyy: '金缕玉衣，汉代帝王丧葬殓服。以金丝连缀两千余片和田玉片，耗时十年方成。古人相信玉石可保尸身不朽、灵魂永生。现存最完整的一件出土于河北满城汉墓。',
  ltsx: '兰亭序，东晋王羲之书，永和九年（公元353年）作于会稽山阴。通篇324字，笔法"飘若浮云，矫若惊龙"，被誉为"天下第一行书"。与快雪时晴帖并藏，所有1分文物各加1分。',
  zhybz: '曾侯乙编钟，战国早期青铜礼乐器，1978年出土于湖北随州。全套65件，总重逾2500公斤，音域跨越五个半八度。是世界音乐史上最伟大的考古发现之一。',
  yqz: '影青盏，宋代景德镇窑青白瓷精品。釉色介于青白之间，薄如纸、明如镜、声如磬。宋人崇尚简约之美，影青瓷正是这种审美理想的化身。',
  yqh: '元青花，元代景德镇创烧的釉下彩瓷。以进口"苏麻离青"钴料绘制，蓝白相间、浓淡相宜。开创了中国瓷器彩绘的新纪元。持有者可独立掷骰重取高值。',
  dhmh: '敦煌壁画，莫高窟是世界上规模最大、保存最完整的佛教艺术宝库。现存洞窟735个、壁画4.5万平方米。持有壁画者担任拍卖师时，连任惩罚减半——大漠千年，佛光护佑。',
  rytqy: '汝窑天青釉，宋代五大名窑之首。釉色"雨过天青云破处"，传世不足百件、件件国宝。与甲骨卜辞同时持有，掷骰可窥天机、重掷取高值。',
  kxqt: '快雪时晴帖，东晋王羲之致友人短札，全文仅三行二十八字："羲之顿首，快雪时晴，佳想安善……"是现存最可靠的王羲之真迹摹本。与兰亭序并藏触发联动。',
  jgpx: '甲骨卜辞，商代王室占卜记录。刻于龟甲兽骨之上，是汉字最早的成熟形态。殷墟出土甲骨逾十五万片，为研究商代历史提供了第一手资料。与汝窑天青釉联动掷骰。',
  dhft: '敦煌飞天，莫高窟壁画中最为灵动的形象。飞天手持乐器或花篮，衣带当风、翩翩起舞，融合了印度佛教天人形象与中国道教羽人传统。持有时可升级骰子一级。',
  sq: '市券，汉代商业凭证。汉代"市"为官方指定的交易场所，入市交易须持有市券，相当于古代的市场许可证。持券者担任拍卖师时可获双倍佣金。',
  sxtc: '三彩驼，唐代三彩釉陶精品。骆驼昂首嘶鸣，背上驮着丝绸、瓷器与西域香料。它是丝绸之路最鲜活的缩影。持有此驼者每轮可获$1商旅补给。',
  cjgb: '鸡缸杯，明成化斗彩瓷器的巅峰之作。杯身绘子母鸡图，胎薄釉润，万历时已"值钱十万"。2014年一件成化鸡缸杯以2.8亿港元成交，轰动全球。',
  jofjg: '金瓯永固杯，清乾隆年间御制金器。以黄金打造，镶嵌珍珠宝石，杯身刻"金瓯永固"四字，寓江山永固之意。是清代宫廷工艺的集大成之作。',
  dhcxb: '沉香雕笔，明代文房珍宝。以沉香木雕刻而成，笔杆饰以山水人物纹。明代士大夫崇尚雅致生活，文房用具极尽工巧。此笔承载着千年文人的书斋清梦。'
};

const CARD_COLORS = { 1: '#2E5C8A', 2: '#8B6914', 3: '#C43A31' };

const RANK_MEDALS = { 1: '👑', 2: '🥈', 3: '🥉' };

function _renderFinished(view, container) {
  container.className = 'game-action-area';

  // ★ 教程模式：显示完成页
  if (GameState._tutorial && GameState._tutorial.active) {
    const completeHtml = renderTutorialComplete();
    if (completeHtml) {
      container.innerHTML = completeHtml;
      return;
    }
  }

  if (typeof playSound === 'function') playSound('gameOver');
  // 停止背景音乐
  if (typeof SoundManager !== 'undefined') SoundManager.stopAmbient();

  // 用服务端返回的 finalResults，若缺失则回退构建
  const results = (view.finalResults && view.finalResults.length
    ? view.finalResults
    : _buildFallbackResults(view)).map(r => ({ ...r, isMe: r.id === socket.id }));

  const totalRounds = view.round - 1;

  // 收集所有出现过的卡牌 ID（用于文物图鉴）
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
            const prevScore = i > 0 ? results[i-1].cardScore : -1;
            const prevFunds = i > 0 ? results[i-1].funds : -1;
            const trulyTied = i > 0 && r.cardScore === prevScore && r.funds === prevFunds
              && r.cardScore !== results[0].cardScore;

            const cards = r.cards && r.cards.length ? r.cards : [];
            const cardScore = r.cardScore != null ? r.cardScore : cards.reduce((sum, c) => sum + (c.score || 0), 0);

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
                <span class="score-num">${cardScore}</span>
                <span class="score-label">分</span>
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

  // 撒花粒子（第一名延迟 0.6s 出现）
  const firstCard = container.querySelector('.finish-first');
  if (firstCard) {
    setTimeout(() => spawnConfetti(firstCard), 600);
  }
}

// 回退构建（服务端未返回 finalResults 时用）
function _buildFallbackResults(view) {
  const scores = [];
  for (const p of view.players) {
    const cards = p.cards || [];
    const cardScore = cards.reduce((sum, c) => sum + (c.score || 0), 0);
    scores.push({
      id: p.id, nickname: p.nickname, cardScore, funds: p.funds,
      cardCount: p.cardCount, cards, isMe: p.isMe, rank: 0
    });
  }
  scores.sort((a, b) => {
    if (b.cardScore !== a.cardScore) return b.cardScore - a.cardScore;
    return b.funds - a.funds;
  });
  for (let i = 0; i < scores.length; i++) {
    if (i > 0 && scores[i].cardScore === scores[i-1].cardScore && scores[i].funds === scores[i-1].funds) {
      scores[i].rank = scores[i-1].rank;
    } else {
      scores[i].rank = i + 1;
    }
  }
  return scores;
}

// 撒花粒子效果
function spawnConfetti(parent) {
  const colors = ['#C43A31', '#D4AF37', '#FFD700', '#FFF', '#F5E6C8', '#C9A96E'];
  const angleRange = { min: -60, max: 60 };
  const distanceRange = { min: 60, max: 180 };

  const frag = document.createDocumentFragment();
  for (let i = 0; i < 14; i++) {
    const dot = document.createElement('span');
    dot.className = 'confetti-dot';
    dot.style.setProperty('--c', colors[Math.floor(Math.random() * colors.length)]);
    dot.style.setProperty('--dx', `${(Math.random() - 0.5) * (angleRange.max - angleRange.min)}px`);
    dot.style.setProperty('--dy', `${-(distanceRange.min + Math.random() * (distanceRange.max - distanceRange.min))}px`);
    dot.style.setProperty('--d', `${0.8 + Math.random() * 0.4}s`);
    dot.style.setProperty('--rot', `${Math.random() * 720}deg`);
    dot.style.setProperty('--delay', `${Math.random() * 0.3}s`);
    dot.style.setProperty('--sz', `${6 + Math.random() * 6}px`);
    frag.appendChild(dot);
  }
  parent.appendChild(frag);

  // 1.5s 后清除
  setTimeout(() => {
    const dots = parent.querySelectorAll('.confetti-dot');
    dots.forEach(d => d.remove());
  }, 1800);
}

// 再来一局（只让自己回到房间等待界面）
function doRestartGame() {
  if (!GameState.roomId) return;
  if (typeof playSound === 'function') playSound('click');

  // ★ Fix#3 关键修复：切到 LOBBY 视图（不是 ROOM_WAIT！）
  showView(Views.LOBBY);

  // 通知服务器自己准备好了
  socket.emit('game:rejoin', GameState.roomId);

  // 先用缓存数据显示 lobby 界面（服务器响应后会刷新）
  if (GameState._lastPlayers && GameState._lastPlayers.length > 0) {
    const roomIdEl = document.getElementById('roomIdDisplay');
    if (roomIdEl) roomIdEl.textContent = GameState.roomId;

    // 使用 room.js 的 renderPlayerList 函数（与初始加入房间一致）
    if (typeof renderPlayerList === 'function') {
      renderPlayerList(GameState._lastPlayers);
    }
    // 更新 lobby UI 按钮状态
    if (typeof updateLobbyUI === 'function') {
      updateLobbyUI();
    }
  }
}

// ==================== 我的状态栏 ====================

function _renderMyStatus(view) {
  const myStatus = document.getElementById('gameMyStatus');

  // 观战者：隐藏个人状态栏
  if (view.isSpectator) {
    if (myStatus) myStatus.style.display = 'none';
    return;
  }
  if (myStatus) myStatus.style.display = '';

  const me = view.players.find(p => p.id === socket.id);
  if (!me) return;

  // Bug3: 用 _lastFunds 记录上次服务端真实值，避免 DOM 动画中间值污染
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

function animateValue(el, start, end, duration) {
  const startTime = performance.now();
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (end - start) * ease);
    const diff = end - start;
    el.className = diff > 0 ? 'funds-up' : diff < 0 ? 'funds-down' : '';
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}


// ==================== 玩家列表 ====================

// 卡牌图标弹窗
function showCardPopup(cardId, cardName, isHidden, optScore, optEffect) {
  let popup = document.getElementById('card-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'card-popup';
    popup.className = 'card-popup';
    document.body.appendChild(popup);
  }

  // 存储供 HTML 模板使用
  const _ps = optScore !== undefined ? optScore : 0;
  const _pe = optEffect || 'none';

  if (isHidden || !cardId) {
    popup.innerHTML = `<div class="card-popup-content">
      <div class="card-popup-emoji">❓</div>
      <div class="card-popup-name">未揭示</div>
      <div class="card-popup-desc">此卡牌尚未被获得，信息隐藏</div>
    </div>`;
  } else {
    // 修复：不再依赖 CARDS 全局变量（客户端不存在）
    const vis = getCardVisual(cardId);
    popup.innerHTML = `<div class="card-popup-content rarity-${getCardRarity(cardId)}">
      <div class="card-popup-emoji">${getCardFramedImageHtml(cardId, 'frame-xl')}</div>
      <div class="card-popup-name">${cardName}</div>
      <div class="card-popup-score">★ ${_ps} 分</div>
      <div class="card-popup-effect">${getEffectLabel(_pe)}</div>
      <div class="card-popup-lore">${CARD_LORE[cardId] || ''}</div>
    </div>`;
  }

  popup.style.display = 'block';

  // 防止立即关闭：标记时间戳
  popup._openedAt = Date.now();

  // 点击任意位置关闭（排除刚打开的 300ms 内）
  setTimeout(() => {
    const closePopup = (evt) => {
      // 如果点击的是卡牌图标本身，不关闭
      if (evt.target.closest('.card-icon')) return;
      // 刚打开后300ms内的click忽略（防止触发源穿透）
      if (Date.now() - (popup._openedAt || 0) < 300) return;
      popup.style.display = 'none';
      document.removeEventListener('click', closePopup);
      document.removeEventListener('touchstart', closePopup);
    };
    // 先清除旧监听（防止泄漏）
    document.removeEventListener('click', closePopup);
    document.removeEventListener('touchstart', closePopup);
    document.addEventListener('click', closePopup);
    document.addEventListener('touchstart', closePopup, { passive: true });
  }, 100);
}

function _renderPlayerList(view) {
  const allPlayers = view.players || [];
  const list = document.getElementById('otherList');
  const container = document.getElementById('gameOtherPlayers');

  if (!list || !container) {
    console.warn('[Game] 玩家列表 DOM 未找到');
    return;
  }

  // 始终显示容器，便于布局和调试
  container.style.display = 'flex';

  if (allPlayers.length === 0) {
    list.innerHTML = '<div class="player-row-placeholder">等待玩家数据…</div>';
    console.log('[Game] 玩家列表为空');
    return;
  }

  console.log('[Game] 渲染玩家列表:', allPlayers.length, '人');

  // 计算最高卡牌分和最高资金
  let maxScore = -1, maxFunds = -1;
  for (const p of allPlayers) {
    if ((p.cardScore || 0) > maxScore) maxScore = p.cardScore || 0;
    if ((p.funds || 0) > maxFunds) maxFunds = p.funds || 0;
  }

  list.innerHTML = allPlayers.map(p => {
    const isMe = p.isMe || p.id === socket.id;
    const cardScore = p.cardScore || 0;
    const funds = p.funds || 0;
    const nickname = p.nickname || '未知';
    const isTopScore = cardScore > 0 && cardScore === maxScore && maxScore > 0;
    const isRichest = funds === maxFunds && maxFunds > 0;
    const botTag = p.isBot ? '<span class="pl-tag pl-tag-bot">AI</span>' : '';
    const managedTag = p.managed ? '<span class="pl-tag pl-tag-managed">托管</span>' : '';
    const avatarText = (nickname.charAt(0) || '?').toUpperCase();
    const moneyIcon = isRichest ? '💎' : '💰';
    const scoreIcon = isTopScore ? '👑' : '⭐';

    return `
      <div class="player-row${isMe ? ' is-me' : ''}" data-player-id="${p.id}" onclick="showPlayerDetailPopup(this, '${p.id}')">
        <div class="pl-avatar-col">
          <div class="pl-avatar">${avatarText}</div>
          <div class="pl-tag-row">${botTag}${managedTag}</div>
        </div>
        <div class="pl-main">
          <div class="pl-nick" title="${nickname}">${nickname}</div>
          <div class="pl-stats">${moneyIcon}$${funds} · ${scoreIcon}${cardScore}</div>
        </div>
        <div class="pl-right">
          <span class="pl-expand-icon">▶</span>
        </div>
      </div>
    `;
  }).join('');
}

// 玩家详情浮窗
function showPlayerDetailPopup(rowEl, playerId) {
  // 关闭已有弹窗
  _closePlayerPopup();

  // 从最近渲染数据中查找玩家
  const view = _lastView;
  if (!view) return;
  const p = view.players.find(pp => pp.id === playerId);
  if (!p) return;

  // 效果图标
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

  // 卡牌详情
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

  // 技能详情
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
    <div class="pp-stats">💰 $${p.funds || 0} · ⭐ ${p.cardScore||0}分 · 🃏 ${p.cardCount||0}张 ${effects}</div>
    ${cardDetail ? `<div class="pp-cards-section">${cardDetail}</div>` : ''}
    ${skillStr}
  `;
  document.body.appendChild(popup);

  // 定位到行附近
  const rect = rowEl.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  let left = rect.right + 6;
  let top = rect.top;
  // 如果右侧放不下，放左侧
  if (left + popupRect.width > window.innerWidth - 10) {
    left = rect.left - popupRect.width - 6;
  }
  // 如果左侧也放不下，放下方
  if (left < 10) {
    left = rect.left;
    top = rect.bottom + 6;
  }
  // 垂直边界
  if (top + popupRect.height > window.innerHeight - 10) {
    top = window.innerHeight - popupRect.height - 10;
  }
  if (top < 10) top = 10;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';

  // 点击外部关闭
  setTimeout(() => {
    document.addEventListener('click', _onPopupOutsideClick, { once: true });
  }, 10);
}

function _onPopupOutsideClick(e) {
  const popup = document.getElementById('playerPopup');
  if (popup && !popup.contains(e.target) && !e.target.closest('.player-row')) {
    _closePlayerPopup();
  } else if (popup) {
    // 仍然存在，重新监听
    setTimeout(() => {
      document.addEventListener('click', _onPopupOutsideClick, { once: true });
    }, 10);
  }
}

function _closePlayerPopup() {
  const popup = document.getElementById('playerPopup');
  if (popup) popup.remove();
}

// 卡牌图标点击 — 事件委托（替代内联 onclick，移动端兼容）
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
document.addEventListener('click', _onCardIconClick, true); // 捕获阶段
document.addEventListener('touchend', _onCardIconClick, { passive: false });

// 展开/折叠玩家详情 — 现在通过浮窗实现
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

// ==================== 倒计时辅助 ====================

function _clearSettleTimer() {
  if (_settleTimer) {
    clearInterval(_settleTimer);
    _settleTimer = null;
  }
}

function _startTurnCountdown(deadline) {
  _stopTurnCountdown();
  const bar = document.getElementById('globalTimerBar');
  if (!bar) return;
  bar.style.display = 'block';
  const fill = document.getElementById('globalTimerFill');
  if (!fill) return;

  const totalMs = 30000;
  const update = () => {
    const now = Date.now();
    const remaining = Math.max(0, deadline - now);
    const pct = (remaining / totalMs) * 100;
    fill.style.width = pct + '%';
    if (pct < 30) fill.style.background = '#C43A31';
    else if (pct < 60) fill.style.background = '#D4A017';
    else fill.style.background = '#5B7B5E';
    if (remaining > 0) {
      _turnCountdownId = setTimeout(() => requestAnimationFrame(update), 200);
    }
  };
  requestAnimationFrame(update);
}

function _stopTurnCountdown() {
  if (_turnCountdownId) {
    clearTimeout(_turnCountdownId);
    _turnCountdownId = null;
  }
  const bar = document.getElementById('globalTimerBar');
  if (bar) bar.style.display = 'none';
}

// ==================== 等待 UI ====================

function _renderWaiting(container, label, subLabel) {
  container.className = 'game-action-area';

  container.innerHTML = `
    <div class="waiting-area">
      <div class="waiting-spinner"></div>
      <div class="waiting-label">${label}...</div>
      ${subLabel ? `<div style="font-size:13px;color:#B8A99A;">${subLabel}</div>` : ''}
    </div>
  `;
}

function _pendingAreBots(pending) {
  if (!pending || pending.length === 0) return false;
  return pending.every(p => p.isBot || p.managed);
}

// ==================== 返回大厅 ====================

function backToLobby() {
  if (typeof playSound === 'function') playSound('click');
  if (GameState.roomId) {
    if (GameState.isSpectator) {
      socket.emit('spectator:leave', GameState.roomId);
    } else {
      socket.emit('room:leave', GameState.roomId);
    }
  }
  showView(Views.LOBBY);
  GameState.roomId = null;
  GameState._lastPlayers = null;
  GameState._rejoining = false;
  GameState.isSpectator = false;
  GameState.gameInProgress = false;
  // 清理观战标识
  const sbar = document.getElementById('spectatorBar');
  if (sbar) sbar.remove();
  // 清理可能的残留 UI
  const popup = document.getElementById('card-popup');
  if (popup) popup.style.display = 'none';
}

// ==================== 房间等待界面（再来一局） ====================

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

  // 房主「开始游戏」按钮（所有人 ready 时可点）
  const hostCtl = document.getElementById('hostControls');
  const guestMsg = document.getElementById('guestMessage');
  const startBtn = document.getElementById('waitStartBtn');
  if (hostCtl && guestMsg) {
    const isHost = GameState.isHost;
    hostCtl.style.display = isHost ? 'block' : 'none';
    guestMsg.style.display = isHost ? 'none' : 'block';

    // 更新按钮状态
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

function startGameFromWait() {
  socket.emit('game:start', GameState.roomId, (res) => {
    if (res && !res.success) {
      if (typeof showToast === 'function') showToast(res.error || '开始失败', 'error');
    }
  });
}

function leaveRoomFromWait() {
  backToLobby();
}

// ==================== 本局牌堆总览 ====================

let _cardPoolData = null;  // 缓存牌堆数据
let _totalDeckSize = 0;

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

  // 动态副标题
  const dealtCount = _cardPoolData.filter(c => c.dealt).length;
  if (subEl) {
    subEl.textContent = `共 ${_totalDeckSize || _cardPoolData.length} 张文物 · 已打出 ${dealtCount} 张`;
  }

  grid.innerHTML = _cardPoolData.map(c => {
    const acquiredClass = c.acquired ? ' acquired' : '';
    const scoreClass = 'score-' + (c.score || 1);
    const emojiHtml = getCardFramedImageHtml(c.id, 'frame-sm');

    // 状态标签
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
      SoundManager.setVolume(0);  // ★ 静音时也设置 master gain = 0
    } else {
      SoundManager.enabled = true;
      SoundManager.setVolume(vol);
    }
  } else if (typeof setMasterVolume === 'function') {
    // 回退：直接设置 audio.js master gain
    setMasterVolume(vol);
  }
  const label = document.getElementById('volumeLabel');
  if (label) label.textContent = vol === 0 ? '🔇' : Math.round(vol * 100) + '%';
}

let _autoPlayEnabled = false;

function toggleAutoPlay() {
  _autoPlayEnabled = !_autoPlayEnabled;
  const roomId = GameState.roomId;
  if (!roomId) {
    if (typeof showToast === 'function') showToast('⚠️ 未在游戏中', 'warn');
    return;
  }
  const btn = document.getElementById('btnAutoPlay');
  if (_autoPlayEnabled) {
    // ★ 通知服务端标记 managed + 调度 Bot
    socket.emit('game:autoPlay', roomId);
    if (btn) {
      btn.textContent = '已开启';
      btn.className = 'btn btn-sm btn-warning';
    }
    if (typeof showToast === 'function') {
      showToast('🤖 托管模式已开启，Bot 将接管操作', 'info');
    }
  } else {
    // ★ 通知服务端取消托管
    socket.emit('game:unautoPlay', roomId);
    if (btn) {
      btn.textContent = '已关闭';
      btn.className = 'btn btn-sm btn-outline';
    }
    if (typeof showToast === 'function') {
      showToast('👤 托管模式已关闭，恢复手动操作', 'info');
    }
  }
}

function exitGame() {
  if (!confirm('确定退出游戏吗？退出后 Bot 将以自动难度托管你的身份继续游戏。你可以随时重新加入。')) return;
  socket.emit('room:leave', GameState.roomId);
}

// 监听 room:left（含托管标记）
socket.on('room:left', (data) => {
  if (data && data.managed) {
    GameState._hasExitedManaged = true;  // ★ 标记已托管退出，阻止 game_state_update 拉回游戏
    if (typeof showToast === 'function') showToast('🤖 已退出，Bot 托管中。可随时重新加入。', 'info');

    // 回到该模式的房间界面（登录/创建页），并在顶部显示托管浮窗
    showView(Views.LOGIN);

    // 更新模式页浮窗
    const banner = document.getElementById('managedGameBanner');
    const roomIdSpan = document.getElementById('mgbRoomId');
    if (banner) banner.style.display = 'block';
    if (roomIdSpan) roomIdSpan.textContent = GameState.roomId || '------';

    // 清理旧版 lobby 中的重新加入按钮（如有）
    const oldBtn = document.getElementById('btnRejoinGame');
    if (oldBtn) oldBtn.remove();
  }
});

function rejoinGame() {
  if (!GameState.roomId || !GameState.nickname) {
    if (typeof showToast === 'function') showToast('无法重新加入', 'error');
    return;
  }
  GameState._hasExitedManaged = false;  // ★ 清除托管退出标记

  // 隐藏托管浮窗
  const banner = document.getElementById('managedGameBanner');
  if (banner) banner.style.display = 'none';

  // 移除旧版 lobby 中的重新加入按钮（如有）
  const btn = document.getElementById('btnRejoinGame');
  if (btn) btn.remove();

  socket.emit('room:join', GameState.roomId, GameState.nickname, (res) => {
    if (res && res.success) {
      if (typeof showToast === 'function') showToast('✅ 已恢复身份，欢迎回来！', 'info');
      // 服务器会通过 game_state_update 推送游戏画面
    } else {
      if (typeof showToast === 'function') showToast(res?.error || '重新加入失败', 'error');
    }
  });
}

// 在 renderGame 中缓存 cardPool 数据、绑定回合标签点击
const _origRenderGame = renderGame;
renderGame = function(view) {
  // 缓存牌堆数据
  if (view.cardPool) _cardPoolData = view.cardPool;
  if (view.totalDeckSize) _totalDeckSize = view.totalDeckSize;

  // 绑定回合标签点击
  const roundLabel = document.getElementById('gameRoundLabel');
  if (roundLabel && !roundLabel._boundClick) {
    roundLabel._boundClick = true;
    roundLabel.title = '点击查看卡池总览';
    roundLabel.addEventListener('click', showCardPool);
  }

  // 点击模态框背景关闭
  const cpModal = document.getElementById('cardPoolModal');
  if (cpModal && !cpModal._boundClick) {
    cpModal._boundClick = true;
    cpModal.addEventListener('click', (e) => {
      if (e.target === cpModal) closeCardPool();
    });
  }

  return _origRenderGame(view);
};

console.log('[Game] 游戏模块已加载');
