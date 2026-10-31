import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAiDeckPrompt,
  buildAiPrompt,
  buildAiViewHistory,
  designAiDeck,
  extractJsonValue,
  heuristicPlan,
  MAX_LLM_TIMEOUT_MS,
  normalizeEndpoint,
  probeAiConnection,
  proposeAiPlan,
  validateDesignedAiDeck,
  PERSONA_PROFILE,
  PERSONA_TEXT,
  type AiLogEvent,
  type AiPersona,
  type AiView,
} from '../src/engine/ai';
import { compileCard, compileScript } from '../src/engine/analyze';
import { Battle, PERSONAS } from '../src/engine/battle';
import { API_SPECS } from '../src/engine/config';
import { DEFAULT_REGISTERS } from '../src/content/deck';

function view(persona: AiPersona): AiView {
  return {
    turn: 3,
    self: {
      hp: 20,
      maxHp: 54,
      block: 0,
      energy: 3,
      hand: [
        { slot: 0, cost: 2, type: 'attack', target: 'enemy', api: ['deal_damage'] },
        { slot: 1, cost: 1, type: 'skill', target: 'enemy', api: ['discard', 'draw'] },
        { slot: 2, cost: 1, type: 'skill', target: 'self', api: ['gain_block'] },
      ],
      drawCount: 1,
      discardCount: 2,
    },
    opponent: { hp: 10, maxHp: 72, block: 0, handCount: 4, drawCount: 2, discardCount: 1 },
    persona,
    legalOps: ['play', 'discard', 'end'],
  };
}

