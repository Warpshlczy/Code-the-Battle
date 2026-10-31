import type { RefObject } from 'react';
import { API_BY_NAME, CREDIT_BUDGET } from '../engine/config';
import type { CodeEditorHandle } from './CodeEditor';
import { pick, useLang, useT } from '../i18n';

type Scope = 'card' | 'script' | 'both' | 'read';
interface ApiItem {
  sig: string;
  insert: string;
  desc: string;
  descEn: string;
  scope: Scope;
  price?: string;
  priceEn?: string;
}
interface ApiGroup {
  name: string;
  nameEn: string;
  items: ApiItem[];
}

const GROUPS: ApiGroup[] = [
  {
    name: '对手情报',
    nameEn: 'Opponent intel',
    items: [
      { sig: 'ctx.enemy.hp()', insert: 'ctx.enemy.hp()', desc: '读取对手当前生命；卡牌效果与对局脚本都能使用，构筑期效果上限固定为 6。', descEn: "Read the opponent's current HP. Available to card effects and battle scripts; the build-time effect cap is fixed at 6.", scope: 'both', price: '计费：0.1 + 0.015×对手生命。', priceEn: 'Cost: 0.1 + 0.015×enemy HP.' },
      { sig: 'ctx.enemy.block()', insert: 'ctx.enemy.block()', desc: '读取对手当前格挡；卡牌效果与对局脚本都能使用。', descEn: "Read the opponent's current Block. Available to card effects and battle scripts.", scope: 'both', price: '计费：0.1 + 0.02×对手格挡。', priceEn: 'Cost: 0.1 + 0.02×enemy Block.' },
    ],
  },
  {
    name: '出牌与顺序',
    nameEn: 'Play & order',
    items: [
      { sig: 'ctx.playcard()', insert: 'ctx.playcard()', desc: '打出当前手牌最左边的一张，只消耗能量，不读取手牌内容。', descEn: 'Play the leftmost card in hand. It spends energy only and never reads hand contents.', scope: 'script', price: '计费：固定 0.8 算力。', priceEn: 'Cost: flat 0.8 credits.' },
      { sig: 'ctx.swap(pile, i, j)', insert: 'ctx.swap("hand", 0, 1)', desc: '交换同一牌堆里的两张牌，用来调整下一张打出的牌；调度类 API 价格很低。', descEn: 'Swap two cards in the same pile to change which card is played next; scheduling APIs are cheap.', scope: 'both', price: '计费：固定 0.1 算力，不随位置变化。', priceEn: 'Cost: flat 0.1 credits, independent of positions.' },
      { sig: 'ctx.move_card(from, i, to, j)', insert: 'ctx.move_card("draw", 0, "hand", 0)', desc: '把一张牌从任意牌堆移到另一个牌堆的指定位置；调度类 API 价格很低。', descEn: 'Move a card from any pile to a chosen position in another pile; scheduling APIs are cheap.', scope: 'both', price: '计费：固定 0.25 算力。', priceEn: 'Cost: flat 0.25 credits.' },
    ],
  },
  {
    name: '牌堆',
    nameEn: 'Piles',
    items: [
      { sig: 'ctx.draw(count)', insert: 'ctx.draw(1)', desc: '从抽牌堆抽 n 张牌，抽牌堆为空时自动把弃牌堆洗回。', descEn: 'Draw n cards from the draw pile; the discard pile is reshuffled automatically when needed.', scope: 'both', price: '计费：1.5 + 0.9n + 0.04n²，张数越多单价越高。', priceEn: 'Cost: 1.5 + 0.9n + 0.04n²; larger draws cost more per card.' },
      { sig: 'ctx.discard(count)', insert: 'ctx.discard(1)', desc: '弃掉最左边的 n 张手牌，放进弃牌堆。', descEn: 'Discard the leftmost n cards in hand into the discard pile.', scope: 'both', price: '计费：1.2 + 0.7n，按弃牌张数线性增长。', priceEn: 'Cost: 1.2 + 0.7n, linear in the number discarded.' },
      { sig: 'ctx.shuffle()', insert: 'ctx.shuffle()', desc: '按本局种子重洗抽牌堆，不改变牌的总数。', descEn: "Reshuffle the draw pile using this run's seed without changing the total card count.", scope: 'both', price: '计费：固定 1.2 算力。', priceEn: 'Cost: flat 1.2 credits.' },
      { sig: 'ctx.reshuffle()', insert: 'ctx.reshuffle()', desc: '把弃牌堆洗回抽牌堆，抽牌堆满时停止。', descEn: 'Shuffle the discard pile back into the draw pile, stopping when the draw pile is full.', scope: 'both', price: '计费：固定 1.5 算力。', priceEn: 'Cost: flat 1.5 credits.' },
      { sig: 'ctx.pile_costs(pile)', insert: 'ctx.pile_costs("hand")', desc: '读取一个牌堆里每张牌的费用，返回只读数字列表。', descEn: 'Read the cost of every card in one pile as a read-only number list.', scope: 'both', price: '计费：0.15 + 0.04n，n 为读到的张数。', priceEn: 'Cost: 0.15 + 0.04n, where n is the number of cards read.' },
    ],
  },
  {
    name: '战斗与资源',
    nameEn: 'Combat & resources',
    items: [
      { sig: 'ctx.deal_damage(target, amount)', insert: 'ctx.deal_damage("enemy", |)', desc: '对目标造成 a 点伤害，先扣格挡再扣生命，没有单次上限。', descEn: 'Deal a damage to the target. Block absorbs first, then HP; there is no per-cast cap.', scope: 'both', price: '计费：4 + 1.2a + 0.12a²；平方项惩罚大数值。', priceEn: 'Cost: 4 + 1.2a + 0.12a²; the square term punishes huge values.' },
      { sig: 'ctx.gain_block(amount)', insert: 'ctx.gain_block(|)', desc: '获得 a 点格挡，持续到自己的下个回合开始，没有上限。', descEn: 'Gain a Block until the start of your next turn. There is no cap.', scope: 'both', price: '计费：5 + 1.5a + 0.25a²；平方项防止无限叠盾。', priceEn: 'Cost: 5 + 1.5a + 0.25a²; the square term prevents infinite stacking.' },
      { sig: 'ctx.heal(amount)', insert: 'ctx.heal(|)', desc: '回复 a 点生命，不能超过生命上限。', descEn: 'Restore a HP, up to max HP.', scope: 'both', price: '计费：4 + 2a + 0.2a²；回血比伤害更贵。', priceEn: 'Cost: 4 + 2a + 0.2a²; healing is more expensive than damage.' },
      { sig: 'ctx.gain_energy(amount)', insert: 'ctx.gain_energy(1)', desc: '获得 a 点能量，立即增加本回合可出牌次数。', descEn: 'Gain a Energy immediately, adding plays this turn.', scope: 'both', price: '计费：14 + 8a；回能会放大整回合输出，所以极贵。', priceEn: 'Cost: 14 + 8a; energy multiplies the whole turn, so it is very expensive.' },
      { sig: 'ctx.lose_energy(amount)', insert: 'ctx.lose_energy(1)', desc: '失去 a 点能量，不会低于 0。', descEn: 'Lose a Energy; the total never drops below 0.', scope: 'both', price: '计费：1 + 0.8a；作为负面效果时按规则抵扣。', priceEn: 'Cost: 1 + 0.8a; refunded by the rules when used as a drawback.' },
      { sig: 'ctx.random_int(min, max)', insert: 'ctx.random_int(0, |)', desc: '用本局固定种子在 [min,max] 取一个整数，结果可重放。', descEn: "Draw an integer in [min,max] from this run's fixed seed; the result is replayable.", scope: 'both', price: '计费：2 + 0.4×跨度；跨度越大越贵。', priceEn: 'Cost: 2 + 0.4×span; wider ranges cost more.' },
      { sig: 'ctx.log(message)', insert: 'ctx.log("|")', desc: '往战斗记录写一条玩家日志，方便逐行复盘。', descEn: 'Write a player log entry into the battle record for line-by-line review.', scope: 'both', price: '计费：固定 0.2 算力。', priceEn: 'Cost: flat 0.2 credits.' },
    ],
  },
  {
    name: '查询',
    nameEn: 'Queries',
    items: [
      { sig: 'ctx.getTurn()', insert: 'ctx.getTurn()', desc: '读取当前回合数。', descEn: 'Read the current turn number.', scope: 'read', price: '计费：0.1 + 0.03×回合数。', priceEn: 'Cost: 0.1 + 0.03×turn number.' },
      { sig: 'ctx.getEnergy()', insert: 'ctx.getEnergy()', desc: '读取自己当前能量。', descEn: 'Read your current Energy.', scope: 'read', price: '计费：0.1 + 0.04×当前能量。', priceEn: 'Cost: 0.1 + 0.04×current Energy.' },
      { sig: 'ctx.getBlock()', insert: 'ctx.getBlock()', desc: '读取自己当前格挡。', descEn: 'Read your current Block.', scope: 'read', price: '计费：0.1 + 0.02×当前格挡。', priceEn: 'Cost: 0.1 + 0.02×current Block.' },
      { sig: 'ctx.getMaxEnergy()', insert: 'ctx.getMaxEnergy()', desc: '读取每回合能量上限。', descEn: 'Read the per-turn Energy cap.', scope: 'read', price: '计费：0.1 + 0.04×上限。', priceEn: 'Cost: 0.1 + 0.04×cap.' },
      { sig: 'ctx.getHand()', insert: 'ctx.getHand()', desc: '读取自己手牌的只读快照；每项是卡牌对象，只有 name 与 cost。', descEn: 'Read a read-only snapshot of your hand; each item is a card object with only name and cost.', scope: 'both', price: '计费：0.2 + 0.06×手牌数。', priceEn: 'Cost: 0.2 + 0.06×hand size.' },
      { sig: 'ctx.getDraw()', insert: 'ctx.getDraw()', desc: '读取抽牌堆的只读快照；每项是卡牌对象，只有 name 与 cost。', descEn: 'Read a read-only snapshot of the draw pile; each item is a card object with only name and cost.', scope: 'both', price: '计费：0.2 + 0.06×抽牌数。', priceEn: 'Cost: 0.2 + 0.06×draw size.' },
      { sig: 'ctx.getDiscard()', insert: 'ctx.getDiscard()', desc: '读取弃牌堆的只读快照；每项是卡牌对象，只有 name 与 cost。', descEn: 'Read a read-only snapshot of the discard pile; each item is a card object with only name and cost.', scope: 'both', price: '计费：0.2 + 0.06×弃牌数。', priceEn: 'Cost: 0.2 + 0.06×discard size.' },
      { sig: 'ctx.getPile(pile)', insert: 'ctx.getPile("hand")', desc: '按名字读取任意自己的牌堆；返回卡牌对象数组，每项只有 name 与 cost。', descEn: 'Read any of your piles by name; returns card objects with only name and cost.', scope: 'both', price: '计费：0.2 + 0.06×牌堆张数。', priceEn: 'Cost: 0.2 + 0.06×pile size.' },
      { sig: 'ctx.hand_size()', insert: 'ctx.hand_size()', desc: '读取手牌数量。', descEn: 'Read the hand size.', scope: 'both', price: '计费：0.05 + 0.03×手牌数。', priceEn: 'Cost: 0.05 + 0.03×hand size.' },
      { sig: 'ctx.draw_size()', insert: 'ctx.draw_size()', desc: '读取抽牌堆数量。', descEn: 'Read the draw pile size.', scope: 'both', price: '计费：0.05 + 0.03×抽牌数。', priceEn: 'Cost: 0.05 + 0.03×draw size.' },
      { sig: 'ctx.discard_size()', insert: 'ctx.discard_size()', desc: '读取弃牌堆数量。', descEn: 'Read the discard pile size.', scope: 'both', price: '计费：0.05 + 0.03×弃牌数。', priceEn: 'Cost: 0.05 + 0.03×discard size.' },
      { sig: 'ctx.turn.played_count', insert: 'ctx.turn.played_count', desc: '读取本回合已经打出的牌数。', descEn: 'Read how many cards have been played this turn.', scope: 'read', price: '计费：1.0 基准，再乘表达式。', priceEn: 'Cost: 1.0 base, then scaled by the expression.' },
      { sig: 'ctx.turn.discarded_count', insert: 'ctx.turn.discarded_count', desc: '读取本回合已经弃掉的牌数。', descEn: 'Read how many cards have been discarded this turn.', scope: 'read', price: '计费：1.0 基准，再乘表达式。', priceEn: 'Cost: 1.0 base, then scaled by the expression.' },
    ],
  },
  {
    name: '寄存器',
    nameEn: 'Registers',
    items: [
      { sig: 'ctx.get_global(name)', insert: 'ctx.get_global("combo")', desc: '读取一个已声明寄存器的当前值。', descEn: 'Read the current value of a declared register.', scope: 'both', price: '计费：0.15 + 0.05×寄存器范围。', priceEn: 'Cost: 0.15 + 0.05×register range.' },
      { sig: 'ctx.set_global(name, value)', insert: 'ctx.set_global("combo", |)', desc: '写入寄存器，立即校验范围并生效。', descEn: 'Write a register; its range is validated and applied immediately.', scope: 'script', price: '计费：固定 0.6 算力。', priceEn: 'Cost: flat 0.6 credits.' },
    ],
  },
];

