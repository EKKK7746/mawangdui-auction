// ============================================================
// roomManager.js - 房间创建/加入/离开/销毁（纯逻辑，不做IO广播）
// ============================================================

const rooms = new Map();

// -------------------- 房间号生成 --------------------

function generateRoomId() {
  const MIN = 100000;
  const MAX = 999999;
  while (true) {
    const id = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    if (!isAllSame(id) && !isSequential(id)) {
      return String(id);
    }
  }
}

function isAllSame(num) {
  const s = String(num);
  return s.split('').every(ch => ch === s[0]);
}

function isSequential(num) {
  const s = String(num);
  const digits = s.split('').map(Number);
  let asc = true, desc = true;
  for (let i = 1; i < digits.length; i++) {
    if (digits[i] !== digits[i - 1] + 1) asc = false;
    if (digits[i] !== digits[i - 1] - 1) desc = false;
  }
  return asc || desc;
}

// -------------------- 辅助：查找人类玩家 --------------------

/**
 * 找到房间内第一个非 Bot 玩家
 * @returns {object|null} 第一个人类玩家，或 null（全是 Bot 或空）
 */
function _findFirstHuman(room) {
  return room.players.find(p => !p.isBot) || null;
}

/**
 * 检查房间是否只剩 Bot（或为空）
 * @returns {boolean}
 */
function _isOnlyBots(room) {
  return room.players.length > 0 && !room.players.some(p => !p.isBot);
}

// -------------------- 房间操作 --------------------

function createRoom(socket, nickname, isPublic) {
  const roomId = generateRoomId();
  const player = { id: socket.id, nickname, isHost: true };

  rooms.set(roomId, {
    roomId,
    players: [player],
    gameState: null,
    createdAt: Date.now(),
    hostSocketId: socket.id,
    isPublic: !!isPublic
  });

  socket.join(roomId);
  console.log(`[房间] ${nickname} 创建房间 ${roomId} (${isPublic ? '公开' : '私密'})`);
  return { roomId, players: getPlayers(roomId) };
}

function joinRoom(socket, roomId, nickname) {
  const room = rooms.get(roomId);

  if (!room)  return { success: false, error: '房间不存在' };
  if (room.players.length >= 6) return { success: false, error: '房间已满（最多6人）' };
  if (room.gameState !== null) return { success: false, error: '游戏已开始，无法加入' };
  if (room.players.some(p => p.nickname === nickname)) return { success: false, error: '昵称已被使用' };

  const player = { id: socket.id, nickname, isHost: false };
  room.players.push(player);
  socket.join(roomId);

  console.log(`[房间] ${nickname} 加入房间 ${roomId}`);

  return {
    success: true,
    player,
    players: getPlayers(roomId),
    roomId
  };
}

function leaveRoom(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;

  const player = room.players.find(p => p.id === socket.id);
  if (!player) return null;

  const wasHost = player.isHost;
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(roomId);

  console.log(`[房间] ${player.nickname} 离开房间 ${roomId}`);

  let destroyed = false;
  if (room.players.length === 0) {
    rooms.delete(roomId);
    destroyed = true;
    console.log(`[房间] 房间 ${roomId} 已销毁（无玩家）`);
  } else if (_isOnlyBots(room)) {
    // 只剩 Bot，销毁房间
    rooms.delete(roomId);
    destroyed = true;
    console.log(`[房间] 房间 ${roomId} 已销毁（只剩机器人）`);
  } else if (wasHost) {
    // 房主离开，转移给第一个人类玩家
    const newHost = _findFirstHuman(room);
    if (newHost) {
      newHost.isHost = true;
      room.hostSocketId = newHost.id;
      console.log(`[房间] 房主转移至 ${newHost.nickname}`);
    }
  }

  return {
    player,
    players: destroyed ? [] : getPlayers(roomId),
    roomId,
    destroyed,
    wasHost
  };
}

function handleDisconnect(socket) {
  const results = [];
  for (const [roomId, room] of rooms) {
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      room.players = room.players.filter(p => p.id !== socket.id);
      const destroyed = room.players.length === 0 || _isOnlyBots(room);
      if (destroyed) {
        rooms.delete(roomId);
        console.log(`[房间] 房间 ${roomId} 已销毁（断连，${room.players.length === 0 ? '无玩家' : '只剩机器人'}）`);
      } else if (player.isHost) {
        const newHost = _findFirstHuman(room);
        if (newHost) {
          newHost.isHost = true;
          room.hostSocketId = newHost.id;
        }
      }
      results.push({ player, players: getPlayers(roomId), roomId, destroyed });
    }
  }
  return results;
}

// -------------------- 查询接口 --------------------

function getPlayers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return room.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost, isBot: !!p.isBot }));
}

// -------------------- Bot 操作 --------------------

function addBot(roomId, botPlayer) {
  const room = rooms.get(roomId);
  if (!room) return { success: false, error: '房间不存在' };
  if (room.players.length >= 6) return { success: false, error: '房间已满（最多6人）' };
  if (room.gameState !== null) return { success: false, error: '游戏已开始，无法加入' };

  const player = {
    id: botPlayer.id,
    nickname: botPlayer.nickname,
    isHost: false,
    isBot: true,
    strategy: botPlayer.strategy || 'greedy',
  };
  room.players.push(player);
  console.log(`[房间] Bot ${botPlayer.nickname} 加入房间 ${roomId}`);
  return { success: true, player, players: getPlayers(roomId), roomId };
}

function roomExists(roomId) {
  return rooms.has(roomId);
}

// -------------------- 踢人 --------------------

function kickPlayer(socket, roomId, targetId) {
  const room = rooms.get(roomId);
  if (!room) return { success: false, error: '房间不存在' };
  if (room.hostSocketId !== socket.id) return { success: false, error: '只有房主可以踢人' };
  if (room.gameState !== null) return { success: false, error: '游戏已开始，无法踢人' };

  const target = room.players.find(p => p.id === targetId);
  if (!target) return { success: false, error: '目标玩家不存在' };
  if (target.isHost) return { success: false, error: '不能踢出房主' };

  room.players = room.players.filter(p => p.id !== targetId);
  console.log(`[房间] 房主踢出 ${target.nickname} (${targetId}) 从房间 ${roomId}`);
  return { success: true, kickedPlayer: target, players: getPlayers(roomId) };
}

// -------------------- 公开房间列表 --------------------

function getPublicRooms() {
  const result = [];
  for (const [, room] of rooms) {
    if (room.isPublic && !room.gameState) {
      result.push({
        roomId: room.roomId,
        playerCount: room.players.length,
        hostNickname: room.players[0]?.nickname || '?',
        isPublic: true,
      });
    }
  }
  return result;
}

// -------------------- 导出 --------------------

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  handleDisconnect,
  getPlayers,
  roomExists,
  addBot,
  kickPlayer,
  getPublicRooms,
};
