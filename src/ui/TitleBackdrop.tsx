import { useEffect, useRef } from 'react';

interface Stream {
  x: number;
  y: number;
  speed: number;
  len: number;
  hue: 'cyan' | 'magenta';
  width: number;
}

interface FloatCard {
  x: number;
  y: number;
  scale: number;
  rot: number;
  drift: number;
  speed: number;
  phase: number;
  accent: string;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Animated title backdrop. Pure presentation: canvas only, no game state.
 * Draws a receding grid, data streams, floating hologram cards and a scan sweep.
 */
export function TitleBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let time = 0;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const rand = mulberry(20261028);

    const streams: Stream[] = Array.from({ length: 34 }, () => ({
      x: rand(),
      y: rand(),
      speed: 0.02 + rand() * 0.09,
      len: 0.05 + rand() * 0.22,
      hue: rand() > 0.82 ? 'magenta' : 'cyan',
      width: 1 + rand() * 2.2,
    }));
    const cards: FloatCard[] = Array.from({ length: 11 }, (_, i) => ({
      x: 0.06 + rand() * 0.9,
      y: 0.16 + rand() * 0.66,
      scale: 0.55 + rand() * 0.9,
      rot: -0.34 + rand() * 0.68,
      drift: 0.02 + rand() * 0.04,
      speed: 0.35 + rand() * 0.5,
      phase: i * 1.7 + rand() * 2,
      accent: i % 4 === 0 ? '#ff2f7d' : i % 3 === 0 ? '#ffb454' : '#38f2cf',
    }));

