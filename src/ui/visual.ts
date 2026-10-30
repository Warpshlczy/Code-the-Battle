import type { LogEvent, PublicBattleState, PublicCard } from '../engine/battle';

export type CueKind =
  | 'cast' | 'hit' | 'block' | 'heal' | 'energy' | 'draw' | 'discard' | 'shuffle' | 'arrange'
  | 'halt' | 'ai' | 'register' | 'end' | 'skip' | 'expire' | 'phase';

export interface VisualCue {
  id: number;
  kind: CueKind;
  side?: 'player' | 'enemy';
  target?: 'player' | 'enemy';
  amount?: number;
  blocked?: number;
  card?: PublicCard;
  cards?: PublicCard[];
  label: string;
  message?: string;
  phaseSide?: 'player' | 'enemy' | 'over';
  turn?: number;
  energy?: number;
  credits?: number;
  /** Signed change for energy cues. */
  delta?: number;
}

type Side = 'player' | 'enemy';

function cloneState(state: PublicBattleState): PublicBattleState {
  return {
    ...state,
    player: {
      ...state.player,
      hand: [...state.player.hand],
      draw: [...state.player.draw],
      discard: [...state.player.discard],
      handCount: state.player.hand.length,
      drawCount: state.player.draw.length,
      discardCount: state.player.discard.length,
    },
    enemy: { ...state.enemy },
    playerDeck: [...state.playerDeck],
    aiDeck: [...state.aiDeck],
    enemyDiscard: [...state.enemyDiscard],
    registers: state.registers.map((r) => ({ ...r })),
    turnRecords: [...state.turnRecords],
    aiMeta: [...state.aiMeta],
  };
}

function uid(prefix: string, n: number): string {
  return `${prefix}-${n}-${Date.now().toString(36)}`;
}

