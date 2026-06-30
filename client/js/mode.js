// ============================================================
// mode.js — 游戏模式定义 & 选择界面
// ============================================================

const GAME_MODES = [
  {
    id: 'classic',
    name: '经典竞拍',
    icon: '🏺',
    available: true,
    desc: '2-6人博弈，竞标拍卖师，租骰掷骰，10轮文物卡定胜负',
    players: '2-6人',
    rounds: 10,
    cardCount: 10,
    maxPlayers: 6,
    minPlayers: 2,
    initialCash: 12
  },
  {
    id: 'speed',
    name: '极速对决',
    icon: '⚡',
    available: true,
    desc: '5轮闪电战，快节奏策略博弈，新手友好',
    players: '2-4人',
    rounds: 5,
    cardCount: 5,
    maxPlayers: 4,
    minPlayers: 2,
    initialCash: 8
  },
  {
    id: 'fulldeck',
    name: '完整对局',
    icon: '📜',
    available: true,
    desc: '全部20张文物参战，更长更深度的策略体验',
    players: '2-6人',
    rounds: 20,
    cardCount: 20,
    maxPlayers: 6,
    minPlayers: 2,
    initialCash: 20
  },
];

// 当前选中的模式
let _selectedMode = null;

/**
 * 获取模式定义
 */
function getModeById(id) {
  return GAME_MODES.find(m => m.id === id) || GAME_MODES[0];
}

/**
 * 渲染模式选择界面
 */
function renderModeCards() {
  const container = document.getElementById('modeCards');
  if (!container) return;

  container.innerHTML = GAME_MODES.map(m => {
    const locked = !m.available;
    return `
      <div class="mode-card ${locked ? 'mode-locked' : ''}" ${locked ? '' : `onclick="selectMode('${m.id}')"`}>
        <div class="mode-card-icon">${m.icon}</div>
        <div class="mode-card-body">
          <div class="mode-card-name">${m.name}</div>
          <div class="mode-card-desc">${m.desc}</div>
          <div class="mode-card-meta">${m.players} · ${m.rounds}轮</div>
        </div>
        <div class="mode-card-action">
          ${locked
            ? '<span class="mode-lock-badge">🔒 即将推出</span>'
            : '<button class="btn btn-primary btn-sm">进入 →</button>'}
        </div>
      </div>
    `;
  }).join('');
}

/**
 * 选择模式 → 进入房间界面
 */
function selectMode(modeId) {
  const mode = getModeById(modeId);
  if (!mode.available) {
    if (typeof showToast === 'function') showToast('该模式即将推出，敬请期待！', 'info');
    return;
  }

  _selectedMode = mode;
  GameState.selectedMode = mode;

  // 更新房间界面的模式徽章
  const badge = document.getElementById('roomModeBadge');
  if (badge) badge.textContent = `${mode.icon} ${mode.name}`;

  // 更新最大玩家选择器
  updateMaxPlayerSelect(mode);

  // 更新玩家信息显示（含昵称输入框同步）
  const nameSpan = document.getElementById('roomPlayerName');
  if (nameSpan) nameSpan.textContent = GameState.nickname || '';
  const nickInput = document.getElementById('nicknameInput');
  if (nickInput && GameState.nickname) {
    nickInput.value = GameState.nickname;
    // 触发 input 事件以更新按钮状态
    nickInput.dispatchEvent(new Event('input'));
  }

  showView(Views.LOGIN);
}

/**
 * 根据模式更新最大玩家选择器
 */
