// ============================================================
// index.js - Express + Socket.IO 游戏服务器入口
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const roomManager = require('./roomManager');
const gameEngine = require('./gameEngine');
const { BotManager, createBotPlayer, resolveAutoStrategies } = require('./bot');
const SecurityMiddleware = require('./security');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,   // 60秒内无 pong 才断连
  pingInterval: 25000,   // 每25秒发一次 ping
  connectTimeout: 20000,  // 连接握手超时 20s
  maxHttpBufferSize: 1e6, // 防止大包导致断连
});

// ==================== 注入 IO 实例 + Bot 调度 ====================

gameEngine.setIO(io);
const botManager = new BotManager(io, gameEngine);
gameEngine.setOnBroadcast((roomId) => botManager.processBots(roomId));

const security = new SecurityMiddleware(io);

// ==================== 连接管理 ====================

io.on('connection', (socket) => {
  console.log(`[连接] 玩家上线: ${socket.id}`);

  // 安全中间件：所有事件先过安全检查
  socket.use((packet, next) => {
    const eventName = packet[0];
    const args = packet.slice(1);
    const result = security.check(socket, eventName, ...args);
    if (!result.allowed) {
      // 如果事件有 callback，返回错误信息
      const lastArg = args[args.length - 1];
      if (typeof lastArg === 'function') {
        lastArg({ success: false, error: result.reason });
      }
      return next(new Error(result.reason));
    }
    next();
  });

  // ------ 房间操作 ------

  // --- 创建房间 ---
  socket.on('room:create', (nickname, isPublic, opts, callback) => {
    // 兼容旧调用方式（opts 可能直接是 callback）
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (typeof callback !== 'function') {
      console.warn('[警告] room:create 缺少回调函数');
      return;
    }
    try {
      const { roomId, players } = roomManager.createRoom(socket, nickname, isPublic, opts);
      socket.emit('room:created', { roomId, players, mode: opts.mode || 'classic' });
      callback({ success: true, roomId });
    } catch (err) {
      console.error('[错误] 创建房间失败:', err.message);
      callback({ success: false, error: '创建房间失败' });
    }
  });

  // --- 加入房间 ---
  socket.on('room:join', (roomId, nickname, callback) => {
    if (typeof callback !== 'function') {
      console.warn('[警告] room:join 缺少回调函数');
      return;
    }
    try {
      // 检查游戏是否正在进行
      const game = gameEngine.getGame(roomId);
      if (game && game.phase !== 'finished' && game.phase !== 'waiting') {
        // 游戏进行中 — 检查是否是托管玩家重连
        const managedPlayer = game.players.find(p => p.managed && p._originalNickname === nickname);
        if (managedPlayer) {
          // ★ 托管玩家重连：更新 socket ID，恢复身份
          const oldId = managedPlayer.id;
          managedPlayer.id = socket.id;
          managedPlayer.managed = false;
          managedPlayer._originalNickname = undefined;
          managedPlayer.managedAt = undefined;
          managedPlayer.strategy = undefined; // 清除托管策略

          // 更新所有游戏数据中的 playerId 引用
          game.bids = game.bids.map(b => b.playerId === oldId ? { ...b, playerId: socket.id } : b);
          if (game.diceSelections[oldId]) { game.diceSelections[socket.id] = game.diceSelections[oldId]; delete game.diceSelections[oldId]; }
          if (game.diceResults[oldId]) { game.diceResults[socket.id] = game.diceResults[oldId]; delete game.diceResults[oldId]; }
          if (game._roundExpense && game._roundExpense[oldId]) { game._roundExpense[socket.id] = game._roundExpense[oldId]; delete game._roundExpense[oldId]; }
          if (game.playersDone.has(oldId)) { game.playersDone.delete(oldId); game.playersDone.add(socket.id); }
          if (game.auctioneerId === oldId) game.auctioneerId = socket.id;
          if (game.lastAuctioneerId === oldId) game.lastAuctioneerId = socket.id;
          if (game.duel) {
            if (game.duel.initiatorId === oldId) game.duel.initiatorId = socket.id;
            if (game.duel.targetId === oldId) game.duel.targetId = socket.id;
            if (game.duel.winnerId === oldId) game.duel.winnerId = socket.id;
            if (game.duel.loserId === oldId) game.duel.loserId = socket.id;
            if (game.duel.diceSelections[oldId]) { game.duel.diceSelections[socket.id] = game.duel.diceSelections[oldId]; delete game.duel.diceSelections[oldId]; }
            if (game.duel.diceResults[oldId]) { game.duel.diceResults[socket.id] = game.duel.diceResults[oldId]; delete game.duel.diceResults[oldId]; }
          }

          // 加入 Socket.IO 房间
          socket.join(roomId);
          // 更新 roomManager 中的玩家
          roomManager.updatePlayerId(roomId, oldId, socket.id, nickname);

          console.log(`[房间] 托管玩家 ${nickname} 重连恢复，旧ID: ${oldId} → 新ID: ${socket.id}`);

          // ★ 取消 Bot 定时器（玩家已恢复控制）
          botManager.cancelPlayerTimer(roomId, oldId);

          // 发送完整游戏状态
          const view = gameEngine.getPlayerView(game, socket.id);
          socket.emit('game_state_update', view);
          callback({ success: true, roomId, reclaimed: true });
          return;
        }

        // 非托管玩家 → 只能观战
        const players = roomManager.getPlayers(roomId);
        callback({ success: false, error: '游戏已开始，无法加入', gameInProgress: true, players, roomId });
        return;
      }

      const result = roomManager.joinRoom(socket, roomId, nickname);
      if (!result.success) {
        callback(result);
        return;
      }
      socket.emit('room:joined', { roomId, players: result.players });
      socket.to(roomId).emit('room:player_joined', { player: result.player, players: result.players });
      callback(result);
    } catch (err) {
      console.error('[错误] 加入房间失败:', err.message);
      callback({ success: false, error: '加入房间失败' });
    }
  });

  // --- 观战：进入 ---
  socket.on('spectator:enter', (roomId, nickname, callback) => {
    if (typeof callback !== 'function') callback = () => {};

    const game = gameEngine.getGame(roomId);
    if (!game || game.phase === 'finished' || game.phase === 'waiting') {
      callback({ success: false, error: '没有正在进行的游戏' });
      return;
    }

    const result = roomManager.joinAsSpectator(socket, roomId, nickname);
    if (!result.success) {
      callback(result);
      return;
    }

    // 发送当前游戏状态（观战者视角）
    const view = gameEngine.getSpectatorView(game);
    socket.emit('game_state_update', view);
    callback({ success: true });
  });

  // --- 观战：离开 ---
  socket.on('spectator:leave', (roomId) => {
    roomManager.leaveSpectator(socket, roomId);
    socket.emit('room:left', { roomId });
  });

  // --- 离开房间 ---
  socket.on('room:leave', (roomId) => {
    const game = gameEngine.getGame(roomId);
    if (game && game.phase !== 'finished' && game.phase !== 'waiting') {
      // 游戏进行中 → Bot 托管接管，并从 roomManager 中移除真人玩家
      gameEngine.disconnectPlayer(roomId, socket.id);
      const result = roomManager.leaveRoom(socket, roomId);
      if (result) {
        if (!result.destroyed) {
          // 通知房间内其他玩家有人离开
          socket.to(roomId).emit('room:player_left', { player: result.player, players: result.players });
          // 显式调度托管 Bot 接管后续操作
          botManager.processBots(roomId);
        } else {
          // 房间已销毁（无人或只剩 Bot），清理 Bot 定时器
          botManager.cancelRoom(roomId);
        }
      }
      socket.emit('room:left', { roomId, managed: true });
      return;
    }

    const result = roomManager.leaveRoom(socket, roomId);
    if (!result) return;
    socket.emit('room:left', { roomId });
    if (!result.destroyed) {
      socket.to(roomId).emit('room:player_left', { player: result.player, players: result.players });
    } else {
      // 房间已销毁（包括全 Bot 情况），清理 Bot 定时器
      botManager.cancelRoom(roomId);
    }
  });

  // --- ★ 托管 / 取消托管（玩家保持连接） ---
  socket.on('game:autoPlay', (roomId) => {
    gameEngine.setPlayerManaged(roomId, socket.id);
    botManager.processBots(roomId);
  });

  socket.on('game:unautoPlay', (roomId) => {
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
  });

  // --- 踢出玩家 ---
  socket.on('room:kick', (roomId, targetId, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    const result = roomManager.kickPlayer(socket, roomId, targetId);
    if (!result.success) {
      callback(result);
      return;
    }
    // 通知被踢玩家
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.leave(roomId);
      targetSocket.emit('room:kicked', { roomId, msg: '你被房主移出了房间' });
    }

    // 如果被踢的是 Bot，清理其定时器
    if (result.kickedPlayer && result.kickedPlayer.isBot) {
      botManager.removeBot(roomId, targetId);
    }

    // 通知房间其他人
    io.to(roomId).emit('room:player_left', { player: result.kickedPlayer, players: result.players, kicked: true });
    callback({ success: true });
  });

  // --- 公开房间列表 ---
  socket.on('room:list', (callback) => {
    if (typeof callback !== 'function') return;
    const list = roomManager.getPublicRooms();
    callback({ success: true, rooms: list });
  });

  // --- 查询房间信息（加入前预览） ---
  socket.on('room:info', (roomId, callback) => {
    if (typeof callback !== 'function') return;
    const room = roomManager.getRoom(roomId);
    if (!room) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    const game = gameEngine.getGame(roomId);
    callback({
      success: true,
      roomId: room.roomId,
      mode: room.mode || 'classic',
      playerCount: room.players.length,
      hostNickname: room.players[0]?.nickname || '?',
      maxPlayers: room.maxPlayers || 6,
      isStarted: !!(game && game.phase !== 'waiting' && game.phase !== 'finished')
    });
  });

  // ------ 游戏操作 ------

  // --- 开始游戏（仅房主） ---
  socket.on('game:start', (roomId, callback) => {
    if (typeof callback !== 'function') callback = () => {};

    const room = roomManager.getPlayers(roomId);
    if (room.length < 2) {
      callback({ success: false, error: '至少需要2名玩家' });
      return;
    }

    const existing = gameEngine.getGame(roomId);
    if (existing && existing.phase !== 'finished' && existing.phase !== 'waiting') {
      // 幂等：游戏已在进行中，不报错（防止客户端重复点击）
      callback({ success: true });
      return;
    }

    try {
      // ★ 自动档解析：根据真人玩家数动态决定 Bot 难度
      resolveAutoStrategies(room);

      // ★ 获取房间模式配置，传给游戏引擎
      const roomData = roomManager.getRoom(roomId);
      const modeId = (roomData && roomData.mode) || 'classic';
      const modeConfig = require('./gameEngine').getModeConfig(modeId);
      gameEngine.initGame(roomId, room, modeConfig);

      console.log(`[服务器] 房间 ${roomId} 游戏开始！（模式: ${modeId}），玩家: ${room.map(p => p.nickname).join(', ')}`);

      // ★ 直接向发起者推送初始状态（不依赖 broadcast 的房间查询）
      const state = gameEngine.getGame(roomId);
      if (state) {
        try {
          const pv = require('./gameEngine').getPlayerView(state, socket.id);
          socket.emit('game_state_update', pv);
          console.log(`[服务器] ✓ 已直接推送 game_state_update 给房主 ${socket.id}`);
        } catch (e) {
          console.error(`[服务器] ✗ 房主推送失败:`, e.message);
        }
        // 延迟 300ms 后对其他玩家逐一推送
        setTimeout(() => {
          for (const p of state.players) {
            if (p.id === socket.id) continue;
            try {
              const pv2 = require('./gameEngine').getPlayerView(state, p.id);
              _io.to(p.id).emit('game_state_update', pv2);
            } catch (e) { /* ignore */ }
          }
          console.log(`[服务器] ✓ 已补推 game_state_update 给其余 ${state.players.length - 1} 名玩家`);
        }, 300);
      } else {
        console.error(`[服务器] ✗ initGame 完成但 getGame 返回 null！roomId=${roomId}`);
      }

      callback({ success: true });
    } catch (err) {
      console.error('[错误] 开始游戏失败:', err.message);
      callback({ success: false, error: err.message });
    }
  });

  // --- 请求当前游戏状态（客户端 fallback） ---
  socket.on('game:requestState', (roomId) => {
    const state = gameEngine.getGame(roomId);
    if (state) {
      try {
        const view = require('./gameEngine').getPlayerView(state, socket.id);
        socket.emit('game_state_update', view);
        console.log(`[服务器] 主动推送状态给 ${socket.id}, phase=${view.phase}`);
      } catch (err) {
        console.error(`[错误] requestState 失败:`, err.message);
      }
    }
  });

  // --- 报价（10/20/30/40/50 或 null） ---
  socket.on('game:bid', (roomId, percentage, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    // ★ 托管玩家手动操作 → 退出托管
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    const result = gameEngine.submitBid(roomId, socket.id, percentage);
    if (result.error) {
      callback({ success: false, error: result.error });
    } else {
      callback({ success: true, waiting: result.waiting });
    }
  });

  // --- 拍卖师选卡 ---
  socket.on('game:select_card', (roomId, cardIndex, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    const result = gameEngine.selectCard(roomId, socket.id, cardIndex);
    if (result.error) {
      callback({ success: false, error: result.error });
    } else {
      callback({ success: true, card: result.card });
    }
  });

  // --- 选骰子（d4/d6/d12/d20/pass） ---
  socket.on('game:select_dice', (roomId, diceType, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    const result = gameEngine.selectDice(roomId, socket.id, diceType);
    if (result.error) {
      callback({ success: false, error: result.error });
    } else {
      callback({ success: true, waiting: result.waiting });
    }
  });

  // --- 选骰子 + 升级组合接口（对书俑 checkbox 用） ---
  socket.on('game:select_dice_with_upgrade', (roomId, diceType, useUpgrade, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    const result = gameEngine.selectDiceWithUpgrade(roomId, socket.id, diceType, useUpgrade);
    if (result.error) {
      callback({ success: false, error: result.error });
    } else {
      callback({ success: true, waiting: result.waiting });
    }
  });

  // --- 掷骰（每人独立掷） ---
  socket.on('game:roll_dice', (roomId, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    const result = gameEngine.rollOneDice(roomId, socket.id);
    if (result.error) {
      callback({ success: false, error: result.error });
    } else {
      callback({ success: true });
    }
  });

  // --- 添加机器人 ---
  socket.on('room:add_bot', (roomId, difficulty, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    try {
      const room = roomManager.getPlayers(roomId);
      const existingNicknames = room.map(p => p.nickname);
      const botDifficulty = difficulty || 'auto';
      const bot = createBotPlayer(existingNicknames, botDifficulty);
      const result = roomManager.addBot(roomId, bot);
      if (!result.success) {
        callback(result);
        return;
      }
      // 通知大厅所有人
      io.to(roomId).emit('room:player_joined', { player: result.player, players: result.players });
      callback(result);
    } catch (err) {
      console.error('[错误] 添加机器人失败:', err.message);
      callback({ success: false, error: '添加机器人失败' });
    }
  });

  // --- 推进回合 ---
  socket.on('game:end_round', (roomId, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    const result = gameEngine.endRound(roomId);
    if (result.error) {
      callback({ success: false, error: result.error });
    } else {
      callback({ success: true, finished: result.finished, results: result.results });
    }
  });

  // --- 镜中决斗：选择对手 ---
  socket.on('game:duel_select_target', (roomId, targetId) => {
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    gameEngine.duelSelectTarget(socket, io, roomId, targetId);
  });

  // --- 镜中决斗：选择争夺卡牌 ---
  socket.on('game:duel_select_card', (roomId, cardId) => {
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    gameEngine.duelSelectCard(socket, io, roomId, cardId);
  });

  // --- 镜中决斗：租用骰子 ---
  socket.on('game:duel_rent_dice', (roomId, diceType, useUpgrade) => {
    if (gameEngine.unmanagePlayer(roomId, socket.id)) {
      botManager.cancelPlayerTimer(roomId, socket.id);
    }
    gameEngine.duelRentDice(socket, io, roomId, diceType, useUpgrade);
  });

  // --- 再来一局（重置游戏）---
  socket.on('game:restart', (roomId) => {
    gameEngine.restartGame(socket, io, roomId);
  });

  // --- 玩家重新加入（再来一局，单玩家）---
  socket.on('game:rejoin', (roomId) => {
    gameEngine.playerRejoin(socket, io, roomId);
  });

  // ------ 断开连接 ------

  socket.on('disconnect', () => {
    console.log(`[连接] 玩家下线: ${socket.id}`);

    security.cleanup(socket.id);

    const results = roomManager.handleDisconnect(socket);
    for (const r of results) {
      socket.to(r.roomId).emit('room:player_left', { player: r.player, players: r.players });

      const game = gameEngine.getGame(r.roomId);
      if (game && game.phase !== 'finished' && game.phase !== 'waiting') {
        // 游戏进行中 → Bot 托管接管
        gameEngine.disconnectPlayer(r.roomId, socket.id);
        // ★ 显式调度托管 Bot（不依赖 broadcast 回调链，消除竞态窗口）
        botManager.processBots(r.roomId);
        // 将玩家加回 roomManager（保留房间成员身份，方便重连）
        if (!r.destroyed) {
          roomManager.reAddPlayer(r.roomId, r.player);
        }
      }

      // 如果房间销毁或只剩 bot，清理定时器
      if (r.destroyed) {
        botManager.cancelRoom(r.roomId);
      }
    }
  });
});

// ==================== 启动 ====================

server.listen(PORT, () => {
  console.log(`[服务器] 马王堆拍卖游戏服务器已启动，端口: ${PORT}`);
});
