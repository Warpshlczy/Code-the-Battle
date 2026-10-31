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
});

describe('SENTINEL deck design', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function compiledDeck() {
    const sources = (await import('../src/content/deck')).STARTER_CARDS.slice(0, 6).map((s) => s.source);
    return sources.map((s) => compileCard(s, []).value!);
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
});
