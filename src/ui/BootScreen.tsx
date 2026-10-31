import { useEffect, type CSSProperties } from 'react';
import { useT } from '../i18n';
import { ART } from './art';
import { RuleIcon } from './components';
import { TitleBackdrop } from './TitleBackdrop';

function Letters({ text }: { text: string }) {
  return (
    <>
      {[...text].map((ch, i) => (
        <span key={`${ch}-${i}`} className="bt-char" style={{ '--i': i } as CSSProperties}>
          {ch === ' ' ? '\u00a0' : ch}
        </span>
      ))}
    </>
  );
}

export function BootScreen({ onStart, onRules }: { onStart: () => void; onRules: () => void }) {
  const t = useT();
  return (
    <main className="boot-screen bt">
      <TitleBackdrop />
      <div className="bt-scanlines" aria-hidden="true" />
      <div className="bt-vignette" aria-hidden="true" />

      <header className="bt-top">
        <div className="bt-brand">
          <span className="bt-brand-mark">CODE THE BATTLE</span>
        </div>
      </header>

      <section className="bt-main">
        <div className="bt-copy">
          <h1 className="bt-title" aria-label="CODE THE BATTLE">
            <span className="bt-line bt-line-a">
              <Letters text="CODE" />
            </span>
            <span className="bt-line bt-line-b">
              <Letters text="THE BATTLE" />
            </span>
          </h1>
          <p className="bt-tag">
            {t('Vibe code 太久，忘了代码怎么写？', 'Vibe-coded too long and forgot how to code?')}
          </p>
          <p className="bt-sub">
            {t(
              '来打 Code the Battle，在回合制卡牌对战中证明你的代码能比 AI 写得好。',
              'Come play Code the Battle and prove your code beats the AI in a turn-based card duel.',
            )}
            <br />
            {t(
              '你操控一台外接战斗设备，对面是一台人形支配体。卡牌和每回合战术都由你亲手写，规则引擎只负责执行。',
              'You pilot an external combat rig. Across the table sits a humanoid dominator. Every card and every turn tactic is written by you; the rules engine only executes it.',
            )}
          </p>
          <div className="bt-actions">
            <button type="button" className="bt-cta primary" onClick={onStart} data-testid="start-build">
              <span>{t('进入构筑', 'ENTER THE BUILD')}</span>
              <i aria-hidden="true">→</i>
              <em>ENTER</em>
            </button>
            <button type="button" className="bt-cta ghost" onClick={onRules}>
              {t('查看战斗规则', 'View combat rules')}
            </button>
          </div>
          <ol className="bt-facts">
            <li><b>01</b><span>{t('写五到十张卡', 'Write 5–10 cards')}</span></li>
            <li><b>02</b><span>{t('画你自己的卡面', 'Paint your own card faces')}</span></li>
            <li><b>03</b><span>{t('每回合调度手牌', 'Command your hand every turn')}</span></li>
            <li><b>04</b><span>{t('逐行复盘', 'Audit every line afterwards')}</span></li>
          </ol>
        </div>

        <aside className="bt-holo" aria-hidden="true">
          <div className="bt-holo-frame">
            <img src={ART.enemy} alt="" />
            <span className="bt-holo-grid" />
            <span className="bt-holo-sweep" />
            <span className="bt-holo-ring r1" />
            <span className="bt-holo-ring r2" />
            <div className="bt-holo-tag">
              <b>SENTINEL-07</b>
              <span>{t('人形支配体 / 未知协议', 'Humanoid dominator / unknown protocol')}</span>
            </div>
            <div className="bt-holo-bars">
              <span style={{ width: '88%' }} />
              <span style={{ width: '63%' }} />
              <span style={{ width: '74%' }} />
            </div>
          </div>
          <div className="bt-float-card c1"><b>7</b><span>{t('直击', 'STRIKE')}</span></div>
          <div className="bt-float-card c2"><b>8</b><span>{t('格挡', 'BLOCK')}</span></div>
          <div className="bt-float-card c3"><b>14</b><span>{t('算力', 'CREDITS')}</span></div>
        </aside>
      </section>

      <footer className="bt-foot">
        <span>{t('战术由你手写', 'Tactics are handwritten')}</span>
        <span>{t('对手只按规则行动', 'The opponent only follows rules')}</span>
        <span>{t('输赢由现场结算', 'The engine settles every hit')}</span>
        <span>{t('复盘只看日志', 'Review reads only the log')}</span>
      </footer>
    </main>
  );
}

