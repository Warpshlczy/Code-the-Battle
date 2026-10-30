import * as THREE from 'three';
import type { PublicCard } from '../engine/battle';
import type { Lang } from '../i18n';
import { translateCardName, translateCardText } from '../i18n/messages';

/**
 * Runtime texture atlas kept small and deterministic: card faces, card backs,
 * table surface and small number sprites. No network or file writes.
 */

const CARD_W = 512;
const CARD_H = 720;

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached) return cached;
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败: ${url}`));
    img.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

/** Rasterizes a vector/bitmap asset into a canvas texture so WebGL always gets valid pixel data. */
export function rasterizedTexture(url: string, width: number, height: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  void loadImage(url).then((img) => {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    texture.needsUpdate = true;
  });
  return texture;
}

const TYPE_TEXT: Record<Lang, Record<string, string>> = {
  zh: { attack: '攻击', skill: '技能' },
  en: { attack: 'Attack', skill: 'Skill' },
};

const faceCache = new Map<string, THREE.CanvasTexture>();
const faceOrder: string[] = [];

function rememberFace(key: string, texture: THREE.CanvasTexture): void {
  faceCache.set(key, texture);
  faceOrder.push(key);
  while (faceOrder.length > 72) {
    const old = faceOrder.shift();
    if (!old) break;
    const stale = faceCache.get(old);
    faceCache.delete(old);
    stale?.dispose();
  }
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

export function cardFaceTexture(card: PublicCard, lang: Lang = 'zh'): THREE.CanvasTexture {
  const image = card.art?.image;
  const key = [
    lang,
    card.name,
    card.cost,
    card.type,
    card.description,
    card.art?.frame,
    card.art?.sigil,
    card.art?.ink,
    card.art?.imageRev ?? 0,
    image?.length ?? 0,
  ].join('|');
  const cached = faceCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d')!;
  const accent = card.art?.frame ?? '#58d7ff';
  const ink = card.art?.ink ?? '#08222b';
  // Match the DOM CardFace: cost + name on top, art window, description, footer.
  const artRect = { x: 30, y: 112, w: CARD_W - 60, h: 300 };
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const drawOverlay = (): void => {
    // Top row: frame-colored cost disc + name, exactly like .cf-top / .cf-cost.
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(60, 60, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#05090d';
    ctx.font = '700 40px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(card.cost), 60, 62);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e6fbf6';
    ctx.font = '600 46px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(clip(translateCardName(card.name, lang), lang === 'zh' ? 7 : 12), 108, 62);

    // Description, then type + cost footer.
    ctx.fillStyle = '#cfe3e0';
    ctx.font = '27px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'top';
    wrapText(
      ctx,
      translateCardText(card.description, lang) || (lang === 'zh' ? '在代码行尾写 // 注释以显示卡面说明' : 'Add a // comment at the end of a code line to fill in the card text'),
      30,
      458,
      CARD_W - 60,
      36,
      3,
    );

    ctx.fillStyle = accent;
    ctx.font = '600 25px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(TYPE_TEXT[lang][card.type] ?? card.type, 30, 670);
    ctx.fillStyle = '#8fb3b0';
    ctx.textAlign = 'right';
    ctx.fillText(lang === 'zh' ? `${card.cost} 费` : `${card.cost} energy`, CARD_W - 30, 670);
    ctx.textAlign = 'left';
  };

  const drawBase = (painted?: HTMLImageElement): void => {
    ctx.clearRect(0, 0, CARD_W, CARD_H);
    ctx.fillStyle = '#070d12';
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.roundRect(8, 8, CARD_W - 16, CARD_H - 16, 24);
    ctx.stroke();

    const grad = ctx.createLinearGradient(artRect.x, artRect.y, CARD_W - artRect.x, artRect.y + artRect.h);
    grad.addColorStop(0, ink);
    grad.addColorStop(1, '#05080c');
    ctx.fillStyle = grad;
    ctx.fillRect(artRect.x, artRect.y, artRect.w, artRect.h);

    if (painted) {
      drawCover(ctx, painted, artRect.x, artRect.y, artRect.w, artRect.h);
    } else {
      drawSigil(ctx, card.art?.sigil ?? 'node', accent, CARD_W / 2, artRect.y + artRect.h / 2, 160);
    }

    // holographic scanlines and edge tint over the art window
    ctx.save();
    ctx.beginPath();
    ctx.rect(artRect.x, artRect.y, artRect.w, artRect.h);
    ctx.clip();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = accent;
    ctx.fillRect(artRect.x, artRect.y, artRect.w, artRect.h);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#04070a';
    for (let y = artRect.y; y < artRect.y + artRect.h; y += 4) ctx.fillRect(artRect.x, y, artRect.w, 1);
    const shade = ctx.createLinearGradient(artRect.x, artRect.y, artRect.x, artRect.y + artRect.h);
    shade.addColorStop(0, 'rgba(4,7,10,0.05)');
    shade.addColorStop(1, 'rgba(4,7,10,0.55)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = shade;
    ctx.fillRect(artRect.x, artRect.y, artRect.w, artRect.h);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 2;
    ctx.strokeRect(artRect.x, artRect.y, artRect.w, artRect.h);
    ctx.globalAlpha = 1;
  };

  drawBase();
  drawOverlay();

  if (image) {
    void loadImage(image)
      .then((img) => {
        drawBase(img);
        drawOverlay();
        texture.needsUpdate = true;
      })
      .catch(() => {
        /* keep the sigil fallback if the painted data URL cannot be decoded */
      });
  }

  rememberFace(key, texture);
  return texture;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  let line = '';
  let row = 0;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line !== '') {
      ctx.fillText(line, x, y + row * lineHeight);
      line = ch;
      row++;
      if (row >= maxLines) return;
    } else {
      line = test;
    }
  }
  if (line && row < maxLines) ctx.fillText(line, x, y + row * lineHeight);
}

function drawSigil(ctx: CanvasRenderingContext2D, kind: string, color: string, cx: number, cy: number, size: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = Math.max(3, size * 0.07);
  ctx.lineCap = 'round';
  const r = size / 2;
  if (kind === 'slash') {
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + r);
    ctx.lineTo(cx + r, cy - r);
    ctx.moveTo(cx + r * 0.1, cy + r);
    ctx.lineTo(cx + r, cy + r * 0.1);
    ctx.stroke();
  } else if (kind === 'shield') {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.8, cy - r * 0.6);
    ctx.lineTo(cx + r * 0.8, cy + r * 0.2);
    ctx.quadraticCurveTo(cx + r * 0.7, cy + r * 0.8, cx, cy + r);
    ctx.quadraticCurveTo(cx - r * 0.7, cy + r * 0.8, cx - r * 0.8, cy + r * 0.2);
    ctx.lineTo(cx - r * 0.8, cy - r * 0.6);
    ctx.closePath();
    ctx.stroke();
  } else if (kind === 'arc') {
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.4, r, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + r * 0.6);
    ctx.lineTo(cx + r, cy + r * 0.6);
    ctx.stroke();
  } else if (kind === 'wave') {
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r * 0.2 + i * r * 0.5);
      for (let x = -r; x <= r; x += r / 4) {
        ctx.lineTo(cx + x, cy - r * 0.2 + i * r * 0.5 + Math.sin((x / r) * Math.PI) * r * 0.18);
      }
      ctx.stroke();
    }
  } else if (kind === 'cross') {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8, r * 0.14, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function drawArt(
  ctx: CanvasRenderingContext2D,
  url: string,
  x: number,
  y: number,
  w: number,
  h: number,
  accent: string,
  onReady?: () => void,
): void {
  const promise = loadImage(url);
  void promise.then((img) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.35;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;
    onReady?.();
  });
}

let backTexture: THREE.CanvasTexture | null = null;

export function cardBackTexture(): THREE.CanvasTexture {
  if (backTexture) return backTexture;
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  grad.addColorStop(0, '#0b1a22');
  grad.addColorStop(1, '#050b10');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.strokeStyle = '#38f2cf';
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, CARD_W - 16, CARD_H - 16);
  ctx.strokeStyle = 'rgba(56,242,207,0.35)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(40, 90 + i * 90);
    ctx.lineTo(CARD_W - 40, 150 + i * 90);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,47,125,0.5)';
  ctx.beginPath();
  ctx.moveTo(CARD_W / 2, 0);
  ctx.lineTo(CARD_W / 2, CARD_H);
  ctx.stroke();
  backTexture = new THREE.CanvasTexture(canvas);
  backTexture.colorSpace = THREE.SRGBColorSpace;
  return backTexture;
}

let tableTex: THREE.CanvasTexture | null = null;

export function tableTexture(): THREE.CanvasTexture {
  if (tableTex) return tableTex;
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 60, size / 2, size / 2, size / 2);
  grad.addColorStop(0, '#16222a');
  grad.addColorStop(0.7, '#0a1319');
  grad.addColorStop(1, '#05090d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(56,242,207,0.16)';
  ctx.lineWidth = 2;
  for (let r = 90; r < size / 2; r += 78) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(56,242,207,0.1)';
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(size / 2 + Math.cos(a) * 120, size / 2 + Math.sin(a) * 120);
    ctx.lineTo(size / 2 + Math.cos(a) * 470, size / 2 + Math.sin(a) * 470);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,180,84,0.35)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 468, 0, Math.PI * 2);
  ctx.stroke();
  tableTex = new THREE.CanvasTexture(canvas);
  tableTex.colorSpace = THREE.SRGBColorSpace;
  return tableTex;
}

const numberCache = new Map<string, THREE.CanvasTexture>();

const pileLabelCache = new Map<string, THREE.CanvasTexture>();

export function pileLabelTexture(label: string, count: number, accent: string): THREE.CanvasTexture {
  const key = `${label}|${count}|${accent}`;
  const cached = pileLabelCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 160);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = accent;
  ctx.shadowBlur = 24;
  ctx.fillStyle = accent;
  ctx.font = '600 46px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(label, 256, 46);
  ctx.fillStyle = '#f2fffb';
  ctx.font = '700 74px "PingFang SC", sans-serif';
  ctx.fillText(String(count), 256, 112);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  pileLabelCache.set(key, texture);
  return texture;
}

export function numberTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${text}|${color}`;
  const cached = numberCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  let size = 86;
  do {
    ctx.font = `700 ${size}px "PingFang SC", sans-serif`;
    if (ctx.measureText(text).width <= 228) break;
    size -= 4;
  } while (size > 28);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 26;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 128, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  numberCache.set(key, texture);
  return texture;
}

export function disposeTextures(): void {
  for (const t of faceCache.values()) t.dispose();
  faceCache.clear();
  for (const t of numberCache.values()) t.dispose();
  numberCache.clear();
  for (const t of pileLabelCache.values()) t.dispose();
  pileLabelCache.clear();
  backTexture?.dispose();
  backTexture = null;
  tableTex?.dispose();
  tableTex = null;
}
