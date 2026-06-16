// ============================================================
// room.js — 房间相关 UI 与事件处理
// ============================================================

// -------------------- 渲染玩家列表 --------------------

function renderPlayerList(players) {
  const list = document.getElementById('playerList');
  if (!list) return;

  const isHost = GameState.isHost;

  list.innerHTML = players.map((p, index) => {
    const pHost = !!p.isHost;
    const isMe = GameState.isSelf(p.id);
    const canKick = isHost && !isMe && !pHost; // 房主可以踢非自己、非原房主的人
    return `
      <li>
        <span class="host-icon">${pHost ? '👑' : '🎭'}</span>
        <span>${p.nickname}</span>
        ${pHost ? '<span class="host-badge">房主</span>' : ''}
        ${isMe ? '<span class="you-tag">(你)</span>' : ''}
        ${canKick ? `<button class="btn-kick-player" onclick="doKickPlayer('${p.id}')" title="踢出玩家">−</button>` : ''}
      </li>
    `;
  }).join('');
}

function doKickPlayer(targetId) {
  if (!confirm('确定要踢出该玩家吗？')) return;
  socket.emit('room:kick', GameState.roomId, targetId, (res) => {
    if (!res.success) {
      if (typeof showToast === 'function') showToast(res.error || '踢人失败', 'error');
    }
  });
}

// -------------------- Socket 事件监听（房间相关） --------------------

socket.on('room:created', (data) => {
  console.log('[Room] 房间已创建:', data.roomId);
  GameState.roomId = data.roomId;
  GameState.players = data.players;
  GameState.isHost = true;

  document.getElementById('roomIdDisplay').textContent = data.roomId;
  renderPlayerList(data.players);
  updateLobbyUI();
  showView(Views.LOBBY);
  if (typeof playSound === 'function') playSound('confirm');
});

socket.on('room:joined', (data) => {
  console.log('[Room] 已加入房间:', data.roomId);
  GameState.roomId = data.roomId;
  GameState.players = data.players;
  GameState.isHost = false; // 加入者不是房主（除非原房主离开后转移）

  document.getElementById('roomIdDisplay').textContent = data.roomId;
  renderPlayerList(data.players);
  updateLobbyUI();
  showView(Views.LOBBY);
  if (typeof playSound === 'function') playSound('confirm');

  // 检查自己是否被设为房主
  const me = data.players.find(p => p.id === socket.id);
  if (me && me.isHost) {
    GameState.isHost = true;
    updateLobbyUI();
  }
});

socket.on('room:player_joined', (data) => {
  console.log('[Room] 玩家加入:', data.player.nickname);
  GameState.players = data.players;
  renderPlayerList(data.players);
  updateLobbyUI();
});

socket.on('room:player_left', (data) => {
  console.log('[Room] 玩家离开:', data.player.nickname);
  GameState.players = data.players;
  renderPlayerList(data.players);

  // 检查自己是否成为新房主
  const me = data.players.find(p => p.id === socket.id);
  if (me && me.isHost) {
    GameState.isHost = true;
    showToast('你已成为房主', 'info');
  }
  updateLobbyUI();
});

socket.on('room:left', (data) => {
  console.log('[Room] 已离开房间:', data.roomId);
  backToLogin();
});

socket.on('room:kicked', (data) => {
  console.log('[Room] 被踢出房间:', data.roomId);
  GameState.roomId = null;
  GameState.players = [];
  GameState.isHost = false;
  backToLogin();
  if (typeof showToast === 'function') showToast('你被房主移出了房间', 'info');
});

// 监听其他玩家的"再来一局"ready 状态
socket.on('player:ready', (data) => {
  console.log(`[Lobby] 玩家 ready: ${data.playerId} (${data.readyCount}/${data.total})`);
  // 更新等待提示
  const waitingText = document.getElementById('waitingText');
  if (waitingText && GameState.currentView === Views.LOBBY) {
    const readyPct = Math.round((data.readyCount / data.total) * 100);
    waitingText.style.display = 'block';
    waitingText.innerHTML =
      `<span class="ready-status">✅ 已准备: ${data.readyCount}/${data.total} (${readyPct}%)</span>`;
  }
});

// -------------------- 更新大厅 UI --------------------

