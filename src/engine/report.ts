import { compileCard, compileScript, type RegisterDecl } from './analyze';
import { Battle, type LogEvent, type PublicBattleState } from './battle';
import type { AiOp } from './ai';

export interface AttributionRow {
  key: string;
  kind: 'script' | 'card' | 'ai' | 'engine';
  actor: 'player' | 'enemy' | 'engine';
  label: string;
  line: number;
  apiCalls: number;
  apis: Record<string, number>;
  damage: number;
  blocked: number;
  blockGained: number;
  heal: number;
  credits: number;
  pileOps: number;
}

export interface TimelineEntry {
  turn: number;
  actor: 'player' | 'enemy' | 'engine';
  kind: 'card' | 'pile' | 'register' | 'halt' | 'draw' | 'ai' | 'other';
  text: string;
  source?: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  evidence: string;
  explanation: string;
  tag: 'halt' | 'energy' | 'attribution' | 'register' | 'ai' | 'budget' | 'zero' | 'limit';
}

export interface BattleReport {
  outcome: 'victory' | 'defeat' | 'unfinished';
  state: PublicBattleState;
  seed: number;
  turns: number;
  totalDamageDealt: number;
  totalDamageTaken: number;
  biggestHit: { amount: number; source: string } | null;
  attribution: AttributionRow[];
  timeline: TimelineEntry[];
  halts: { turn: number; reason: string; label: string; line: number; message: string }[];
  questions: QuizQuestion[];
  aiAudit: {
    mode: string;
    persona: string;
    proposals: number;
    fallbacks: number;
    lastPromptHash?: string;
    lastValidation?: string;
    sample: string[];
  };
}

function keyFor(e: LogEvent): string {
  const src = e.source;
  if (!src) return 'engine';
  return `${e.actor}:${src.kind}:${src.label}:${src.line}`;
}

function rowFor(map: Map<string, AttributionRow>, e: LogEvent): AttributionRow {
  const key = keyFor(e);
  let row = map.get(key);
  if (!row) {
    const src = e.source;
    row = {
      key,
      kind: (src?.kind as AttributionRow['kind']) ?? 'engine',
      actor: e.actor === 'engine' ? (src?.kind === 'script' ? 'player' : 'engine') : e.actor,
      label: src?.label ?? '引擎固定结算',
      line: src?.line ?? 0,
      apiCalls: 0,
      apis: {},
      damage: 0,
      blocked: 0,
      blockGained: 0,
      heal: 0,
      credits: 0,
      pileOps: 0,
    };
    map.set(key, row);
  }
  return row;
}

