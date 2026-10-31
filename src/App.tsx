import { useEffect, useMemo, useRef, useState } from 'react';
import { compileCard, validateDeck, validateRegisters, type CompiledCard } from './engine/analyze';
import { personaForSeed, Battle } from './engine/battle';
import { buildReport, type BattleReport } from './engine/report';
import {
  DEFAULT_ART,
  compileAiDeck,
  defaultRegisters,
  localizeStarterSlots,
  starterCards,
  type DeckSlot,
} from './content/deck';
import type { AiConfig, AiDeckMeta } from './engine/ai';
import { useLang } from './i18n';
import { BootScreen, RulesModal } from './ui/BootScreen';
import BuildScreen from './ui/BuildScreen';
import BattleScreen from './ui/BattleScreen';
import ReportScreen from './ui/ReportScreen';
import LanguageToggle from './ui/LanguageToggle';

type Screen = 'boot' | 'build' | 'battle' | 'report';

function newSeed(): number {
  return Math.floor(Math.random() * 900000) + 1000;
}

export default function App() {
  const lang = useLang();
  const [screen, setScreen] = useState<Screen>('boot');
  const [showRules, setShowRules] = useState(false);
  const [slots, setSlots] = useState<DeckSlot[]>(() => starterCards(lang));
  const [registers, setRegisters] = useState(() => defaultRegisters(lang));
  const [seed, setSeed] = useState(newSeed);
  const [aiMode, setAiMode] = useState<'heuristic' | 'llm'>('heuristic');
  const [aiConfig, setAiConfig] = useState<AiConfig>({ endpoint: '', model: 'gpt-4o-mini', apiKey: '', timeoutMs: 8000 });
  const [battle, setBattle] = useState<Battle | null>(null);
  const [report, setReport] = useState<BattleReport | null>(null);
  const previousLang = useRef(lang);

  const aiDeck = useMemo(() => compileAiDeck(lang), [lang]);
  const persona = useMemo(() => personaForSeed(seed), [seed]);

  // Switching language converts untouched starter content only. Custom cards,
  // edited sources and user registers keep their exact code and values.
  useEffect(() => {
    if (previousLang.current === lang) return;
    const from = previousLang.current;
    previousLang.current = lang;
    setSlots((current) => localizeStarterSlots(current, lang));
    setRegisters((current) => {
      const previousDefaults = defaultRegisters(from);
      const sameAsDefaults = JSON.stringify(current) === JSON.stringify(previousDefaults);
      return sameAsDefaults ? defaultRegisters(lang) : current;
    });
  }, [lang]);

  const cardCompiles = useMemo(
    () =>
      slots.map((s) => {
        const res = compileCard(s.source, registers);
        // Card faces are presentation only, but they must travel with the compiled card
        // into the battle, otherwise the player's art never reaches the table.
        if (res.value) res.value.art = s.art ? { ...s.art } : { ...DEFAULT_ART };
        return res;
      }),
    [slots, registers],
  );
  const cards = useMemo(() => cardCompiles.map((r) => r.value).filter((c): c is CompiledCard => !!c), [cardCompiles]);
  const allCardsOk = cardCompiles.every((r) => r.ok);
  const regDiags = useMemo(() => validateRegisters(registers), [registers]);
  const deckDiags = useMemo(() => {
    if (!allCardsOk || cards.length !== slots.length) return [];
    return validateDeck(cards);
  }, [allCardsOk, cards, slots.length]);
  const regBlocking = regDiags.some((d) => d.severity === 'error');
  const deckBlocking = deckDiags.some((d) => d.severity === 'error');
  const canStart = allCardsOk && !regBlocking && !deckBlocking && cards.length >= 5;

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [screen]);

  const startBattle = (designedDeck?: CompiledCard[], deckMeta?: AiDeckMeta) => {
    if (!canStart) return;
    const b = new Battle({
      seed,
      playerDeck: cards,
      registers: registers.map((r) => ({ ...r, enumValues: r.enumValues ? [...r.enumValues] : undefined })),
      aiDeck: designedDeck ?? aiDeck,
      aiDeckMeta: deckMeta ?? { source: 'fixed' },
      aiMode,
      aiConfig: aiMode === 'llm' ? { ...aiConfig } : undefined,
    });
    setBattle(b);
    setReport(null);
    setScreen('battle');
  };

  const finishBattle = () => {
    if (!battle) return;
    setReport(buildReport(battle));
    setScreen('report');
  };

  const again = (sameSeed: boolean) => {
    if (!sameSeed) setSeed(newSeed());
    setBattle(null);
    setReport(null);
    setScreen('build');
  };

  const resetBuild = () => {
    setSlots(starterCards(lang));
    setRegisters(defaultRegisters(lang));
  };

  return (
    <div className="app">
      <LanguageToggle />
      {screen === 'boot' && (
        <BootScreen
          onStart={() => setScreen('build')}
          onRules={() => setShowRules(true)}
        />
      )}
      {screen === 'build' && (
        <BuildScreen
          slots={slots}
          setSlots={setSlots}
          registers={registers}
          setRegisters={setRegisters}
          cardCompiles={cardCompiles}
          deckDiags={deckDiags}
          regDiags={regDiags}
          canStart={canStart}
          seed={seed}
          setSeed={setSeed}
          aiMode={aiMode}
          setAiMode={setAiMode}
          aiConfig={aiConfig}
          setAiConfig={setAiConfig}
          persona={persona}
          aiDeck={aiDeck}
          onStart={startBattle}
          onReset={resetBuild}
          onRules={() => setShowRules(true)}
          onBoot={() => setScreen('boot')}
        />
      )}
      {screen === 'battle' && battle && (
        <BattleScreen
          battle={battle}
          onFinish={finishBattle}
          onQuit={() => {
            setBattle(null);
            setScreen('build');
          }}
          onRules={() => setShowRules(true)}
        />
      )}
      {screen === 'report' && report && battle && (
        <ReportScreen
          report={report}
          battle={battle}
          onAgain={again}
          onBoot={() => {
            setBattle(null);
            setReport(null);
            setScreen('boot');
          }}
        />
      )}
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
    </div>
  );
}
