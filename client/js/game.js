// ============================================================
// game.js — 游戏主入口（socket 事件绑定 + 模块变量）
// 渲染: game/render.js  |  动画: game/animation.js
// 操作: game/actions.js  |  数据: game/data.js
// ============================================================

// 缓存上一次状态用于 diff（动画触发等）
let _lastView = null;
let _renderVersion = 0;       // 版本号防抖，避免竞态渲染
let _lastFunds = null;        // 上次服务端确认的资金值，避免动画中间值污染
let _lastDuelRollAnimPlayed = false;  // 决斗掷骰动画防重复播放
let _settleTimer = null;      // 自动下一轮计时器
let _turnCountdownId = null;  // 客户端倒计时 interval ID
let _auctionResultTimer = null; // 拍卖师公示页计时器
let _auctionResultShown = false; // 当前轮次公示页是否已展示
let _roundTransitionTimer = null; // 回合切换横幅计时器
let _duelIntroTimer = null;       // 决斗开场动画计时器
let _cardRevealTimer = null;      // 卡牌揭晓动画计时器
let _autoPlayEnabled = false;     // 托管状态
let _cardPoolData = null;         // 牌堆数据
let _totalDeckSize = 0;           // 牌堆总数

// ==================== 入口：接收 game:state_update ====================

socket.on('game_state_update', (view) => {
  console.log(`[Game] ✓ 收到 game_state_update! phase=${view.phase}, round=${view.round}, view=${GameState.currentView}`);

  // ★ 已主动退出（托管中）→ 忽略游戏状态更新，防止被拉回游戏
  if (GameState._hasExitedManaged) {
    if (view.phase === 'finished' || view.phase === 'waiting') {
      GameState._hasExitedManaged = false;
      const banner = document.getElementById('managedGameBanner');
      if (banner) banner.style.display = 'none';
    }
    return;
  }

  // 缓存最新玩家列表
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

  // "再来一局"的重加入响应
  if (view._isRejoin) {
    showView(Views.LOBBY);
    GameState.players = view.players || [];
    const me = (view.players || []).find(p => p.id === socket.id);
    GameState.isHost = !!(me && me.isHost);

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

  // 房主重启游戏的等待状态
  if (view.phase === 'waiting') {
    showView(Views.LOBBY);
    GameState.players = view.players || [];
    const me = (view.players || []).find(p => p.id === socket.id);
    GameState.isHost = !!(me && me.isHost);

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

// 监听 room:left（含托管标记）
socket.on('room:left', (data) => {
  if (data && data.managed) {
    GameState._hasExitedManaged = true;
    if (typeof showToast === 'function') showToast('🤖 已退出，Bot 托管中。可随时重新加入。', 'info');

    showView(Views.LOGIN);

    const banner = document.getElementById('managedGameBanner');
    const roomIdSpan = document.getElementById('mgbRoomId');
    if (banner) banner.style.display = 'block';
    if (roomIdSpan) roomIdSpan.textContent = GameState.roomId || '------';

    const oldBtn = document.getElementById('btnRejoinGame');
    if (oldBtn) oldBtn.remove();
  }
});

// ==================== 卡牌图标事件委托 ====================

document.addEventListener('click', _onCardIconClick, true);
document.addEventListener('touchend', _onCardIconClick, { passive: false });

// ==================== renderGame 包装：缓存牌堆数据 + 绑定回合标签 ====================

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
