import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAiDeckPrompt,
  buildAiPrompt,
  designAiDeck,
  extractJsonValue,
  heuristicPlan,
  normalizeEndpoint,
  probeAiConnection,
  proposeAiPlan,
  validateDesignedAiDeck,
  PERSONA_PROFILE,
  PERSONA_TEXT,
  type AiPersona,
  type AiView,
} from '../src/engine/ai';
import { compileCard } from '../src/engine/analyze';
import { PERSONAS } from '../src/engine/battle';

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

  it('never receives card names, descriptions, player code or hidden state', () => {
    const prompt = buildAiPrompt(view('aggressor'));
    expect(prompt).not.toContain('处决斩');
    expect(prompt).not.toContain('ctx.');
    expect(prompt).not.toContain('script');
    expect(prompt).toContain('卡牌名称与描述不会提供给你');
    expect(prompt).toContain('opponent_public');
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

  it('reserves a reasoning budget for DeepSeek Flash instead of starving the answer', async () => {
    let body: { max_tokens?: number; reasoning_effort?: string } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return planResponse({ content: '{"ops":[{"op":"play"},{"op":"end"}]}' });
    }));
    const { plan, meta } = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'aggressor');
    expect(body?.max_tokens).toBe(2000);
    expect(body?.reasoning_effort).toBe('low');
    expect(plan.source).toBe('llm');
    expect(meta.validation).toBe('格式通过');
  });

  it('falls back to the local tactic when the text holds no plan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => planResponse({ content: '我会先观察一下。' })));
    const { plan, meta } = await proposeAiPlan(view('aggressor'), 'llm', { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'aggressor');
    expect(plan.source).toBe('heuristic');
    expect(meta.fallbackReason).toContain('不是合法的动作计划');
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

  it('asks for self-designed cards with comments and legal APIs', () => {
    const prompt = buildAiDeckPrompt('controller', 'zh');
    expect(prompt).toContain('//');
    expect(prompt).toContain('至少设计 2 张 "attack" 牌');
    expect(prompt).toContain('ctx.deal_damage');
    expect(prompt).toContain('不超过 12');
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