const EFFECT_PRICE: Record<string, [string, string]> = {
  'ctx.swap(pile, i, j)': ['0.25 效果值', '0.25 effect value'],
  'ctx.move_card(from, i, to, j)': ['0.35 效果值', '0.35 effect value'],
  'ctx.draw(count)': ['0.6 + 0.5n', '0.6 + 0.5n'],
  'ctx.discard(count)': ['0.4 + 0.25n', '0.4 + 0.25n'],
  'ctx.shuffle()': ['0.5 效果值', '0.5 effect value'],
  'ctx.reshuffle()': ['0.6 效果值', '0.6 effect value'],
  'ctx.pile_costs(pile)': ['0.25 效果值', '0.25 effect value'],
  'ctx.getPile(pile)': ['0.8 固定，读取牌堆', '0.8 fixed · reads a pile'],
  'ctx.deal_damage(target, amount)': ['0.8 + 0.22a', '0.8 + 0.22a'],
  'ctx.gain_block(amount)': ['0.6 + 0.2a', '0.6 + 0.2a'],
  'ctx.heal(amount)': ['0.7 + 0.3a', '0.7 + 0.3a'],
  'ctx.gain_energy(amount)': ['1.4 + 1.4a', '1.4 + 1.4a'],
  'ctx.lose_energy(amount)': ['0.5 + 1.0a', '0.5 + 1.0a'],
  'ctx.random_int(min, max)': ['0.5 效果值', '0.5 effect value'],
  'ctx.log(message)': ['0.1 效果值', '0.1 effect value'],
  'ctx.getTurn()': ['2.6 固定，全局动态数据', '2.6 fixed · global dynamic read'],
  'ctx.getEnergy()': ['2.6 固定，全局动态数据', '2.6 fixed · global dynamic read'],
  'ctx.getBlock()': ['2.6 固定，全局动态数据', '2.6 fixed · global dynamic read'],
  'ctx.getMaxEnergy()': ['2.2 固定，全局动态数据', '2.2 fixed · global dynamic read'],
  'ctx.enemy.hp()': ['6.0 固定，全局动态数据', '6.0 fixed · global dynamic read'],
  'ctx.enemy.block()': ['2.4 固定，全局动态数据', '2.4 fixed · global dynamic read'],
  'ctx.getHand()': ['0.8 固定，读取手牌', '0.8 fixed · reads the hand'],
  'ctx.getDraw()': ['0.8 固定，读取抽牌堆', '0.8 fixed · reads the draw pile'],
  'ctx.getDiscard()': ['0.8 固定，读取弃牌堆', '0.8 fixed · reads the discard pile'],
  'ctx.hand_size()': ['0.7 固定，读取数量', '0.7 fixed · reads a count'],
  'ctx.draw_size()': ['0.7 固定，读取数量', '0.7 fixed · reads a count'],
  'ctx.discard_size()': ['0.7 固定，读取数量', '0.7 fixed · reads a count'],
  'ctx.turn.played_count': ['1.2 基准，再乘表达式', '1.2 base · scaled by the expression'],
  'ctx.turn.discarded_count': ['1.2 基准，再乘表达式', '1.2 base · scaled by the expression'],
  'ctx.get_global(name)': ['1.6 固定，玩家自定义状态', '1.6 fixed · player-defined state'],
  'ctx.set_global(name, value)': ['0.5 效果值', '0.5 effect value'],
};

