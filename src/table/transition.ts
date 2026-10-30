import { handSlot, pileSlot, type PileKey, type Slot } from './layout';

export interface HandCardLike {
  name: string;
  uid?: string;
}

/**
 * Presentation identity for a hand slot. Prefer the engine uid so two copies of the
 * same card can carry different faces; fall back to name + occurrence for cue-only cards.
 */
export function cardKeys(cards: readonly HandCardLike[]): string[] {
  const seen = new Map<string, number>();
  return cards.map((card) => {
    const n = seen.get(card.name) ?? 0;
    seen.set(card.name, n + 1);
    return card.uid ? `uid:${card.uid}` : `${card.name}#${n}`;
  });
}

export interface HandDiff {
  removed: { key: string; index: number }[];
  added: { key: string; index: number }[];
  kept: { key: string; from: number; to: number }[];
}

export function diffHand(prev: readonly string[], next: readonly string[]): HandDiff {
  const prevIndex = new Map(prev.map((key, i) => [key, i]));
  const nextSet = new Set(next);
  const removed: HandDiff['removed'] = [];
  const added: HandDiff['added'] = [];
  const kept: HandDiff['kept'] = [];
  prev.forEach((key, index) => {
    if (!nextSet.has(key)) removed.push({ key, index });
  });
  next.forEach((key, index) => {
    const from = prevIndex.get(key);
    if (from === undefined) added.push({ key, index });
    else kept.push({ key, from, to: index });
  });
  return { removed, added, kept };
}

export function handTargets(count: number): Slot[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => handSlot(i, count));
}

export function pileTargets(pile: PileKey, count: number, maxVisible = 8): Slot[] {
  const visible = Math.min(count, maxVisible);
  return Array.from({ length: visible }, (_, i) => pileSlot(pile, i, count));
}
