import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Battle, LogEvent, PublicBattleState, PublicCard } from '../engine/battle';
import { compileScript } from '../engine/analyze';
import { CODE_LIMITS, CREDIT_BUDGET, LIMITS } from '../engine/config';
import { STARTER_SCRIPT, MANUAL_SORT_SCRIPT } from '../content/deck';
import { RulesModal } from './BootScreen';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import { ApiReference } from './ApiReference';
import { CardFace, Diagnostics, EnergyPips, EventFeed, Meter, type EventFilter } from './components';
import { VisualSession, type VisualCue } from './visual';
import { TableScene } from '../table/scene';
import { cueDuration, nextSpeed, speedLabel } from '../table/timeline';
import type { PileKey } from '../table/layout';
import { pick, useLang, useT, type Lang } from '../i18n';
import { translateCardName, translateCardText, translateMessage } from '../i18n/messages';

interface Props {
  battle: Battle;
  onFinish: () => void;
  onQuit: () => void;
  onRules: () => void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PILE_LABEL: Record<PileKey, [string, string]> = {
  'player-draw': ['我方抽牌堆', 'Your draw pile'],
  'player-discard': ['我方弃牌堆', 'Your discard pile'],
  'enemy-draw': ['敌方抽牌堆', 'SENTINEL draw pile'],
  'enemy-discard': ['敌方弃牌堆', 'SENTINEL discard pile'],
};

function typeLabel(type: string, lang: Lang): string {
  return pick(lang, type === 'attack' ? '攻击' : '技能', type === 'attack' ? 'Attack' : 'Skill');
}

export default function BattleScreen({ battle, onFinish, onQuit, onRules }: Props) {
  const lang = useLang();
  const t = useT();
  const [state, setState] = useState<PublicBattleState>(() => battle.getState());
  const [events, setEvents] = useState<LogEvent[]>(() => battle.getEvents(0));
  const [cue, setCue] = useState<VisualCue | null>(null);
  const [script, setScript] = useState(STARTER_SCRIPT);
  const [history, setHistory] = useState<string[]>([]);
  const [tab, setTab] = useState<'script' | 'log' | 'decks'>('script');
  const [filter, setFilter] = useState<EventFilter>('all');
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [armed, setArmed] = useState(false);
  const [pileView, setPileView] = useState<'hand' | 'draw' | 'discard'>('hand');
  const [energyError, setEnergyError] = useState<{ need: number; have: number; card?: string } | null>(null);
  const [haltDismissed, setHaltDismissed] = useState(false);
  const [commandError, setCommandError] = useState<{ title: string; message: string; detail?: string } | null>(null);
  const [info, setInfo] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [hover, setHover] = useState<{ card: PublicCard; x: number; y: number } | null>(null);
  const [discardPeek, setDiscardPeek] = useState<'player' | 'enemy' | null>(null);
  const [spread, setSpread] = useState<PileKey | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [handTray, setHandTray] = useState(false);
  const [blockFx, setBlockFx] = useState<{ side: 'player' | 'enemy'; kind: 'gain' | 'break'; nonce: number } | null>(null);
  const [enemyReveal, setEnemyReveal] = useState<PublicCard | null>(null);
  const revealTimer = useRef<number | null>(null);
  const [overDismissed, setOverDismissed] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [intro, setIntro] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tableRef = useRef<TableScene | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const mounted = useRef(true);
  const runToken = useRef(0);
  const skipRef = useRef(false);
  const stateRef = useRef(state);
  const endedRef = useRef(false);
  const speedRef = useRef(speed);

  useEffect(() => {
    stateRef.current = state;
    endedRef.current = !!state.result;
  }, [state]);

  // A fresh halt (or a cleared one) re-arms the banner; dismissing the energy
  // dialog must not leave the old halt text pinned over the table.
  useEffect(() => {
    setHaltDismissed(false);
  }, [state.lastHalt]);

  useEffect(() => {
    if (!blockFx) return;
    const timer = window.setTimeout(() => setBlockFx(null), 720);
    return () => window.clearTimeout(timer);
  }, [blockFx]);

  useEffect(() => {
    const timer = window.setTimeout(() => setIntro(false), 1300);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    setArmed(false);
  }, [script]);

  useEffect(() => {
    speedRef.current = speed;
    tableRef.current?.setSpeed(speed);
  }, [speed]);

  const compile = useMemo(() => compileScript(script, battle.registers), [script, battle.registers]);
  const errors = compile.diagnostics;
  const ended = !!state.result;
  const energyMax = Math.max(5, state.player.maxEnergy);
  const scriptCredits = Number((compile.value?.credits ?? 0).toFixed(1));
  const usedCredits = Number(state.player.creditsUsed.toFixed(1));

  const openPile = useCallback((pile: PileKey) => {
    const table = tableRef.current;
    if (!table) return;
    if (pile.endsWith('discard')) {
      table.spreadPile(pile, stateRef.current);
      setDiscardPeek(null);
      setDrawer(false);
      setArmed(false);
      return;
    }
    setHint(pile.endsWith('draw') ? '抽牌堆只公开张数。' : '手牌内容不可见，打出后才会揭示。');
    window.setTimeout(() => setHint(null), 1600);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const table = new TableScene(canvas, {
        lang,
        onHoverCard: (card, client) => setHover(card && client ? { card, x: client.x, y: client.y } : null),
        onViewChange: () => {},
        onPileClick: (pile) => openPile(pile),
        onSpreadChange: (pile) => setSpread(pile),
        onHandHover: (active) => { if (!stateRef.current.result) setHandTray(active); },
      });
      tableRef.current = table;
      table.setState(stateRef.current);
      setSpread(null);
    } catch (err) {
      setSceneError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      mounted.current = false;
      runToken.current += 1;
      tableRef.current?.dispose();
      tableRef.current = null;
    };
  }, [openPile, lang]);

