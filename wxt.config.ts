import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  srcDir: 'src',
  publicDir: 'public',
  vite: () => ({ plugins: [preact()] }),
  hooks: {
    // WXT derives the action title from popup.html's <title>; keep it localised instead.
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.action) manifest.action.default_title = '__MSG_actionTitle__';
    },
  },
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    minimum_chrome_version: '121',
    permissions: ['tabs', 'tabGroups', 'storage', 'unlimitedStorage', 'alarms', 'sidePanel', 'notifications', 'favicon'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: { default_title: '__MSG_actionTitle__' },
    side_panel: { default_path: 'sidepanel.html' },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+K' },
        description: '__MSG_cmdPalette__',
      },
      'apply-workspace': {
        suggested_key: { default: 'Alt+Shift+C' },
        description: '__MSG_cmdApply__',
      },
      undo: {
        suggested_key: { default: 'Alt+Shift+Z' },
        description: '__MSG_cmdUndo__',
      },
      'open-side-panel': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: '__MSG_cmdSidePanel__',
      },
      'next-workspace': { description: '__MSG_cmdNextWorkspace__' },
      'archive-ungrouped': { description: '__MSG_cmdArchiveUngrouped__' },
    },
  },
});
