import { useI18n } from './i18n.js';

/** zh-CN / en toggle. Shown in the top bar and on the login card. */
export function LangSwitch() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label="Language / 语言">
      <button
        type="button"
        className={locale === 'zh-CN' ? 'lang-btn active' : 'lang-btn'}
        onClick={() => setLocale('zh-CN')}
      >
        中文
      </button>
      <button
        type="button"
        className={locale === 'en' ? 'lang-btn active' : 'lang-btn'}
        onClick={() => setLocale('en')}
      >
        EN
      </button>
    </div>
  );
}