function returnTypeFor(sig: string): string {
  if (sig.startsWith('ctx.enemy.')) return 'int';
  if (sig.startsWith('ctx.turn.')) return 'int';
  const open = sig.indexOf('(');
  if (open < 0) return 'int';
  const name = sig.slice(4, open);
  return API_BY_NAME.get(name)?.ret ?? 'none';
}

export function ApiReference({
  mode,
  onInsert,
  compact = false,
}: {
  mode: 'card' | 'script';
  onInsert: (snippet: string) => void;
  compact?: boolean;
}) {
  const lang = useLang();
  const t = useT();
  const visible = (_scope: Scope) => true;
  return (
    <div className={`api-ref ${compact ? 'compact' : ''}`} data-testid="api-reference">
      <p className="api-budget">
        {mode === 'script'
          ? t(
              `对局计费：每回合 ${CREDIT_BUDGET} 算力，可多次执行；读取越深，花费越高。`,
              `Battle billing: ${CREDIT_BUDGET} credits per turn, reusable across multiple executions; deeper reads cost more.`,
            )
          : t(
              '构筑计费：调度类 API 最便宜；读取与全局动态读取更贵，最终都受费用对应的效果上限约束。',
              'Build billing: scheduling APIs are cheapest; reads and global dynamic reads cost more, all under the cap set by card cost.',
            )}
      </p>
      {GROUPS.map((group) => {
        const items = group.items.filter((i) => visible(i.scope));
        if (items.length === 0) return null;
        return (
          <details key={group.name} className="api-group" open>
            <summary>
              {pick(lang, group.name, group.nameEn)}
              <span>{items.length}</span>
            </summary>
            <div className="api-items">
              {items.map((item) => (
                <button
                  key={item.sig}
                  type="button"
                  className="api-item"
                  disabled={mode === 'card' && item.scope === 'script'}
                  onClick={() => onInsert(item.insert)}
                  data-testid={`api-item-${item.sig}`}
                  title={t(`插入：${item.insert.replace('|', '')}`, `Insert: ${item.insert.replace('|', '')}`)}
                >
                  <code>{item.sig}<i className="api-ret">→ {returnTypeFor(item.sig)}</i></code>
                  <span>{pick(lang, item.desc, item.descEn)}</span>
                  {(mode === 'card' ? EFFECT_PRICE[item.sig] : item.price) && (
                    <em>
                      {mode === 'card'
                        ? t(`效果上限：${pick(lang, EFFECT_PRICE[item.sig][0], EFFECT_PRICE[item.sig][1])}`, `Effect cap: ${EFFECT_PRICE[item.sig][1]}`)
                        : pick(lang, item.price ?? '', item.priceEn ?? '')}
                    </em>
                  )}
                </button>
              ))}
            </div>
          </details>
        );
      })}
      <p className="api-foot">
        {t('点击插入签名；光标停在 `|` 的位置。', 'Click to insert the signature; the cursor stops at `|`.')}
      </p>
    </div>
  );
}

