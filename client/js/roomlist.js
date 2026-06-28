// ============================================================
// roomlist.js — 公开房间列表（浏览 & 加入）
// ============================================================

function openRoomListModal() {
  const modal = document.getElementById('roomListModal');
  if (!modal) return;
  modal.style.display = 'flex';
  loadRoomList();
}

function closeRoomListModal() {
  const modal = document.getElementById('roomListModal');
  if (modal) modal.style.display = 'none';
}

function loadRoomList() {
  const listEl = document.getElementById('roomListContent');
  const loadingEl = document.getElementById('roomListLoading');
  if (loadingEl) loadingEl.style.display = 'block';
  if (listEl) listEl.innerHTML = '';

  socket.emit('room:list', (res) => {
    if (loadingEl) loadingEl.style.display = 'none';
    if (!listEl) return;

    if (!res.success || !res.rooms || res.rooms.length === 0) {
      listEl.innerHTML = '<div class="room-list-empty">暂无公开房间，去创建一个吧！</div>';
      return;
    }

    listEl.innerHTML = res.rooms.map(r => `
      <div class="room-list-item" onclick="joinPublicRoom('${r.roomId}')">
        <div class="room-list-item-left">
          <span class="room-list-num">#${r.roomId}</span>
          <span class="room-list-host">👑 ${r.hostNickname}</span>
        </div>
        <div class="room-list-item-right">
          <span class="room-list-count">👥 ${r.playerCount}/6</span>
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); joinPublicRoom('${r.roomId}')">加入</button>
        </div>
      </div>
    `).join('');
  });
}

function joinPublicRoom(roomId) {
  // 优先从 GameState 取，fallback 到输入框
  const nickname = GameState.nickname
    || (document.getElementById('nicknameInput')?.value || '').trim();
  if (!nickname || nickname.length < 2) {
    if (typeof showToast === 'function') showToast('请先设置昵称（至少2个字）', 'error');
    return;
  }
  // 同步到 GameState（防止后续操作读不到）
  GameState.nickname = nickname;
  if (typeof showLoading === 'function') showLoading('加入房间中…');
  socket.emit('room:join', roomId, nickname, (response) => {
    if (typeof hideLoading === 'function') hideLoading();
    if (!response.success) {
      if (response.gameInProgress) {
        // 游戏进行中 — 进入大厅但显示观战按钮
        GameState.roomId = roomId;
        GameState.nickname = nickname;
        GameState.players = response.players || [];
        GameState.isHost = false;
        GameState.gameInProgress = true;

        document.getElementById('roomIdDisplay').textContent = roomId;
        renderPlayerList(response.players || []);
        updateLobbyUI();
        showView(Views.LOBBY);
        closeRoomListModal();
        if (typeof showToast === 'function') showToast('游戏进行中，可点击观战', 'info');
      } else {
        if (typeof showToast === 'function') showToast(response.error || '加入房间失败', 'error');
      }
      return;
    }
    closeRoomListModal();
  });
}

// 点击遮罩关闭
document.addEventListener('click', (e) => {
  const modal = document.getElementById('roomListModal');
  if (modal && e.target === modal) {
    closeRoomListModal();
  }
});

console.log('[RoomList] 公开房间列表模块已加载');
