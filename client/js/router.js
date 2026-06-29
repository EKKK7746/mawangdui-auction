// ============================================================
// router.js — 视图切换（登录 / 大厅 / 游戏）
// ============================================================

const Views = {
  START: 'start',
  MODE: 'mode',
  LOGIN: 'login',
  LOBBY: 'lobby',
  ROOM_WAIT: 'room-wait',
  GAME: 'game',
};

/**
 * 切换到指定视图
 * @param {'login'|'lobby'|'game'} viewName
 */
function showView(viewName) {
  // 隐藏所有视图
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active');
  });

  // 显示目标视图
  const target = document.getElementById('view-' + viewName);
  if (target) {
    target.classList.add('active');
    GameState.currentView = viewName;
    console.log('[Router] 切换到视图:', viewName);
  } else {
    console.error('[Router] 视图不存在:', viewName);
  }
}

/**
 * 返回登录页并重置状态
 */
function backToLogin() {
  GameState.reset();
  showView(Views.START);

  // 保留昵称：回填到开始界面
  const startNickname = document.getElementById('startNickname');
  if (startNickname && GameState.nickname) {
    startNickname.value = GameState.nickname;
  }
}