export function StructureTree({ source }: { source: string }) {
  const t = useT();
  const lines = source.split('\n');
  const rows = lines
    .map((raw, i) => {
      const cleaned = raw.replace(/(#|\/\/).*$/, '').trimEnd();
      if (cleaned.trim() === '') return null;
      const indent = cleaned.length - cleaned.trimStart().length;
      return { line: i + 1, text: cleaned.trim(), indent };
    })
    .filter((x): x is { line: number; text: string; indent: number } => x !== null);
  return (
    <div className="structure-tree" data-testid="structure-tree">
      {rows.length === 0 && <span className="empty-hint">{t('暂无结构', 'No structure yet')}</span>}
      {rows.map((r) => (
        <div key={r.line} className="structure-row" style={{ paddingLeft: `${Math.min(5, Math.floor(r.indent / 4)) * 12}px` }}>
          <span className="structure-line">{String(r.line).padStart(2, '0')}</span>
          <span className={r.text.startsWith('ctx.') ? 'structure-api' : ''}>{r.text}</span>
        </div>
      ))}
    </div>
  );
}

export function ApiHelpButton({ editorRef }: { editorRef: RefObject<CodeEditorHandle> }) {
  const t = useT();
  return (
    <button type="button" className="ghost-btn" onClick={() => editorRef.current?.focus()}>
      {t('聚焦编辑器', 'Focus editor')}
    </button>
  );
}