function removeCardByName(list: PublicCard[], name: string): PublicCard | null {
  const index = list.findIndex((c) => c.name === name);
  if (index < 0) return null;
  return list.splice(index, 1)[0] ?? null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export class VisualSession {
  view: PublicBattleState;
  private readonly final: PublicBattleState;
  private readonly pool: PublicCard[];
  private pending: { card: PublicCard; side: Side } | null = null;
  private seq = 0;

  constructor(view: PublicBattleState, final: PublicBattleState) {
    this.view = cloneState(view);
    this.final = final;
    this.pool = [
      ...view.player.hand,
      ...view.player.draw,
      ...view.player.discard,
      ...final.player.hand,
      ...final.player.draw,
      ...final.player.discard,
    ];
  }

  private setPlayerCounts(): void {
    this.view.player.handCount = this.view.player.hand.length;
    this.view.player.drawCount = this.view.player.draw.length;
    this.view.player.discardCount = this.view.player.discard.length;
  }

  private cardFor(data: Record<string, unknown>, nameFallback?: string): PublicCard {
    const name = str(data.card, nameFallback ?? '未知卡');
    const wantedUid = str(data.uid);
    const existing = (wantedUid ? this.pool.find((c) => c.uid === wantedUid) : undefined) ?? this.pool.find((c) => c.name === name);
    if (existing) return { ...existing, uid: uid('fx', ++this.seq) };
    return {
      uid: uid('fx', ++this.seq),
      name,
      description: str(data.description, ''),
      cost: num(data.cost, 1),
      type: str(data.type, 'skill'),
      target: str(data.target, 'none'),
      playable: true,
    };
  }

  private addEnemyDiscard(cards: PublicCard[], fallbackCount = 0): void {
    for (const card of cards) {
      if (!this.view.enemyDiscard.some((c) => c.uid === card.uid)) this.view.enemyDiscard.push(card);
    }
    const unknown = Math.max(0, fallbackCount - cards.length);
    for (let i = 0; i < unknown; i++) {
      this.view.enemyDiscard.push({
        uid: uid('enemy-discard', ++this.seq),
        name: '未知卡',
        description: '对手弃置时未公开牌面',
        cost: 0,
        type: 'skill',
        target: 'none',
        playable: false,
      });
    }
    this.view.enemy.discardCount = this.view.enemyDiscard.length;
  }

  private pushPendingToDiscard(): void {
    if (!this.pending) return;
    if (this.pending.side === 'player') {
      const card = this.pending.card;
      if (!this.view.player.discard.some((c) => c.uid === card.uid)) {
        this.view.player.discard.push(card);
        this.setPlayerCounts();
      }
    } else {
      this.addEnemyDiscard([this.pending.card], 1);
    }
    this.pending = null;
  }

  private takeFromPile(side: Side, pile: string, cardName: string, index: number): PublicCard | null {
    if (side !== 'player') return null;
    const list = pile === 'draw' ? this.view.player.draw : pile === 'hand' ? this.view.player.hand : this.view.player.discard;
    let card: PublicCard | null = null;
    if (index >= 0 && index < list.length) card = list.splice(index, 1)[0] ?? null;
    if (!card) card = removeCardByName(list, cardName);
    this.setPlayerCounts();
    return card;
  }

  /**
   * Applies one battle event to the visual copy and returns a presentation cue.
   * The real battle has already resolved; this method never affects rules or logs.
   */
  apply(event: LogEvent): VisualCue | null {
    this.view.turn = event.turn;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const actor = event.actor;
    const side = (data.side as Side | undefined) ?? (actor === 'enemy' ? 'enemy' : 'player');
    const cue = (kind: CueKind, label: string, extra: Partial<VisualCue> = {}): VisualCue => ({
      id: ++this.seq,
      kind,
      label,
      message: event.message,
      ...extra,
    });

    switch (event.type) {
      case 'turn_start': {
        if (typeof data.energy === 'number') {
          if (side === 'player') this.view.player.energy = data.energy;
          else this.view.enemy.energy = data.energy;
        }
        this.view.phase = side === 'player' ? 'player' : 'enemy';
        if (side === 'player') {
          this.view.player.block = 0;
          this.view.player.creditsUsed = 0;
        } else {
          this.view.enemy.block = 0;
        }
        if (typeof data.energy === 'number' && typeof data.side === 'string') {
          return cue('phase', event.message, {
            phaseSide: side,
            turn: event.turn,
            energy: data.energy,
            credits: this.view.player.creditsUsed,
            side,
          });
        }
        return null;
      }
      case 'block_expire': {
        const target = side;
        const unit = target === 'player' ? this.view.player : this.view.enemy;
        const amount = num(data.block, unit.block);
        unit.block = 0;
        return cue('expire', event.message, { side: target, target, amount });
      }
      case 'card_play': {
        const card = this.cardFor(data);
        if (actor === 'enemy') {
          const aiCard = this.final.aiDeck.find((c) => c.name === card.name);
          if (aiCard?.art) card.art = aiCard.art;
        }
        if (actor === 'player') {
          // playcard() always uses the leftmost card; keep that exact copy so its face follows it.
          const removed = this.view.player.hand[0]?.name === card.name
            ? this.view.player.hand.shift()
            : removeCardByName(this.view.player.hand, card.name);
          this.view.player.energy = num(data.energyAfter, this.view.player.energy);
          this.pending = { card: removed ?? card, side: 'player' };
          this.setPlayerCounts();
        } else {
          this.view.enemy.energy = num(data.energyAfter, this.view.enemy.energy);
          this.view.enemy.handCount = Math.max(0, this.view.enemy.handCount - 1);
          this.pending = { card, side: 'enemy' };
        }
        return cue('cast', `${actor === 'player' ? '你' : 'SENTINEL'} 打出【${card.name}】`, {
          side: actor === 'enemy' ? 'enemy' : 'player',
          card,
        });
      }
      case 'card_end': {
        this.pushPendingToDiscard();
        return null;
      }
      case 'card_halt': {
        this.pushPendingToDiscard();
        return cue('halt', event.message, { side: actor === 'enemy' ? 'enemy' : 'player' });
      }
      case 'damage': {
        const target = (data.side as Side | undefined) ?? (actor === 'player' ? 'enemy' : 'player');
        const unit = target === 'player' ? this.view.player : this.view.enemy;
        unit.hp = Math.max(0, num(data.hpAfter, unit.hp - num(data.hpDamage, num(data.amount))));
        if (typeof data.blockAfter === 'number') unit.block = Math.max(0, data.blockAfter);
        else unit.block = Math.max(0, unit.block - num(data.blocked));
        return cue('hit', event.message, {
          side: actor === 'enemy' ? 'enemy' : 'player',
          target,
          amount: num(data.hpDamage, num(data.amount)),
          blocked: num(data.blocked),
        });
      }
      case 'block': {
        const unit = side === 'player' ? this.view.player : this.view.enemy;
        unit.block = num(data.block, unit.block + num(data.amount));
        if (num(data.amount) <= 0) return null;
        return cue('block', event.message, { side, amount: num(data.amount) });
      }
      case 'heal': {
        const unit = side === 'player' ? this.view.player : this.view.enemy;
        const healed = num(data.healed, num(data.amount));
        unit.hp = Math.min(unit.maxHp, num(data.hp, unit.hp + healed));
        if (healed <= 0) return null;
        return cue('heal', event.message, { side, amount: healed });
      }
      case 'energy': {
        const unit = side === 'player' ? this.view.player : this.view.enemy;
        const before = unit.energy;
        unit.energy = num(data.energy, unit.energy);
        const delta = unit.energy - before;
        if (delta === 0) return null;
        return cue('energy', event.message, { side, amount: Math.abs(delta), delta });
      }
      case 'draw': {
        const count = num(data.drawn);
        if (actor === 'player') {
          const drawn: PublicCard[] = [];
          if (Array.isArray(data.cards)) {
            const wanted = data.cards as string[];
            // Prefer real top-of-pile copies when the visual draw pile still matches the event.
            const canShift = this.view.player.draw.length >= wanted.length
              && wanted.every((name, i) => this.view.player.draw[i]?.name === name);
            for (const name of wanted) {
              const card = canShift
                ? this.view.player.draw.shift() ?? this.cardFor({ card: name }, name)
                : this.cardFor({ card: name }, name);
              this.view.player.hand.push(card);
              drawn.push(card);
            }
            if (Array.isArray(data.order)) {
              this.view.player.draw = (data.order as string[]).map((name) => this.cardFor({ card: name }, name));
            }
            if (Array.isArray(data.discard)) {
              this.view.player.discard = (data.discard as string[]).map((name) => this.cardFor({ card: name }, name));
            }
          } else {
            for (let i = 0; i < count; i++) {
              const card = this.view.player.draw.shift();
              if (!card) break;
              this.view.player.hand.push(card);
              drawn.push(card);
            }
          }
          this.setPlayerCounts();
          if (drawn.length === 0) return null;
          return cue('draw', event.message, { side: 'player', cards: drawn, amount: drawn.length });
        }
        this.view.enemy.drawCount = Math.max(0, this.view.enemy.drawCount - count);
        this.view.enemy.handCount += count;
        if (count <= 0) return null;
        return cue('draw', event.message, { side: 'enemy', amount: count });
      }
      case 'discard': {
        if (side === 'player') {
          const names = Array.isArray(data.cards) ? (data.cards as string[]) : [];
          const discarded: PublicCard[] = [];
          for (const name of names) {
            const card = removeCardByName(this.view.player.hand, name);
            if (card) {
              this.view.player.discard.push(card);
              discarded.push(card);
            }
          }
          if (discarded.length === 0 && num(data.count) > 0) {
            for (let i = 0; i < num(data.count); i++) {
              const card = this.view.player.hand.shift();
              if (!card) break;
              this.view.player.discard.push(card);
              discarded.push(card);
            }
          }
          this.setPlayerCounts();
          if (discarded.length === 0) return null;
          return cue('discard', event.message, { side: 'player', cards: discarded, amount: discarded.length });
        }
        const count = num(data.count);
        const names = Array.isArray(data.cards) ? (data.cards as string[]) : [];
        this.view.enemy.handCount = Math.max(0, this.view.enemy.handCount - count);
        this.addEnemyDiscard(names.map((name) => this.cardFor({ card: name }, name)), count);
        return cue('discard', event.message, { side: 'enemy', amount: count });
      }
      case 'shuffle': {
        if (actor === 'player' || side === 'player') {
          if (Array.isArray(data.order)) {
            const build = (names: string[]) => names.map((name) => this.cardFor({ card: name }, name));
            this.view.player.draw = build(data.order as string[]);
            if (Array.isArray(data.discard)) this.view.player.discard = build(data.discard as string[]);
            this.setPlayerCounts();
          }
          return cue('shuffle', event.message, { side: 'player', amount: num(data.count, (data.order as string[] | undefined)?.length ?? 0) });
        }
        return cue('shuffle', event.message, { side: 'enemy', amount: num(data.count) });
      }
      case 'pile': {
        if (Array.isArray(data.cards) && data.side) {
          const names = data.cards as string[];
          if (data.side === 'player') {
            const discarded: PublicCard[] = [];
            for (const name of names) {
              const card = removeCardByName(this.view.player.hand, name);
              if (card) {
                this.view.player.discard.push(card);
                discarded.push(card);
              }
            }
            this.setPlayerCounts();
            return cue('discard', event.message, { side: 'player', cards: discarded, amount: discarded.length });
          }
          this.view.enemy.handCount = Math.max(0, this.view.enemy.handCount - names.length);
          this.addEnemyDiscard(names.map((name) => this.cardFor({ card: name }, name)), names.length);
          return cue('discard', event.message, { side: 'enemy', amount: names.length });
        }
        if (actor === 'player') {
          if (typeof data.pile === 'string' && Array.isArray(data.order)) {
            const source = data.pile === 'hand'
              ? this.view.player.hand
              : data.pile === 'draw'
                ? this.view.player.draw
                : this.view.player.discard;
            const pool = [...source];
            // Reuse the same card instances so a swap/move animates the existing meshes
            // across the table instead of rebuilding every card in the pile.
            const next = (data.order as string[]).map((name) => {
              const index = pool.findIndex((c) => c.name === name);
              return index >= 0 ? pool.splice(index, 1)[0] : this.cardFor({ card: name }, name);
            });
            if (data.pile === 'hand') this.view.player.hand = next;
            else if (data.pile === 'draw') this.view.player.draw = next;
            else this.view.player.discard = next;
            this.setPlayerCounts();
            return cue('arrange', event.message, { side: 'player', amount: next.length });
          }
          const from = str(data.from, 'draw');
          const to = str(data.to, 'hand');
          const cardName = str(data.card, '');
          const moved = this.takeFromPile('player', from, cardName, num(data.index, -1));
          if (moved) {
            const target = to === 'draw' ? this.view.player.draw : to === 'hand' ? this.view.player.hand : this.view.player.discard;
            const at = num(data.targetIndex, target.length);
            target.splice(Math.max(0, Math.min(at, target.length)), 0, moved);
          }
          this.setPlayerCounts();
          return moved ? cue('arrange', event.message, { side: 'player' }) : null;
        }
        if (actor === 'enemy' && typeof data.card === 'string') {
          const card = this.cardFor({ card: data.card }, data.card);
          this.view.enemy.handCount = Math.max(0, this.view.enemy.handCount - 1);
          this.addEnemyDiscard([card], 1);
          return cue('discard', event.message, { side: 'enemy', amount: 1 });
        }
        return null;
      }
      case 'api': {
        const spent = num(data.credits);
        if (spent > 0) {
          this.view.player.creditsUsed = Math.round((this.view.player.creditsUsed + spent) * 10) / 10;
        }
        return null;
      }
      case 'register_commit':
      case 'register_stage': {
        const name = str(data.name);
        const entry = this.view.registers.find((r) => r.name === name);
        if (entry && (typeof data.value === 'number' || typeof data.value === 'boolean' || typeof data.value === 'string')) {
          entry.value = data.value;
        }
        return event.type === 'register_commit' ? cue('register', event.message, { side: 'player' }) : null;
      }
      case 'ai_plan':
      case 'ai_fallback': {
        return cue('ai', event.message, { side: 'enemy' });
      }
      case 'card_skip': {
        return cue('skip', event.message, { side: actor === 'enemy' ? 'enemy' : 'player' });
      }
      case 'halt': {
        return cue('halt', event.message, { side: actor === 'enemy' ? 'enemy' : 'player' });
      }
      case 'battle_end':
      case 'timeout': {
        this.pushPendingToDiscard();
        if (event.type === 'battle_end') {
          this.view.phase = 'over';
          this.view.result = (data.result as PublicBattleState['result']) ?? this.final.result;
        }
        return cue('end', event.message, { side: this.final.result === 'victory' ? 'player' : 'enemy' });
      }
      default:
        return null;
    }
  }

  snapshot(): PublicBattleState {
    return cloneState(this.view);
  }

  finish(): PublicBattleState {
    return cloneState(this.final);
  }
}