export function buildReport(battle: Battle): BattleReport {
  const state = battle.getState();
  const log = battle.getEvents(0);
  const attribution = new Map<string, AttributionRow>();
  const timeline: TimelineEntry[] = [];
  const halts: BattleReport['halts'] = [];
  let totalDamageDealt = 0;
  let totalDamageTaken = 0;
  let biggestHit: { amount: number; source: string } | null = null;

  for (const e of log) {
    const src = e.source ? `${e.source.label}${e.source.line ? `:${e.source.line}` : ''}` : undefined;
    if (e.type === 'api') {
      const row = rowFor(attribution, e);
      row.apiCalls++;
      const api = String((e.data as { api?: string })?.api ?? '?');
      row.apis[api] = (row.apis[api] ?? 0) + 1;
      row.credits += Number((e.data as { credits?: number })?.credits ?? 0);
      if (['move_card', 'swap', 'shuffle', 'reshuffle', 'draw', 'discard', 'playcard'].includes(api)) row.pileOps++;
    } else if (e.type === 'damage') {
      const d = e.data as { side?: string; amount?: number; blocked?: number; hpDamage?: number };
      const row = rowFor(attribution, e);
      row.damage += d.hpDamage ?? 0;
      row.blocked += d.blocked ?? 0;
      if (d.side === 'enemy') totalDamageDealt += d.hpDamage ?? 0;
      if (d.side === 'player') totalDamageTaken += d.hpDamage ?? 0;
      if (e.actor === 'player' && d.side === 'enemy' && (d.hpDamage ?? 0) > (biggestHit?.amount ?? 0)) {
        biggestHit = { amount: d.hpDamage ?? 0, source: row.label + (row.line ? `:${row.line}` : '') };
      }
    } else if (e.type === 'heal') {
      const row = rowFor(attribution, e);
      row.heal += Number((e.data as { healed?: number })?.healed ?? 0);
    } else if (e.type === 'block') {
      const row = rowFor(attribution, e);
      row.blockGained += Number((e.data as { amount?: number })?.amount ?? 0);
    } else if (e.type === 'halt') {
      halts.push({
        turn: e.turn,
        reason: String((e.data as { reason?: string })?.reason ?? 'PROTOCOL_HALT'),
        label: String((e.data as { label?: string })?.label ?? '协议中断'),
        line: e.source?.line ?? 0,
        message: String((e.data as { detail?: string })?.detail ?? e.message),
      });
    }

    // Build a human timeline for deck/status/result attribution.
    if (e.type === 'card_play') {
      timeline.push({ turn: e.turn, actor: e.actor, kind: 'card', text: e.message, source: src });
    } else if (e.type === 'card_skip') {
      timeline.push({ turn: e.turn, actor: e.actor, kind: 'card', text: e.message, source: src });
    } else if (e.type === 'pile' || e.type === 'discard') {
      timeline.push({ turn: e.turn, actor: e.actor, kind: 'pile', text: e.message, source: src });
    } else if (e.type === 'register_commit' || e.type === 'register_reject') {
      timeline.push({ turn: e.turn, actor: e.actor, kind: 'register', text: e.message, source: src });
    } else if (e.type === 'halt') {
      timeline.push({ turn: e.turn, actor: e.actor, kind: 'halt', text: e.message, source: src });
    } else if (e.type === 'draw') {
      timeline.push({ turn: e.turn, actor: e.actor, kind: 'draw', text: e.message, source: src });
    } else if (e.type === 'ai_plan') {
      timeline.push({ turn: e.turn, actor: 'enemy', kind: 'ai', text: e.message, source: src });
    }
  }

  const questions = buildQuestions(battle, log, attribution, halts);
  const proposals = state.aiMeta.filter((m) => m.source === 'llm').length;
  const fallbacks = state.aiMeta.filter((m) => m.fallbackReason).length;
  const lastLlm = [...state.aiMeta].reverse().find((m) => m.source === 'llm');

  return {
    outcome: state.result ?? 'unfinished',
    state,
    seed: state.seed,
    turns: state.turn,
    totalDamageDealt,
    totalDamageTaken,
    biggestHit,
    attribution: [...attribution.values()]
      .filter((r) => r.actor === 'player' || r.kind === 'engine')
      .sort((a, b) => b.damage - a.damage || b.apiCalls - a.apiCalls),
    timeline,
    halts,
    questions,
    aiAudit: {
      mode: state.aiMode,
      persona: state.persona,
      proposals,
      fallbacks,
      lastPromptHash: lastLlm?.promptHash,
      lastValidation: lastLlm?.validation,
      sample: state.aiMeta.slice(-4).map((m) => `${m.source === 'llm' ? '外部模型' : m.source === 'recorded' ? '录制回放' : '本地策略'}${m.fallbackReason ? ` · 退回：${m.fallbackReason}` : ''}`),
    },
  };
}