describe('opponent contract', () => {
  it('allows late-game plan requests up to two minutes', () => {
    expect(MAX_LLM_TIMEOUT_MS).toBe(120_000);
  });

  it('ships exactly the five fixed personas', () => {
    expect(PERSONAS).toHaveLength(5);
    for (const p of PERSONAS) {
      expect(PERSONA_PROFILE[p].name).toContain('SENTINEL-07');
      expect(PERSONA_TEXT[p].length).toBeGreaterThan(4);
    }
  });

  it('produces a feasible plan for every persona', () => {
    for (const persona of PERSONAS) {
      const plan = heuristicPlan(view(persona));
      expect(plan[plan.length - 1].op).toBe('end');
      expect(plan.length).toBeLessThanOrEqual(8);
      expect(plan.every((o) => ['play', 'discard', 'end'].includes(o.op))).toBe(true);
    }
  });

  it('sends its own deck, the public player deck, registers, piles and the API guide to the model', () => {
    const v = view('aggressor');
    v.self.energyMax = 5;
    v.self.handLimit = 10;
    v.self.drawLimit = 10;
    v.self.drawPile = [{ slot: 0, name: '后手补给', cost: 1 }];
    v.self.discardPile = [{ slot: 0, name: '旧盾', cost: 1 }];
    v.self.hand[0] = { ...v.self.hand[0], name: '处决斩' };
    v.self.deck = [
      {
        slot: 0,
        name: '处决斩',
        cost: 2,
        type: 'attack',
        target: 'enemy',
        description: '造成 12 点伤害',
        api: ['deal_damage'],
        source: 'class 处决斩(Card):\n    def effect(self, ctx):\n        ctx.deal_damage("enemy", 12)',
      },
      {
        slot: 1,
        name: '后手补给',
        cost: 1,
        type: 'skill',
        target: 'self',
        description: '获得 2 能量',
        api: ['gain_energy'],
        source: 'class PileSource(Card):\n    def effect(self, ctx):\n        ctx.gain_energy(2)',
      },
      {
        slot: 2,
        name: '旧盾',
        cost: 1,
        type: 'skill',
        target: 'self',
        description: '获得 6 格挡',
        api: ['gain_block'],
        source: 'class OldShield(Card):\n    def effect(self, ctx):\n        ctx.gain_block(6)',
      },
    ];
    v.opponent.deck = [
      {
        slot: 0,
        name: '玩家自定义牌',
        cost: 2,
        type: 'skill',
        target: 'self',
        description: '玩家设计的隐藏组合',
        api: ['gain_block', 'get_global'],
        source: 'class PlayerSeal(Card):\n    def effect(self, ctx):\n        ctx.gain_block(6)\n        ctx.get_global("combo")',
      },
    ];
    v.registers = [{ name: 'combo', type: 'int', value: 7, min: 0, max: 20, owner: 'player' }];
    v.history = {
      maxTurns: 30,
      recentEvents: [{ turn: 2, actor: 'player', type: 'card_play', text: '你 打出最左牌【侦察】' }],
      previousPlans: [[{ op: 'play' }, { op: 'end' }]],
    };
    const prompt = buildAiPrompt(v);
    expect(prompt).toContain('处决斩');
    expect(prompt).toContain('造成 12 点伤害');
    expect(prompt).toContain('ctx.deal_damage');
    expect(prompt).toContain('后手补给');
    expect(prompt).toContain('旧盾');
    expect(prompt).toContain('玩家自定义牌');
    expect(prompt).toContain('玩家设计的隐藏组合');
    expect(prompt).toContain('class PlayerSeal(Card)');
    expect(prompt).toContain('"drawPile"');
    expect(prompt).toContain('"discardPile"');
    expect(prompt).toContain('"energyMax":5');
    expect(prompt).toContain('【资源账本】');
    expect(prompt).toContain('【牌组公开】');
    expect(prompt).toContain('【寄存器】');
    expect(prompt).toContain('"value":7');
    expect(prompt).toContain('【算法辅助】');
    expect(prompt).toContain('唯一最高目标');
    expect(prompt).toContain('公开场面');
    expect(prompt).toContain('recentEvents');
    expect(prompt).toContain('previousPlans');
    expect(prompt).toContain('opponent_public');
    for (const api of API_SPECS.filter((spec) => spec.scope !== 'script')) {
      expect(prompt).toContain(`ctx.${api.name}(`);
    }
    expect(prompt).not.toContain('ctx.playcard(');
    expect(prompt).not.toContain('ctx.set_global(');

    const stateText = prompt.slice(prompt.indexOf('JSON_STATE:') + 'JSON_STATE:'.length).trim();
    const state = JSON.parse(stateText) as {
      self: { hand: Record<string, unknown>[]; deck: { name: string }[] };
      opponent_public: { deck: { name: string }[] };
      registers: { name: string; value: number }[];
    };
    // Battle-time instances expose only the name and energy cost.
    expect(Object.keys(state.self.hand[0]).sort()).toEqual(['cost', 'name', 'slot']);
    expect(state.self.deck[0].name).toBe('处决斩');
    expect(state.opponent_public.deck[0].name).toBe('玩家自定义牌');
    expect(state.registers[0]).toMatchObject({ name: 'combo', value: 7 });
  });

  it('keeps hidden player piles, registers, code and logs out of the history', () => {
    const events: AiLogEvent[] = [
      { turn: 1, actor: 'player', type: 'pile', message: '你 移动 隐藏牌：hand[0] → draw[0]' },
      { turn: 2, actor: 'player', type: 'card_play', message: '你 打出最左牌【侦察】' },
      { turn: 2, actor: 'player', type: 'script_submit', message: '执行指令块 · 12 行 · 预算 7.5' },
      { turn: 2, actor: 'player', type: 'register_commit', message: '寄存器 追踪 ← 3' },
      { turn: 3, actor: 'player', type: 'damage', message: '你 对 SENTINEL 造成 9 伤害（格挡吸收 0）' },
      { turn: 3, actor: 'player', type: 'card_skip', message: '能量不足：隐藏牌 需要 3，当前 1' },
      { turn: 3, actor: 'player', type: 'player_log', message: '隐藏调试输出' },
      { turn: 3, actor: 'enemy', type: 'pile', message: 'SENTINEL 弃置 挡路牌' },
    ];
    const history = buildAiViewHistory(events, 3, 30, [[{ op: 'play' }, { op: 'end' }]]);
    const texts = history.recentEvents.map((event) => event.text);
    expect(texts).toContain('你 打出最左牌【侦察】');
    expect(texts).toContain('你 对 SENTINEL 造成 9 伤害（格挡吸收 0）');
    expect(texts).toContain('SENTINEL 弃置 挡路牌');
    expect(texts).not.toContain('你 移动 隐藏牌：hand[0] → draw[0]');
    expect(texts).not.toContain('能量不足：隐藏牌 需要 3，当前 1');
    expect(texts).not.toContain('执行指令块 · 12 行 · 预算 7.5');
    expect(texts).not.toContain('寄存器 追踪 ← 3');
    expect(texts).not.toContain('隐藏调试输出');
    expect(history.previousPlans).toEqual([[{ op: 'play' }, { op: 'end' }]]);
  });

  it('cannot afford a card whose cost exceeds its energy', () => {
    const v = view('combo');
    v.self.energy = 1;
    v.self.hand = [{ slot: 0, cost: 3, type: 'attack', target: 'enemy', api: ['deal_damage'] }];
    const plan = heuristicPlan(v);
    expect(plan.some((o) => o.op === 'play')).toBe(false);
    expect(plan[plan.length - 1].op).toBe('end');
  });
});

