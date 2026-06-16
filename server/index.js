// ============================================================
// index.js - Express + Socket.IO 游戏服务器入口
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const roomManager = require('./roomManager');
const gameEngine = require('./gameEngine');
const { BotManager, createBotPlayer } = require('./bot');

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

// ==================== 连接管理 ====================

io.on('connection', (socket) => {
  console.log(`[连接] 玩家上线: ${socket.id}`);

  // ------ 房间操作 ------

  // --- 创建房间 ---
  socket.on('room:create', (nickname, isPublic, callback) => {
    if (typeof callback !== 'function') {
      console.warn('[警告] room:create 缺少回调函数');
      return;
    }
    try {
      const { roomId, players } = roomManager.createRoom(socket, nickname, isPublic);
      socket.emit('room:created', { roomId, players });
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

  // --- 离开房间 ---
  socket.on('room:leave', (roomId) => {
    const game = gameEngine.getGame(roomId);
    if (game && game.phase !== 'finished') {
      gameEngine.removePlayer(roomId, socket.id);
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
      callback({ success: false, error: '游戏已在进行中' });
      return;
    }

    try {
      gameEngine.initGame(roomId, room);
      console.log(`[服务器] 房间 ${roomId} 游戏开始！`);
      callback({ success: true });
    } catch (err) {
      console.error('[错误] 开始游戏失败:', err.message);
      callback({ success: false, error: err.message });
    }
  });

  // --- 报价（10/20/30/40/50 或 null） ---
  socket.on('game:bid', (roomId, percentage, callback) => {
    if (typeof callback !== 'function') callback = () => {};
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
    const result = gameEngine.rollOneDice(roomId, socket.id);
    if (result.error) {
      callback({ success: false, error: result.error });
    } else {
      callback({ success: true });
    }
  });

  // --- 添加机器人 ---
  socket.on('room:add_bot', (roomId, botName, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    try {
      const room = roomManager.getPlayers(roomId);
      const existingNicknames = room.map(p => p.nickname);
      const bot = createBotPlayer(existingNicknames);
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
    const result = gameEngine.endRound(roomId);
    if (result.error) {
      callback({ success: false, error: result.error });
    } else {
      callback({ success: true, finished: result.finished, results: result.results });
    }
  });

  // --- 镜中决斗：选择对手 ---
  socket.on('game:duel_select_target', (roomId, targetId) => {
    gameEngine.duelSelectTarget(socket, io, roomId, targetId);
  });

  // --- 镜中决斗：选择争夺卡牌 ---
  socket.on('game:duel_select_card', (roomId, cardId) => {
    gameEngine.duelSelectCard(socket, io, roomId, cardId);
  });

  // --- 镜中决斗：租用骰子 ---
  socket.on('game:duel_rent_dice', (roomId, diceType, useUpgrade) => {
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

    const results = roomManager.handleDisconnect(socket);
    for (const r of results) {
      socket.to(r.roomId).emit('room:player_left', { player: r.player, players: r.players });

      const game = gameEngine.getGame(r.roomId);
      if (game && game.phase !== 'finished') {
        gameEngine.removePlayer(r.roomId, socket.id);
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
