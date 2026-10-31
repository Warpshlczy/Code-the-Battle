import { useEffect, useRef, useState } from 'react';
import type { CardArt, CompileResult, CompiledCard, Diagnostic, RegisterDecl } from '../engine/analyze';
import { CODE_LIMITS, LIMITS, effectCapForCost } from '../engine/config';
import { probeAiConnection, normalizeEndpoint, type AiConfig, type AiPersona, type ProbeResult } from '../engine/ai';
import type { DeckSlot } from '../content/deck';
import { DEFAULT_ART, defaultRegisters, starterCards } from '../content/deck';
import { useLang, useT, type Lang } from '../i18n';
import { translateMessage } from '../i18n/messages';
import CardPaint from './CardPaint';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import { ApiReference, StructureTree } from './ApiReference';
import { CardFace, Diagnostics, Label, Meter, Panel, PersonaCard, typeLabel } from './components';

interface Props {
  slots: DeckSlot[];
  setSlots: (slots: DeckSlot[]) => void;
  registers: RegisterDecl[];
  setRegisters: (regs: RegisterDecl[]) => void;
  cardCompiles: CompileResult<CompiledCard>[];
  deckDiags: Diagnostic[];
  regDiags: Diagnostic[];
  canStart: boolean;
  seed: number;
  setSeed: (seed: number) => void;
  aiMode: 'heuristic' | 'llm';
  setAiMode: (mode: 'heuristic' | 'llm') => void;
  aiConfig: AiConfig;
  setAiConfig: (config: AiConfig) => void;
  persona: AiPersona;
  aiBudget: number;
  aiDeck: CompiledCard[];
  onStart: () => void;
  onReset: () => void;
  onRules: () => void;
  onBoot: () => void;
}

const FRAMES = ['#58d7ff', '#7ef0c0', '#ffb45c', '#ff7a8a', '#c9a4ff', '#ffe27a'];
const INKS = ['#08222b', '#072620', '#2a1707', '#2b0710', '#1b0b2c', '#2a2307'];
const SIGILS: CardArt['sigil'][] = ['slash', 'shield', 'arc', 'wave', 'node', 'cross'];
const SIGIL_LABEL: Record<string, [string, string]> = {
  slash: ['斩击', 'Slash'],
  shield: ['盾面', 'Shield'],
  arc: ['弧光', 'Arc'],
  wave: ['波纹', 'Wave'],
  node: ['节点', 'Node'],
  cross: ['十字', 'Cross'],
};

function slotName(result: CompileResult<CompiledCard>, i: number, lang: Lang): string {
  if (result.value) return result.value.name;
  const m = result.diagnostics.find((d) => d.severity === 'error');
  if (m) return lang === 'zh' ? `卡位 ${i + 1} 未编译` : `Slot ${i + 1} did not compile`;
  return lang === 'zh' ? `卡位 ${i + 1}` : `Slot ${i + 1}`;
}

function errorCount(result: CompileResult<CompiledCard>): number {
  return result.diagnostics.filter((d) => d.severity === 'error').length;
}

