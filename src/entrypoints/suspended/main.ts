/**
 * Lazy-restore placeholder. Costs almost nothing while the tab sits in the background and turns
 * into the real page the moment it becomes visible.
 */
import { t } from '../../lib/i18n';
import '../../ui/styles.css';
import './page.css';

const params = new URLSearchParams(location.search);
const url = params.get('url') ?? '';
const title = params.get('title') || url;
const safe = /^(https?|file|ftp):/i.test(url);
const favicon = `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;

document.title = title;
(document.getElementById('favicon') as HTMLLinkElement).href = favicon;
(document.getElementById('icon') as HTMLImageElement).src = favicon;
document.getElementById('title')!.textContent = title;
document.getElementById('host')!.textContent = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
})();
document.getElementById('hint')!.textContent = safe ? t('Loading when you look at it…') : t('This address cannot be opened automatically.');

const go = () => {
  if (safe) location.replace(url);
};
document.getElementById('go')!.addEventListener('click', go);
if (document.visibilityState === 'visible') go();
else document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && go());
