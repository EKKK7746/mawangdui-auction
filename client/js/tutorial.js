// ============================================================
// tutorial.js — 新手引导系统
// ============================================================

// 教程引导文案（按阶段）
const TUTORIAL_STEPS = {
  auction: {
    icon: '⚖️',
    title: '竞标拍卖师',
    text: '所有人同时秘密报价佣金比例（10%~50%）。\n数字越小越容易当选拍卖师！\n拍卖师本轮不参与掷骰，但可以抽取佣金。\n在下方输入你的佣金比例，然后点「确认报价」。',
  },
  select_card: {
    icon: '🏺',
    title: '挑选文物（拍卖师）',
    text: '作为拍卖师，你从本轮剩余的文物中挑选一张进行拍卖。\n点击你想拍卖的文物卡牌。',
  },
  rent_dice: {
    icon: '🎲',
    title: '租骰阶段',
    text: '选择你想要的骰子来争夺卡牌！\n• d4：1💰（胜率低）\n• d6：2💰\n• d12：4💰\n• d20：6💰（胜率高）\n选好骰子后点「确认」。',
  },
  roll_dice: {
    icon: '🎯',
    title: '掷骰对决',
    text: '所有玩家掷骰子，点数最高者赢得卡牌！\n点击「掷骰」按钮，看看你的运气如何。',
  },
  settle: {
    icon: '🏆',
    title: '结算阶段',
    text: '点数最高者获得本轮文物卡牌！\n拍卖师获得佣金收入。\n持有特定卡牌组合可以触发联动效果。',
  },
};

// 阶段顺序
const TUTORIAL_PHASES = ['auction', 'select_card', 'rent_dice', 'roll_dice', 'settle'];

// -------------------- 弹窗控制 --------------------

function openTutorialModal() {
  const modal = document.getElementById('tutorialModal');
  if (modal) modal.style.display = 'flex';
}

function closeTutorialModal() {
  const modal = document.getElementById('tutorialModal');
  if (modal) modal.style.display = 'none';
}

// 从教程弹窗打开游戏介绍
function openIntroFromTutorial() {
  closeTutorialModal();
  if (typeof openIntro === 'function') openIntro();
}

// -------------------- 新手教程：创建教程对局 --------------------

/**
 * 开始新手教程——自动创建房间、添加 Bot、开始游戏
 */
function startTutorial() {
  closeTutorialModal();

  // 确保用户有昵称
  const nicknameInput = document.getElementById('startNickname');
  const nickname = (nicknameInput && nicknameInput.value.trim()) || GameState.nickname;
  if (!nickname || nickname.length < 2) {
    if (typeof showToast === 'function') showToast('请先输入你的名字（至少2个字）', 'error');
    return;
  }

  // 保存昵称
  GameState.nickname = nickname;
  if (nicknameInput) nicknameInput.value = nickname;

  // 设置教程模式和极速模式
  GameState._tutorial = { active: true, seenPhases: {}, completed: false };
  GameState.selectedMode = getModeById('speed');

  if (typeof showLoading === 'function') showLoading('正在创建教程房间...');

  // 1. 创建房间（极速模式，2人）
  socket.emit('room:create', nickname, false, { mode: 'speed', maxPlayers: 2 }, (res) => {
    if (!res || !res.success) {
      if (typeof hideLoading === 'function') hideLoading();
      if (typeof showToast === 'function') showToast('创建教程房间失败: ' + (res?.error || '未知错误'), 'error');
      GameState._tutorial = null;
      return;
    }

    GameState.roomId = res.roomId;
    console.log('[教程] 房间已创建:', res.roomId);

    // 2. 添加一个简单难度的 Bot
    socket.emit('room:add_bot', res.roomId, 'easy', (botRes) => {
      if (!botRes || !botRes.success) {
        if (typeof hideLoading === 'function') hideLoading();
        if (typeof showToast === 'function') showToast('添加AI对手失败: ' + (botRes?.error || '未知错误'), 'error');
        GameState._tutorial = null;
        return;
      }

      console.log('[教程] Bot 已加入');

      // 3. 开始游戏
      socket.emit('game:start', res.roomId, (startRes) => {
        if (typeof hideLoading === 'function') hideLoading();

        if (!startRes || !startRes.success) {
          if (typeof showToast === 'function') showToast('开始游戏失败: ' + (startRes?.error || '未知错误'), 'error');
          GameState._tutorial = null;
          return;
        }

        console.log('[教程] 游戏已开始！');
        if (typeof showToast === 'function') showToast('🎓 新手教程开始！跟着引导一步步操作吧~', 'info');
      });
    });
  });
}