  useEffect(() => {
    if (state.phase === 'enemy') {
      // The opponent acting takes over the table: every player-facing popup closes
      // so a stale error, rules sheet or pile peek cannot cover its turn.
      setDrawer(false);
      setArmed(false);
      setInfo(false);
      setShowApi(false);
      setCommandError(null);
      setEnergyError(null);
      setHaltDismissed(true);
      setDiscardPeek(null);
      setHover(null);
      setHint(null);
      setHandTray(false);
      setSpread(null);
      setEnemyReveal(null);
      if (revealTimer.current) {
        window.clearTimeout(revealTimer.current);
        revealTimer.current = null;
      }
      tableRef.current?.collapseSpread();
    } else if (state.phase === 'over') {
      setDrawer(false);
      setArmed(false);
    }
  }, [state.phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tableRef.current?.isSpread()) {
        tableRef.current.collapseSpread();
        setSpread(null);
      }
    };
    let lastWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
    const onResize = () => {
      if (lastWidth > 900 && window.innerWidth <= 900) setDrawer(false);
      lastWidth = window.innerWidth;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const showCompileError = useCallback(() => {
    const blocking = errors.filter((d) => d.severity === 'error');
    const lines = blocking.slice(0, 4).map((d) => (d.line > 0 ? `第 ${d.line} 行：${d.message}` : d.message));
    setCommandError({
      title: '命令未执行',
      message: blocking[0]?.message ?? '脚本没有通过检查，请先修正代码。',
      detail: lines.length > 1 ? lines.join('\n') : undefined,
    });
    editorRef.current?.focus();
  }, [errors]);

  const reportHaltFromEvents = useCallback((events: LogEvent[]) => {
    const halt = [...events].reverse().find((event) => event.type === 'halt' && event.actor === 'player');
    if (!halt) return;
    if (halt.message.includes('能量不足')) {
      const match = halt.message.match(/需要 (\d+) 能量，当前只有 (\d+)/);
      const name = halt.message.match(/【([^】]+)】/);
      setEnergyError({ need: match ? Number(match[1]) : 0, have: match ? Number(match[2]) : 0, card: name?.[1] });
      return;
    }
    setCommandError({
      title: '命令中断',
      message: halt.message,
      detail: halt.source && halt.source.line > 0
        ? `停在第 ${halt.source.line} 行，已执行的动作会保留。`
        : '已执行的动作会保留，可以修改后重新提交。',
    });
  }, []);

  const playResult = useCallback(async (run: () => Promise<{ events: LogEvent[]; state: PublicBattleState; ended: boolean }>) => {
    if (busy || endedRef.current) return;
    const token = ++runToken.current;
    skipRef.current = false;
    setBusy(true);
    setResolving(true);
    setCue(null);
    setSpread(null);
    setHint(null);
    setHandTray(false);
    tableRef.current?.collapseSpread();
    try {
      await wait(40);
      const previous = stateRef.current;
      const res = await run();
      if (!mounted.current || token !== runToken.current) return;
      setEvents(battle.getEvents(0));
      const session = new VisualSession(previous, res.state);
      const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion || speedRef.current <= 0) {
        tableRef.current?.setState(res.state);
        setState(res.state);
        stateRef.current = res.state;
        setResolving(false);
        if (!res.state.result) reportHaltFromEvents(res.events);
        return;
      }
      for (const event of res.events) {
        const visualCue = session.apply(event);
        const snapshot = session.snapshot();
        setState(snapshot);
        stateRef.current = snapshot;
        tableRef.current?.applyEvent(event, snapshot, visualCue);
        if (event.type === 'halt' && event.message.includes('能量不足')) {
          const match = event.message.match(/需要 (\d+) 能量，当前只有 (\d+)/);
          const name = event.message.match(/【([^】]+)】/);
          setEnergyError({ need: match ? Number(match[1]) : 0, have: match ? Number(match[2]) : 0, card: name?.[1] });
        }
        if (event.type === 'card_play' && event.actor === 'enemy') {
          const data = (event.data ?? {}) as Record<string, unknown>;
          const name = String(data.card ?? '');
          const aiCard = stateRef.current.aiDeck.find((c) => c.name === name);
          setEnemyReveal({
            uid: String(data.uid ?? `enemy-${event.seq}`),
            name,
            description: String(data.description ?? ''),
            cost: Number(data.cost ?? 0),
            type: String(data.type ?? 'skill'),
            target: String(data.target ?? 'none'),
            art: aiCard?.art ?? visualCue?.card?.art,
            playable: false,
          });
          if (revealTimer.current) window.clearTimeout(revealTimer.current);
          revealTimer.current = window.setTimeout(() => setEnemyReveal(null), 2200);
        }
        if (visualCue) {
          setCue(visualCue);
          setResolving(false);
          if (visualCue.kind === 'block') setBlockFx({ side: visualCue.side ?? 'player', kind: 'gain', nonce: Date.now() });
          if (visualCue.kind === 'hit' && (visualCue.blocked ?? 0) > 0) {
            setBlockFx({ side: visualCue.target ?? 'player', kind: 'break', nonce: Date.now() });
          }
        }
        if (skipRef.current) break;
        if (!visualCue) continue;
        await wait(cueDuration(visualCue, speedRef.current));
        if (!mounted.current || token !== runToken.current) return;
      }
      tableRef.current?.syncState(res.state, true);
      setState(res.state);
      stateRef.current = res.state;
      setCue(null);
      setResolving(false);
      setOverDismissed(false);
      if (!res.state.result) reportHaltFromEvents(res.events);
    } catch (err) {
      if (mounted.current && token === runToken.current) {
        tableRef.current?.syncState(battle.getState(), true);
        setState(battle.getState());
        setEvents(battle.getEvents(0));
        setCommandError({
          title: '命令执行失败',
          message: err instanceof Error ? err.message : String(err),
          detail: '战场已回到上一个稳定状态，请检查代码后重试。',
        });
      }
    } finally {
      if (mounted.current && token === runToken.current) {
        setBusy(false);
        setCue(null);
        setResolving(false);
      }
    }
  }, [busy, battle, reportHaltFromEvents]);

