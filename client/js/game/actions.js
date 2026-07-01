// ============================================================
// game/actions.js — 玩家操作：socket emit 包装 + 状态切换
// 依赖: game/data.js, game/animation.js, game/render.js（在加载顺序中）
// ============================================================

// ==================== 出场/返回 ====================

function leaveSpectate() {
  if (typeof playSound === 'function') playSound('click');
  if (GameState.roomId) {
    socket.emit('spectator:leave', GameState.roomId);
  }
  GameState._justLeftSpectate = true;
  GameState.isSpectator = false;
  GameState.gameInProgress = false;
  const sbar = document.getElementById('spectatorBar');
  if (sbar) sbar.remove();
  showView(Views.LOBBY);
}

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
  const sbar = document.getElementById('spectatorBar');
  if (sbar) sbar.remove();
  const popup = document.getElementById('card-popup');
  if (popup) popup.style.display = 'none';
}

function exitGame() {
  if (!confirm('确定退出游戏吗？退出后 Bot 将以自动难度托管你的身份继续游戏。你可以随时重新加入。')) return;
  socket.emit('room:leave', GameState.roomId);
}

function rejoinGame() {
  if (!GameState.roomId || !GameState.nickname) {
    if (typeof showToast === 'function') showToast('无法重新加入', 'error');
    return;
  }
  GameState._hasExitedManaged = false;

  const banner = document.getElementById('managedGameBanner');
  if (banner) banner.style.display = 'none';

  const btn = document.getElementById('btnRejoinGame');
  if (btn) btn.remove();

  socket.emit('room:join', GameState.roomId, GameState.nickname, (res) => {
    if (res && res.success) {
      if (typeof showToast === 'function') showToast('✅ 已恢复身份，欢迎回来！', 'info');
    } else {
      if (typeof showToast === 'function') showToast(res?.error || '重新加入失败', 'error');
    }
  });
}

// ==================== 再来一局 ====================

function doRestartGame() {
  if (!GameState.roomId) return;
  if (typeof playSound === 'function') playSound('click');

  showView(Views.LOBBY);
  socket.emit('game:rejoin', GameState.roomId);

  if (GameState._lastPlayers && GameState._lastPlayers.length > 0) {
    const roomIdEl = document.getElementById('roomIdDisplay');
    if (roomIdEl) roomIdEl.textContent = GameState.roomId;

    if (typeof renderPlayerList === 'function') {
      renderPlayerList(GameState._lastPlayers);
    }
    if (typeof updateLobbyUI === 'function') {
      updateLobbyUI();
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

// ==================== 拍卖阶段 ====================

function doBid(percentage) {
  if (typeof playSound === 'function') playSound('bid');
  socket.emit('game:bid', GameState.roomId, percentage, (res) => {
    if (!res.success) {
      showToast(res.error || '出价失败', 'error');
    }
  });
}

// ==================== 选卡阶段 ====================

function doSelectCard(index) {
  if (typeof playSound === 'function') playSound('click');
  socket.emit('game:select_card', GameState.roomId, index, (res) => {
    if (!res.success) {
      showToast(res.error || '选卡失败', 'error');
    }
  });
}

// ==================== 租骰阶段 ====================

function doSelectDiceWithUpgrade(diceType) {
  if (typeof playSound === 'function') playSound('diceShake');
  const useUpgrade = document.getElementById('useUpgradeCheck')?.checked || false;
  if (diceType === 'd20') {
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

function onUpgradeCheckChange() {
  const checked = document.getElementById('useUpgradeCheck')?.checked || false;
  const UPGRADE_MAP = { d4: 'd6', d6: 'd12', d12: 'd20' };
  const previews = document.querySelectorAll('.dice-upgrade-preview');
  const buttons = document.querySelectorAll('.dice-btn');

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

// ==================== 掷骰阶段 ====================

function doRollDice() {
  if (typeof playSound === 'function') playSound('click');
  socket.emit('game:roll_dice', GameState.roomId, (res) => {
    if (!res.success) {
      showToast(res.error || '掷骰失败', 'error');
    }
  });
}

// ==================== 结算阶段 ====================

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

// ==================== 决斗阶段 ====================

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

// ==================== 托管 ====================

function toggleAutoPlay() {
  _autoPlayEnabled = !_autoPlayEnabled;
  const roomId = GameState.roomId;
  if (!roomId) {
    if (typeof showToast === 'function') showToast('⚠️ 未在游戏中', 'warn');
    return;
  }
  const btn = document.getElementById('btnAutoPlay');
  if (_autoPlayEnabled) {
    socket.emit('game:autoPlay', roomId);
    if (btn) {
      btn.textContent = '已开启';
      btn.className = 'btn btn-sm btn-warning';
    }
    if (typeof showToast === 'function') {
      showToast('🤖 托管模式已开启，Bot 将接管操作', 'info');
    }
  } else {
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

console.log('[Game/Actions] 操作模块已加载');
