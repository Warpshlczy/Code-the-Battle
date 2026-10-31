import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAiPrompt, heuristicPlan, normalizeEndpoint, probeAiConnection, PERSONA_PROFILE, PERSONA_TEXT, type AiView, type AiPersona } from '../src/engine/ai';
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