export default function BuildScreen(props: Props) {
  const {
    slots, setSlots, registers, setRegisters, cardCompiles, deckDiags, regDiags, canStart,
    seed, setSeed, aiMode, setAiMode, aiConfig, setAiConfig, persona, aiBudget, aiDeck, onStart, onReset, onRules, onBoot,
  } = props;
  const t = useT();
  const lang = useLang();
  const [selected, setSelected] = useState(0);
  const [faceTab, setFaceTab] = useState<'paint' | 'style'>('paint');
  const [llmPhase, setLlmPhase] = useState<'idle' | 'checking' | 'ready' | 'error'>('idle');
  const [llmError, setLlmError] = useState('');
  const probeToken = useRef(0);
  const editorRef = useRef<CodeEditorHandle>(null);
  const result = cardCompiles[selected];
  const card = result?.value;
  const errors = result ? result.diagnostics : [];
  const totalCost = cardCompiles.reduce((sum, r) => sum + (r.value?.cost ?? 0), 0);
  const zeroCost = cardCompiles.filter((r) => r.value?.cost === 0).length;
  const blocking = deckDiags.filter((d) => d.severity === 'error');
  const regBlocking = regDiags.filter((d) => d.severity === 'error');
  const art = slots[selected]?.art ?? DEFAULT_ART;
  const llmBusy = aiMode === 'llm' && llmPhase === 'checking';
  const resolvedEndpoint = normalizeEndpoint(aiConfig.endpoint);
  const endpointTyped = (aiConfig.endpoint ?? '').trim();

  const describeProbe = (probe: ProbeResult): string => {
    const raw = probe.detail ? ` · ${probe.detail}` : '';
    switch (probe.reason) {
      case 'empty':
        return t('请先填写外接模型接口地址', 'Enter the external model endpoint first');
      case 'not_found':
        return t(
          `接口返回 HTTP 404：地址不存在。实际请求 ${probe.url}${raw}。协议和 /chat/completions 已自动补全；请确认填的是 API 地址（DeepSeek 是 https://api.deepseek.com），而不是网页域名或错误的中转路径。`,
          `HTTP 404: address not found. Requested ${probe.url}${raw}. The scheme and /chat/completions are completed automatically; make sure this is the API host (https://api.deepseek.com for DeepSeek), not the website or a wrong proxy path.`,
        );
      case 'auth':
        return t(
          `接口返回 HTTP ${probe.status}：密钥无效或没有权限。实际请求 ${probe.url}${raw}`,
          `HTTP ${probe.status}: the key is invalid or lacks permission. Requested ${probe.url}${raw}`,
        );
      case 'rate_limited':
        return t(
          `接口返回 HTTP 429：请求过多或余额不足。实际请求 ${probe.url}${raw}`,
          `HTTP 429: too many requests or the balance is empty. Requested ${probe.url}${raw}`,
        );
      case 'timeout':
        return t(
          `外接模型超时（${probe.latencyMs}ms）。实际请求 ${probe.url}。检查网络、代理和地址。`,
          `The external model timed out (${probe.latencyMs}ms). Requested ${probe.url}. Check the network, proxy and URL.`,
        );
      case 'network':
        return t(
          `无法连接外接模型：${probe.detail || '未知错误'}。实际请求 ${probe.url}。可能是网络、CORS 限制或地址错误。`,
          `Could not reach the external model: ${probe.detail || 'unknown error'}. Requested ${probe.url}. This may be the network, a CORS restriction or a wrong URL.`,
        );
      default:
        return t(
          `接口返回 HTTP ${probe.status ?? '?'}${raw}。实际请求 ${probe.url}`,
          `Endpoint returned HTTP ${probe.status ?? '?'}${raw}. Requested ${probe.url}`,
        );
    }
  };

  // DeepSeek rejects the default placeholder model, so follow the endpoint.
  const updateEndpoint = (endpoint: string) => {
    const patch: AiConfig = { ...aiConfig, endpoint };
    if (/deepseek/i.test(endpoint) && (aiConfig.model ?? '').trim() === 'gpt-4o-mini') {
      patch.model = 'deepseek-chat';
    }
    setAiConfig(patch);
  };

  // Any endpoint/key/model change invalidates the previous handshake.
  useEffect(() => {
    probeToken.current += 1;
    setLlmPhase('idle');
    setLlmError('');
  }, [aiMode, aiConfig.endpoint, aiConfig.model, aiConfig.apiKey]);

  const startBattle = async () => {
    if (!canStart || llmBusy) return;
    if (aiMode !== 'llm') {
      onStart();
      return;
    }
    const token = ++probeToken.current;
    setLlmPhase('checking');
    setLlmError('');
    const result = await probeAiConnection(aiConfig);
    if (token !== probeToken.current) return;
    if (!result.ok) {
      setLlmPhase('error');
      setLlmError(describeProbe(result));
      return;
    }
    setLlmPhase('ready');
    // Let both readiness rows actually paint before the battle takes over.
    await new Promise((resolve) => window.setTimeout(resolve, 260));
    if (token !== probeToken.current) return;
    onStart();
  };

  const startLabel = llmBusy
    ? t('等待双方准备…', 'Waiting for both sides…')
    : aiMode === 'llm' && llmPhase === 'error'
      ? t('重试连接并进入战场', 'Retry connection and enter battle')
      : t('进入战场', 'ENTER BATTLE');
  const startMeta = aiMode === 'llm'
    ? llmBusy
      ? t('玩家已就绪 · 正在等待外接模型响应', 'Player ready · waiting for the external model')
      : llmPhase === 'error'
        ? t('模型未就绪 · 点击重新握手', 'Model not ready · click to handshake again')
        : t(`玩家${canStart ? '已就绪' : '未就绪'} · 开战前检查外接模型`, `Player ${canStart ? 'ready' : 'not ready'} · external model checked before battle`)
    : t(`种子 ${seed} · 牌组 ${slots.length} 张`, `Seed ${seed} · ${slots.length}-card deck`);

  const setSource = (source: string) => {
    setSlots(slots.map((s, i) => (i === selected ? { ...s, source } : s)));
  };

  const setArt = (patch: Partial<NonNullable<DeckSlot['art']>>) => {
    setSlots(slots.map((s, i) => (i === selected ? { ...s, art: { ...(s.art ?? DEFAULT_ART), ...patch } } : s)));
  };

  const addSlot = () => {
    if (slots.length >= LIMITS.deck.maxSize) return;
    const base = starterCards(lang)[0];
    const next: DeckSlot = {
      id: `custom-${Date.now().toString(36)}`,
      source: base.source
        .replace('class DirectStrike(Card):', 'class CustomStrike(Card):')
        .replace(/name = "[^"]+"/, `name = "${lang === 'en' ? 'New Card' : '新卡'}"`),
      art: { ...DEFAULT_ART, sigil: 'node' },
    };
    setSlots([...slots, next]);
    setSelected(slots.length);
  };

  const removeSlot = (index: number) => {
    if (slots.length <= LIMITS.deck.minSize) return;
    setSlots(slots.filter((_, i) => i !== index));
    setSelected(Math.max(0, Math.min(selected, slots.length - 2)));
  };

  const updateReg = (index: number, patch: Partial<RegisterDecl>) => {
    setRegisters(registers.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const changeRegType = (index: number, type: RegisterDecl['type']) => {
    if (type === 'int') updateReg(index, { type, initial: 0, min: 0, max: 10 });
    else if (type === 'bool') updateReg(index, { type, initial: false, min: 0, max: 1 });
    else {
      const values = defaultRegisters(lang).find((r) => r.name === 'mode')?.enumValues ?? ['默认', '强攻', '蛰伏'];
      updateReg(index, { type, initial: values[0], min: 0, max: 2, enumValues: values });
    }
  };

  return (
    <main className="screen build-screen" data-testid="build-screen">
      <header className="screen-head">
        <div className="brand-line">
          <span className="brand-mark">CODE THE BATTLE</span>
          <span className="brand-suffix">{t('/ 构筑', '/ BUILD')}</span>
        </div>
        <div className="steps">
          <span className="step active">{t('01 构筑', '01 BUILD')}</span>
          <span className="step">{t('02 交火', '02 BATTLE')}</span>
          <span className="step">{t('03 复盘', '03 REVIEW')}</span>
        </div>
        <div className="head-actions">
          <button type="button" className="ghost-btn small" onClick={onRules}>{t('说明', 'Rules')}</button>
          <button type="button" className="ghost-btn small" onClick={onBoot} data-testid="build-to-boot">{t('首页', 'Home')}</button>
        </div>
      </header>

      <div className="build-grid">
        <aside className={`deck-col ${aiMode === 'llm' ? 'llm-mode' : ''}`}>
          <Panel
            title={t('牌组', 'DECK')}
            meta={<span className="mono">{cardCompiles.filter((r) => r.ok).length}/{slots.length} READY</span>}
            testId="deck-panel"
          >
            <div className="deck-budget">
              <div className="deck-cost-line"><span>{t('牌组费用总和', 'Total deck cost')}</span><b>{Math.round(totalCost)}</b></div>
              <div className="deck-chips">
                <span>{t(`${slots.length}/${LIMITS.deck.maxSize} 张`, `${slots.length}/${LIMITS.deck.maxSize} cards`)}</span>
                <span>{t(`0 费 ${zeroCost}`, `0 cost: ${zeroCost}`)}</span>
              </div>
            </div>
            <div className="slot-list">
              {slots.map((slot, i) => {
                const c = cardCompiles[i].value;
                const errs = errorCount(cardCompiles[i]);
                return (
                  <div key={slot.id} className={`slot-row ${i === selected ? 'selected' : ''} ${errs ? 'has-error' : ''}`}>
                    <button type="button" className="slot-pick" onClick={() => setSelected(i)} data-testid={`deck-slot-${i}`}>
                      <span className="slot-index">{String(i + 1).padStart(2, '0')}</span>
                      {c && <CardFace name={c.name} cost={c.cost} type={c.type} description={c.description} art={c.art} size="thumb" />}
                      <span className="slot-info">
                        <b>{slotName(cardCompiles[i], i, lang)}</b>
                        <span>
                          {c
                            ? `${typeLabel(c.type, lang)} · C=${c.cost}${c.description ? ` · ${c.description}` : ''}`
                            : t('编译失败', 'Compile failed')}
                        </span>
                      </span>
                      <span className={`slot-state ${errs ? 'err' : ''}`}>{errs ? 'ERR' : ''}</span>
                    </button>
                    {slots.length > LIMITS.deck.minSize && (
                      <button
                        type="button"
                        className="icon-btn slot-del"
                        aria-label={t(`删除卡位 ${i + 1}`, `Delete slot ${i + 1}`)}
                        onClick={() => removeSlot(i)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="deck-foot">
              <button type="button" className="ghost-btn small" onClick={addSlot} disabled={slots.length >= LIMITS.deck.maxSize} data-testid="add-card">
                {t('+ 加一张', '+ Add card')}
              </button>
              <button type="button" className="ghost-btn small" onClick={onReset} data-testid="load-sample">
                {t('载入示例牌组', 'Load sample deck')}
              </button>
            </div>
            <p className="hint">{t(`${LIMITS.deck.minSize}—${LIMITS.deck.maxSize} 张。费用决定效果上限。`, `${LIMITS.deck.minSize}–${LIMITS.deck.maxSize} cards. The printed cost sets the effect cap.`)}</p>
            {deckDiags.length > 0 && (
              <div className="deck-diags">
                <Diagnostics items={deckDiags} />
              </div>
            )}
          </Panel>

          <div className="deck-start" data-testid="deck-start">
            <div className="deck-start-head">
              <span className="eyebrow">READY ROOM</span>
              <div className="deck-cost-line"><span>{t('牌组费用总和', 'Total deck cost')}</span><b>{Math.round(totalCost)}</b></div>
            </div>
            {aiMode === 'llm' && (
              <div className="ready-panel" data-testid="llm-readiness">
                <div className={`ready-row ${canStart ? 'ok' : 'wait'}`}>
                  <span>{t('玩家牌组', 'Player deck')}</span>
                  <b>{canStart ? t('已就绪', 'Ready') : t('未就绪', 'Not ready')}</b>
                </div>
                <div className={`ready-row ${llmPhase === 'ready' ? 'ok' : llmPhase === 'error' ? 'bad' : llmBusy ? 'wait' : ''}`}>
                  <span>{t('外接模型', 'External model')}</span>
                  <b>
                    {llmBusy
                      ? t('握手中…', 'Handshaking…')
                      : llmPhase === 'ready'
                        ? t('已就绪', 'Ready')
                        : llmPhase === 'error'
                          ? t('未就绪', 'Not ready')
                          : t('待检测', 'Not checked')}
                  </b>
                </div>
                {llmError && <p className="ready-error" role="alert">{llmError}</p>}
                <p className="hint">{t('双方就绪后开战 · 握手仅发送 1 token', 'Battle starts when both sides are ready · the handshake sends only 1 token')}</p>
              </div>
            )}
            {!canStart && (
              <div className="block-reason" data-testid="build-blocked">
                {translateMessage(
                  regBlocking[0]?.message ?? blocking[0]?.message ?? cardCompiles.find((c) => !c.ok)?.diagnostics.find((d) => d.severity === 'error')?.message,
                  lang,
                ) || t('牌组尚未就绪', 'The deck is not ready yet.')}
              </div>
            )}
            <button
              type="button"
              className="primary-btn battlefield-cta"
              disabled={!canStart || llmBusy}
              onClick={startBattle}
              data-testid="start-battle"
            >
              <span className="cta-main">{startLabel}<i aria-hidden="true">→</i></span>
              <span className="cta-meta">{startMeta}</span>
            </button>
          </div>
        </aside>

        <section className="editor-col">
          <Panel
            title={t(`卡牌源码 · 卡位 ${String(selected + 1).padStart(2, '0')}`, `CARD SOURCE · SLOT ${String(selected + 1).padStart(2, '0')}`)}
            meta={
              <span className="compile-meta">
                {card ? (
                  <>
                    <span className="cost-badge">C {card.cost}</span>
                    <span>{t(`最坏情况 ${card.P.toFixed(1)}`, `worst case ${card.P.toFixed(1)}`)}</span>
                    <span>{t(`抵扣 ${card.R.toFixed(1)}`, `discount ${card.R.toFixed(1)}`)}</span>
                    <span>{t(`声明 ${card.declaredCost}`, `declared ${card.declaredCost}`)}</span>
                  </>
                ) : (
                  <span className="err-text">{t('未通过编译', 'Compile failed')}</span>
                )}
              </span>
            }
          >
            <div className="editor-bar">
              <span className="editor-hint">
                {t(
                  'class X(Card) · 固定字段 · 只写 effect(self, ctx) · 行尾 // 注释会成为卡面说明',
                  'class X(Card) · fixed fields · only write effect(self, ctx) · a trailing // comment becomes the card description',
                )}
              </span>
              <button type="button" className="ghost-btn small" onClick={() => editorRef.current?.focus()}>{t('聚焦', 'Focus')}</button>
            </div>
            <CodeEditor
              ref={editorRef}
              value={slots[selected].source}
              onChange={setSource}
              minRows={14}
              maxRows={26}
              errorLines={errors.filter((d) => d.severity === 'error').map((d) => d.line)}
              ariaLabel={t('卡牌源码编辑器', 'Card source editor')}
              testId="card-editor"
              maxLines={CODE_LIMITS.card.maxLines}
              maxComplexity={CODE_LIMITS.card.maxComplexity}
              complexity={card?.astNodes ?? 0}
            />
            <div className="editor-stats">
              <Meter
                label={t(`效果上限 · ${card?.cost ?? 0} 费`, `Effect cap · cost ${card?.cost ?? 0}`)}
                value={Number((card?.N ?? 0).toFixed(1))}
                max={effectCapForCost(card?.cost ?? 0)}
              />
              <Meter
                label={t('负面抵扣', 'Negative discount')}
                value={Number((card?.R ?? 0).toFixed(1))}
                max={Number(Math.max(1, (card?.P ?? 0) * 0.7).toFixed(1))}
                tone="violet"
              />
              <Meter label={t('代码复杂度', 'Code complexity')} value={card?.astNodes ?? 0} max={CODE_LIMITS.card.maxComplexity} tone="amber" />
              <Meter label={t('有效行', 'Effective lines')} value={card?.lines ?? 0} max={CODE_LIMITS.card.maxLines} tone="cyan" />
            </div>
            {card && card.negatives.length > 0 && (
              <div className="negative-list">
                <Label>{t('可抵扣负面', 'Discountable negatives')}</Label>
                {card.negatives.map((n, i) => (
                  <span key={i} className="neg-chip" title={t(`基础 ${n.base.toFixed(1)} · 频率 ${n.frequency}`, `base ${n.base.toFixed(1)} · frequency ${n.frequency}`)}>
                    {n.kind} L{n.line} → {t('抵扣', 'discount')} {n.credit.toFixed(2)}
                  </span>
                ))}
              </div>
            )}
            <Diagnostics
              items={errors}
              onLine={() => editorRef.current?.focus()}
            />
          </Panel>

          <Panel
            title={t('卡面', 'CARD FACE')}
            meta={<span className="mono">{t('只改外观，不改数值', 'Cosmetic only; values are untouched')}</span>}
            testId="card-designer"
          >
            <div className="face-design">
              <div className="face-preview">
                <CardFace
                  name={card?.name ?? t('新卡', 'New Card')}
                  cost={card?.cost ?? 0}
                  type={card?.type ?? 'skill'}
                  description={card?.description ?? ''}
                  art={art}
                  size="large"
                />
                <div className="face-tabs" role="tablist" aria-label={t('卡面编辑方式', 'Card face editing mode')}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={faceTab === 'paint'}
                    className={faceTab === 'paint' ? 'on' : ''}
                    onClick={() => setFaceTab('paint')}
                  >
                    {t('画笔', 'Brush')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={faceTab === 'style'}
                    className={faceTab === 'style' ? 'on' : ''}
                    onClick={() => setFaceTab('style')}
                  >
                    {t('边框与标记', 'Frame & sigil')}
                  </button>
                </div>
              </div>

              <div className="face-controls">
                {faceTab === 'paint' ? (
                  <CardPaint
                    image={art.image}
                    onCommit={(image) => setArt({ image, imageRev: (art.imageRev ?? 0) + 1 })}
                    onClear={() => setArt({ image: undefined, imageRev: (art.imageRev ?? 0) + 1 })}
                  />
                ) : (
                  <>
                    <div className="face-group">
                      <Label>{t('边框', 'Frame')}</Label>
                      <div className="swatches">
                        {FRAMES.map((c) => (
                          <button
                            key={c}
                            type="button"
                            className={`swatch ${art.frame === c ? 'on' : ''}`}
                            style={{ background: c }}
                            aria-label={t(`边框颜色 ${c}`, `Frame color ${c}`)}
                            onClick={() => setArt({ frame: c })}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="face-group">
                      <Label>{t('底色', 'Base ink')}</Label>
                      <div className="swatches">
                        {INKS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            className={`swatch ${art.ink === c ? 'on' : ''}`}
                            style={{ background: c }}
                            aria-label={t(`卡面底色 ${c}`, `Card ink ${c}`)}
                            onClick={() => setArt({ ink: c })}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="face-group">
                      <Label>{t('标记', 'Sigil')}</Label>
                      <div className="sigil-row">
                        {SIGILS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={`ghost-btn small ${art.sigil === s ? 'on' : ''}`}
                            onClick={() => setArt({ sigil: s })}
                            data-testid={`sigil-${s}`}
                          >
                            {t(SIGIL_LABEL[s][0], SIGIL_LABEL[s][1])}
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="hint">
                      {t(
                        '没有画图时显示标记；边框和底色始终保留。卡面会出现在手牌、悬浮提示、弃牌堆和 3D 桌面上。',
                        'Without a painting, the sigil is shown; the frame and ink always remain. The face appears in the hand, hover tips, discard pile and 3D table.',
                      )}
                    </p>
                  </>
                )}
              </div>
            </div>
          </Panel>

          <div className="editor-split">
            <Panel title={t('接口', 'API')} meta={t('点击插入补全', 'Click to insert')}>
              <ApiReference mode="card" onInsert={(snippet) => editorRef.current?.insert(snippet)} compact />
            </Panel>
            <Panel title={t('结构树', 'Structure tree')} meta={t('来自当前源码', 'From the current source')}>
              <StructureTree source={slots[selected].source} />
            </Panel>
          </div>
        </section>

        <aside className="build-side">
          <Panel title={t('寄存器', 'REGISTERS')} meta={<span className="mono">{registers.length}/3</span>}>
            <div className="register-editor">
              {registers.map((r, i) => (
                <div className="reg-row" key={i}>
                  <div className="reg-main">
                    <input
                      className="input name"
                      value={r.name}
                      aria-label={t(`寄存器 ${i + 1} 名称`, `Register ${i + 1} name`)}
                      onChange={(e) => updateReg(i, { name: e.target.value })}
                    />
                    <select className="input type" value={r.type} aria-label={t(`寄存器 ${i + 1} 类型`, `Register ${i + 1} type`)} onChange={(e) => changeRegType(i, e.target.value as RegisterDecl['type'])}>
                      <option value="int">int</option>
                      <option value="bool">bool</option>
                      <option value="enum">enum</option>
                    </select>
                    <button type="button" className="icon-btn" aria-label={t('删除寄存器', 'Delete register')} onClick={() => setRegisters(registers.filter((_, j) => j !== i))}>✕</button>
                  </div>
                  {r.type === 'int' && (
                    <div className="reg-fields">
                      <label>{t('初始', 'initial')}<input className="input" type="number" value={r.initial as number} onChange={(e) => updateReg(i, { initial: Number(e.target.value) || 0 })} /></label>
                      <label>min<input className="input" type="number" value={r.min} onChange={(e) => updateReg(i, { min: Number(e.target.value) || 0 })} /></label>
                      <label>max<input className="input" type="number" value={r.max} onChange={(e) => updateReg(i, { max: Number(e.target.value) || 0 })} /></label>
                    </div>
                  )}
                  {r.type === 'bool' && (
                    <div className="reg-fields">
                      <label>{t('初始', 'initial')}
                        <select className="input" value={String(r.initial)} onChange={(e) => updateReg(i, { initial: e.target.value === 'true' })}>
                          <option value="false">False</option>
                          <option value="true">True</option>
                        </select>
                      </label>
                    </div>
                  )}
                  {r.type === 'enum' && (
                    <div className="reg-fields enum">
                      <label>{t('值列表', 'values')}
                        <input
                          className="input wide"
                          value={(r.enumValues ?? []).join(',')}
                          onChange={(e) => {
                            const vals = e.target.value.split(',').map((v) => v.trim()).filter(Boolean).slice(0, 8);
                            updateReg(i, { enumValues: vals, initial: vals.includes(r.initial as string) ? r.initial : vals[0] ?? '' });
                          }}
                        />
                      </label>
                      <label>{t('初始', 'initial')}
                        <select className="input" value={String(r.initial)} onChange={(e) => updateReg(i, { initial: e.target.value })}>
                          {(r.enumValues ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              ))}
              {registers.length < 3 && (
                <button type="button" className="ghost-btn small add-reg" onClick={() => setRegisters([...registers, { name: `reg${registers.length + 1}`, type: 'int', initial: 0, min: 0, max: 10 }])}>
                  {t('+ 添加寄存器', '+ Add register')}
                </button>
              )}
              {regDiags.length > 0 && <Diagnostics items={regDiags} />}
            </div>
          </Panel>

          <Panel title={t('本局设置', 'MATCH SETUP')} meta={<span className="mono">{t('单次作战', 'Single match')}</span>}>
            <div className="seed-row">
              <label className="field-label" htmlFor="seed">{t('本局种子', 'Match seed')}</label>
              <div className="seed-controls">
                <input
                  id="seed"
                  className="input"
                  type="number"
                  min={1}
                  max={999999}
                  value={seed}
                  data-testid="seed-input"
                  onChange={(e) => setSeed(Math.max(1, Math.min(999999, Number(e.target.value) || 1)))}
                />
                <button type="button" className="ghost-btn small" onClick={() => setSeed(Math.floor(Math.random() * 900000) + 1000)}>
                  {t('换种子', 'Reroll')}
                </button>
              </div>
              <span className="hint">{t('牌组、种子和脚本不变，战斗结果就不会变。', 'Keep the deck, seed and scripts fixed and the battle result stays fixed.')}</span>
            </div>

            <div className="ai-mode">
              <Label>{t('SENTINEL 的战斗风格', 'SENTINEL FIGHTING STYLE')}</Label>
              <div className="segmented">
                <button type="button" className={aiMode === 'heuristic' ? 'on' : ''} onClick={() => setAiMode('heuristic')} data-testid="ai-mode-heuristic">
                  {t('固定战术', 'Fixed tactic')}
                </button>
                <button type="button" className={aiMode === 'llm' ? 'on' : ''} onClick={() => setAiMode('llm')} data-testid="ai-mode-llm">
                  {t('外接战术', 'External model')}
                </button>
              </div>
              {aiMode === 'llm' && (
                <div className="llm-config">
                  <label className="field-label">{t('接口地址', 'Endpoint')}</label>
                  <input
                    className="input wide"
                    placeholder="https://api.deepseek.com"
                    value={aiConfig.endpoint ?? ''}
                    onChange={(e) => updateEndpoint(e.target.value)}
                    data-testid="llm-endpoint"
                  />
                  {resolvedEndpoint && resolvedEndpoint !== endpointTyped && (
                    <p className="hint" data-testid="llm-endpoint-resolved">
                      {t(`实际请求：${resolvedEndpoint}`, `Resolved request: ${resolvedEndpoint}`)}
                    </p>
                  )}
                  <label className="field-label">{t('外接型号', 'Model')}</label>
                  <input
                    className="input wide"
                    placeholder="deepseek-chat / gpt-4o-mini"
                    value={aiConfig.model ?? ''}
                    onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
                  />
                  <label className="field-label">{t('密钥（只留在这个页面）', 'API key (stays on this page only)')}</label>
                  <input className="input wide" type="password" value={aiConfig.apiKey ?? ''} onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })} />
                  <p className="hint">
                    {t(
                      'DeepSeek 示例：地址 https://api.deepseek.com，型号 deepseek-chat，密钥 sk-…。地址末尾的 /chat/completions 会自动补全。',
                      'DeepSeek example: endpoint https://api.deepseek.com, model deepseek-chat, key sk-…. A missing /chat/completions is appended automatically.',
                    )}
                  </p>
                  <p className="hint warn">
                    {t(
                      '外接战术只负责提出出牌顺序，规则引擎会逐条检查。连不上、答得慢或答错，就整份退回固定战术，并写进战后档案。',
                      'The external model only proposes a play order; the rules engine validates every op. If it cannot connect, answers too slowly or answers wrongly, the whole plan falls back to the fixed tactic and is recorded in the post-battle file.',
                    )}
                  </p>
                </div>
              )}
              <p className="hint">
                {t(
                  `SENTINEL 和你用同一套卡、能量和牌堆规则。它的牌组费用 ${aiBudget.toFixed(0)}，最多也带 10 张。`,
                  `SENTINEL shares your card, Energy and pile rules. Its deck costs ${aiBudget.toFixed(0)} and also caps at 10 cards.`,
                )}
              </p>
            </div>
          </Panel>

          <PersonaCard persona={persona} compact />

          <details className="enemy-deck-panel" data-testid="enemy-deck" open>
            <summary>
              {t(`敌方牌库 · ${aiDeck.length} 张`, `SENTINEL deck · ${aiDeck.length} cards`)}
              <span>{t('展开', 'expand')}</span>
            </summary>
            <div className="enemy-deck-grid">
              {aiDeck.map((c, i) => (
                <CardFace key={`${c.name}-${i}`} name={c.name} cost={c.cost} type={c.type} description={c.description} size="mini" />
              ))}
            </div>
          </details>
        </aside>
      </div>
    </main>
  );
}