function updateMaxPlayerSelect(mode) {
  const sel = document.getElementById('maxPlayersSelect');
  if (!sel) return;

  const max = mode.maxPlayers;
  const min = mode.minPlayers;

  sel.innerHTML = '';
  for (let i = min; i <= max; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i}人`;
    if (i === max) opt.selected = true;
    sel.appendChild(opt);
  }
}

/**
 * 从模式选择界面加入房间（右上角按钮）
 */
function showJoinRoomFromMode() {
  const panel = document.getElementById('modeJoinPanel');
  const input = document.getElementById('modeRoomInput');
  if (panel) panel.style.display = 'block';
  if (input) {
    input.value = '';
    input.focus();
  }
  const preview = document.getElementById('modeRoomPreview');
  if (preview) preview.style.display = 'none';
  const btn = document.getElementById('btnModeJoin');
  if (btn) btn.disabled = true;
}

function hideJoinRoomFromMode() {
  const panel = document.getElementById('modeJoinPanel');
  if (panel) panel.style.display = 'none';
}

/**
 * 返回开始界面
 */
function goToStart() {
  const nickInput = document.getElementById('startNickname');
  if (nickInput && GameState.nickname) {
    nickInput.value = GameState.nickname;
  }
  showView(Views.START);
  updateStartButton();
}

/**
 * 返回模式选择
 */
function goToMode() {
  renderModeCards();
  showView(Views.MODE);
}

// ==================== DOM 初始化 ====================

document.addEventListener('DOMContentLoaded', () => {
  // --- 开始界面 ---
  const startNickname = document.getElementById('startNickname');
  const btnStartGame = document.getElementById('btnStartGame');

  // 恢复昵称
  const saved = JSON.parse(localStorage.getItem('mwPlayer') || '{}');
  if (saved.nickname && startNickname) {
    startNickname.value = saved.nickname;
    GameState.nickname = saved.nickname;
    updateStartButton();
  }

  if (startNickname) {
    startNickname.addEventListener('input', updateStartButton);
    startNickname.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && startNickname.value.trim().length >= 2) {
        btnStartGame?.click();
      }
    });
  }

  if (btnStartGame) {
    btnStartGame.addEventListener('click', () => {
      const nick = startNickname.value.trim();
      if (nick.length < 2) return;

      GameState.nickname = nick;
      localStorage.setItem('mwPlayer', JSON.stringify({ nickname: nick, roomId: '' }));

      // 进入模式选择
      renderModeCards();
      showView(Views.MODE);
      if (typeof playSound === 'function') playSound('confirm');
    });
  }

  // --- 模式选择界面：加入房间面板 ---
  const modeRoomInput = document.getElementById('modeRoomInput');
  const btnModeJoin = document.getElementById('btnModeJoin');
  const modeRoomPreview = document.getElementById('modeRoomPreview');

  if (modeRoomInput) {
    modeRoomInput.addEventListener('input', () => {
      const val = modeRoomInput.value.replace(/\D/g, '').slice(0, 6);
      modeRoomInput.value = val;

      if (val.length === 6) {
        // 查询房间信息
        socket.emit('room:info', val, (res) => {
          if (res.success && modeRoomPreview) {
            const mode = getModeById(res.mode || 'classic');
            modeRoomPreview.style.display = 'block';
            modeRoomPreview.innerHTML = `
              <div class="room-preview-mode">${mode.icon} ${mode.name}</div>
              <div class="room-preview-info">👤 ${res.hostNickname || '?'} · 👥 ${res.playerCount || 0}人 · ${res.isStarted ? '⚡ 游戏中' : '⏳ 等待中'}</div>
            `;
            if (btnModeJoin) {
              btnModeJoin.disabled = res.isStarted;
              btnModeJoin.textContent = res.isStarted ? '游戏已开始' : '加入房间';
            }
          } else {
            if (modeRoomPreview) modeRoomPreview.style.display = 'none';
            if (btnModeJoin) { btnModeJoin.disabled = true; btnModeJoin.textContent = '加入'; }
          }
        });
      } else {
        if (modeRoomPreview) modeRoomPreview.style.display = 'none';
        if (btnModeJoin) btnModeJoin.disabled = true;
      }
    });
  }

  if (btnModeJoin) {
    btnModeJoin.addEventListener('click', () => {
      const roomId = modeRoomInput?.value.trim();
      if (!roomId || roomId.length !== 6) return;
      if (!GameState.nickname) return;

      localStorage.setItem('mwPlayer', JSON.stringify({ nickname: GameState.nickname, roomId: '' }));
      if (typeof showLoading === 'function') showLoading('加入房间中…');

      // 直接走加入房间流程
      socket.emit('room:join', roomId, GameState.nickname, (response) => {
        if (typeof hideLoading === 'function') hideLoading();
        if (!response.success) {
          if (response.gameInProgress) {
            GameState.roomId = roomId;
            GameState.players = response.players || [];
            GameState.isHost = false;
            GameState.gameInProgress = true;
            document.getElementById('roomIdDisplay').textContent = roomId;
            if (typeof renderPlayerList === 'function') renderPlayerList(response.players || []);
            if (typeof updateLobbyUI === 'function') updateLobbyUI();
            showView(Views.LOBBY);
            if (typeof showToast === 'function') showToast('游戏进行中，可点击观战', 'info');
          } else {
            if (typeof showToast === 'function') showToast(response.error || '加入失败', 'error');
          }
        }
      });
    });
  }
});

function updateStartButton() {
  const nick = document.getElementById('startNickname')?.value?.trim() || '';
  const btn = document.getElementById('btnStartGame');
  if (btn) btn.disabled = nick.length < 2;
}