function buildQuestions(
  battle: Battle,
  log: LogEvent[],
  attribution: Map<string, AttributionRow>,
  halts: BattleReport['halts'],
): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  const seen = new Set<string>();

  if (halts.length > 0) {
    const h = halts[0];
    const labels: Record<string, string> = {
      LOOP_FUSE: '循环熔断（单循环/总迭代超限）',
      COMPUTE_OVERLOAD: '算力过载（执行时间超限）',
      PROTOCOL_HALT: '协议中断（API/牌堆/寄存器超限）',
    };
    const correct = labels[h.reason] ?? '协议中断';
    const options = [labels.LOOP_FUSE, labels.COMPUTE_OVERLOAD, labels.PROTOCOL_HALT].filter((o) => o !== correct);
    options.splice(Math.min(1, options.length), 0, correct);
    questions.push({
      id: 'halt',
      prompt: `第 ${h.turn} 回合，脚本跑到第 ${h.line} 行时被拦下了。引擎记的原因是什么？`,
      options,
      answer: options.indexOf(correct),
      evidence: `${h.label}：${h.message}`,
      explanation:
        '静态分析先拒绝不可分析的结构；若运行时仍越界（时间、调用、迭代、牌堆操作），沙盒只中断当次执行，已执行动作保留，不回滚整回合。',
      tag: 'halt',
    });
  }

  const skip = [...log].reverse().find((e) => e.type === 'card_skip' && String((e.data as { energy?: number })?.energy ?? '') !== '');
  if (skip) {
    const d = skip.data as { card?: string; cost?: number; energy?: number };
    questions.push({
      id: 'energy',
      prompt: `第 ${skip.turn} 回合，你想打【${d.card ?? '最左牌'}】，没打出去。最直接的原因是什么？`,
      options: ['能量不够，付不起最左那张', '手牌空了，playcard() 没有目标', '这张牌本回合已经出过'],
      answer: 0,
      evidence: `需要 ${d.cost} 能量，当时只有 ${d.energy}。`,
      explanation:
        'playcard() 永远打手牌最左边那张。脚本能读 ctx.getEnergy()，但你得自己先算费用；费用由引擎按最坏情况估算推导，卡上写的数字不算数。',
      tag: 'energy',
    });
    seen.add('energy');
  }

  const swap = [...log].reverse().find((e) => e.type === 'pile' && typeof (e.data as { i?: unknown })?.i !== 'undefined');
  if (swap) {
    const d = swap.data as { i: number; j: number; pile?: string; order?: string[] };
    const actual = (d.order ?? []).join(' / ') || '（空）';
    const options = [actual, [...(d.order ?? [])].reverse().join(' / ') || '（空）', '未改变任何顺序'];
    questions.push({
      id: 'swap',
      prompt: `第 ${swap.turn} 回合执行 swap(${d.pile ?? 'hand'}, ${d.i}, ${d.j}) 后，该牌堆从左到右变成？`,
      options,
      answer: 0,
      evidence: swap.message,
      explanation: 'swap 只交换给定索引；它计入每回合交换次数上限，并会改变下一次 playcard() 打出的最左牌。',
      tag: 'attribution',
    });
    seen.add('swap');
  }

  const full = [...log].reverse().find((e) => e.type === 'pile' && typeof (e.data as { reason?: string })?.reason === 'string');
  if (full) {
    const d = full.data as { reason: string };
    const reason = d.reason === 'hand_full' ? '手牌已满（10 张），牌没有移动' : d.reason === 'draw_full' ? '抽牌堆已满，牌没有移动' : '总卡牌实例达到 60 上限，牌没有移动';
    const options = [reason, '牌被引擎吞掉，但扣了费用', '目标牌堆被自动扩容'];
    questions.push({
      id: 'limit',
      prompt: `第 ${full.turn} 回合，一次移动失败了。引擎怎么处理的？`,
      options,
      answer: 0,
      evidence: full.message,
      explanation: '超限行为是写死的：手牌满、抽牌堆满、总实例满时移动失败且牌不动，也不会扣费，只写一条日志。',
      tag: 'limit',
    });
    seen.add('limit');
  }

  const zeroCards = battle.playerDeck.filter((c) => c.cost === 0);
  if (zeroCards.length > 0) {
    const card = zeroCards[0];
    questions.push({
      id: 'zero',
      prompt: `本局带了 0 费卡【${card.name}】。它为什么不能靠回能变成引擎？`,
      options: ['0 费卡禁止 gain_energy，且效果上限只有 1.5', '0 费卡每回合只能出一次', '0 费卡必须先进弃牌堆才能生效'],
      answer: 0,
      evidence: `0 费卡 ${card.name} 的最坏情况估算 P=${card.P.toFixed(2)}，效果上限 1.5。`,
      explanation: '0 费卡是节奏牌：禁止回能、禁止生成卡牌，效果预算上限 1.5。出牌次数不单独限制，由能量、手牌上限和效果预算自然约束。',
      tag: 'zero',
    });
    seen.add('zero');
  }

  const damageRows = [...attribution.values()].filter((r) => r.damage > 0 && r.kind !== 'engine' && r.actor === 'player').sort((a, b) => b.damage - a.damage);
  if (damageRows.length > 0) {
    const top = damageRows[0];
    const label = `${top.label}${top.line ? ` · 第 ${top.line} 行` : ''}`;
    const options = [label, '引擎固定结算（回合开始/结束）', 'SENTINEL 的隐藏资源'];
    if (damageRows[1]) {
      const second = `${damageRows[1].label}${damageRows[1].line ? ` · 第 ${damageRows[1].line} 行` : ''}`;
      if (!options.includes(second)) options.splice(1, 0, second);
    }
    const uniq = [...new Set(options)].slice(0, 4);
    questions.push({
      id: 'attribution',
      prompt: `本局单一行代码造成的生命伤害最高为 ${top.damage} 点。它来自哪里？`,
      options: uniq,
      answer: uniq.indexOf(label),
      evidence: `该来源还记录了 ${top.apiCalls} 次 API 调用、${top.blocked} 点被格挡伤害。`,
      explanation:
        '每个 API 调用都带源码行与 IR id，报告按来源行聚合伤害、格挡、治疗与牌堆操作；不靠记忆猜测。',
      tag: 'attribution',
    });
    seen.add('attribution');
  }

  const sortEvent = [...log].reverse().find((e) => e.type === 'pile' && typeof (e.data as { order?: unknown })?.order !== 'undefined');
  if (sortEvent) {
    const kind = '重排';
    questions.push({
      id: 'order',
      prompt: `第 ${sortEvent.turn} 回合，牌堆被${kind}了。谁改的顺序，依据是什么？`,
      options: [
        `本局代码调用 swap/move_card/ reshuffle（${sortEvent.source?.label ?? '引擎'}）`,
        '引擎每回合自动整理，与玩家代码无关',
        'SENTINEL 读取了玩家脚本后改的顺序',
      ],
      answer: 0,
      evidence: sortEvent.message,
      explanation:
        '顺序只能由代码调用 swap / move_card / draw / reshuffle 改变，并且每次调用都带源码行。playcard() 只打最左牌，所以顺序就是战术本身。',
      tag: 'attribution',
    });
  }

  const commit = [...log].reverse().find((e) => e.type === 'register_commit' || e.type === 'register_reject');
  if (commit) {
    const rejected = commit.type === 'register_reject';
    const options = rejected
      ? ['值越界或类型不对，整批写入被退回', '寄存器写入会立即生效，不用提交', '寄存器被对手覆盖了']
      : ['end_turn() 时整批提交，失败就整批退回', '每次 set_global 立即写入', '打完一整局才写一次'];
    questions.push({
      id: 'register',
      prompt: `第 ${commit.turn} 回合的寄存器发生了什么？`,
      options,
      answer: 0,
      evidence: commit.message,
      explanation: '寄存器最多 3 个，只允许 int/bool/enum，写入在 end_turn() 前整批校验并原子提交；对局结束清空，不跨局。',
      tag: 'register',
    });
    seen.add('register');
  }

  questions.push({
    id: 'budget',
    prompt: '一张卡的费用是怎么算出来的？',
    options: [
      '按最坏情况展开：循环上界 × 循环体 × 修正，分支取最贵那条',
      '按代码行数粗略估',
      '先按当前能量估，超了再补扣',
    ],
    answer: 0,
    evidence: '卡牌编译诊断中同时显示 P、R、N 与推导费用 C。',
    explanation:
      '动态数值取变量声明 max 或可达最大值；三元/函数/推导式按展开后总效果计；估不出上界的写法直接拒绝。负面抵扣最多 0.7P，费用 = max(1, ceil(N/3))。',
    tag: 'budget',
  });

  const ai = battle.getState().aiMeta;
  if (ai.length > 0) {
    const anyLlm = ai.some((m) => m.source === 'llm');
    const anyFallback = ai.some((m) => m.fallbackReason);
    const options = ['外部模型提议通过检查', '外部模型被退回，用了本地策略', '全程使用本地策略'];
    const answer = anyLlm ? (anyFallback ? 1 : 0) : 2;
    questions.push({
      id: 'ai',
      prompt: 'SENTINEL 这局是怎么做决定的？',
      options,
      answer,
      evidence: `决策来源：${battle.getState().aiMode === 'llm' ? '外部模型' : battle.getState().aiMode === 'recorded' ? '录制回放' : '本地策略'}；提议 ${ai.filter((m) => m.source === 'llm').length} 次，退回 ${ai.filter((m) => m.fallbackReason).length} 次。`,
      explanation:
        '外部模型只看得到公开场面和自己的手牌，它交上来的只是一套顺序。引擎会逐条检查目标、能量、预算和牌堆；非法、超时或答非所问，就整份退回本地策略，你的代码它看不到。',
      tag: 'ai',
    });
  }

  // Stable, non-repeating subset; always keep the required code-attribution questions.
  const filtered = questions.filter((q, i) => questions.findIndex((x) => x.id === q.id) === i);
  const priority = filtered.filter((q) => ['halt', 'attribution', 'limit', 'energy', 'zero', 'budget'].includes(q.id));
  const rest = filtered.filter((q) => !priority.includes(q));
  return [...priority, ...rest].slice(0, 6);
}

