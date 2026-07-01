// ============================================================
// game/animation.js — 动画、定时器、过渡效果
// 依赖: game/data.js（_CN_NUMS）
// ============================================================

// ==================== P0-1 + P2-2: 回合切换横幅 ====================

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

// ==================== 拍卖师皇冠动画 ====================

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

// ==================== 撒花粒子 ====================

function spawnConfetti(parent) {
  const colors = ['#C43A31', '#D4AF37', '#FFD700', '#FFF', '#F5E6C8', '#C9A96E'];

  const frag = document.createDocumentFragment();
  for (let i = 0; i < 14; i++) {
    const dot = document.createElement('span');
    dot.className = 'confetti-dot';
    dot.style.setProperty('--c', colors[Math.floor(Math.random() * colors.length)]);
    dot.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
    dot.style.setProperty('--dy', `${-(60 + Math.random() * 120)}px`);
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

// ==================== 数字动画 ====================

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

// ==================== 结算倒计时 ====================

function _clearSettleTimer() {
  if (_settleTimer) {
    clearInterval(_settleTimer);
    _settleTimer = null;
  }
}

// ==================== 回合倒计时 ====================

function _startTurnCountdown(remainingMs) {
  _stopTurnCountdown();
  const bar = document.getElementById('globalTimerBar');
  if (!bar) return;
  bar.style.display = 'block';
  const fill = document.getElementById('globalTimerFill');
  if (!fill) return;

  const totalMs = 30000;
  const startTime = Date.now();
  const initialRemaining = Math.max(0, Number(remainingMs) || 0);
  const update = () => {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, initialRemaining - elapsed);
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

console.log('[Game/Animation] 动画模块已加载');
