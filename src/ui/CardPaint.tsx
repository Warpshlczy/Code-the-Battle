import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '../i18n';

const W = 512;
const H = 360;

const PALETTE = ['#38f2cf', '#ff2f7d', '#ffb454', '#9cf2a0', '#c9a4ff', '#eafffb', '#071015'];

interface Props {
  image?: string;
  onCommit: (image: string) => void;
  onClear: () => void;
}

interface Point {
  x: number;
  y: number;
  pressure: number;
}

/**
 * Freehand card-art painter. The canvas is fixed at 512×360 so card textures stay
 * crisp without depending on the device pixel ratio. Everything stays in this session.
 */
export default function CardPaint({ image, onCommit, onClear }: Props) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState(PALETTE[0]);
  const [size, setSize] = useState(8);
  const [erasing, setErasing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const drawing = useRef<{ id: number; last: Point } | null>(null);
  const history = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const loadedImage = useRef<string | undefined>(undefined);

  const context = (): CanvasRenderingContext2D | null => canvasRef.current?.getContext('2d') ?? null;

  const refreshHistoryFlags = (): void => {
    setCanUndo(history.current.length > 0);
    setCanRedo(future.current.length > 0);
  };

  const snapshot = useCallback((): string => canvasRef.current?.toDataURL('image/png') ?? '', []);

  const applyImage = useCallback((data: string): void => {
    const ctx = context();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
    };
    img.src = data;
  }, []);

  useEffect(() => {
    if (image === loadedImage.current) return;
    loadedImage.current = image;
    const ctx = context();
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (image) applyImage(image);
    history.current = [];
    future.current = [];
    refreshHistoryFlags();
  }, [image, applyImage]);

  const pushHistory = (): void => {
    history.current.push(snapshot());
    if (history.current.length > 18) history.current.shift();
    future.current = [];
    refreshHistoryFlags();
  };

  const commit = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const webp = canvas.toDataURL('image/webp', 0.86);
    onCommit(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png'));
  };

  const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * W,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * H,
      pressure: event.pressure > 0 ? event.pressure : 0.5,
    };
  };

  const strokeTo = (ctx: CanvasRenderingContext2D, from: Point, to: Point, width: number): void => {
    ctx.save();
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    ctx.quadraticCurveTo(from.x, from.y, mx, my);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const ctx = context();
    if (!ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pushHistory();
    const point = pointFor(event);
    drawing.current = { id: event.pointerId, last: point };
    ctx.save();
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(1, (size * (0.6 + point.pressure)) / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || drawing.current.id !== event.pointerId) return;
    const ctx = context();
    if (!ctx) return;
    const point = pointFor(event);
    const width = Math.max(1, size * (0.55 + point.pressure));
    strokeTo(ctx, drawing.current.last, point, width);
    drawing.current.last = point;
  };

  const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || drawing.current.id !== event.pointerId) return;
    drawing.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit();
  };

  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    future.current.push(snapshot());
    applyImage(previous);
    refreshHistoryFlags();
    window.setTimeout(() => window.requestAnimationFrame(commit), 60);
  };

  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    history.current.push(snapshot());
    applyImage(next);
    refreshHistoryFlags();
    window.setTimeout(() => window.requestAnimationFrame(commit), 60);
  };

  const clear = () => {
    const ctx = context();
    if (!ctx) return;
    pushHistory();
    ctx.clearRect(0, 0, W, H);
    onClear();
  };

  return (
    <div className="paint">
      <div className="paint-stage">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="paint-canvas"
          data-testid="card-paint-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onPointerLeave={(e) => {
            if (drawing.current) finish(e);
          }}
          aria-label={t('卡面画布', 'Card art canvas')}
          role="img"
        />
        <span className="paint-grid" aria-hidden="true" />
      </div>
      <div className="paint-tools">
        <div className="paint-row">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch ${!erasing && color === c ? 'on' : ''}`}
              style={{ background: c }}
              aria-label={t(`画笔颜色 ${c}`, `Brush color ${c}`)}
              onClick={() => {
                setColor(c);
                setErasing(false);
              }}
            />
          ))}
          <label className="swatch custom" title={t('自定义颜色', 'Custom color')}>
            <input
              type="color"
              value={color}
              onChange={(e) => {
                setColor(e.target.value);
                setErasing(false);
              }}
              aria-label={t('自定义画笔颜色', 'Custom brush color')}
            />
          </label>
          <button type="button" className={`ghost-btn small ${erasing ? 'on' : ''}`} onClick={() => setErasing((v) => !v)} data-testid="paint-eraser">
            {t('橡皮', 'Eraser')}
          </button>
        </div>
        <div className="paint-row">
          <span className="paint-label">{t('笔触', 'Brush')}</span>
          {[3, 6, 10, 16, 26].map((s) => (
            <button
              key={s}
              type="button"
              className={`ghost-btn small ${size === s ? 'on' : ''}`}
              onClick={() => setSize(s)}
              data-testid={`paint-size-${s}`}
            >
              <i className="paint-dot" style={{ width: Math.min(16, s), height: Math.min(16, s) }} />
              {s}
            </button>
          ))}
        </div>
        <div className="paint-row">
          <button type="button" className="ghost-btn small" onClick={undo} disabled={!canUndo} data-testid="paint-undo">{t('撤销', 'Undo')}</button>
          <button type="button" className="ghost-btn small" onClick={redo} disabled={!canRedo} data-testid="paint-redo">{t('重做', 'Redo')}</button>
          <button type="button" className="ghost-btn small danger" onClick={clear} data-testid="paint-clear">{t('清空', 'Clear')}</button>
        </div>
        <p className="hint">{t(
          '画在卡面窗口里，会同步到手牌、悬浮提示、弃牌堆与 3D 桌面。画作只保存在本次构筑。',
          'What you paint here appears on the hand, hover tips, discard pile and 3D table. The drawing stays in this build session only.',
        )}</p>
      </div>
    </div>
  );
}