export interface ReplayResult {
  ok: boolean;
  originalHash: string;
  replayHash: string;
  original: { playerHp: number; enemyHp: number; turn: number; result: string };
  replay: { playerHp: number; enemyHp: number; turn: number; result: string };
  reason?: string;
}

/** Re-executes the recorded scripts and AI plans with the same seed; compares final signature. */
export async function verifyReplay(original: Battle): Promise<ReplayResult> {
  const data = original.replayData();
  const deck = data.playerDeckSources.map((src) => compileCard(src, data.registers));
  if (deck.some((d) => !d.ok || !d.value)) {
    const sig = original.signature();
    return {
      ok: false,
      originalHash: sig.hash,
      replayHash: '-',
      original: { playerHp: sig.playerHp, enemyHp: sig.enemyHp, turn: sig.turn, result: sig.result ?? 'unfinished' },
      replay: { playerHp: 0, enemyHp: 0, turn: 0, result: 'compile-error' },
      reason: '重放时牌组无法重新编译',
    };
  }
  const replay = new Battle({
    seed: data.seed,
    playerDeck: deck.map((d) => d.value!),
    registers: data.registers as RegisterDecl[],
    aiDeck: data.aiDeck,
    aiMode: original.aiMode,
    recordedAiPlans: data.plans as AiOp[][],
    autoStart: true,
  });
  const playerTurns = original.turnRecords.filter((r) => r.actor === 'player' && r.scriptSource);
  for (const rec of playerTurns) {
    if (replay.result) break;
    const compiled = compileScript(rec.scriptSource!, data.registers as RegisterDecl[]);
    if (!compiled.ok || !compiled.value) {
      const os = original.signature();
      const rs = replay.signature();
      return {
        ok: false,
        originalHash: os.hash,
        replayHash: rs.hash,
        original: { playerHp: os.playerHp, enemyHp: os.enemyHp, turn: os.turn, result: os.result ?? 'unfinished' },
        replay: { playerHp: rs.playerHp, enemyHp: rs.enemyHp, turn: rs.turn, result: rs.result ?? 'unfinished' },
        reason: `第 ${rec.turn} 回合脚本重编译失败`,
      };
    }
    await replay.submitPlayerTurn(compiled.value);
  }
  const os = original.signature();
  const rs = replay.signature();
  const ok = os.hash === rs.hash && os.playerHp === rs.playerHp && os.enemyHp === rs.enemyHp && os.result === rs.result;
  return {
    ok,
    originalHash: os.hash,
    replayHash: rs.hash,
    original: { playerHp: os.playerHp, enemyHp: os.enemyHp, turn: os.turn, result: os.result ?? 'unfinished' },
    replay: { playerHp: rs.playerHp, enemyHp: rs.enemyHp, turn: rs.turn, result: rs.result ?? 'unfinished' },
    reason: ok ? undefined : '最终签名不一致',
  };
}
