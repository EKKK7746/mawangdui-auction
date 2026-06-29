/**
 * Canvas 粒子骰子系统 — 马王堆「幽灵文物」风格
 *
 * 动画四阶段：
 *   1. SWIRL  (0-1200ms) — 金色粒子漩涡，混沌初开
 *   2. COLLAPSE (1200-2200ms) — 漩涡坍缩，粒子聚拢成骰形+数字
 *   3. GLOW   (2200-3000ms) — 骰子金光脉冲，数字稳定
 *   4. DISSOLVE (3000-4000ms) — 粒子向外飘散，淡出
 *
 * 支持的骰子: d4(三角), d6(方形), d12(五边), d20(六边)
 */

(function () {
  'use strict';

  /* ========== 配置 ========== */

  const PARTICLE_COUNT = 280;          // 粒子总数
  const DICE_OUTLINE_R = 100;          // 骰子轮廓半径
  const NUMBER_W = 80;                 // 数字采样区宽
  const NUMBER_H = 80;                 // 数字采样区高
  const SWIRL_R = 140;                 // 漩涡初始半径

  // 调色板：金色 + 赭红混合（马王堆漆器/金器色系）
  const PALETTE = [
    '#D4AF37', '#FFD700', '#C73E3A', '#E8C84A',
    '#A0522D', '#DAA520', '#CD5C5C', '#B8860B',
    '#B8442A', '#F5DEB3', '#D2691E', '#E8A840'
  ];

  // 阶段时长 (ms)
  const DURATION = {
    SWIRL: 1200,
    COLLAPSE: 1000,
    GLOW: 800,
    DISSOLVE: 1000
  };

  const PHASE = { SWIRL: 0, COLLAPSE: 1, GLOW: 2, DISSOLVE: 3, DONE: 4 };


  /* ========== 几何工具 ========== */

  /**
   * 生成正多边形顶点（骰子轮廓）
   */
  function polygonVertices(cx, cy, r, sides) {
    const verts = [];
    const startAngle = -Math.PI / 2; // 顶部开始
    for (let i = 0; i < sides; i++) {
      const a = startAngle + (2 * Math.PI * i) / sides;
      verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return verts;
  }

  /**
   * 在多边形边缘上均匀采样点（用于骰子轮廓粒子目标）
   */
  function samplePolygonEdges(verts, count) {
    const points = [];
    const n = verts.length;
    // 计算总周长
    let totalLen = 0;
    const segLens = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = verts[j].x - verts[i].x;
      const dy = verts[j].y - verts[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      segLens.push(len);
      totalLen += len;
    }
    // 均匀采样
    for (let k = 0; k < count; k++) {
      const t = totalLen * (k / count);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (acc + segLens[i] >= t || i === n - 1) {
          const localT = segLens[i] > 0 ? (t - acc) / segLens[i] : 0;
          points.push({
            x: verts[i].x + (verts[j].x - verts[i].x) * localT,
            y: verts[i].y + (verts[j].y - verts[i].y) * localT
          });
          break;
        }
        acc += segLens[i];
      }
    }
    return points;
  }

  /**
   * 通过离屏 canvas 采样数字形状 → 粒子位置列表
   */
  function sampleNumberShape(number, cx, cy, w, h) {
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const ctx = offscreen.getContext('2d');

    // 渲染文字
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 64px "Georgia", "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(number), w / 2, h / 2);

    // 采样像素
    const imageData = ctx.getImageData(0, 0, w, h);
    const positions = [];
    const step = 2; // 每 2px 采样一次
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const idx = (y * w + x) * 4;
        if (imageData.data[idx + 3] > 100) {
          positions.push({ x: cx + x - w / 2, y: cy + y - h / 2 });
        }
      }
    }
    return positions;
  }


  /* ========== 粒子引擎 ========== */

  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  let ctx = null;
  let animId = null;
  let particles = [];
  let state = null;
  let onCompleteCallback = null;

  function initParticle() {
    const angle = Math.random() * 2 * Math.PI;
    const dist = SWIRL_R * (0.3 + Math.random() * 0.7);
    return {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      tx: 0, ty: 0,                 // 目标位置
      vx: 0, vy: 0,                 // 当前速度
      size: 1.5 + Math.random() * 3.5,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      alpha: 0.7 + Math.random() * 0.3,
      // 漩涡状态
      swirlAngle: angle,
      swirlDist: dist,
      swirlSpeed: 0.5 + Math.random() * 2.0,
      // 个性
      phaseOffset: Math.random() * 0.3, // 响应延迟
    };
  }

  function createCanvas(container) {
    // 移除旧 canvas
    const old = container.querySelector('.dice-canvas');
    if (old) old.remove();

    canvas = document.createElement('canvas');
    canvas.className = 'dice-canvas';
    canvas.width = 360 * (window.devicePixelRatio || 1);
    canvas.height = 300 * (window.devicePixelRatio || 1);
    canvas.style.width = '360px';
    canvas.style.height = '300px';
    container.appendChild(canvas);

    ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  }

  /**
   * 计算所有粒子的目标位置
   */
  function computeTargets(diceType, resultNum, isReroll, v2) {
    const CX = 180, CY = 155; // canvas 逻辑中心
    const SIDES = { d4: 3, d6: 4, d12: 5, d20: 6 };
    const sides = SIDES[diceType] || 4;

    // 生成骰子轮廓目标点
    const verts = polygonVertices(CX, CY, DICE_OUTLINE_R, sides);
    const outlineTargets = samplePolygonEdges(verts, Math.floor(PARTICLE_COUNT * 0.55));

    // 生成数字形状目标点
    const numTargets = sampleNumberShape(resultNum, CX, CY, NUMBER_W, NUMBER_H);

    // 双签模式：第二颗骰子偏移
    let outlineTargets2 = [], numTargets2 = [];
    if (isReroll && v2 != null) {
      const CX2 = 90, CY2 = 155;
      const CX3 = 270, CY3 = 155;
      // 两骰并排，各占一半空间，缩小
      const R2 = 55;
      const verts2 = polygonVertices(CX2, CY2, R2, sides);
      const verts3 = polygonVertices(CX3, CY3, R2, sides);
      outlineTargets2 = samplePolygonEdges(verts2, Math.floor(PARTICLE_COUNT * 0.25));
      outlineTargets3 = samplePolygonEdges(verts3, Math.floor(PARTICLE_COUNT * 0.25));
      numTargets2 = sampleNumberShape(resultNum, CX2, CY2, 50, 50);
      numTargets3 = sampleNumberShape(v2, CX3, CY3, 50, 50);

      // 合并
      return [
        ...outlineTargets2, ...outlineTargets3,
        ...numTargets2, ...numTargets3
      ];
    }

    return [...outlineTargets, ...numTargets];
  }

  /**
   * 启动粒子动画
   */
  function startDiceAnimation(container, diceType, resultNum, isReroll, v2, onComplete) {
    // 清理旧动画
    cancelDiceAnimation();
    onCompleteCallback = onComplete || null;

    createCanvas(container);

    const targets = computeTargets(diceType, resultNum, isReroll, v2);
    const CX = 180, CY = 155;

    // 创建粒子
    particles = [];
    const actualCount = Math.min(PARTICLE_COUNT, targets.length);
    for (let i = 0; i < actualCount; i++) {
      const p = initParticle();
      // 打乱目标分配
      const ti = Math.floor(Math.random() * targets.length);
      p.tx = targets[ti].x - CX;
      p.ty = targets[ti].y - CY;
      // 移除已分配目标防止重复
      targets.splice(ti, 1);
      particles.push(p);
    }

    state = {
      phase: PHASE.SWIRL,
      elapsed: 0,
      lastTime: performance.now(),
      diceType,
      resultNum,
      CX, CY,
      soundPlayed: { shake: false, pop: false }
    };

    animId = requestAnimationFrame(tick);
  }

  function tick(now) {
    if (!state) return;

    const dt = Math.min(now - state.lastTime, 50); // 防大帧跳跃
    state.lastTime = now;
    state.elapsed += dt;

    const { CX, CY } = state;

    // 决定当前阶段
    let phase = PHASE.SWIRL;
    let phaseProgress = 0;
    let acc = 0;
    for (const p of [PHASE.SWIRL, PHASE.COLLAPSE, PHASE.GLOW, PHASE.DISSOLVE]) {
      const dur = DURATION[Object.keys(DURATION)[p]];
      if (state.elapsed <= acc + dur) {
        phase = p;
        phaseProgress = Math.max(0, Math.min(1, (state.elapsed - acc) / dur));
        break;
      }
      acc += dur;
      phase = PHASE.DONE;
    }

    if (state.phase !== PHASE.DONE) state.phase = phase;

    // 音效触发
    if (!state.soundPlayed.shake && phase >= PHASE.COLLAPSE && state.elapsed > DURATION.SWIRL + 200) {
      state.soundPlayed.shake = true;
      if (typeof playSound === 'function') playSound('qianShake');
    }
    if (!state.soundPlayed.pop && phase >= PHASE.GLOW && state.elapsed > DURATION.SWIRL + DURATION.COLLAPSE + 100) {
      state.soundPlayed.pop = true;
      if (typeof playSound === 'function') playSound('qianPop');
    }

    // 清除画布（透明背景）
    ctx.clearRect(0, 0, 360, 300);

    // 更新 + 渲染粒子
    for (const p of particles) {
      const effProgress = Math.max(0, Math.min(1, phaseProgress - p.phaseOffset));

      switch (phase) {
        case PHASE.SWIRL: {
          // 粒子绕中心旋转 + 缓慢内缩
          p.swirlAngle += p.swirlSpeed * 0.02 * (dt / 16);
          p.swirlDist += (SWIRL_R * 0.2 - p.swirlDist) * 0.01 * (dt / 16);
          const tx = CX + Math.cos(p.swirlAngle) * p.swirlDist;
          const ty = CY + Math.sin(p.swirlAngle) * p.swirlDist;
          p.x += (tx - p.x) * 0.08;
          p.y += (ty - p.y) * 0.08;
          p.alpha = 0.6 + Math.sin(p.swirlAngle * 3 + state.elapsed * 0.003) * 0.3;
          break;
        }
        case PHASE.COLLAPSE: {
          // 向目标位置聚拢
          const tx = CX + p.tx;
          const ty = CY + p.ty;
          p.x += (tx - p.x) * 0.06 * (dt / 16);
          p.y += (ty - p.y) * 0.06 * (dt / 16);
          p.alpha = 0.5 + effProgress * 0.5;
          p.size = 1.5 + (3.5 - 1.5) * (1 - effProgress * 0.6); // 聚拢时缩小
          break;
        }
        case PHASE.GLOW: {
          // 在目标位置微颤 + 金光脉冲
          const tx = CX + p.tx;
          const ty = CY + p.ty;
          const jitter = 2 * (1 - effProgress);
          p.x = tx + (Math.random() - 0.5) * jitter;
          p.y = ty + (Math.random() - 0.5) * jitter;
          p.alpha = 0.8 + Math.sin(effProgress * Math.PI * 3) * 0.2;
          p.size = 2 + 2 * Math.sin(effProgress * Math.PI * 4) * 0.5;
          break;
        }
        case PHASE.DISSOLVE: {
          // 粒子向外飘散
          const dx = p.x - CX;
          const dy = p.y - CY;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          p.x += (dx / dist) * 0.8 * effProgress * (dt / 16);
          p.y += (dy / dist) * 0.8 * effProgress * (dt / 16);
          // 加轻微随机漂移
          p.x += (Math.random() - 0.5) * 0.5;
          p.y += (Math.random() - 0.5) * 0.5;
          p.alpha = Math.max(0, 0.9 * (1 - effProgress));
          p.size *= 0.998;
          break;
        }
        case PHASE.DONE:
          p.alpha = 0;
          break;
      }

      // 渲染粒子
      if (p.alpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = phase >= PHASE.GLOW ? 6 + 4 * Math.sin(phaseProgress * Math.PI * 3) : 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 阶段 3 (GLOW) — 中心辉光环
    if (phase === PHASE.GLOW) {
      const glowAlpha = 0.15 + 0.1 * Math.sin(phaseProgress * Math.PI * 4);
      ctx.save();
      ctx.globalAlpha = glowAlpha;
      const grad = ctx.createRadialGradient(CX, CY, DICE_OUTLINE_R * 0.3, CX, CY, DICE_OUTLINE_R * 1.4);
      grad.addColorStop(0, '#FFC040');
      grad.addColorStop(0.3, '#C75B3A');
      grad.addColorStop(0.6, 'rgba(180,68,42,0.35)');
      grad.addColorStop(1, 'rgba(212,175,55,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(CX - DICE_OUTLINE_R * 2, CY - DICE_OUTLINE_R * 2, DICE_OUTLINE_R * 4, DICE_OUTLINE_R * 4);
      ctx.restore();
    }

    // 阶段 1-2 — 漩涡中心微光
    if (phase <= PHASE.COLLAPSE) {
      const glowR = SWIRL_R * (phase === PHASE.COLLAPSE ? (1 - phaseProgress) * 0.6 : 0.6);
      ctx.save();
      ctx.globalAlpha = 0.08;
      const grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, glowR);
      grad.addColorStop(0, '#E8C84A');
      grad.addColorStop(1, 'rgba(199,62,58,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(CX - glowR, CY - glowR, glowR * 2, glowR * 2);
      ctx.restore();
    }

    // 继续或结束
    if (phase === PHASE.DONE || state.elapsed >= 4000) {
      // 延长 0.5s 让消散完成
      if (state.elapsed >= 4500) {
        cancelDiceAnimation();
        if (onCompleteCallback) onCompleteCallback();
        return;
      }
    }

    animId = requestAnimationFrame(tick);
  }

  function cancelDiceAnimation() {
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    particles = [];
    state = null;
  }

  function removeCanvas() {
    cancelDiceAnimation();
    if (canvas && canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
    canvas = null;
    ctx = null;
  }


  /* ========== 全局 API ========== */

  window.startDiceAnimation = startDiceAnimation;
  window.cancelDiceAnimation = cancelDiceAnimation;
  window.removeDiceCanvas = removeCanvas;

})();
