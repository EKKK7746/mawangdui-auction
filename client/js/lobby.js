// ============================================================
// lobby.js — 等待大厅交互逻辑
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const btnCopy = document.getElementById('btnCopy');
  const btnStart = document.getElementById('btnStart');
  const btnAddBot = document.getElementById('btnAddBot');
  const btnLeaveLobby = document.getElementById('btnLeaveLobby');

  // --- 复制房间号 ---
  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      if (!GameState.roomId) return;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(GameState.roomId).then(() => {
          showToast('房间号已复制', 'info');
        }).catch(() => {
          fallbackCopy(GameState.roomId);
        });
      } else {
        fallbackCopy(GameState.roomId);
      }
    });
  }

  // --- 开始游戏 ---
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      if (!GameState.isHost || GameState.getPlayerCount() < 2) return;
      if (btnStart.disabled) return;            // 防重复点击

      btnStart.disabled = true;
      btnStart.textContent = '开始中…';
      console.log('[Lobby] 发送 game:start');
      if (typeof playSound === 'function') playSound('gameStart');
      socket.emit('game:start', GameState.roomId, (res) => {
        console.log('[Lobby] game:start 回调:', JSON.stringify(res));
        if (!res || !res.success) {
          showToast(res?.error || '开始游戏失败', 'error');
          btnStart.disabled = false;            // 失败后恢复按钮
          btnStart.textContent = '开始游戏';
          return;
        }
        // ★ 超时保险：3 秒后若未收到 game_state_update，主动请求
        setTimeout(() => {
          if (GameState.currentView !== Views.GAME && btnStart.disabled) {
            console.warn('[Lobby] 未收到 game_state_update，主动请求状态');
            socket.emit('game:requestState', GameState.roomId);
          }
        }, 3000);
      });

      // 超时保险：5 秒后无响应则恢复按钮
      setTimeout(() => {
        if (btnStart.disabled && GameState.currentView !== Views.GAME) {
          btnStart.disabled = false;
          btnStart.textContent = '开始游戏';
        }
      }, 5000);
    });
  }

  // --- 添加机器人 ---
  if (btnAddBot) {
    btnAddBot.addEventListener('click', () => {
      if (!GameState.roomId) return;
      if (GameState.getPlayerCount() >= 6) {
        showToast('房间已满（最多6人）', 'error');
        return;
      }
      const diffSelect = document.getElementById('botDifficulty');
      const difficulty = diffSelect ? diffSelect.value : 'auto';
      socket.emit('room:add_bot', GameState.roomId, difficulty, (res) => {
        if (!res.success) {
          showToast(res.error || '添加失败', 'error');
        } else {
          showToast('🤖 机器人已加入', 'info');
        }
      });
    });
  }

  // --- 离开房间 ---
  if (btnLeaveLobby) {
    btnLeaveLobby.addEventListener('click', () => {
      if (!GameState.roomId) return;
      const roomId = GameState.roomId;
      // 立即重置并返回模式页，不等服务端 room:left
      goToMode();
      socket.emit('room:leave', roomId);
    });
  }
});

// 降级复制方案
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('房间号已复制', 'info');
  } catch (e) {
    showToast('复制失败，请手动记录', 'error');
  }
  document.body.removeChild(ta);
}