  const submit = useCallback(async () => {
    if (busy || ended || state.phase !== 'player') return;
    if (!compile.ok || !compile.value) {
      showCompileError();
      return;
    }
    setCommandError(null);
    setHaltDismissed(true);
    setHistory((h) => [...h, script]);
    setArmed(false);
    setDrawer(false);
    await playResult(() => battle.executePlayerScript(compile.value!));
  }, [busy, compile, ended, playResult, script, state.phase, battle, showCompileError]);

  const skipTurn = useCallback(async () => {
    if (busy || ended || state.phase !== 'player') return;
    setEnergyError(null);
    setCommandError(null);
    setHaltDismissed(true);
    setArmed(false);
    setDrawer(false);
    await playResult(() => battle.endPlayerTurn());
  }, [busy, ended, playResult, state.phase, battle]);

  const dismissEnergyError = useCallback(() => {
    setEnergyError(null);
    setHaltDismissed(true);
  }, []);

  const confirmCommand = useCallback(() => {
    if (!compile.ok || !compile.value) {
      showCompileError();
      return;
    }
    setArmed(true);
    setDrawer(false);
    setHint('命令已锁定。点击「执行终端命令」。');
    window.setTimeout(() => setHint(null), 1800);
  }, [compile, showCompileError]);

  const closeTerminal = useCallback(() => {
    setDrawer(false);
    setArmed(false);
  }, []);

  const feed = translateMessage(cue?.label ?? events[events.length - 1]?.message ?? '写下这一回合的战术', lang);
  const lastTurn = history[history.length - 1];
  const halted = state.lastHalt;

