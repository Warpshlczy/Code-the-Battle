import { useEffect, useRef, type ReactNode } from 'react';
import type { CardArt, Diagnostic } from '../engine/analyze';
import type { LogEvent } from '../engine/battle';
import { PERSONA_PROFILE, type AiPersona } from '../engine/ai';
import { pick, useLang, useT, type Lang } from '../i18n';
import { translateCardName, translateCardText, translateMessage } from '../i18n/messages';
import { ART } from './art';

export const TYPE_LABEL: Record<string, string> = { attack: '攻击', skill: '技能' };
export const PERSONA = PERSONA_PROFILE;

export function typeLabel(type: string, lang: Lang): string {
  return pick(lang, TYPE_LABEL[type] ?? type, type === 'attack' ? 'Attack' : type === 'skill' ? 'Skill' : type);
}


/** DOM card face, used for previews and the discard-pile popover. */
export function CardFace({
  name,
  cost,
  type,
  description,
  art,
  size = 'normal',
}: {
  name: string;
  cost: number;
  type: string;
  description: string;
  art?: CardArt;
  size?: 'normal' | 'large' | 'mini' | 'thumb';
}) {
  const lang = useLang();
  const frame = art?.frame ?? '#58d7ff';
  const ink = art?.ink ?? '#08222b';
  const sigil = art?.sigil ?? 'node';
  const displayName = translateCardName(name, lang);
  const displayDescription = translateCardText(description, lang);
  return (
    <div
      className={`card-face size-${size} type-${type}`}
      style={{ borderColor: frame, background: `linear-gradient(160deg, ${ink} 0%, #05080c 78%)` }}
      data-testid="card-face"
    >
      <div className="cf-top">
        <span className="cf-cost" style={{ background: frame }}>{cost}</span>
        <span className="cf-name">{displayName}</span>
      </div>
      <div className={`cf-art ${art?.image ? 'painted' : ''}`} style={{ color: frame }} aria-hidden="true">
        {art?.image ? <img src={art.image} alt="" /> : <Sigil kind={sigil} />}
      </div>
      <p className="cf-desc">
        {displayDescription || pick(lang, '（在代码行尾写 // 注释，会显示在这里）', '(Write a // comment at the end of a code line; it shows up here.)')}
      </p>
      <div className="cf-foot">
        <span style={{ color: frame }}>{typeLabel(type, lang)}</span>
        <span>{pick(lang, `${cost} 费`, `${cost} cost`)}</span>
      </div>
    </div>
  );
}

export function Sigil({ kind }: { kind: CardArt['sigil'] }) {
  if (kind === 'slash') return <svg viewBox="0 0 100 100"><path d="M18 82 L78 18 M52 82 L86 44" stroke="currentColor" strokeWidth="7" fill="none" strokeLinecap="round" /></svg>;
  if (kind === 'shield') return <svg viewBox="0 0 100 100"><path d="M50 12 L82 26 V52 C82 70 66 82 50 88 C34 82 18 70 18 52 V26 Z" stroke="currentColor" strokeWidth="6" fill="none" /></svg>;
  if (kind === 'arc') return <svg viewBox="0 0 100 100"><path d="M20 70 Q50 14 80 70" stroke="currentColor" strokeWidth="7" fill="none" strokeLinecap="round" /><path d="M20 82 H80" stroke="currentColor" strokeWidth="4" fill="none" /></svg>;
  if (kind === 'wave') return <svg viewBox="0 0 100 100"><path d="M14 58 q14 -20 28 0 t28 0 t16 0" stroke="currentColor" strokeWidth="6" fill="none" /><path d="M14 40 q14 -20 28 0 t28 0 t16 0" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.6" /></svg>;
  if (kind === 'cross') return <svg viewBox="0 0 100 100"><path d="M50 16 V84 M16 50 H84" stroke="currentColor" strokeWidth="8" strokeLinecap="round" /><circle cx="50" cy="50" r="22" stroke="currentColor" strokeWidth="3" fill="none" /></svg>;
  return <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="10" fill="currentColor" /><circle cx="50" cy="50" r="26" stroke="currentColor" strokeWidth="4" fill="none" /><circle cx="50" cy="18" r="5" fill="currentColor" /><circle cx="50" cy="82" r="5" fill="currentColor" /><circle cx="18" cy="50" r="5" fill="currentColor" /><circle cx="82" cy="50" r="5" fill="currentColor" /></svg>;
}