describe('endpoint normalization', () => {
  it('appends the chat route to bare hosts and base URLs', () => {
    expect(normalizeEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(normalizeEndpoint(' https://api.deepseek.com/ ')).toBe('https://api.deepseek.com/chat/completions');
    expect(normalizeEndpoint('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('adds a scheme to scheme-less input so it never resolves to the site itself', () => {
    expect(normalizeEndpoint('api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(normalizeEndpoint('api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(normalizeEndpoint('localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions');
    expect(normalizeEndpoint('/llm-proxy')).toBe('/llm-proxy/chat/completions');
  });

  it('keeps complete routes, query strings and blank input intact', () => {
    expect(normalizeEndpoint('https://api.deepseek.com/chat/completions')).toBe('https://api.deepseek.com/chat/completions');
    expect(normalizeEndpoint('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(normalizeEndpoint('https://proxy.local/api/completions?team=blue')).toBe('https://proxy.local/api/completions?team=blue');
    expect(normalizeEndpoint('')).toBe('');
    expect(normalizeEndpoint(undefined)).toBe('');
  });
});

describe('connection handshake', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the completed chat route instead of the bare host', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return new Response('{"error":{"message":"Not Found"}}', { status: 404 });
    }));
    const result = await probeAiConnection({ endpoint: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test' });
    expect(calls).toEqual(['https://api.deepseek.com/chat/completions']);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.reason).toBe('not_found');
    expect(result.url).toBe('https://api.deepseek.com/chat/completions');
    expect(result.detail).toContain('Not Found');
  });

  it('accepts a responding endpoint and flags an empty address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"choices":[]}', { status: 200 })));
    const ok = await probeAiConnection({ endpoint: 'https://example.test/v1/chat/completions', model: 'deepseek-chat' });
    expect(ok.ok).toBe(true);
    const empty = await probeAiConnection({ endpoint: '   ' });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toBe('empty');
  });
});

function planResponse(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 12 } }), { status: 200 });
}

