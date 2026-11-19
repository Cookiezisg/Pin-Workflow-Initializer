/** Shown instead of a site a focus rule blocks in the current workspace. */
import { hostOf } from '../../core/match';
import { t } from '../../lib/i18n';
import { call } from '../../lib/rpc';
import '../../ui/styles.css';
import '../suspended/page.css';

const params = new URLSearchParams(location.search);
const url = params.get('url') ?? '';
const ws = params.get('ws') ?? '';
const host = hostOf(url);
const ALLOW_MINUTES = 10;

document.title = t('{0} is blocked', host);
document.getElementById('headline')!.textContent = t('{0} is blocked', host);
document.getElementById('sub')!.textContent = ws ? t('You are in {0}. Stay focused.', ws) : t('Stay focused.');
document.getElementById('rules')!.textContent = t('Edit rules');

const back = document.getElementById('back')!;
back.textContent = t('Go back');
back.addEventListener('click', async () => {
  if (history.length > 1) history.back();
  else {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  }
});

const allow = document.getElementById('allow')!;
allow.textContent = t('Allow for {0} minutes', ALLOW_MINUTES);
allow.addEventListener('click', async () => {
  if (!/^https?:/i.test(url)) return;
  await call('allowHost', { host, minutes: ALLOW_MINUTES });
  location.replace(url);
});
