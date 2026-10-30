import { setLang, useLang } from '../i18n';

/**
 * Global language switch. It stays mounted above every screen and every modal,
 * so the player can flip the interface at any moment without losing state.
 */
export default function LanguageToggle() {
  const lang = useLang();
  const next = lang === 'en' ? 'zh' : 'en';
  const label = lang === 'en' ? 'Switch to Chinese' : 'Switch to English';

  return (
    <button
      type="button"
      className="language-toggle"
      onClick={() => setLang(next)}
      aria-label={label}
      title={label}
      data-testid="language-toggle"
    >
      <span className="language-globe" aria-hidden="true">◎</span>
      <span className={lang === 'en' ? 'on' : ''}>EN</span>
      <i aria-hidden="true">/</i>
      <span className={lang === 'zh' ? 'on' : ''}>中文</span>
    </button>
  );
}