export function Panel({
  title,
  meta,
  children,
  className = '',
  testId,
}: {
  title?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`panel ${className}`} data-testid={testId}>
      {(title || meta) && (
        <header className="panel-head">
          {title && <h2 className="panel-title">{title}</h2>}
          {meta && <div className="panel-meta">{meta}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}

export function EnergyPips({ energy, max = 3 }: { energy: number; max?: number }) {
  const t = useT();
  return (
    <span className="energy-pips" title={t(`能量 ${energy}/${max}`, `Energy ${energy}/${max}`)} data-testid="energy">
      {Array.from({ length: Math.max(max, energy) }, (_, i) => (
        <i key={i} className={i < energy ? 'on' : ''} />
      ))}
      <b>{energy}</b>
    </span>
  );
}

export function Meter({
  label,
  value,
  max,
  unit = '',
  tone = 'cyan',
}: {
  label: string;
  value: number;
  max: number;
  unit?: string;
  tone?: 'cyan' | 'magenta' | 'amber' | 'violet';
}) {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : 0);
  const over = value > max;
  return (
    <div className={`meter tone-${tone} ${over ? 'over' : ''}`}>
      <div className="meter-top">
        <span>{label}</span>
        <b>
          {Number.isInteger(value) ? value : value.toFixed(1)}
          <em>/{max}{unit}</em>
        </b>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Diagnostics({ items, onLine }: { items: Diagnostic[]; onLine?: (line: number) => void }) {
  const lang = useLang();
  if (items.length === 0) return <div className="diag-ok">{pick(lang, '检查通过，没有发现问题', 'All checks passed. No issues found.')}</div>;
  return (
    <div className="diag-list" data-testid="diagnostics">
      {items.slice(0, 10).map((d, i) => (
        <button
          key={`${d.line}-${d.code}-${i}`}
          type="button"
          className={`diag ${d.severity}`}
          onClick={() => d.line > 0 && onLine?.(d.line)}
          title={d.code}
        >
          <span className="diag-line">{d.line > 0 ? `L${d.line}` : pick(lang, '全局', 'global')}</span>
          <span>{translateMessage(d.message, lang)}</span>
        </button>
      ))}
      {items.length > 10 && (
        <div className="diag-more">
          {lang === 'zh' ? `还有 ${items.length - 10} 条诊断…` : `${items.length - 10} more diagnostic${items.length - 10 === 1 ? '' : 's'}…`}
        </div>
      )}
    </div>
  );
}

const CODE_TYPES = new Set([
  'api', 'script_submit', 'card_play', 'card_end', 'card_skip', 'card_halt', 'halt', 'truncate',
  'register_stage', 'register_commit', 'register_reject', 'register_discard', 'player_log', 'phase',
]);
const PILE_TYPES = new Set(['pile', 'draw', 'discard', 'shuffle']);
const COMBAT_TYPES = new Set(['damage', 'block', 'heal', 'energy', 'block_expire', 'death', 'turn_start', 'timeout']);
const AI_TYPES = new Set(['ai_plan', 'ai_fallback', 'ai_invalid']);

export type EventFilter = 'all' | 'code' | 'combat' | 'pile' | 'ai';

export function matchesFilter(e: LogEvent, filter: EventFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'code') return CODE_TYPES.has(e.type);
  if (filter === 'combat') return COMBAT_TYPES.has(e.type) || e.type === 'battle_start';
  if (filter === 'pile') return PILE_TYPES.has(e.type);
  if (filter === 'ai') return AI_TYPES.has(e.type);
  return true;
}

export function EventFeed({
  events,
  filter,
  limit = 240,
}: {
  events: LogEvent[];
  filter: EventFilter;
  limit?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lang = useLang();
  const shown = events.filter((e) => matchesFilter(e, filter)).slice(-limit);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length, filter]);

  return (
    <div
      className="event-feed"
      ref={boxRef}
      data-testid="event-feed"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {shown.map((e) => (
        <div
          className={`evt evt-${e.type} actor-${e.actor}`}
          key={e.seq}
          title={e.data ? JSON.stringify(e.data, null, 2) : undefined}
          data-testid="log-event"
        >
          <span className="evt-turn">T{e.turn}</span>
          <span className="evt-msg">{translateMessage(e.message, lang)}</span>
          {e.source && (
            <span className="evt-src">
              {e.source.label}:{e.source.line}
            </span>
          )}
        </div>
      ))}
      {shown.length === 0 && <div className="empty-hint">{pick(lang, '这里还没有记录', 'Nothing logged here yet.')}</div>}
    </div>
  );
}

export function PersonaCard({ persona, compact = false }: { persona: AiPersona; compact?: boolean }) {
  const lang = useLang();
  const p = PERSONA[persona];
  return (
    <div className={`persona-card ${compact ? 'compact' : ''}`} data-testid="persona-card">
      <img src={ART.enemy} alt="" className="persona-art" />
      <div className="persona-info">
        <span className="eyebrow">{pick(lang, '对手档案 · 战前情报', 'Opponent file · pre-battle intel')}</span>
        <h3>{pick(lang, p.name, p.nameEn)}</h3>
        <span className="tag">{pick(lang, p.tag, p.tagEn)}</span>
        <p>{pick(lang, p.description, p.descriptionEn)}</p>
      </div>
    </div>
  );
}

export function RuleIcon({ kind }: { kind: 'card' | 'code' | 'shield' | 'deck' | 'log' | 'energy' | 'skull' }) {
  const paths: Record<string, ReactNode> = {
    card: <><rect x="7" y="4" width="10" height="16" rx="1" /><path d="M10 8h4M10 11h4M10 14h2" /></>,
    code: <><path d="M8 6L3 12l5 6M16 6l5 6-5 6M13 4l-2 16" /></>,
    shield: <><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" /><path d="M9 12l2 2 4-5" /></>,
    deck: <><rect x="4" y="5" width="11" height="15" rx="1" /><path d="M8 3h11v15" /><path d="M7 10h5M7 13h5" /></>,
    log: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    energy: <><path d="M13 2L5 14h6l-1 8 8-12h-6z" /></>,
    skull: <><path d="M5 10a7 7 0 1114 0c0 3-2 4-2 6h-3l-1 3h-2l-1-3H8c0-2-3-3-3-6z" /><circle cx="9" cy="10" r="1" /><circle cx="15" cy="10" r="1" /></>,
  };
  return (
    <svg className={`rule-icon icon-${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}
