import { useMemo, useState } from 'react';
import type { Battle } from '../engine/battle';
import type { BattleReport, QuizQuestion } from '../engine/report';
import { verifyReplay, type ReplayResult } from '../engine/report';
import { LIMITS } from '../engine/config';
import { Panel, Label, PERSONA } from './components';
import { ART } from './art';
import { pick, useLang, useT } from '../i18n';
import { translateMessage } from '../i18n/messages';

interface Props {
  report: BattleReport;
  battle: Battle;
  onAgain: (sameSeed: boolean) => void;
  onBoot: () => void;
}

type Tab = 'attribution' | 'timeline' | 'quiz' | 'ai' | 'replay';

const TAB_LABEL: Record<Tab, [string, string]> = {
  attribution: ['代码账本', 'Code ledger'],
  timeline: ['牌堆回放', 'Pile replay'],
  quiz: ['读码审讯', 'Code interrogation'],
  ai: ['对手档案', 'Opponent file'],
  replay: ['重放校验', 'Replay check'],
};

export default function ReportScreen({ report, battle, onAgain, onBoot }: Props) {
  const lang = useLang();
  const t = useT();
  const [tab, setTab] = useState<Tab>('attribution');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [replay, setReplay] = useState<{ status: 'idle' | 'running' | 'done'; result?: ReplayResult }>({ status: 'idle' });

  const answered = Object.keys(answers).length;
  const correct = report.questions.filter((q) => answers[q.id] === q.answer).length;
  const persona = PERSONA[report.state.persona];
  const exportLog = () => {
    const data = {
      seed: report.seed,
      outcome: report.outcome,
      turns: report.turns,
      playerDeck: report.state.playerDeckBudget,
      aiAudit: report.state.aiMeta,
      aiDeck: report.state.aiDeckMeta,
      events: battle.getEvents(0),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `riftcode-log-${report.seed}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runReplay = async () => {
    setReplay({ status: 'running' });
    const result = await verifyReplay(battle);
    setReplay({ status: 'done', result });
  };

  return (
    <main className="screen report-screen" data-testid="report-screen">
      <header className="screen-head">
        <div className="brand-line">
          <span className="brand-mark">CODE THE BATTLE</span>
          <span className="brand-suffix">{t('· 战斗之后', '· after the battle')}</span>
        </div>
        <div className="steps">
          <span className="step">{t('01 构筑', '01 Build')}</span>
          <span className="step">{t('02 对局', '02 Duel')}</span>
          <span className="step active">{t('03 复盘', '03 Review')}</span>
        </div>
        <div className="head-actions">
          <button type="button" className="ghost-btn small" onClick={exportLog}>{t('导出日志', 'Export log')}</button>
          <button type="button" className="ghost-btn small" onClick={onBoot}>{t('首页', 'Home')}</button>
        </div>
      </header>

      <section className={`report-hero ${report.outcome}`}>
        <div className="report-hero-bg" style={{ backgroundImage: `url(${ART.arena})` }} />
        <div className="report-hero-content">
          <span className="eyebrow">{t(`战斗记录 · 种子 ${report.seed}`, `Battle record · seed ${report.seed}`)}</span>
          <h1>
            {report.outcome === 'victory'
              ? t('协议突破', 'Protocol breached')
              : report.outcome === 'defeat'
                ? t('链路中断', 'Link severed')
                : t('对局未完成', 'Run unfinished')}
          </h1>
          <p>
            {report.outcome === 'victory'
              ? t('SENTINEL-07 核心协议崩溃。', "SENTINEL-07's core protocol collapsed.")
              : t('你的外接战斗设备离线。', 'Your external combat rig went offline.')}
            {t(` 共 ${report.turns} 回合。这局怎么打的，记录里都有。`, ` ${report.turns} turns total. Everything that happened is in the record.`)}
          </p>
          <div className="report-stats">
            <div><Label>{t('对敌方伤害', 'Damage dealt')}</Label><b>{report.totalDamageDealt}</b></div>
            <div><Label>{t('承受伤害', 'Damage taken')}</Label><b>{report.totalDamageTaken}</b></div>
            <div><Label>{t('最大一下', 'Biggest hit')}</Label><b>{report.biggestHit?.amount ?? 0}</b><span>{report.biggestHit?.source ?? '—'}</span></div>
            <div><Label>{t('熔断', 'Halts')}</Label><b>{report.halts.length}</b><span>{report.halts[0] ? translateMessage(report.halts[0].label, lang) : t('无', 'none')}</span></div>
            <div><Label>{t('审讯', 'Quiz')}</Label><b>{correct}/{report.questions.length}</b><span>{t(`${answered} 题已答`, `${answered} answered`)}</span></div>
          </div>
        </div>
        <div className="report-hero-art">
          <img src={ART.enemy} alt="" />
        </div>
      </section>

      <div className="report-tabs" role="tablist">
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button type="button" key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
            {pick(lang, ...TAB_LABEL[key])}
          </button>
        ))}
      </div>

      {tab === 'attribution' && (
        <div className="report-grid">
          <Panel title={t('每一行代码的去向', 'Where every line went')} meta={<span className="mono">{t('源码 → 调用 → 结果', 'source → call → result')}</span>}>
            <div className="table-wrap">
              <table className="data-table" data-testid="attribution-table">
                <thead>
                  <tr>
                    <th>{t('来源', 'Source')}</th><th>{t('位置', 'Location')}</th><th>{t('接口', 'API')}</th><th>{t('算力合计', 'Credits')}</th><th>{t('伤害', 'Damage')}</th><th>{t('获格挡', 'Block')}</th><th>{t('治疗', 'Heal')}</th><th>{t('牌堆', 'Piles')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.attribution.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <span className={`kind-badge kind-${row.kind}`}>
                          {row.kind === 'script'
                            ? t('脚本', 'Script')
                            : row.kind === 'card'
                              ? t('卡牌', 'Card')
                              : row.kind === 'ai'
                                ? t('对手', 'Opponent')
                                : t('引擎', 'Engine')}
                        </span>
                        {translateMessage(row.label, lang)}
                      </td>
                      <td className="mono">{row.line ? `L${row.line}` : '—'}</td>
                      <td className="mono">{row.apiCalls}</td>
                      <td className="mono">{row.credits ? row.credits.toFixed(1) : '—'}</td>
                      <td className={row.damage ? 'hot' : ''}>{row.damage}</td>
                      <td>{row.blockGained}</td>
                      <td>{row.heal}</td>
                      <td>{row.pileOps}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">
              {t(
                '每次接口调用记录来源文件、源码行与 IR id；引擎行是回合开始/结束的固定结算。卡牌/脚本行只统计玩家代码。这张表回答“哪一行代码造成了什么”。',
                'Every API call records the source file, source line and IR id; engine rows are the fixed turn-start and turn-end settlements. Card and script rows count player code only. This table answers "which line caused what".',
              )}
            </p>
          </Panel>

          <div className="report-side">
            <Panel title={t('这局的事实', 'Facts from this run')} meta={<span className="mono">{t('只记事实', 'facts only')}</span>}>
              <ul className="fact-list">
                <li><span>{t('你的牌组费用', 'Your deck cost')}</span><b>{report.state.playerDeckBudget.toFixed(0)}</b></li>
                <li><span>{t('对手牌组费用', 'Opponent deck cost')}</span><b>{report.state.aiDeckBudget.toFixed(0)}</b></li>
                <li><span>{t('对手战斗风格', 'Opponent style')}</span><b>{modeText(report.aiAudit.mode, lang)}</b></li>
                <li><span>{t('熔断位置', 'Halt location')}</span><b>{report.halts[0] ? `T${report.halts[0].turn} L${report.halts[0].line}` : t('无', 'none')}</b></li>
                <li><span>{t('本局寄存器', 'Run registers')}</span><b>{t('已清空', 'cleared')}</b></li>
              </ul>
              {report.halts.length > 0 && (
                <div className="halt-list">
                  {report.halts.map((h, i) => (
                    <div key={i} className="halt-item">
                      <b>{translateMessage(h.label, lang)}</b>
                      <span>{t(`T${h.turn} · L${h.line}`, `T${h.turn} · L${h.line}`)} · {translateMessage(h.message, lang)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title={t('审讯说明', 'How the quiz works')} meta={t('没有奖励', 'no rewards')}>
              <p className="hint">
                {t(
                  '题目都是从这局记录里长出来的。先翻账本和牌堆回放，再作答；答错会告诉你证据在哪。',
                  'Every question is grown from this run’s record. Check the ledger and pile replay first; wrong answers tell you where the evidence lives.',
                )}
              </p>
              <button type="button" className="primary-btn" onClick={() => setTab('quiz')}>{t('开始读码审讯', 'Start the interrogation')}</button>
            </Panel>
          </div>
        </div>
      )}

      {tab === 'timeline' && (
        <Panel title={t('牌堆回放', 'Pile replay')} meta={<span className="mono">{t(`${report.timeline.length} 条`, `${report.timeline.length} entries`)}</span>}>
          <div className="timeline">
            {report.timeline.map((entry, i) => {
              const prev = report.timeline[i - 1];
              const showTurn = !prev || prev.turn !== entry.turn;
              return (
                <div key={i} className="timeline-group">
                  {showTurn && <div className="timeline-turn">T{String(entry.turn).padStart(2, '0')}</div>}
                  <div className={`timeline-entry kind-${entry.kind}`}>
                    <span className={`tl-kind kind-${entry.kind}`}>{entry.kind.toUpperCase()}</span>
                    <span className="tl-text">{translateMessage(entry.text, lang)}</span>
                    {entry.source && <span className="tl-src">{translateMessage(entry.source, lang)}</span>}
                  </div>
                </div>
              );
            })}
            {report.timeline.length === 0 && <p className="hint">{t('这局没有可回放的牌堆事件。', 'No pile events to replay in this run.')}</p>}
          </div>
        </Panel>
      )}

      {tab === 'quiz' && (
        <div className="quiz-wrap">
          <div className="quiz-head">
            <div>
              <Label>{t('读码审讯', 'Code interrogation')}</Label>
              <h2>{t('读码审讯', 'Code interrogation')}</h2>
              <p className="hint">{t('每道题都能在日志里找到证据。没有提示系统，也不给解锁奖励。', 'Every answer has evidence in the log. There are no hints and no unlock rewards.')}</p>
            </div>
            <div className="quiz-score">
              <b>{correct}</b><span>/ {report.questions.length}</span>
              <em>{answered === report.questions.length ? t('全部作答', 'All answered') : t(`${answered} 题已答`, `${answered} answered`)}</em>
              <button type="button" className="ghost-btn tiny" onClick={() => setAnswers({})}>{t('重置', 'Reset')}</button>
            </div>
          </div>
          <div className="quiz-list">
            {report.questions.map((q, qi) => (
              <QuizCard key={q.id} q={q} index={qi} selected={answers[q.id]} onSelect={(idx) => setAnswers((a) => ({ ...a, [q.id]: idx }))} />
            ))}
          </div>
        </div>
      )}

      {tab === 'ai' && (
        <div className="report-grid">
          <Panel title={t('SENTINEL 的行动档案', "SENTINEL's action file")} meta={<span className="mono">{t('它当时怎么想', 'how it decided')}</span>}>
            <div className="ai-audit-head">
              <img src={ART.enemy} alt="" />
              <div>
                <h3>{pick(lang, persona.name, persona.nameEn)}</h3>
                <span className="tag">{pick(lang, persona.tag, persona.tagEn)}</span>
                <p>{pick(lang, persona.description, persona.descriptionEn)}</p>
              </div>
            </div>
            <ul className="fact-list">
              <li><span>{t('决策来源', 'Decision source')}</span><b>{modeText(report.aiAudit.mode, lang)}</b></li>
              <li>
                <span>{t('牌组来源', 'Deck source')}</span>
                <b>
                  {report.state.aiDeckMeta.source === 'llm'
                    ? t('SENTINEL 自行设计', 'Designed by SENTINEL')
                    : t('固定牌组', 'Fixed deck')}
                </b>
              </li>
              <li><span>{t('牌组检查', 'Deck check')}</span><b>{translateMessage(report.state.aiDeckMeta.note ?? '', lang) || '—'}</b></li>
              <li><span>{t('外接提议', 'External proposals')}</span><b>{report.aiAudit.proposals}</b></li>
              <li><span>{t('整份退回', 'Full fallbacks')}</span><b>{report.aiAudit.fallbacks}</b></li>
              <li><span>{t('最近请求指纹', 'Latest prompt hash')}</span><b className="mono">{report.aiAudit.lastPromptHash ?? '—'}</b></li>
              <li><span>{t('最近检查', 'Latest validation')}</span><b>{translateMessage(report.aiAudit.lastValidation, lang) || '—'}</b></li>
              <li><span>{t('最近用量（tokens）', 'Latest tokens')}</span><b>{report.state.aiMeta.filter((m) => m.source === 'llm').slice(-1)[0]?.tokens ?? '—'}</b></li>
            </ul>
            {report.state.aiDeckMeta.rawOutput && (
              <details className="raw-output">
                <summary>{t('牌组设计原始输出（截断）', 'Raw deck design output (truncated)')}</summary>
                <pre>{report.state.aiDeckMeta.rawOutput}</pre>
              </details>
            )}
            {(() => {
              const llm = report.state.aiMeta.filter((m) => m.source === 'llm').slice(-1)[0];
              return llm?.rawOutput ? (
                <details className="raw-output">
                  <summary>{t('最近一次外接原始输出（截断）', 'Latest raw external output (truncated)')}</summary>
                  <pre>{llm.rawOutput}</pre>
                </details>
              ) : null;
            })()}
            <div className="audit-notes">
              {report.aiAudit.sample.map((s, i) => (
                <span key={i} className="audit-line">{translateMessage(s, lang)}</span>
              ))}
            </div>
          </Panel>
          <div className="report-side">
            <Panel title={t('它的信息边界', 'Its information boundary')} meta={t('底线', 'limits')}>
              <ul className="fair-list">
                <li>{t('能看到公开场面、双方完整牌组设计和寄存器状态', 'Sees the public board, both deck designs and the register state')}</li>
                <li>{t('不看你当前的手牌、抽牌顺序和未执行的脚本', 'Cannot see your current hand, draw order or unexecuted scripts')}</li>
                <li>{t('和你用同一套规则、编译器、能量与预算', 'Uses the same rules, compiler, energy and budget as you')}</li>
                <li>{t('牌组由它自己设计，每张牌都要通过编译和注释校验', 'Its deck is self-designed; every card must pass compilation and comment checks')}</li>
                <li>{t('外接战术只提出顺序，引擎逐条检查', 'External tactics only propose an order; the engine checks every item')}</li>
                <li>{t('非法、超时或答非所问，就整份退回固定战术', 'Illegal, late or off-topic proposals are replaced by the fixed heuristic')}</li>
                <li>{t('牌组非法或没写成，就整组退回固定牌组', 'An illegal or missing deck falls back to the fixed deck')}</li>
                <li>{t('记下请求指纹、原始输出、检查结果和退回原因', 'Records prompt hashes, raw output, validation results and fallback reasons')}</li>
              </ul>
            </Panel>
            <Panel title={t('战后档案', 'Post-battle file')}>
              <p className="hint">
                {pick(
                  lang,
                  `${persona.description} 战前只看得到画像；具体怎么打，现在才摊开。`,
                  `${persona.descriptionEn} Before the battle you only saw its profile; now the details are laid out.`,
                )}
              </p>
            </Panel>
          </div>
        </div>
      )}

      {tab === 'replay' && (
        <div className="report-grid">
          <Panel title={t('重放校验', 'Replay verification')} meta={<span className="mono">{t('同种子 · 同脚本', 'same seed · same scripts')}</span>}>
            <p className="hint">
              {t(
                '拿同样的牌组、同样的种子和每一回合的脚本，再跑一遍，比较最后的日志指纹和生命值。外接层的不确定性留在提议层，重放用的是当场记下的出牌顺序。',
                'Rerun the same deck, the same seed and every turn script, then compare the final log hash and HP. External uncertainty stays in the proposal layer; replay uses the play order recorded on the spot.',
              )}
            </p>
            <div className="replay-actions">
              <button type="button" className="primary-btn" onClick={runReplay} disabled={replay.status === 'running'} data-testid="verify-replay">
                {replay.status === 'running' ? t('正在重跑…', 'Replaying…') : t('再跑一遍', 'Run it again')}
              </button>
              <span className="mono">{t('日志指纹 · 不依赖服务器', 'log hash · no server required')}</span>
            </div>
            {replay.status === 'done' && replay.result && (
              <div className={`replay-result ${replay.result.ok ? 'ok' : 'bad'}`} data-testid="replay-result">
                <h3>{replay.result.ok ? t('和原局一致', 'Matches the original') : t('和原局对不上', 'Does not match the original')}</h3>
                <div className="hash-grid">
                  <div><span>{t('原始', 'Original')}</span><b className="mono">{replay.result.originalHash}</b></div>
                  <div><span>{t('重放', 'Replay')}</span><b className="mono">{replay.result.replayHash}</b></div>
                </div>
                <table className="data-table small">
                  <thead><tr><th></th><th>{t('生命', 'HP')}</th><th>{t('敌方生命', 'Enemy HP')}</th><th>{t('回合', 'Turn')}</th><th>{t('结果', 'Result')}</th></tr></thead>
                  <tbody>
                    <tr><td>{t('原始', 'Original')}</td><td>{replay.result.original.playerHp}</td><td>{replay.result.original.enemyHp}</td><td>{replay.result.original.turn}</td><td>{resultText(replay.result.original.result, lang)}</td></tr>
                    <tr><td>{t('重放', 'Replay')}</td><td>{replay.result.replay.playerHp}</td><td>{replay.result.replay.enemyHp}</td><td>{replay.result.replay.turn}</td><td>{resultText(replay.result.replay.result, lang)}</td></tr>
                  </tbody>
                </table>
                {replay.result.reason && <p className="hint warn">{translateMessage(replay.result.reason, lang)}</p>}
              </div>
            )}
          </Panel>
          <div className="report-side">
            <Panel title={t('重放里有什么', 'What replay includes')}>
              <ul className="fact-list">
                <li><span>{t('随机种子', 'RNG seed')}</span><b>{report.seed}</b></li>
                <li><span>{t('每回合脚本', 'Turn scripts')}</span><b>{t(`${report.turns} 段`, `${report.turns}`)}</b></li>
                <li><span>{t('对手出牌记录', 'Opponent plays')}</span><b>{t('当场录制', 'recorded live')}</b></li>
                <li><span>{t('牌堆/寄存器', 'Piles / registers')}</span><b>{t('完整日志', 'full log')}</b></li>
              </ul>
            </Panel>
          </div>
        </div>
      )}

      <footer className="report-foot">
        <div className="report-actions">
          <button type="button" className="primary-btn" onClick={() => onAgain(true)} data-testid="again-same-seed">{t('同种子再打', 'Rematch · same seed')}</button>
          <button type="button" className="ghost-btn" onClick={() => onAgain(false)} data-testid="again-new-seed">{t('换个种子', 'Rematch · new seed')}</button>
          <button type="button" className="ghost-btn" onClick={onBoot}>{t('回到首页', 'Back to home')}</button>
        </div>
        <p className="hint">{t('没有奖励，也没有人替你写代码。战术只能自己来。', 'No rewards, and nobody writes your code for you. The tactics are yours.')}</p>
      </footer>
    </main>
  );
}

function tagText(value: string, lang: 'en' | 'zh'): string {
  const labels: Record<string, string> = { halt: '中断', energy: '能量', attribution: '归因', register: '寄存器', ai: '对手', budget: '预算', zero: '0 费', limit: '上限' };
  const labelsEn: Record<string, string> = { halt: 'Halt', energy: 'Energy', attribution: 'Attribution', register: 'Register', ai: 'Opponent', budget: 'Budget', zero: '0-cost', limit: 'Limit' };
  return pick(lang, labels[value] ?? value, labelsEn[value] ?? value);
}

function modeText(value: string, lang: 'en' | 'zh'): string {
  if (value === 'llm') return pick(lang, '外接战术', 'External tactics');
  if (value === 'recorded') return pick(lang, '录制回放', 'Recorded replay');
  if (value === 'heuristic') return pick(lang, '固定战术', 'Fixed heuristic');
  return value;
}

function resultText(value: string, lang: 'en' | 'zh'): string {
  if (value === 'victory') return pick(lang, '胜利', 'Victory');
  if (value === 'defeat') return pick(lang, '失败', 'Defeat');
  if (value === 'unfinished') return pick(lang, '未完成', 'Unfinished');
  return value;
}

function QuizCard({
  q,
  index,
  selected,
  onSelect,
}: {
  q: QuizQuestion;
  index: number;
  selected?: number;
  onSelect: (index: number) => void;
}) {
  const lang = useLang();
  const t = useT();
  const answered = selected !== undefined;
  const isCorrect = selected === q.answer;
  return (
    <article className={`quiz-card ${answered ? (isCorrect ? 'correct' : 'wrong') : ''}`} data-testid="quiz-card">
      <header>
        <span className="quiz-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="quiz-tag">{tagText(q.tag, lang)}</span>
        <h3>{translateMessage(q.prompt, lang)}</h3>
      </header>
      <div className="quiz-options">
        {q.options.map((opt, i) => (
          <button
            type="button"
            key={i}
            className={`${selected === i ? 'chosen' : ''} ${answered && i === q.answer ? 'answer' : ''}`}
            disabled={answered}
            onClick={() => onSelect(i)}
          >
            <span>{String.fromCharCode(65 + i)}</span>
            {translateMessage(opt, lang)}
          </button>
        ))}
      </div>
      {answered && (
        <div className="quiz-explain">
          <b>{isCorrect ? t('正确。', 'Correct.') : t('不正确。', 'Not quite.')}</b>
          <span>{t(`证据：${translateMessage(q.evidence, 'zh')}`, `Evidence: ${translateMessage(q.evidence, 'en')}`)}</span>
          <span>{translateMessage(q.explanation, lang)}</span>
        </div>
      )}
    </article>
  );
}