describe('plan parsing tolerance', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads JSON out of fenced blocks, prose and aliased operations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => planResponse({
      content: '这是本回合的计划：\n```json\n{"ops":[{"op":"attack"},{"action":"结束"}]}\n```',
    })));
    const { plan, meta } = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(plan.source).toBe('llm');
    expect(plan.ops.map((o) => o.op)).toEqual(['play', 'end']);
    expect(meta.validation).toBe('格式通过');
    expect(meta.tokens).toBe(12);
  });

  it('falls back to reasoning_content when the content field is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => planResponse({
      content: '',
      reasoning_content: '{"plan":{"ops":[{"op":"play"},{"op":"end"}]}}',
    })));
    const { plan } = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://example.test/v1', model: 'deepseek-reasoner' }, 'aggressor');
    expect(plan.source).toBe('llm');
    expect(plan.ops.map((o) => o.op)).toEqual(['play', 'end']);
  });

  it('omits the token cap for DeepSeek Flash and asks for the shortest JSON', async () => {
    let body: { max_tokens?: number; reasoning_effort?: string; messages?: { role: string; content: string }[] } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return planResponse({ content: '{"ops":[{"op":"play"},{"op":"end"}]}' });
    }));
    const { plan, meta } = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'aggressor');
    expect(body?.max_tokens).toBeUndefined();
    expect(body?.reasoning_effort).toBe('low');
    expect(body?.messages?.[1].content).toContain('尽可能短');
    expect(plan.source).toBe('llm');
    expect(meta.validation).toBe('格式通过');
  });

  it('accepts a valid plan on the single format retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(planResponse({ content: '我会先观察一下。' }))
      .mockResolvedValueOnce(planResponse({ content: '{"ops":[{"op":"discard"},{"op":"end"}]}' }));
    vi.stubGlobal('fetch', fetchMock);
    const { plan, meta } = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(retryBody.messages[1].content).toContain('格式重试');
    expect(plan.source).toBe('llm');
    expect(plan.ops.map((op) => op.op)).toEqual(['discard', 'end']);
    expect(meta.validation).toBe('格式通过（第 2 次尝试）');
    expect(meta.tokens).toBe(24);
  });

  it('retries at most once before falling back to the local tactic', async () => {
    const fetchMock = vi.fn(async () => planResponse({ content: '我会先观察一下。' }));
    vi.stubGlobal('fetch', fetchMock);
    const { plan, meta } = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(plan.source).toBe('heuristic');
    expect(meta.validation).toBe('失败：格式（已重试 1 次）');
    expect(meta.fallbackReason).toContain('不是合法的动作计划');
    expect(meta.fallbackReason).toContain('已重试 1 次');
    expect(plan.ops[plan.ops.length - 1].op).toBe('end');
  });

  it('extracts balanced JSON even when strings contain braces', () => {
    const parsed = extractJsonValue('前缀 {"ops":[{"op":"play"}],"note":"a { b"} 后缀') as { ops: unknown[]; note: string };
    expect(parsed.ops).toHaveLength(1);
    expect(parsed.note).toBe('a { b');
  });

  it('skips a non-plan object and repairs single quotes, trailing commas and raw newlines', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => planResponse({
      content: '{"note":"先想一想"}\n{\'ops\':[{\'op\':\'play\'},{\'op\':\'end\'}],}',
    })));
    const nearJson = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(nearJson.plan.source).toBe('llm');
    expect(nearJson.plan.ops.map((o) => o.op)).toEqual(['play', 'end']);
    expect(nearJson.meta.validation).toBe('格式通过');

    vi.stubGlobal('fetch', vi.fn(async () => planResponse({
      content: '{"ops":[{"op":"play"},{"op":"end"}],"note":"第一行\n第二行"}',
    })));
    const rawNewline = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(rawNewline.plan.source).toBe('llm');
    expect(rawNewline.plan.ops.map((o) => o.op)).toEqual(['play', 'end']);

    vi.stubGlobal('fetch', vi.fn(async () => planResponse({
      content: JSON.stringify({ response: JSON.stringify({ ops: [{ op: 'discard' }, { op: 'end' }] }) }),
    })));
    const wrapped = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(wrapped.plan.source).toBe('llm');
    expect(wrapped.plan.ops.map((o) => o.op)).toEqual(['discard', 'end']);
  });

  it('accepts Chinese connective prose and plans longer than the old 8-op limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => planResponse({ content: '先出牌，再弃牌，最后结束' })));
    const prose = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(prose.plan.source).toBe('llm');
    expect(prose.plan.ops.map((o) => o.op)).toEqual(['play', 'discard', 'end']);

    const longOps = [
      ...Array.from({ length: 9 }, () => ({ op: 'play' })),
      { op: 'end' },
      { op: 'discard' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => planResponse({ content: JSON.stringify({ ops: longOps }) })));
    const longPlan = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(longPlan.plan.source).toBe('llm');
    expect(longPlan.plan.ops).toHaveLength(10);
    expect(longPlan.plan.ops[9].op).toBe('end');
  });

  it('uses reasoning_content when content holds a valid but non-plan JSON object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => planResponse({
      content: '{"note":"not a plan"}',
      reasoning_content: '{"ops":[{"op":"discard"},{"op":"end"}]}',
    })));
    const { plan } = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-reasoner' }, 'aggressor');
    expect(plan.source).toBe('llm');
    expect(plan.ops.map((o) => o.op)).toEqual(['discard', 'end']);
  });
});