  return (
    <main className={`battle-screen ${drawer ? 'drawer-open' : ''} ${state.phase === 'enemy' ? 'enemy-phase' : ''}`} data-testid="battle-screen">
      <div className="stage">
        <canvas ref={canvasRef} className="stage-canvas" data-testid="table-canvas" />
        {cue && cue.kind !== 'phase' && (
          <div
            key={`pulse-${cue.id}`}
            className={`combat-pulse ${cue.kind} ${cue.target ?? cue.side ?? ''}`}
            aria-hidden="true"
          />
        )}
        {sceneError && (
          <div className="stage-error">
            {t('3D 场景不可用', '3D table unavailable')}: {sceneError}
          </div>
        )}

        <header className="hud-top">
          <div className="hud-left">
            <span className="hud-turn">{t(`回合 ${String(state.turn).padStart(2, '0')}`, `Turn ${String(state.turn).padStart(2, '0')}`)}</span>
            <span className={`hud-phase phase-${state.phase}`}>
              {state.phase === 'player'
                ? t('轮到你', 'Your turn')
                : state.phase === 'enemy'
                  ? t('SENTINEL 行动', 'SENTINEL acts')
                  : state.phase === 'over'
                    ? t('已结束', 'Finished')
                    : t('结算中', 'Resolving')}
            </span>
          </div>
          <div className="hud-right">
            <button
              type="button"
              className="hud-btn speed"
              onClick={() => setSpeed((s) => nextSpeed(s))}
              title={t('调整演出速度', 'Adjust presentation speed')}
              data-testid="speed-toggle"
            >
              {t('演出', 'Pace')} {speedLabel(speed, lang)}
            </button>
            <button type="button" className="hud-btn" onClick={onRules}>{t('说明', 'Rules')}</button>
            <button type="button" className="hud-btn danger" onClick={() => { if (window.confirm(t('现在退出？这局不会留下复盘。', 'Quit now? This run will not be saved for review.'))) onQuit(); }}>{t('退出', 'Quit')}</button>
          </div>
        </header>

        <section className={`unit-hud enemy ${state.phase === 'enemy' ? 'active' : ''}`} aria-label={t('敌方状态', 'Enemy status')}>
          <div className="unit-hud-head">
            <span className="unit-side">{t('敌方', 'Enemy')}</span>
            <span className="unit-name">{state.enemy.hp > 0 ? 'SENTINEL-07' : t('SENTINEL-07 · 离线', 'SENTINEL-07 · offline')}</span>
          </div>
          <div className="unit-hud-body">
            <span className="unit-hp">{state.enemy.hp}</span>
            <span className="unit-hp-max">/{state.enemy.maxHp}</span>
            {state.enemy.block > 0 && (
              <span className={`shield on ${blockFx?.side === 'enemy' ? blockFx.kind : ''}`} key={`eb-${blockFx?.nonce ?? 0}`} data-testid="block-enemy" title={t(`格挡 ${state.enemy.block} · 下个自己回合开始清零`, `Block ${state.enemy.block} · expires at its next turn start`)}>
                <em>{t('格挡', 'Block')}</em><b>{state.enemy.block}</b>
              </span>
            )}
          </div>
          <div className="unit-hud-piles">
            <span>{t('抽', 'Draw')} {state.enemy.drawCount}</span>
            <span
              role="button"
              tabIndex={0}
              data-testid="discard-enemy"
              onMouseEnter={() => setDiscardPeek('enemy')}
              onMouseLeave={() => setDiscardPeek((p) => (p === 'enemy' ? null : p))}
              onFocus={() => setDiscardPeek('enemy')}
              onBlur={() => setDiscardPeek((p) => (p === 'enemy' ? null : p))}
              onClick={() => openPile('enemy-discard')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPile('enemy-discard'); } }}
              aria-label={t(`对手弃牌堆 ${state.enemy.discardCount} 张，点击靠近浏览`, `SENTINEL discard pile: ${state.enemy.discardCount} cards. Click to inspect.`)}
              title={t('点击靠近浏览对手弃牌堆', 'Click to inspect the SENTINEL discard pile')}
            >
              {t('弃', 'Disc')} {state.enemy.discardCount}
            </span>
          </div>
        </section>

        <section className={`unit-hud player ${state.phase === 'player' ? 'active' : ''}`} aria-label={t('我方状态', 'Your status')}>
          <div className="unit-hud-head">
            <span className="unit-side">{t('我方', 'You')}</span>
            <span className="unit-name">K-13</span>
          </div>
          <div className="unit-hud-body">
            <span className="unit-hp">{state.player.hp}</span>
            <span className="unit-hp-max">/{state.player.maxHp}</span>
            {state.player.block > 0 && (
              <span className={`shield on ${blockFx?.side === 'player' ? blockFx.kind : ''}`} key={`pb-${blockFx?.nonce ?? 0}`} data-testid="block-player" title={t(`格挡 ${state.player.block} · 下个自己回合开始清零`, `Block ${state.player.block} · expires at your next turn start`)}>
                <em>{t('格挡', 'Block')}</em><b>{state.player.block}</b>
              </span>
            )}
          </div>
          <div className="unit-hud-piles">
            <EnergyPips key={`energy-${state.turn}-${state.player.energy}`} energy={state.player.energy} max={energyMax} />
            <span>{t('抽', 'Draw')} {state.player.drawCount}</span>
            <span
              role="button"
              tabIndex={0}
              data-testid="discard-player"
              onMouseEnter={() => setDiscardPeek('player')}
              onMouseLeave={() => setDiscardPeek((p) => (p === 'player' ? null : p))}
              onFocus={() => setDiscardPeek('player')}
              onBlur={() => setDiscardPeek((p) => (p === 'player' ? null : p))}
              onClick={() => openPile('player-discard')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPile('player-discard'); } }}
              aria-label={t(`弃牌堆 ${state.player.discardCount} 张，点击靠近浏览`, `Discard pile: ${state.player.discardCount} cards. Click to inspect.`)}
              title={t('点击靠近浏览弃牌堆', 'Click to inspect your discard pile')}
            >
              {t('弃', 'Disc')} {state.player.discardCount}
            </span>
          </div>
        </section>


        {handTray && state.player.hand.length > 0 && (
          <div className="hand-tray" data-testid="hand-tray">
            <header><span>{t('我方手牌', 'Your hand')}</span><b>{t(`${state.player.hand.length} 张`, `${state.player.hand.length} cards`)}</b></header>
            <div className="hand-tray-cards">
              {state.player.hand.map((c) => (
                <CardFace key={c.uid} name={c.name} cost={c.cost} type={c.type} description={c.description} art={c.art} size="mini" />
              ))}
            </div>
          </div>
        )}

        <div className="hud-feed" aria-live="polite">
          <span>{busy ? t('正在发生', 'Now') : t('刚刚', 'Just now')}</span>
          <b>{feed}</b>
          {busy && (
            <button type="button" className="hud-btn tiny" onClick={() => { skipRef.current = true; }}>{t('快进', 'Skip')}</button>
          )}
        </div>

        {intro && !cue && (
          <div className="phase-banner player intro" data-testid="phase-banner" role="status" aria-live="polite">
            <span className="pb-kicker">YOUR TURN</span>
            <b>{t('你的回合', 'Your turn')}</b>
            <span className="pb-sub">{t(`第 1 回合 · 能量 ${state.player.energy} · 算力 0/${CREDIT_BUDGET}`, `Turn 1 · Energy ${state.player.energy} · credits 0/${CREDIT_BUDGET}`)}</span>
          </div>
        )}

        {cue?.kind === 'phase' && (
          <div className={`phase-banner ${cue.phaseSide}`} data-testid="phase-banner" role="status" aria-live="assertive">
            <span className="pb-kicker">{cue.phaseSide === 'player' ? 'YOUR TURN' : 'SENTINEL ACTING'}</span>
            <b>{cue.phaseSide === 'player' ? t('你的回合', 'Your turn') : t('对手回合', "SENTINEL's turn")}</b>
            <span className="pb-sub">
              {t(`第 ${cue.turn} 回合 · 能量 ${cue.energy ?? 0}`, `Turn ${cue.turn} · Energy ${cue.energy ?? 0}`)}
              {cue.phaseSide === 'player'
                ? t(` · 算力 0/${CREDIT_BUDGET}`, ` · credits 0/${CREDIT_BUDGET}`)
                : t(' · 你无法提交脚本', ' · you cannot submit a script')}
            </span>
          </div>
        )}

        {resolving && cue?.kind !== 'phase' && (
          <div className="phase-banner resolving" data-testid="phase-resolving" role="status">
            <span className="pb-kicker">RESOLVING</span>
            <b>{t('结算中', 'Resolving')}</b>
            <span className="pb-sub">{t('规则引擎正在执行这一回合', 'The rules engine is resolving this turn')}</span>
          </div>
        )}

        {state.phase === 'enemy' && cue?.kind !== 'phase' && (
          <div className="enemy-band" data-testid="enemy-band">{t('对手回合 · 提交已锁定', "SENTINEL's turn · submissions locked")}</div>
        )}


        {halted && !energyError && !haltDismissed && (
          <div className="hud-halt" data-testid="halt-banner" role="status">
            <b>{translateMessage(halted.label, lang)}</b>
            <span>
              {translateMessage(halted.message, lang)}
              {halted.line > 0 ? t(`（第 ${halted.line} 行）`, ` (line ${halted.line})`) : ''}
            </span>
            <button type="button" className="hud-btn tiny" onClick={() => setHaltDismissed(true)} aria-label={t('关闭中断提示', 'Dismiss halt notice')}>{t('关闭', 'Close')}</button>
          </div>
        )}

        {hover && (
          <div className="card-tip" style={{ left: hover.x + 16, top: hover.y + 12 }}>
            <b>{translateCardName(hover.card.name, lang)}</b>
            <span>{t(`${hover.card.cost} 费`, `${hover.card.cost} energy`)} · {typeLabel(hover.card.type, lang)}</span>
            {hover.card.description && <p>{translateCardText(hover.card.description, lang)}</p>}
            <em>{t('最左边的手牌会先出场', 'The leftmost card is played first')}</em>
          </div>
        )}

        {discardPeek && (
          <div className={`discard-peek ${discardPeek}`} data-testid={`discard-peek-${discardPeek}`}>
            <header>
              <span>{discardPeek === 'player' ? t('你的弃牌堆', 'Your discard pile') : t('SENTINEL 的弃牌堆', "SENTINEL's discard pile")}</span>
              <b>{t(`${(discardPeek === 'player' ? state.player.discardCount : state.enemy.discardCount)} 张`, `${(discardPeek === 'player' ? state.player.discardCount : state.enemy.discardCount)} cards`)}</b>
            </header>
            {discardPeek === 'player' ? (
              state.player.discard.length === 0 ? (
                <p className="hint">{t('还没有弃牌', 'No discards yet')}</p>
              ) : (
                <div className="peek-cards">
                  {state.player.discard.slice(-8).map((c) => (
                    <CardFace key={c.uid} name={c.name} cost={c.cost} type={c.type} description={c.description} art={c.art} size="mini" />
                  ))}
                </div>
              )
            ) : state.enemyDiscard.length === 0 ? (
              <p className="hint">{t('对手还没有弃牌', 'SENTINEL has not discarded yet')}</p>
            ) : (
              <div className="peek-cards">
                {state.enemyDiscard.slice(-8).map((c, i) => (
                  <CardFace key={`${c.uid}-${i}`} name={c.name} cost={c.cost} type={c.type} description={c.description} art={c.art} size="mini" />
                ))}
              </div>
            )}
          </div>
        )}

        {spread && <div className="spread-hint">{t('按 Esc 收起', 'Press Esc to close')} · {pick(lang, ...PILE_LABEL[spread])}</div>}
        {enemyReveal && (
          <div className="enemy-reveal" data-testid="enemy-reveal">
            <span>{t('敌方打出', 'SENTINEL played')}</span>
            <CardFace name={enemyReveal.name} cost={enemyReveal.cost} type={enemyReveal.type} description={enemyReveal.description} art={enemyReveal.art} size="mini" />
          </div>
        )}
        {hint && <div className="table-hint" data-testid="table-hint">{translateMessage(hint, lang)}</div>}
        {state.phase === 'player' && !ended && !drawer && (
          <button type="button" className={`skip-fab ${energyError ? 'needs-skip' : ''}`} onClick={skipTurn} disabled={busy} data-testid="skip-turn-fab">{t('跳过回合', 'End turn')}</button>
        )}
      </div>

      {info && <RulesModal onClose={() => setInfo(false)} />}

      <aside className={`terminal ${drawer ? 'open' : 'closed'}`}>
        <div className="terminal-tabs">
          <button type="button" className={tab === 'script' ? 'on' : ''} onClick={() => setTab('script')}>{t('指令', 'Script')}</button>
          <button type="button" className={tab === 'decks' ? 'on' : ''} onClick={() => setTab('decks')}>{t('牌库', 'Decks')}</button>
          <button type="button" className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>{t('记录', 'Log')}</button>
          <button type="button" className="terminal-close" onClick={closeTerminal}>{t('收起', 'Collapse')}</button>
        </div>

        {tab === 'script' ? (
          <div className="terminal-body">
            <div className="terminal-tools">
              <button type="button" className="hud-btn tiny" disabled={!lastTurn} onClick={() => lastTurn && setScript(lastTurn)}>{t('上一回合', 'Last turn')}</button>
              <button type="button" className="hud-btn tiny" onClick={() => setScript(STARTER_SCRIPT)}>{t('示例', 'Sample')}</button>
              <button type="button" className="hud-btn tiny" onClick={() => setScript(MANUAL_SORT_SCRIPT)}>{t('手写排序', 'Manual sort')}</button>
              <button type="button" className="hud-btn tiny" onClick={() => setShowApi(true)} data-testid="open-api">{t('接口', 'API')}</button>
              <button type="button" className="hud-btn tiny" onClick={() => editorRef.current?.focus()}>{t('聚焦', 'Focus')}</button>
            </div>
            <CodeEditor
              ref={editorRef}
              value={script}
              onChange={setScript}
              minRows={10}
              maxRows={18}
              errorLines={errors.filter((d) => d.severity === 'error').map((d) => d.line)}
              ariaLabel={t('回合脚本编辑器', 'Turn script editor')}
              onRun={confirmCommand}
              testId="turn-editor"
              disabled={busy || ended}
              maxLines={CODE_LIMITS.script.maxLines}
              maxComplexity={CODE_LIMITS.script.maxComplexity}
              complexity={compile.value?.astNodes ?? 0}
            />
            <div className="terminal-meters">
              <Meter label={t('脚本算力', 'Script credits')} value={Number((compile.value?.credits ?? 0).toFixed(1))} max={CREDIT_BUDGET} tone={(compile.value?.credits ?? 0) > CREDIT_BUDGET ? 'magenta' : 'cyan'} />
              <Meter label={t('运行时算力', 'Runtime credits')} value={Number(state.player.creditsUsed.toFixed(1))} max={CREDIT_BUDGET} tone="magenta" />
              <Meter label={t('复杂度', 'Complexity')} value={compile.value?.astNodes ?? 0} max={CODE_LIMITS.script.maxComplexity} tone="amber" />
              <Meter label={t('行数', 'Lines')} value={compile.value?.lines ?? 0} max={CODE_LIMITS.script.maxLines} tone="cyan" />
            </div>
            <Diagnostics items={errors} onLine={() => editorRef.current?.focus()} />
            <button
              type="button"
              className="hud-btn primary"
              disabled={busy || ended || state.phase !== 'player'}
              onClick={confirmCommand}
              data-testid="confirm-command"
            >
              {busy
                ? t('结算中…', 'Resolving…')
                : ended
                  ? t('战斗结束', 'Battle over')
                  : state.phase === 'enemy'
                    ? t('对手回合 · 等待', "SENTINEL's turn · wait")
                    : t('确认命令', 'Confirm command')}
            </button>
            {state.phase === 'enemy' && (
              <div className="terminal-lock" data-testid="terminal-lock">
                {t('对手正在行动，脚本已锁定。它出完牌才轮到你。', 'SENTINEL is acting. Your script is locked until it finishes.')}
              </div>
            )}
            <button
              type="button"
              className={`hud-btn skip-turn ${energyError ? 'needs-skip' : ''}`}
              disabled={busy || ended || state.phase !== 'player'}
              onClick={skipTurn}
              data-testid="skip-turn"
            >
              {t('跳过回合', 'End turn')}
            </button>

            <div className="terminal-piles">
              <header>
                <b>{t('牌堆', 'Piles')}</b>
                <div className="pile-tabs">
                  <button type="button" className={pileView === 'hand' ? 'on' : ''} onClick={() => setPileView('hand')}>{t('手牌', 'Hand')} {state.player.handCount}</button>
                  <button type="button" className={pileView === 'draw' ? 'on' : ''} onClick={() => setPileView('draw')}>{t('抽牌', 'Draw')} {state.player.drawCount}</button>
                  <button type="button" className={pileView === 'discard' ? 'on' : ''} onClick={() => setPileView('discard')}>{t('弃牌', 'Discard')} {state.player.discardCount}</button>
                </div>
              </header>
              <div className="pile-strip">
                {pileView === 'hand' && state.player.hand.length === 0 && (
                  <div className="pile-slot empty"><span className="pile-role">{t('打出位', 'Play slot')}</span><em>{t('手牌为空', 'Your hand is empty')}</em></div>
                )}
                {pileView === 'draw' && state.player.drawCount === 0 && (
                  <div className="pile-slot empty"><span className="pile-role">{t('抽取位', 'Draw slot')}</span><em>{t('抽牌堆为空', 'Your draw pile is empty')}</em></div>
                )}
                {pileView === 'discard' && state.player.discardCount === 0 && (
                  <div className="pile-slot empty"><span className="pile-role">{t('弃牌位', 'Discard slot')}</span><em>{t('弃牌堆为空', 'Your discard pile is empty')}</em></div>
                )}
                {pileView === 'hand' && state.player.hand.length > 0 && (
                  <>
                    <div className="pile-slot">
                      <span className="pile-role">{t('打出位', 'Play slot')}</span>
                      <div className="pile-card">
                        <CardFace name={state.player.hand[0].name} cost={state.player.hand[0].cost} type={state.player.hand[0].type} description={state.player.hand[0].description} art={state.player.hand[0].art} size="mini" />
                      </div>
                    </div>
                    {state.player.hand.slice(1).map((c, i) => (
                      <div className="pile-card" key={`${c.uid}-${i}`}>
                        <CardFace name={c.name} cost={c.cost} type={c.type} description={c.description} art={c.art} size="mini" />
                      </div>
                    ))}
                  </>
                )}
                {pileView === 'draw' && state.player.drawCount > 0 && (
                  <>
                    <div className="pile-slot">
                      <span className="pile-role">{t('抽取位', 'Draw slot')}</span>
                      <div className="pile-card back"><span>?</span></div>
                    </div>
                    {Array.from({ length: Math.min(10, state.player.drawCount) - 1 }, (_, i) => (
                      <div className="pile-card back" key={`draw-${i}`}><span>?</span></div>
                    ))}
                  </>
                )}
                {pileView === 'discard' && state.player.discard.length > 0 && (
                  <>
                    <div className="pile-slot">
                      <span className="pile-role">{t('弃牌位', 'Discard slot')}</span>
                      <div className="pile-card">
                        <CardFace name={state.player.discard[0].name} cost={state.player.discard[0].cost} type={state.player.discard[0].type} description={state.player.discard[0].description} art={state.player.discard[0].art} size="mini" />
                      </div>
                    </div>
                    {state.player.discard.slice(1).map((c, i) => (
                      <div className="pile-card" key={`${c.uid}-${i}`}>
                        <CardFace name={c.name} cost={c.cost} type={c.type} description={c.description} art={c.art} size="mini" />
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        ) : tab === 'decks' ? (
          <div className="terminal-body deck-browser">
            <div className="deck-browser-head">
              <b>{t('双方已设计的牌', 'Both designed decks')}</b>
              <span>{t('手牌可见 · 抽牌堆显示卡背', 'Hand visible · draw piles show card backs')}</span>
            </div>
            <section>
              <h3>{t(`我方牌库 · ${state.playerDeck.length} 张`, `Your deck · ${state.playerDeck.length} cards`)}</h3>
              <div className="deck-browser-grid">
                {state.playerDeck.map((c, i) => (
                  <CardFace key={`${c.uid}-${i}`} name={c.name} cost={c.cost} type={c.type} description={c.description} art={c.art} size="mini" />
                ))}
              </div>
            </section>
            <section>
              <h3>{t(`SENTINEL 牌库 · ${state.aiDeck.length} 张`, `SENTINEL deck · ${state.aiDeck.length} cards`)}</h3>
              <div className="deck-browser-grid enemy">
                {state.aiDeck.map((c, i) => (
                  <CardFace key={`${c.uid}-${i}`} name={c.name} cost={c.cost} type={c.type} description={c.description} size="mini" />
                ))}
              </div>
            </section>
          </div>
        ) : (
          <div className="terminal-body">
            <div className="terminal-tools log-filters">
              {([
                ['all', t('全部', 'All')],
                ['code', t('代码', 'Code')],
                ['combat', t('交火', 'Combat')],
                ['pile', t('牌堆', 'Piles')],
                ['ai', t('对手', 'Opponent')],
              ] as [EventFilter, string][]).map(([key, label]) => (
                <button type="button" key={key} className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>{label}</button>
              ))}
            </div>
            <EventFeed events={events} filter={filter} />
          </div>
        )}
      </aside>

      {!drawer && (
        <button type="button" className="terminal-fab main" onClick={() => setDrawer(true)} data-testid="terminal-open">
          <b>{t('战术终端', 'Tactics terminal')}</b>
          <span>{t('写指令 · 牌库 · 记录', 'Script · decks · log')}</span>
        </button>
      )}

      {armed && !drawer && state.phase === 'player' && !ended && (
        <button type="button" className="execute-fab" onClick={submit} disabled={busy} data-testid="execute-command">
          <b>{t('执行终端命令', 'Execute command')}</b>
          <span>{t(`本次脚本 ${scriptCredits} 算力 · 本回合已用 ${usedCredits}/${CREDIT_BUDGET}`, `This script: ${scriptCredits} credits · used ${usedCredits}/${CREDIT_BUDGET} this turn`)}</span>
        </button>
      )}

      {showApi && (
        <div className="modal-backdrop" onClick={() => setShowApi(false)} role="presentation">
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h2>{t('可用接口', 'Available APIs')}</h2>
              <button type="button" className="icon-btn" onClick={() => setShowApi(false)} aria-label={t('关闭', 'Close')}>✕</button>
            </header>
            <div className="modal-body">
              <ApiReference mode="script" onInsert={(snippet) => { editorRef.current?.insert(snippet); setShowApi(false); }} />
            </div>
          </div>
        </div>
      )}


      {commandError && (
        <div className="modal-backdrop" data-testid="command-error">
          <div className="modal command-error" role="dialog" aria-modal="true" aria-labelledby="command-error-title">
            <span className="eyebrow">COMMAND REJECTED</span>
            <h2 id="command-error-title">{translateMessage(commandError.title, lang)}</h2>
            <p>{translateMessage(commandError.message, lang)}</p>
            {commandError.detail && <pre className="command-error-detail">{translateMessage(commandError.detail, lang)}</pre>}
            <div className="end-actions">
              <button
                type="button"
                className="hud-btn primary"
                onClick={() => { setCommandError(null); setDrawer(true); setTab('script'); editorRef.current?.focus(); }}
                data-testid="command-error-edit"
              >
                {t('回到终端修改', 'Back to the terminal')}
              </button>
              <button type="button" className="hud-btn" onClick={() => setCommandError(null)}>{t('知道了', 'Got it')}</button>
            </div>
          </div>
        </div>
      )}

      {energyError && (
        <div className="modal-backdrop" data-testid="energy-error">
          <div className="modal energy-error" role="dialog" aria-modal="true" aria-labelledby="energy-title">
            <span className="eyebrow">COMMAND REJECTED</span>
            <h2 id="energy-title">{t('能量不足', 'Not enough energy')}</h2>
            <p>
              {energyError.card
                ? t(`【${translateCardName(energyError.card, 'zh')}】需要 ${energyError.need} 点能量，`, `【${translateCardName(energyError.card, 'en')}】 needs ${energyError.need} Energy, `)
                : t(`需要 ${energyError.need} 点能量，`, `${energyError.need} Energy is required, `)}
              {t(`当前只有 ${energyError.have} 点。命令已停止。`, `but only ${energyError.have} is available. The command was stopped.`)}
            </p>
            <div className="end-actions">
              <button type="button" className="hud-btn primary needs-skip" onClick={skipTurn} data-testid="energy-skip">{t('跳过回合', 'End turn')}</button>
              <button type="button" className="hud-btn" onClick={dismissEnergyError} data-testid="energy-stay">{t('留在本回合', 'Stay this turn')}</button>
            </div>
          </div>
        </div>
      )}

      {ended && !overDismissed && (
        <div className="modal-backdrop" data-testid="battle-over">
          <div className="modal end-card">
            <h2>{state.result === 'victory' ? t('协议突破', 'Protocol breached') : t('链路中断', 'Link severed')}</h2>
            <p>
              {state.result === 'victory'
                ? t('SENTINEL-07 的核心协议崩了。', "SENTINEL-07's core protocol collapsed.")
                : t('你的外接战斗设备离线了。', 'Your external combat rig went offline.')}
              {t(`共 ${state.turn} 回合 · 你 ${state.player.hp}/${state.player.maxHp} · 对手 ${state.enemy.hp}/${state.enemy.maxHp}`, ` ${state.turn} turns · you ${state.player.hp}/${state.player.maxHp} · SENTINEL ${state.enemy.hp}/${state.enemy.maxHp}`)}
            </p>
            <div className="end-actions">
              <button type="button" className="hud-btn primary" onClick={onFinish} data-testid="open-report">{t('看看这局', 'Review this run')}</button>
              <button type="button" className="hud-btn" onClick={() => setOverDismissed(true)}>{t('先看记录', 'View the log first')}</button>
            </div>
          </div>
        </div>
      )}
      {ended && overDismissed && (
        <button type="button" className="terminal-fab report" onClick={onFinish}>{t('该复盘了 →', 'Review time →')}</button>
      )}
      <ViewSpy view={cue?.kind} />
    </main>
  );
}

/** Keeps the 3D view state reachable for tests without adding UI. */
function ViewSpy({ view }: { view: string | undefined }) {
  return <span className="visually-hidden" data-testid="cue-kind">{view ?? ''}</span>;
}
