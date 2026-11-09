import { Plus } from 'lucide-react';
import { copy, type Locale } from '../copy.ts';

interface HeaderProps {
  locale: Locale;
  onLocale: (locale: Locale) => void;
  conversation: boolean;
  onNewChat: () => void;
}

/** Minimal page chrome; starting a new chat also stops an active response. */
export function Header({ locale, onLocale, conversation, onNewChat }: HeaderProps) {
  const text = copy[locale];
  return (
    <header className="site-header">
      <button type="button" className="wordmark" onClick={onNewChat} aria-label={`${text.brand} — ${text.newChat}`}>
        <img className="wordmark-image" src="/brand/nihao-logo.png" alt="" />
      </button>
      <div className="header-actions">
        {conversation && <button type="button" className="new-chat-button" aria-label={text.newChat} title={text.newChat} onClick={onNewChat}><Plus size={18} strokeWidth={1.5} /><span>{text.newChat}</span></button>}
        <div className="language-switch" role="group" aria-label={text.language}>
          <button type="button" lang="zh" aria-label={text.chinese} aria-pressed={locale === 'zh'} onClick={() => onLocale('zh')}>中文</button>
          <button type="button" lang="en" aria-label={text.english} aria-pressed={locale === 'en'} onClick={() => onLocale('en')}>EN</button>
        </div>
      </div>
    </header>
  );
}