describe('plan execution', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives the model both deck designs and live register values once the battle starts', async () => {
    const playerCard = compileCard(`class PlayerSecret(Card):
    name = "玩家秘密牌"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(6)  // 玩家自定义的 6 点格挡
`, []).value!;
    const aiCard = compileCard(`class AiProbe(Card):
    name = "AI 探针"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6)  // 6 点伤害
`, []).value!;
    let userContent = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      userContent = body.messages[1].content;
      return planResponse({ content: '{"ops":[{"op":"play"},{"op":"end"}]}' });
    }));
    const battle = new Battle({
      seed: 7,
      playerDeck: [playerCard],
      registers: DEFAULT_REGISTERS,
      aiDeck: [aiCard, aiCard],
      aiMode: 'llm',
      aiConfig: { endpoint: 'https://example.test/v1', model: 'test-model' },
    });
    const script = compileScript('ctx.set_global("combo", 5)', DEFAULT_REGISTERS);
    expect(script.ok).toBe(true);
    await battle.executePlayerScript(script.value!);
    await battle.endPlayerTurn();
    expect(userContent).toContain('玩家秘密牌');
    expect(userContent).toContain('玩家自定义的 6 点格挡');
    expect(userContent).toContain('class PlayerSecret(Card)');
    expect(userContent).toContain('AI 探针');
    expect(userContent).toContain('"name":"combo"');
    expect(userContent).toContain('"value":5');
  });

  it('lets a plan spend energy generated by an earlier card instead of falling back', async () => {
    const capacitor = compileCard(`class Capacitor(Card):
    name = "Capacitor"
    cost = 2
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_energy(1)  // Gain 1 Energy
`, []).value!;
    const hammer = compileCard(`class Hammer(Card):
    name = "Hammer"
    cost = 4
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 15)  // Deal 15 damage
`, []).value!;
    expect(hammer.cost).toBe(4);

    const battle = new Battle({
      seed: 91,
      playerDeck: [hammer],
      registers: [],
      aiDeck: [capacitor, hammer],
      aiMode: 'llm',
      aiConfig: { endpoint: 'https://example.test/v1', model: 'test-model' },
    });
    const all = [...battle.enemy.piles.draw, ...battle.enemy.piles.hand, ...battle.enemy.piles.discard];
    battle.enemy.piles.draw = [
      all.find((card) => card.name === 'Capacitor')!,
      all.find((card) => card.name === 'Hammer')!,
    ];
    vi.stubGlobal('fetch', vi.fn(async () => planResponse({
      content: '{"ops":[{"op":"play"},{"op":"play"},{"op":"end"}]}',
    })));

    await battle.endPlayerTurn();
    const meta = battle.aiMeta[battle.aiMeta.length - 1];
    expect(meta.validation).toBe('格式通过');
    expect(meta.fallbackReason).toBeUndefined();
    const opponentTurn = battle.turnRecords.find((record) => record.actor === 'enemy');
    expect(opponentTurn?.cardsPlayed).toEqual(['Capacitor', 'Hammer']);
  });
});

