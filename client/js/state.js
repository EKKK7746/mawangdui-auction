// ============================================================
// state.js — 客户端游戏全局状态
// ============================================================

const GameState = {
  nickname: '',
  roomId: '',
  players: [],
  isHost: false,
  isSpectator: false,
  gameInProgress: false,
  currentView: 'login',
  gameData: null,
};

// -------------------- 辅助方法 --------------------

GameState.getPlayerCount = function () {
  return this.players.length;
};

GameState.isSelf = function (playerId) {
  return playerId === socket.id;
};

GameState.reset = function () {
  // nickname 保留不清空（用户每次打开页面不想重新输入）
  this.roomId = '';
  this.players = [];
  this.isHost = false;
  this.isSpectator = false;
  this.gameInProgress = false;
  this.gameData = null;
};
