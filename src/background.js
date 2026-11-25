import { DEFAULTS } from './shared/settings.js';

chrome.runtime.onInstalled.addListener(async () => {
  const { vfx } = await chrome.storage.sync.get('vfx');
  if (!vfx) await chrome.storage.sync.set({ vfx: DEFAULTS });
});

// Keyboard shortcuts -> engine running inside the active tab.
const CMD = { 'fx-snap': 'snap', 'fx-scroll': 'scroll', 'fx-clones': 'clones', 'fx-orb': 'orb' };
chrome.commands.onCommand.addListener(async (command, tab) => {
  const effect = CMD[command];
  if (!effect) return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!t) return;
  chrome.runtime.sendMessage({ to: 'engine', tabId: t.id, cmd: { type: 'trigger', effect } }).catch(() => {});
});

// Engine iframes ask which tab they live in.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to === 'background' && msg.type === 'whoami') {
    sendResponse({ tabId: sender.tab?.id ?? null });
  }
});