export function RulesModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <span className="eyebrow">{t('作战简报 / PROTOCOL 07', 'COMBAT BRIEF / PROTOCOL 07')}</span>
            <h2 id="rules-title">{t('战斗规则', 'Combat rules')}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('关闭', 'Close')}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <div className="rule-flow">
            <div className="rule-step"><RuleIcon kind="card" /><b>{t('01 写卡', '01 WRITE')}</b><span>{t('5—10 张', '5–10 cards')}</span></div>
            <i>→</i>
            <div className="rule-step"><RuleIcon kind="code" /><b>{t('02 写战术', '02 CODE')}</b><span>{t('分段执行', 'chunked execution')}</span></div>
            <i>→</i>
            <div className="rule-step"><RuleIcon kind="shield" /><b>{t('03 打一场', '03 FIGHT')}</b><span>{t('看它怎么还手', 'see how it hits back')}</span></div>
            <i>→</i>
            <div className="rule-step"><RuleIcon kind="log" /><b>{t('04 翻日志', '04 AUDIT')}</b><span>{t('哪一行起了作用', 'which line mattered')}</span></div>
          </div>
          <div className="rule-protocol">
            <div>
              <span>01</span><b>{t('开局', 'OPENING')}</b>
              <p>{t('双方 100 生命，各 10 张牌，起手 5 张。每回合 5 能量；格挡在自己回合开始时清零。', 'Both sides start at 100 HP with a 10-card deck and a 5-card opening hand. Each turn gives 5 Energy; Block clears at the start of your own turn.')}</p>
            </div>
            <div>
              <span>02</span><b>{t('你的回合', 'YOUR TURN')}</b>
              <p>{t('打开终端写指令，确认后回战场点「执行终端命令」。可重复执行；点「跳过回合」结束。', 'Open the terminal, write commands, confirm, then hit "Execute terminal command" on the battlefield. You may run several chunks; press "Skip turn" to end the turn.')}</p>
            </div>
            <div>
              <span>03</span><b>{t('结算', 'RESOLUTION')}</b>
              <p>{t('剩余手牌进弃牌堆，SENTINEL 行动，再轮到你。生命归零即结束；30 回合后按剩余生命判定。', 'Remaining hand cards go to the discard pile, SENTINEL acts, then it is your turn again. Zero HP ends the duel; after 30 turns the remaining HP decides it.')}</p>
            </div>
          </div>
          <div className="rules-grid">
            <section>
              <h3><RuleIcon kind="card" /> {t('写卡的规矩', 'CARD RULES')}</h3>
              <p>
                {t(
                  '5—10 张卡，字段固定，只写 effect(self, ctx)。行尾写 // 注释会成为卡面说明；卡面可以用画笔自己画。',
                  '5–10 cards with fixed fields. You only write effect(self, ctx). A // comment at the end of a line becomes the card description; you can paint the face yourself.',
                )}
              </p>
              <div className="rule-chips">
                <span>{t('牌组最多 10 张', 'Deck cap: 10 cards')}</span>
                <span>{t('0 费效果 ≤ 1.5', '0 cost: effect ≤ 1.5')}</span>
                <span>{t('1 费 ≤ 2.4', '1 cost: ≤ 2.4')}</span>
                <span>{t('2 费 ≤ 3.2', '2 cost: ≤ 3.2')}</span>
                <span>{t('3 费 ≤ 4.2', '3 cost: ≤ 4.2')}</span>
                <span>{t('4 费 ≤ 5.5', '4 cost: ≤ 5.5')}</span>
                <span>{t('5 费 ≤ 6.4', '5 cost: ≤ 6.4')}</span>
              </div>
              <p className="rule-note">
                {t(
                  '费用写在卡上，直接决定效果上限。没有单独的牌组预算；单卡效果不能超过对应费用的上限。',
                  'The printed cost sets the effect cap. There is no separate deck budget; a single card cannot exceed the cap for its cost.',
                )}
              </p>
            </section>
            <section>
              <h3><RuleIcon kind="code" /> {t('每回合写什么', 'WHAT TO WRITE EACH TURN')}</h3>
              <p>
                {t(
                  '每回合写一段指令，确认后回战场执行；可以分多次跑，直到你点「跳过回合」。手牌顺序就是战术：读 ctx.pile_costs("hand")，再用 swap / move_card 调度。',
                  'Each turn you write a command chunk, confirm it, and run it from the battlefield. You can run several chunks before pressing "Skip turn". Hand order is your tactic: read ctx.pile_costs("hand"), then reorder with swap / move_card.',
                )}
              </p>
              <pre>{`// reorder / play / write a register
ctx.playcard()
ctx.log("open")`}</pre>
              <p>
                {t(
                  'playcard() 只打最左牌。双方 100 生命，每回合 5 点能量，摸到 5 张。跳过回合时所有手牌进弃牌堆；格挡只持续一回合，下个自己回合开始清零。',
                  'playcard() always plays the leftmost card. Both sides have 100 HP, 5 Energy per turn and draw 5 cards. Skipping the turn sends the whole hand to discard; Block lasts one round and clears at your next turn start.',
                )}
              </p>
            </section>
            <section>
              <h3><RuleIcon kind="energy" /> {t('每回合算力', 'TURN CREDITS')}</h3>
              <p>
                {t(
                  '脚本调用共享 14 点算力，卡牌效果由能量付费、不重复扣算力。算力按“数值大小”计费，所以同一段脚本里读得越多、改得越多，花得越多。',
                  'The script shares 14 credits per turn. Card effects are paid with Energy and do not double-charge credits. Credit prices scale with the numbers involved: read more or change more in one chunk and it costs more.',
                )}
              </p>
              <div className="rule-chips">
                <span>{t('伤害 / 格挡 / 治疗 / 回能：按数值平方增长', 'Damage / Block / heal / energy: grows with the square of the value')}</span>
                <span>{t('抽牌 / 弃牌：按张数增长', 'Draw / discard: grows with card count')}</span>
                <span>{t('读取牌堆 / 对手血量：按读取规模计费', 'Reading piles / enemy HP: priced by read size')}</span>
                <span>{t('swap / move_card / playcard：固定低价', 'swap / move_card / playcard: fixed low cost')}</span>
              </div>
              <p className="rule-note">
                {t(
                  '没有接口次数上限；只有这一份总预算。执行前按最坏情况锁死，运行时再兜底。',
                  'There is no API-call limit, only one total budget. It is locked to the worst case before execution, then enforced again at runtime.',
                )}
              </p>
            </section>
            <section>
              <h3><RuleIcon kind="shield" /> {t('场面与格挡', 'BOARD & BLOCK')}</h3>
              <div className="rule-chips">
                <span>{t('双方各 3 个牌堆（抽牌 / 手牌 / 弃牌）', 'Three piles per side (draw / hand / discard)')}</span>
                <span>{t('我方手牌可见，敌方手牌隐藏', 'Your hand is visible; the enemy hand is hidden')}</span>
                <span>{t('抽牌堆显示卡背与张数，弃牌公开牌面', 'Draw piles show backs and counts; discards are public')}</span>
                <span>{t('格挡持续一回合；为 0 时不显示', 'Block lasts one round and is hidden at 0')}</span>
              </div>
              <p>
                {t(
                  '格挡没有上限，被伤害先扣格挡；被打破时护盾会碎裂，打出的牌会高亮展示。',
                  'Block has no cap and absorbs damage first. When it breaks the shield shatters, and the card that broke it is highlighted.',
                )}
              </p>
            </section>
            <section>
              <h3><RuleIcon kind="code" /> {t('硬停与沙盒', 'HARD STOPS & SANDBOX')}</h3>
              <p>
                {t(
                  '写卡 20 行 / 复杂度 80；脚本 20 行 / 60；辅助函数最多 3 个，每个 30 行 / 120。写到上限时编辑器会硬停，粘贴也绕不过去。',
                  'Cards: 20 lines / complexity 80. Scripts: 20 lines / 60. Up to 3 helper functions, each 30 lines / 120. The editor hard-stops at the limit, and pasting cannot bypass it.',
                )}
              </p>
              <p>
                {t(
                  '循环上界说不清、递归、eval、文件、网络、反射，全都不让编译；运行时还有迭代与时间熔断，越线只停在这一步。',
                  'Unclear loop bounds, recursion, eval, files, network and reflection are rejected at compile time. At runtime, iteration and time fuses stop only the current step.',
                )}
              </p>
            </section>
            <section>
              <h3><RuleIcon kind="deck" /> {t('对手的底线', 'THE OPPONENT’S LIMITS')}</h3>
              <p>
                {t(
                  'SENTINEL 和你用同一套卡、牌堆、能量和算力。开战后双方完整牌组设计与寄存器状态对它公开；它看不到你的当前手牌、抽牌顺序和未执行的脚本，也不会预告意图。',
                  'SENTINEL uses the same cards, piles, Energy and credits as you. Once the battle starts, both deck designs and the register state are public to it; it cannot see your current hand, draw order or unexecuted scripts, and it never telegraphs its intent.',
                )}
              </p>
              <p>
                {t(
                  '你只能从它的战斗风格里读到一点倾向；具体怎么打，要等它出牌。越界或超时的方案会被整份作废，退回它自己的固定战术。',
                  'You can only infer its tendencies from its fighting style; the actual play arrives when it acts. Illegal or timed-out proposals are discarded as a whole and fall back to its fixed tactic.',
                )}
              </p>
            </section>
            <section>
              <h3><RuleIcon kind="log" /> {t('胜负与复盘', 'OUTCOME & REVIEW')}</h3>
              <p>
                {t(
                  '对手生命归零即胜；30 回合后按剩余生命比例判定。战后可看逐行归因、牌堆回放、读码审讯、对手档案和确定性重放。',
                  'Reduce the opponent to 0 HP to win; after 30 turns the remaining HP ratio decides. The review shows line attribution, pile replay, code interrogation, the opponent file and deterministic replay.',
                )}
              </p>
            </section>
          </div>
        </div>
        <footer className="modal-foot">
          <button type="button" className="primary-btn" onClick={onClose}>
            {t('明白了', 'GOT IT')}
          </button>
        </footer>
      </div>
    </div>
  );
}