    const resize = (): void => {
      const parent = canvas.parentElement;
      width = Math.max(320, parent?.clientWidth ?? window.innerWidth);
      height = Math.max(320, parent?.clientHeight ?? window.innerHeight);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const onPointer = (e: PointerEvent): void => {
      pointer.tx = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
      pointer.ty = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
    };

    const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    const draw = (t: number): void => {
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      const px = pointer.x * 18;
      const py = pointer.y * 10;
      const horizon = height * 0.5 + py * 0.4;

      const bg = ctx.createLinearGradient(0, 0, 0, height);
      bg.addColorStop(0, '#05080c');
      bg.addColorStop(0.52, '#08121a');
      bg.addColorStop(1, '#04070a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      // receding grid
      const vx = width * 0.5 + px;
      ctx.save();
      ctx.lineWidth = 1;
      for (let i = -14; i <= 14; i++) {
        const bx = vx + i * (width / 9);
        const grad = ctx.createLinearGradient(vx, horizon, bx, height);
        grad.addColorStop(0, 'rgba(56,242,207,0)');
        grad.addColorStop(0.35, i === 0 ? 'rgba(56,242,207,0.35)' : 'rgba(56,242,207,0.12)');
        grad.addColorStop(1, 'rgba(56,242,207,0.03)');
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(vx, horizon);
        ctx.lineTo(bx, height);
        ctx.stroke();
      }
      const scroll = (t * 0.06) % 1;
      for (let i = 0; i < 18; i++) {
        const p = (i / 18 + scroll) % 1;
        const y = horizon + Math.pow(p, 2.2) * (height - horizon);
        const alpha = 0.05 + p * 0.28;
        ctx.strokeStyle = `rgba(56,242,207,${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.restore();

      const horizonGlow = ctx.createLinearGradient(0, horizon - 26, 0, horizon + 26);
      horizonGlow.addColorStop(0, 'rgba(56,242,207,0)');
      horizonGlow.addColorStop(0.5, 'rgba(56,242,207,0.22)');
      horizonGlow.addColorStop(1, 'rgba(56,242,207,0)');
      ctx.fillStyle = horizonGlow;
      ctx.fillRect(0, horizon - 26, width, 52);

      // data streams
      for (const s of streams) {
        const y = ((s.y - t * s.speed) % 1 + 1) % 1;
        const top = y * height;
        const len = s.len * height;
        const x = s.x * width + px * (0.3 + s.x * 0.5);
        const grad = ctx.createLinearGradient(x, top, x, top + len);
        const color = s.hue === 'magenta' ? '255,47,125' : '56,242,207';
        grad.addColorStop(0, `rgba(${color},0)`);
        grad.addColorStop(0.55, `rgba(${color},0.42)`);
        grad.addColorStop(1, `rgba(${color},0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = s.width;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + len);
        ctx.stroke();
        ctx.fillStyle = `rgba(${color},0.5)`;
        ctx.fillRect(x - 1.5, top + len * 0.62, 3, 3);
      }

      // floating hologram cards
      ctx.save();
      for (const c of cards) {
        const bob = Math.sin(t * c.speed + c.phase) * c.drift * height;
        const drift = Math.cos(t * c.speed * 0.6 + c.phase) * c.drift * width * 0.5;
        const x = c.x * width + drift + px * (0.5 + c.x);
        const y = c.y * height + bob + py * 0.6;
        const w = 74 * c.scale;
        const h = 104 * c.scale;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(c.rot + Math.sin(t * 0.3 + c.phase) * 0.05);
        ctx.globalAlpha = 0.16 + 0.1 * Math.abs(Math.sin(t * 0.8 + c.phase));
        ctx.fillStyle = '#061018';
        roundRect(-w / 2, -h / 2, w, h, 6);
        ctx.fill();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 1.2;
        roundRect(-w / 2, -h / 2, w, h, 6);
        ctx.stroke();
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 8, -h / 2 + 26);
        ctx.lineTo(w / 2 - 8, -h / 2 + 26);
        ctx.stroke();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = c.accent;
        ctx.fillRect(-w / 2 + 9, -h / 2 + 10, 16, 9);
        ctx.fillRect(-w / 2 + 9, h / 2 - 30, w - 18, 3);
        ctx.fillRect(-w / 2 + 9, h / 2 - 22, w - 30, 3);
        ctx.restore();
      }
      ctx.restore();

      // scan sweep
      const sweepY = ((t * 0.08) % 1.3) * height - height * 0.15;
      const sweep = ctx.createLinearGradient(0, sweepY - 60, 0, sweepY + 60);
      sweep.addColorStop(0, 'rgba(56,242,207,0)');
      sweep.addColorStop(0.5, 'rgba(56,242,207,0.06)');
      sweep.addColorStop(1, 'rgba(56,242,207,0)');
      ctx.fillStyle = sweep;
      ctx.fillRect(0, sweepY - 60, width, 120);

      // vignette + grain
      const vig = ctx.createRadialGradient(width * 0.5, height * 0.48, Math.min(width, height) * 0.25, width * 0.5, height * 0.5, Math.max(width, height) * 0.78);
      vig.addColorStop(0, 'rgba(4,7,10,0)');
      vig.addColorStop(1, 'rgba(2,4,7,0.86)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, width, height);

      ctx.globalAlpha = 0.05;
      ctx.fillStyle = '#9fe8ff';
      for (let i = 0; i < 60; i++) {
        const gx = ((i * 137.5) % width);
        const gy = ((i * 91.3 + t * 12) % height);
        ctx.fillRect(gx, gy, 1, 1);
      }
      ctx.globalAlpha = 1;
    };

    const loop = (now: number): void => {
      if (!last) last = now;
      time += Math.min(0.05, (now - last) / 1000);
      last = now;
      draw(time);
      raf = window.requestAnimationFrame(loop);
    };

    resize();
    if (reduce) {
      draw(0.4);
    } else {
      raf = window.requestAnimationFrame(loop);
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      resize();
      if (reduce) draw(0.4);
    }) : null;
    observer?.observe(canvas.parentElement ?? canvas);
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointer, { passive: true });
    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointer);
    };
  }, []);

  return <canvas ref={ref} className="bt-canvas" aria-hidden="true" />;
}