describe('SENTINEL deck design', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function compiledDeck() {
    const sources = (await import('../src/content/deck')).STARTER_CARDS.slice(0, 6).map((s) => s.source);
    return sources.map((s) => compileCard(s, []).value!);
  }

  function attackCard(i: number): string {
    return `class Jab${i}(Card):
    name = "刺拳${i}"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6)  // 造成 6 点伤害
`;
  }

  function guardCard(i: number): string {
    return `class Guard${i}(Card):
    name = "守势${i}"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(8)  // 获得 8 点格挡
`;
  }

  function deckResponse(sources: unknown[]): Response {
    const cards = sources.map((source) => (typeof source === 'string' ? { source } : source));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ cards }) } }],
      usage: { total_tokens: 40 },
    }), { status: 200 });
  }

  it('asks for short self-designed cards and lists APIs, registers and resource limits', () => {
    const prompt = buildAiDeckPrompt('controller', 'zh', DEFAULT_REGISTERS);
    expect(prompt).toContain('尽可能短');
    expect(prompt).toContain('//');
    expect(prompt).toContain('至少设计 2 张 "attack" 牌');
    expect(prompt).toContain('不超过 12');
    expect(prompt).toContain('资源账本');
    expect(prompt).toContain('if/elif/else');
    expect(prompt).toContain('for/while');
    expect(prompt).toContain('静态最坏值');
    expect(prompt).toContain('最高目标是取胜');
    expect(prompt).toContain('复杂度上限 80');
    expect(prompt).toContain('combo: int');
    expect(prompt).toContain('范围 [0, 20]');
    expect(prompt).toContain('get_global("name")');
    for (const api of API_SPECS.filter((spec) => spec.scope !== 'script')) {
      expect(prompt).toContain(`ctx.${api.name}(`);
    }
    expect(prompt).not.toContain('ctx.playcard(');
    expect(prompt).not.toContain('ctx.set_global(');
  });

  it('accepts a valid deck and rejects short, non-attacking or uncommented decks', async () => {
    const cards = await compiledDeck();
    expect(validateDesignedAiDeck(cards).ok).toBe(true);
    expect(validateDesignedAiDeck(cards.slice(0, 4)).ok).toBe(false);
    expect(validateDesignedAiDeck(cards.slice(0, 4)).reasons.join()).toContain('需要 5-10 张牌');

    const skillOnly = await Promise.all(Array.from({ length: 6 }, () => compileCard(
      `class Wall(Card):
    name = "Wall"
    cost = 1
    type = "skill"
    target = "self"

    def effect(self, ctx):
        ctx.gain_block(2)  // gain 2 block
`,
      [],
    ).value!));
    expect(validateDesignedAiDeck(skillOnly).reasons.join()).toContain('至少需要 2 张 attack');

    const noComment = await Promise.all(Array.from({ length: 6 }, () => compileCard(
      `class Jab(Card):
    name = "Jab"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 7)
`,
      [],
    ).value!));
    expect(validateDesignedAiDeck(noComment).reasons.join()).toContain('缺少 // 注释');
  });

  it('rejects a deck whose total cost exceeds the cap', async () => {
    const expensive = await Promise.all(Array.from({ length: 6 }, (_, i) => compileCard(
      `class Heavy${i}(Card):
    name = "Heavy ${i}"
    cost = 3
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 15)  // heavy hit
`,
      [],
    ).value!));
    const check = validateDesignedAiDeck(expensive);
    expect(check.ok).toBe(false);
    expect(check.reasons.join()).toContain('总费用');
  });

  it('compiles model cards through the player compiler and keeps their comments', async () => {
    const sources = (await import('../src/content/deck')).STARTER_CARDS.slice(0, 6).map((s) => s.source);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ cards: sources.map((source) => ({ source })) }) } }],
      usage: { total_tokens: 40 },
    }), { status: 200 })));
    const design = await designAiDeck({ endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor', 'zh');
    expect(design.ok).toBe(true);
    expect(design.cards).toHaveLength(6);
    expect(design.cards.every((c) => c.description.trim().length > 0)).toBe(true);
    expect(design.meta.source).toBe('llm');
    expect(design.meta.tokens).toBe(40);
    expect(design.meta.note).toContain('自行设计 6 张牌');
  });

  it('compiles self-designed cards against the player-declared registers', async () => {
    const registerReader = `class ComboScout(Card):
    name = "寄存器侦察"
    cost = 2
    type = "skill"
    target = "self"

    def effect(self, ctx):
        x = ctx.get_global("combo")
        ctx.log(str(x))
        ctx.gain_block(2)  // 读取 combo 当前值并获得 2 格挡
`;
    const sources = [attackCard(1), attackCard(2), guardCard(3), guardCard(4), guardCard(5), registerReader];
    vi.stubGlobal('fetch', vi.fn(async () => deckResponse(sources)));
    const design = await designAiDeck(
      { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' },
      'controller',
      'zh',
      DEFAULT_REGISTERS,
    );
    expect(design.ok).toBe(true);
    expect(design.cards.some((card) => card.name === '寄存器侦察')).toBe(true);
    expect(design.cards.find((card) => card.name === '寄存器侦察')?.apiUses.some((use) => use.name === 'get_global')).toBe(true);
  });

  it('falls back with a recorded note when the designed deck fails validation', async () => {
    const sources = (await import('../src/content/deck')).STARTER_CARDS.slice(0, 4).map((s) => s.source);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ cards: sources.map((source) => ({ source })) }) } }],
    }), { status: 200 })));
    const design = await designAiDeck({ endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor', 'zh');
    expect(design.ok).toBe(false);
    expect(design.cards).toHaveLength(0);
    expect(design.meta.note).toContain('未通过校验');
  });

  it('converts hash comments, drops extra fields and raises cost instead of rejecting over-cap cards', async () => {
    const sources = [
      `class Heavy(Card):
    """Old docstring the engine cannot parse."""
    name = "重击"
    cost = 1
    type = "attack"
    target = "enemy"
    description = "重击说明"
    rarity = "rare"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 8)  # 造成 8 点伤害
`,
      `class Battery(Card):
    name = "电池"
    cost = 0
    type = "skill"
    target = "none"

    def effect(self, ctx):
        ctx.gain_energy(1)  # 获得 1 点能量
`,
      attackCard(2),
      attackCard(3),
      guardCard(4),
      guardCard(5),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => deckResponse(sources)));
    const design = await designAiDeck({ endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'controller', 'zh');
    expect(design.ok).toBe(true);
    expect(design.cards).toHaveLength(6);
    const heavy = design.cards.find((card) => card.name === '重击');
    const battery = design.cards.find((card) => card.name === '电池');
    expect(heavy?.cost).toBe(2);
    expect(heavy?.description).toContain('8');
    expect(battery?.cost).toBeGreaterThan(0);
    expect(design.meta.note).toContain('费用 1→2');
    expect(design.cards.every((card) => card.description.trim().length > 0)).toBe(true);
  });

  it('drops illegal cards but keeps the rest of the designed deck', async () => {
    const broken = `class Broken(Card):
    name = "坏牌"
    cost = 1
    type = "attack"
    target = "enemy"

    def effect(self, ctx):
        ctx.deal_damage("enemy", 6  // 缺少右括号
`;
    const sources = [broken, attackCard(1), attackCard(2), guardCard(3), guardCard(4), guardCard(5), guardCard(6)];
    vi.stubGlobal('fetch', vi.fn(async () => deckResponse(sources)));
    const design = await designAiDeck({ endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor', 'zh');
    expect(design.ok).toBe(true);
    expect(design.cards).toHaveLength(6);
    expect(design.cards.some((card) => card.name === '坏牌')).toBe(false);
    expect(design.meta.note).toContain('剔除 1 张非法牌');
  });

  it('accepts structured card objects as well as raw source strings', async () => {
    const cards = Array.from({ length: 6 }, (_, i) => ({
      name: `卡${i}`,
      cost: 1,
      type: i < 2 ? 'attack' : 'skill',
      target: i < 2 ? 'enemy' : 'self',
      effect: [i < 2 ? 'ctx.deal_damage("enemy", 6)' : 'ctx.gain_block(8)'],
      comment: i < 2 ? '造成 6 点伤害' : '获得 8 点格挡',
    }));
    vi.stubGlobal('fetch', vi.fn(async () => deckResponse(cards)));
    const design = await designAiDeck({ endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'controller', 'zh');
    expect(design.ok).toBe(true);
    expect(design.cards).toHaveLength(6);
    expect(design.cards.every((card) => card.description.trim().length > 0)).toBe(true);
  });

  it('retries once with the validation note when the first design fails', async () => {
    const shortSources = [attackCard(1), attackCard(2), guardCard(3), guardCard(4)];
    const fullSources = [...shortSources, guardCard(5), guardCard(6)];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deckResponse(shortSources))
      .mockResolvedValueOnce(deckResponse(fullSources));
    vi.stubGlobal('fetch', fetchMock);
    const design = await designAiDeck({ endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'controller', 'zh');
    expect(design.ok).toBe(true);
    expect(design.cards).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(design.meta.note).toBe('SENTINEL 自行设计 6 张牌（第 2 次修正后通过）');
  });
});