/**
 * 渲染教程引导面板（在 game action area 顶部）
 */
function renderTutorialPanel(phase) {
  if (!GameState._tutorial || !GameState._tutorial.active) return '';

  const step = TUTORIAL_STEPS[phase];
  if (!step) return '';

  // 记录已见过的阶段
  GameState._tutorial.seenPhases[phase] = true;
  const seenCount = Object.keys(GameState._tutorial.seenPhases).length;

  // 进度点
  let dots = '';
  for (const p of TUTORIAL_PHASES) {
    const done = GameState._tutorial.seenPhases[p];
    dots += `<span class="tutorial-dot ${done ? 'done' : (p === phase ? 'active' : '')}"></span>`;
  }

  // 自动检测当前是谁的回合
  let whoNote = '';
  const gd = GameState.gameData;
  if (gd) {
    if (gd.isAuctioneer && phase === 'select_card') {
      whoNote = '<p style="margin-top:6px;color:#C9A96E;font-weight:600;">👆 这一轮你是拍卖师，由你选卡！</p>';
    } else if (!gd.isAuctioneer && phase === 'select_card') {
      whoNote = '<p style="margin-top:6px;color:#999;">⏳ 等待拍卖师选卡中...</p>';
    }
  }

  return `
    <div class="tutorial-panel">
      <div class="tutorial-panel-header">
        <span class="tutorial-panel-icon">${step.icon}</span>
        <span>${step.title}</span>
      </div>
      <div class="tutorial-panel-text">${step.text.replace(/\n/g, '<br>')}</div>
      ${whoNote}
      <div class="tutorial-panel-progress">${dots}</div>
    </div>
  `;
}

/**
 * 教程结束——显示完成页面
 */
function renderTutorialComplete() {
  if (!GameState._tutorial || GameState._tutorial.completed) return '';

  GameState._tutorial.completed = true;
  if (typeof playSound === 'function') playSound('victory');

  return `
    <div class="tutorial-complete">
      <div class="tutorial-complete-icon">🎉</div>
      <div class="tutorial-complete-title">教程完成！</div>
      <div class="tutorial-complete-text">
        你已经体验了一局完整的极速对局！<br>
        现在可以开始真正的对战了～
      </div>
      <button class="btn btn-primary" onclick="finishTutorial()" style="margin-top:12px;">🎮 开始真正的游戏</button>
      <button class="btn btn-outline" onclick="finishTutorial()" style="margin-top:8px;display:block;width:100%;">回到模式选择</button>
    </div>
  `;
}

/**
 * 退出教程
 */
function finishTutorial() {
  GameState._tutorial = null;
  // 如果在游戏中，离开房间（room:left 事件会自动切到模式选择）
  if (GameState.roomId) {
    socket.emit('room:leave', GameState.roomId);
  } else {
    goToMode();
  }
}

// -------------------- 绑定事件 --------------------

document.addEventListener('DOMContentLoaded', () => {
  const btnHowToPlay = document.getElementById('btnHowToPlay');
  if (btnHowToPlay) {
    btnHowToPlay.addEventListener('click', openTutorialModal);
  }
});

// 点击遮罩关闭教程弹窗
document.addEventListener('click', (e) => {
  const modal = document.getElementById('tutorialModal');
  if (e.target === modal) closeTutorialModal();
});
