// Shared settings schema + defaults (used by popup, engine and background).
export const DEFAULTS = {
  enabled: true,
  effects: { snap: true, scroll: true, clones: true, orb: true },
  sensitivity: 0.5,        // 0..1 gesture sensitivity
  soundConfirm: true,      // require the snap "click" from the mic
  dustDuration: 2.8,       // seconds
  dustDirection: 'right',  // right | left | up | down (as others see you)
  cloneCount: 2,           // 2..4
  muteWhileGone: true,     // mute mic while vanished / sealed
  sfxVolume: 0.8,          // 0..1
  sfxToCall: true,         // mix sound effects into the mic sent to the call
  sfxLocal: true,          // play sound effects on your own speakers
};

export function mergeSettings(stored) {
  const s = { ...DEFAULTS, ...(stored || {}) };
  s.effects = { ...DEFAULTS.effects, ...((stored && stored.effects) || {}) };
  return s;
}

export async function loadSettings() {
  if (!globalThis.chrome?.storage?.sync) return mergeSettings();
  const { vfx } = await chrome.storage.sync.get('vfx');
  return mergeSettings(vfx);
}

export async function saveSettings(s) {
  if (!globalThis.chrome?.storage?.sync) return;
  await chrome.storage.sync.set({ vfx: s });
}
