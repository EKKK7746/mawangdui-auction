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

function createRoom(socket, nickname, isPublic, opts = {}) {
  const roomId = generateRoomId();
  const player = { id: socket.id, nickname, isHost: true };
  const mode = opts.mode || 'classic';
  const maxPlayers = opts.maxPlayers || 6;

  rooms.set(roomId, {
    roomId,
    players: [player],
    spectators: [],
    gameState: null,
    createdAt: Date.now(),
    hostSocketId: socket.id,
    isPublic: !!isPublic,
    mode,
    maxPlayers
  });

  socket.join(roomId);
  console.log(`[房间] ${nickname} 创建房间 ${roomId} (${isPublic ? '公开' : '私密'}, ${mode}, 最多${maxPlayers}人)`);
  return { roomId, players: getPlayers(roomId) };
}

function joinRoom(socket, roomId, nickname) {
  const room = rooms.get(roomId);

  if (!room)  return { success: false, error: '房间不存在' };
  const maxP = room.maxPlayers || 6;
  if (room.players.length >= maxP) return { success: false, error: `房间已满（最多${maxP}人）` };
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
    // 先检查是否是观战者
    const spectator = room.spectators.find(s => s.id === socket.id);
    if (spectator) {
      room.spectators = room.spectators.filter(s => s.id !== socket.id);
      console.log(`[房间] 观战者 ${spectator.nickname} 断连，离开房间 ${roomId}`);
      continue; // 观战者断连不触发 player_left 通知
    }

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

// -------------------- 观战功能 --------------------

/**
 * 以观战者身份加入房间（不参与游戏，只观看）
 */
function joinAsSpectator(socket, roomId, nickname) {
  const room = rooms.get(roomId);
  if (!room) return { success: false, error: '房间不存在' };

  // 检查是否已在房间内（玩家或观战者）
  if (room.players.some(p => p.id === socket.id)) {
    return { success: false, error: '你已在房间中' };
  }
  if (room.spectators.some(s => s.id === socket.id)) {
    return { success: false, error: '你已在观战中' };
  }

  const spectator = { id: socket.id, nickname };
  room.spectators.push(spectator);
  socket.join(roomId);

  console.log(`[房间] ${nickname} 以观战者身份加入房间 ${roomId}`);
  return { success: true, spectator, roomId };
}

/**
 * 观战者离开房间
 */
function leaveSpectator(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;

  const spectator = room.spectators.find(s => s.id === socket.id);
  if (!spectator) return null;

  room.spectators = room.spectators.filter(s => s.id !== socket.id);
  socket.leave(roomId);

  console.log(`[房间] 观战者 ${spectator.nickname} 离开房间 ${roomId}`);
  return { spectator, roomId };
}

/**
 * 获取房间观战者列表
 */
function getSpectators(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return room.spectators.map(s => ({ id: s.id, nickname: s.nickname }));
}

// -------------------- 查询接口 --------------------

function getPlayers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return room.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost, isBot: !!p.isBot, strategy: p.strategy }));
}

// -------------------- Bot 操作 --------------------

function addBot(roomId, botPlayer) {
  const room = rooms.get(roomId);
  if (!room) return { success: false, error: '房间不存在' };
  const maxP = room.maxPlayers || 6;
  if (room.players.length >= maxP) return { success: false, error: `房间已满（最多${maxP}人）` };
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
        maxPlayers: room.maxPlayers || 6,
        hostNickname: room.players[0]?.nickname || '?',
        mode: room.mode || 'classic',
        isPublic: true,
      });
    }
  }
  return result;
}

/**
 * 获取房间对象（用于 room:info 查询）
 */
function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

// -------------------- 导出 --------------------

/**
 * 将玩家重新加入房间（用于断线后保留房间成员身份以便重连）
 */
function reAddPlayer(roomId, player) {
  const room = rooms.get(roomId);
  if (!room) return false;
  // 避免重复添加
  if (room.players.some(p => p.id === player.id)) return true;
  room.players.push(player);
  console.log(`[房间] 托管玩家 ${player.nickname}(${player.id}) 保留在房间 ${roomId}`);
  return true;
}

/**
 * 更新玩家 ID（托管玩家重连时 socket ID 变化）
 */
function updatePlayerId(roomId, oldId, newId, nickname) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const player = room.players.find(p => p.id === oldId);
  if (!player) {
    // 如果旧 ID 不在（可能已被清理），直接添加
    room.players.push({ id: newId, nickname, isHost: false, isBot: false });
    if (room.hostSocketId === oldId) room.hostSocketId = newId;
    return true;
  }
  player.id = newId;
  if (player.nickname !== nickname) player.nickname = nickname;
  if (room.hostSocketId === oldId) room.hostSocketId = newId;
  console.log(`[房间] 更新玩家ID: ${oldId} → ${newId} (${nickname})`);
  return true;
}

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  handleDisconnect,
  getPlayers,
  getRoom,
  roomExists,
  addBot,
  kickPlayer,
  getPublicRooms,
  joinAsSpectator,
  leaveSpectator,
  getSpectators,
  reAddPlayer,
  updatePlayerId,
};