function updateLobbyUI() {
  const btnStart = document.getElementById('btnStart');
  const btnAddBot = document.getElementById('btnAddBot');
  const waitingText = document.getElementById('waitingText');
  const playerCount = GameState.getPlayerCount();

  // 添加机器人按钮：仅房主可见，未满6人
  if (btnAddBot) {
    btnAddBot.style.display = (GameState.isHost && playerCount < 6) ? 'block' : 'none';
  }

  // 开始按钮：仅房主可见，且 ≥2 人
  if (btnStart) {
    if (GameState.isHost && playerCount >= 2) {
      btnStart.style.display = 'block';
      btnStart.disabled = false;
    } else if (GameState.isHost) {
      btnStart.style.display = 'block';
      btnStart.disabled = true;
    } else {
      btnStart.style.display = 'none';
    }
  }

  // 等待提示
  if (waitingText) {
    if (GameState.isHost && playerCount < 2) {
      waitingText.style.display = 'block';
      waitingText.innerHTML = '<span class="dot-pulse">等待玩家加入</span>';
    } else {
      waitingText.style.display = 'none';
    }
  }
}

// -------------------- 登录页按钮状态 --------------------

function updateLoginButtons() {
  const nickname = (document.getElementById('nicknameInput')?.value || '').trim();
  const roomId = (document.getElementById('roomInput')?.value || '').trim();

  const btnCreate = document.getElementById('btnCreate');
  const btnJoin = document.getElementById('btnJoin');

  if (btnCreate) {
    btnCreate.disabled = nickname.length < 2;
  }
  if (btnJoin) {
    btnJoin.disabled = nickname.length < 2 || roomId.length !== 6;
  }
}

// -------------------- 登录页事件绑定 --------------------

document.addEventListener('DOMContentLoaded', () => {
  const nicknameInput = document.getElementById('nicknameInput');
  const roomInput = document.getElementById('roomInput');
  const btnCreate = document.getElementById('btnCreate');
  const btnJoin = document.getElementById('btnJoin');
  const loginError = document.getElementById('loginError');
  const btnBrowseRooms = document.getElementById('btnBrowseRooms');

  // 恢复上次保存的昵称
  const saved = JSON.parse(localStorage.getItem('mwPlayer') || '{}');
  if (saved.nickname && nicknameInput) {
    nicknameInput.value = saved.nickname;
    GameState.nickname = saved.nickname;
    updateLoginButtons();
  }

  // 输入事件 — 更新按钮状态
  if (nicknameInput) {
    nicknameInput.addEventListener('input', updateLoginButtons);
    nicknameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && nicknameInput.value.trim().length >= 2) {
        btnCreate?.click();
      }
    });
  }

  if (roomInput) {
    roomInput.addEventListener('input', () => {
      // 仅允许数字
      roomInput.value = roomInput.value.replace(/\D/g, '').slice(0, 6);
      updateLoginButtons();
    });
    roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && roomInput.value.trim().length === 6) {
        btnJoin?.click();
      }
    });
  }

  // 创建房间
  if (btnCreate) {
    btnCreate.addEventListener('click', () => {
      const nickname = nicknameInput.value.trim();
      if (nickname.length < 2) return;

      GameState.nickname = nickname;
      localStorage.setItem('mwPlayer', JSON.stringify({ nickname, roomId: '' }));
      if (loginError) loginError.textContent = '';
      if (typeof showLoading === 'function') showLoading('创建房间中…');

      const isPublic = document.getElementById('isPublicToggle')?.checked || false;
      socket.emit('room:create', nickname, isPublic, (response) => {
        if (typeof hideLoading === 'function') hideLoading();
        if (!response.success) {
          if (loginError) loginError.textContent = response.error || '创建房间失败';
          console.error('[Room] 创建房间失败:', response.error);
        }
      });
    });
  }

  // 加入房间
  if (btnJoin) {
    btnJoin.addEventListener('click', () => {
      const roomId = roomInput.value.trim();
      const nickname = nicknameInput.value.trim();
      if (roomId.length !== 6 || nickname.length < 2) return;

      GameState.nickname = nickname;
      localStorage.setItem('mwPlayer', JSON.stringify({ nickname, roomId: '' }));
      if (loginError) loginError.textContent = '';
      if (typeof showLoading === 'function') showLoading('加入房间中…');

      socket.emit('room:join', roomId, nickname, (response) => {
        if (typeof hideLoading === 'function') hideLoading();
        if (!response.success) {
          if (loginError) loginError.textContent = response.error || '加入房间失败';
          console.error('[Room] 加入房间失败:', response.error);
        }
      });
    });
  }

  // 浏览公开房间
  if (btnBrowseRooms) {
    btnBrowseRooms.addEventListener('click', () => {
      if (typeof openRoomListModal === 'function') {
        openRoomListModal();
      }
    });
  }
});
