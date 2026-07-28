(async () => {
  // Sigurnosna provjera (27.7.2026, nakon Codex bezbjednosnog audita) - ikonica
  // (tab.icon, app.icon iz tuđeg manifesta, appId iz board-layout kartice) se na
  // više mjesta ubacuje u innerHTML kao dio href="#icon-tabler-<ovo>". Bez ovoga
  // zlonamjeran/pokvaren tool manifest ili ručno izmijenjen dashboard-state.json
  // (npr. prenesen sa drugog računara) može ubaciti proizvoljan HTML/JS. Dozvoljava
  // SAMO kebab-case tabler-stil imena (isti oblik kao TAB_ICONS niže) - sve ostalo
  // pada na bezbjedan default.
  function safeIconName(icon, fallback) {
    return typeof icon === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(icon) ? icon : (fallback || 'tool');
  }
  // Isti princip za appId koji se ispisuje u porukama grešaka - dolazi iz
  // dashboard-state.json (card.dataset.appId), ne iz apps-core registra, pa nije
  // garantovano da je prošao kroz ID_RE validaciju.
  function safeAppIdText(id) {
    return typeof id === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) ? id : '?';
  }
  const STATE_PREFIX = 'aizdravo:';
  const STATE_EXCLUDED_KEYS = new Set(['aizdravo:error-log']);
  let stateSyncTimer = null;
  const pendingStateChanges = new Map();
  const saveStatusEl = document.getElementById('saveStatus');
  const saveStatusText = document.getElementById('saveStatusText');
  const toastEl = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');
  const toastAction = document.getElementById('toastAction');
  let toastTimer = null;
  let saveStatusTimer = null;

  function setSaveStatus(state, message) {
    if (!saveStatusEl || !saveStatusText) return;
    saveStatusEl.classList.toggle('is-saving', state === 'saving');
    saveStatusEl.classList.toggle('is-error', state === 'error');
    saveStatusText.textContent = message || (state === 'saving' ? 'Čuvanje...' : state === 'error' ? 'Sačuvano lokalno' : 'Sačuvano');
    clearTimeout(saveStatusTimer);
    if (state === 'saved') {
      saveStatusTimer = setTimeout(() => saveStatusEl.classList.add('is-quiet'), 1800);
    } else {
      saveStatusEl.classList.remove('is-quiet');
    }
  }

  function showToast(message, actionLabel, action) {
    if (!toastEl || !toastMessage || !toastAction) return;
    clearTimeout(toastTimer);
    toastMessage.textContent = message;
    toastAction.hidden = !actionLabel;
    toastAction.textContent = actionLabel || '';
    toastAction.onclick = action ? () => {
      action();
      hideToast();
    } : null;
    toastEl.classList.add('is-open');
    toastEl.setAttribute('aria-hidden', 'false');
    toastTimer = setTimeout(hideToast, actionLabel ? 9000 : 3200);
  }

  function hideToast() {
    if (!toastEl) return;
    toastEl.classList.remove('is-open');
    toastEl.setAttribute('aria-hidden', 'true');
  }

  const confirmOverlay = document.getElementById('confirmOverlay');
  const confirmMessage = document.getElementById('confirmMessage');
  const confirmCancel = document.getElementById('confirmCancel');
  const confirmAccept = document.getElementById('confirmAccept');
  let confirmResolver = null;
  let confirmReturnFocus = null;

  function closeConfirmation(result) {
    if (!confirmOverlay) return;
    confirmOverlay.classList.remove('is-open');
    confirmOverlay.setAttribute('aria-hidden', 'true');
    const resolver = confirmResolver;
    confirmResolver = null;
    if (confirmReturnFocus && confirmReturnFocus.isConnected) confirmReturnFocus.focus();
    confirmReturnFocus = null;
    if (resolver) resolver(result);
  }

  function askConfirmation(message, trigger) {
    if (!confirmOverlay || !confirmMessage || !confirmCancel || !confirmAccept) return Promise.resolve(false);
    confirmReturnFocus = trigger || document.activeElement;
    confirmMessage.textContent = message;
    confirmOverlay.classList.add('is-open');
    confirmOverlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => confirmCancel.focus());
    return new Promise(resolve => { confirmResolver = resolve; });
  }

  if (confirmCancel) confirmCancel.addEventListener('click', () => closeConfirmation(false));
  if (confirmAccept) confirmAccept.addEventListener('click', () => closeConfirmation(true));
  if (confirmOverlay) confirmOverlay.addEventListener('click', event => {
    if (event.target === confirmOverlay) closeConfirmation(false);
  });

  function collectDashboardState() {
    const values = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(STATE_PREFIX) || STATE_EXCLUDED_KEYS.has(key)) continue;
        const value = localStorage.getItem(key);
        if (value !== null) values[key] = value;
      }
    } catch (err) {
      // Server sync is an enhancement. The dashboard still works if the
      // browser blocks storage access.
    }
    return values;
  }

  async function seedStateFile() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
    try {
      const response = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, values: collectDashboardState() }),
        cache: 'no-store',
      });
      return response.ok;
    } catch (err) {
      return false;
    }
  }

  async function flushStateChanges(keepalive = false) {
    if (!pendingStateChanges.size) return true;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      setSaveStatus('error', 'Sačuvano na uređaju');
      return false;
    }

    const changes = Object.fromEntries(pendingStateChanges);
    pendingStateChanges.clear();
    setSaveStatus('saving');
    try {
      const response = await fetch('/api/state', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, changes }),
        cache: 'no-store',
        keepalive,
      });
      if (response.ok) {
        setSaveStatus('saved');
        return true;
      }
    } catch (err) {
      // Requeue below so a later interaction can retry the same change.
    }
    Object.entries(changes).forEach(([key, value]) => {
      // A newer edit to the same key may have arrived while this request
      // was in flight. Never replace that newer pending value with the
      // older value from the failed request.
      if (!pendingStateChanges.has(key)) pendingStateChanges.set(key, value);
    });
    setSaveStatus('error', 'Sačuvano lokalno');
    return false;
  }

  function scheduleStateSync() {
    if (stateSyncTimer) clearTimeout(stateSyncTimer);
    stateSyncTimer = setTimeout(() => {
      stateSyncTimer = null;
      flushStateChanges();
    }, 60);
  }

  function persistValue(key, value) {
    let localSaved = true;
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      localSaved = false;
    }
    // Server persistence should still work when browser storage is
    // blocked or unavailable.
    pendingStateChanges.set(key, value);
    setSaveStatus(localSaved ? 'saving' : 'error', localSaved ? 'Čuvanje...' : 'Čuvanje nije uspjelo');
    scheduleStateSync();
    return localSaved;
  }

  function removePersistedValue(key) {
    let localRemoved = true;
    try {
      localStorage.removeItem(key);
    } catch (err) {
      localRemoved = false;
    }
    pendingStateChanges.set(key, null);
    setSaveStatus(localRemoved ? 'saving' : 'error', localRemoved ? 'Čuvanje...' : 'Čuvanje nije uspjelo');
    scheduleStateSync();
    return localRemoved;
  }

  async function hydrateStateFromServer() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return 'unavailable';
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) {
        // Korumpiran/nečitljiv dashboard-state.json (npr. prekinut upis
        // van atomskog puta, ručno editovanje) - server javi
        // state_read_failed. Browser i dalje ima kompletan keš u
        // localStorage, pa se fajl može ODMAH obnoviti iz njega umjesto
        // da sync ostane trajno mrtav do ručne popravke (23.7.2026).
        try {
          const payload = await response.json();
          if (payload && payload.error === 'state_read_failed') return 'corrupt';
        } catch (err) { /* nije JSON - tretiraj kao nedostupno */ }
        return 'unavailable';
      }
      const payload = await response.json();
      if (!payload || payload.exists !== true) return 'missing';
      if (!payload.values || typeof payload.values !== 'object') return 'unavailable';

      const serverKeys = new Set(Object.keys(payload.values));
      const localKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STATE_PREFIX) && !STATE_EXCLUDED_KEYS.has(key)) localKeys.push(key);
      }
      localKeys.forEach(key => {
        if (!serverKeys.has(key)) localStorage.removeItem(key);
      });
      Object.entries(payload.values).forEach(([key, value]) => {
        if (key.startsWith(STATE_PREFIX) && !STATE_EXCLUDED_KEYS.has(key) && typeof value === 'string') {
          localStorage.setItem(key, value);
        }
      });
      return 'restored';
    } catch (err) {
      return 'unavailable';
    }
  }

  const stateHydration = await hydrateStateFromServer();
  if (stateHydration === 'missing') await seedStateFile();
  if (stateHydration === 'corrupt') {
    const healed = await seedStateFile();
    setSaveStatus(healed ? 'saved' : 'error', healed ? 'Sačuvano' : 'Lokalni režim');
    if (healed) showToast('Serverski fajl stanja je bio oštećen - obnovljen je iz lokalne kopije.');
  } else {
    setSaveStatus(stateHydration === 'unavailable' ? 'error' : 'saved', stateHydration === 'unavailable' ? 'Lokalni režim' : 'Sačuvano');
  }

  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith(STATE_PREFIX) || STATE_EXCLUDED_KEYS.has(event.key)) return;
    showToast('Dashboard je promijenjen u drugom browser tabu.', 'Učitaj promjene', () => location.reload());
  });

  // Jednokratna migracija (23.7.2026): Home tab je do sada bio klasičan
  // radni tab (mogao je imati sekcije) - sad je welcome wizard i NIKAD
  // više ne prima sekcije/widgete (Ognjenov zahtjev). Bilo šta što je
  // ranije stajalo na Home boardu (npr. Ognjenova stvarna "yuo" test
  // kartica) se NE briše - prebacuje se na prvi drugi postojeći tab,
  // JEDNOM, prije nego board bootstrap ispod uopšte pokuša učitati
  // Home-ov (sad trajno skriveni) board. Ako još ne postoji nijedan
  // drugi tab, migracija se odgađa (ključ se NE postavlja) i pokušava
  // ponovo sljedećeg puta - podaci ostaju netaknuti u međuvremenu.
  (function migrateHomeBoardToFirstOtherTab() {
    const MIGRATED_KEY = 'aizdravo:home-board-migrated-v1';
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;
      const homeRaw = localStorage.getItem('aizdravo:board-layout:v1');
      const homeLayout = homeRaw ? JSON.parse(homeRaw) : [];
      if (!Array.isArray(homeLayout) || !homeLayout.length) {
        persistValue(MIGRATED_KEY, '1');
        return;
      }
      const tabsRaw = localStorage.getItem('aizdravo:tabs:v1');
      const tabs = tabsRaw ? JSON.parse(tabsRaw) : [];
      const target = Array.isArray(tabs) ? tabs.find(t => t && t.id && t.id !== 'home') : null;
      if (!target) return; // nema jos kuda - probaj ponovo sljedeci put
      const targetKey = 'aizdravo:board-layout:' + target.id;
      const existingRaw = localStorage.getItem(targetKey);
      let existing = [];
      try { existing = existingRaw ? JSON.parse(existingRaw) : []; } catch (err) { existing = []; }
      const merged = (Array.isArray(existing) ? existing : []).concat(homeLayout);
      persistValue(targetKey, JSON.stringify(merged));
      persistValue('aizdravo:board-layout:v1', '[]');
      persistValue(MIGRATED_KEY, '1');
      showToast('Sekcije sa uvodnog taba su prebačene na „' + (target.name || 'radni tab') + '“ - AI Zdravo tab je sad vodič.');
    } catch (err) {
      // migracija je best-effort - njen pad ne smije spriječiti load
    }
  })();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Set once the FX overlay block below runs (still before any real user
  // interaction, since both blocks execute synchronously on load) - lets
  // the board's drag code trigger the same click "connection" animation
  // without the two sections needing to be reordered in the file.
  let triggerBurst = () => {};

  // Same pattern as triggerBurst - lets the board section's phase
  // recalculation (alignDotGridToBoard) tell the FX overlay's canvas grid
  // to redraw with the new phase, without the two blocks needing reordering.
  let refreshGridDots = () => {};

  const THEME_KEY = 'aizdravo:theme:v1';
  // Stara pojedinačna tema (do 27.7.2026, samo JEDNA sopstvena tema
  // podržana) - fajl se više ne piše, čita se samo jednom za migraciju
  // u CUSTOM_THEMES_KEY niže ako novi ključ još ne postoji.
  const CUSTOM_THEME_KEY = 'aizdravo:custom-theme:v1';
  const CUSTOM_THEMES_KEY = 'aizdravo:custom-themes:v1';
  const THEME_IDS = new Set([
    'ai-zdravo',
    'neuralna-noc',
    'jadranski-signal',
    'smaragdni-tok',
    'crveni-puls',
    'elektricni-san',
  ]);
  let activeTheme = 'ai-zdravo';
  // Lista (27.7.2026, Ognjenov zahtjev - "opcija da se doda i vise od
  // jedne") umjesto ranijeg pojedinačnog customTheme objekta. Svaka
  // stavka: { id, name, accent }.
  let customThemes = [];
  let themeAccentRgb = [255, 140, 0];
  let themeGlowRgb = [255, 175, 90];
  const CUSTOM_THEME_VARIABLES = [
    '--bg', '--card', '--border', '--accent', '--accent-hover',
    '--accent-highlight', '--accent-rgb', '--accent-glow-rgb',
    '--accent-hue-rotate', '--accent-ink', '--text-soft', '--text-faint',
    '--sidebar-bg', '--modal-bg', '--switch-bg', '--glass-start-rgb',
    '--glass-end-rgb', '--floating-rgb', '--floating-hover-rgb',
  ];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeHex(value) {
    const raw = String(value || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
    if (/^[0-9a-f]{3}$/i.test(raw)) {
      return `#${raw.split('').map(char => char + char).join('').toLowerCase()}`;
    }
    return '#ff8c00';
  }

  function hexToRgb(hex) {
    const normalized = normalizeHex(hex).slice(1);
    return [0, 2, 4].map(index => Number.parseInt(normalized.slice(index, index + 2), 16));
  }

  function rgbToHex(rgb) {
    return `#${rgb.map(channel => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0')).join('')}`;
  }

  function rgbToHsl([red, green, blue]) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * (((b - r) / delta) + 2);
      else hue = 60 * (((r - g) / delta) + 4);
    }
    if (hue < 0) hue += 360;
    const lightness = (max + min) / 2;
    const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
    return [hue, saturation * 100, lightness * 100];
  }

  function hslToRgb(hue, saturation, lightness) {
    const h = ((hue % 360) + 360) % 360;
    const s = clamp(saturation, 0, 100) / 100;
    const l = clamp(lightness, 0, 100) / 100;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
    const offset = l - chroma / 2;
    let rgb = [0, 0, 0];
    if (h < 60) rgb = [chroma, x, 0];
    else if (h < 120) rgb = [x, chroma, 0];
    else if (h < 180) rgb = [0, chroma, x];
    else if (h < 240) rgb = [0, x, chroma];
    else if (h < 300) rgb = [x, 0, chroma];
    else rgb = [chroma, 0, x];
    return rgb.map(channel => Math.round((channel + offset) * 255));
  }

  function mixRgb(from, to, amount) {
    return from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount));
  }

  function buildCustomPalette(accentValue) {
    const accent = normalizeHex(accentValue);
    const accentRgb = hexToRgb(accent);
    const [hue, saturation] = rgbToHsl(accentRgb);
    const complementHue = (hue + 180) % 360;
    const backgroundSaturation = clamp(saturation * .22, 8, 24);
    const bgRgb = hslToRgb(complementHue, backgroundSaturation, 6);
    const sidebarRgb = hslToRgb(complementHue, backgroundSaturation + 2, 7.5);
    const cardRgb = hslToRgb(complementHue, backgroundSaturation + 1, 11);
    const borderRgb = hslToRgb(hue, clamp(saturation * .28, 12, 30), 21);
    const modalRgb = hslToRgb(complementHue, backgroundSaturation + 1, 10);
    const switchRgb = hslToRgb(hue, clamp(saturation * .3, 14, 32), 16);
    const glassStartRgb = hslToRgb(complementHue, backgroundSaturation + 3, 16);
    const floatingRgb = hslToRgb(complementHue, backgroundSaturation + 2, 12);
    const floatingHoverRgb = hslToRgb(complementHue, backgroundSaturation + 4, 18);
    const hoverRgb = mixRgb(accentRgb, [255, 255, 255], .16);
    const highlightRgb = mixRgb(accentRgb, [255, 255, 255], .64);
    const glowRgb = mixRgb(accentRgb, [255, 255, 255], .3);
    const perceivedBrightness = accentRgb[0] * .299 + accentRgb[1] * .587 + accentRgb[2] * .114;
    const accentInk = perceivedBrightness > 155 ? rgbToHex(bgRgb) : '#ffffff';
    const textSoftRgb = hslToRgb(complementHue, 10, 69);
    const textFaintRgb = hslToRgb(complementHue, 10, 43);
    const rgbString = rgb => rgb.join(', ');
    const variables = {
      '--bg': rgbToHex(bgRgb),
      '--card': rgbToHex(cardRgb),
      '--border': rgbToHex(borderRgb),
      '--accent': accent,
      '--accent-hover': rgbToHex(hoverRgb),
      '--accent-highlight': rgbToHex(highlightRgb),
      '--accent-rgb': rgbString(accentRgb),
      '--accent-glow-rgb': rgbString(glowRgb),
      '--accent-hue-rotate': `${Math.round((hue - 33 + 360) % 360)}deg`,
      '--accent-ink': accentInk,
      '--text-soft': rgbToHex(textSoftRgb),
      '--text-faint': rgbToHex(textFaintRgb),
      '--sidebar-bg': rgbToHex(sidebarRgb),
      '--modal-bg': rgbToHex(modalRgb),
      '--switch-bg': rgbToHex(switchRgb),
      '--glass-start-rgb': rgbString(glassStartRgb),
      '--glass-end-rgb': rgbString(bgRgb),
      '--floating-rgb': rgbString(floatingRgb),
      '--floating-hover-rgb': rgbString(floatingHoverRgb),
    };
    return {
      accent,
      variables,
      preview: {
        bg: variables['--bg'],
        sidebar: variables['--sidebar-bg'],
        card: variables['--card'],
        border: variables['--border'],
        accent,
        highlight: variables['--accent-highlight'],
      },
    };
  }

  function clearCustomThemeVariables() {
    CUSTOM_THEME_VARIABLES.forEach(variable => document.documentElement.style.removeProperty(variable));
  }

  function applyCustomThemeVariables(theme) {
    const palette = buildCustomPalette(theme.accent);
    Object.entries(palette.variables).forEach(([variable, value]) => {
      document.documentElement.style.setProperty(variable, value);
    });
    return palette;
  }

  function genCustomThemeId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function findCustomTheme(id) {
    return customThemes.find(theme => theme.id === id) || null;
  }

  function saveCustomThemes() {
    persistValue(CUSTOM_THEMES_KEY, JSON.stringify(customThemes));
  }

  function loadCustomThemes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY) || 'null');
      if (Array.isArray(parsed)) {
        return parsed
          .filter(theme => theme && typeof theme.id === 'string' && typeof theme.name === 'string' && theme.name.trim())
          .map(theme => ({ id: theme.id, name: theme.name.trim().slice(0, 28), accent: normalizeHex(theme.accent) }));
      }
    } catch (err) {
      // pokvaren JSON - padni na migraciju/praznu listu ispod
    }
    // Jednokratna migracija (27.7.2026) - stara verzija je podržavala
    // SAMO jednu sopstvenu temu. Ako ta stara stavka postoji i nova
    // lista još nije nikad sačuvana, prebaci je umjesto da nestane.
    try {
      const old = JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) || 'null');
      if (old && typeof old.name === 'string' && old.name.trim()) {
        return [{ id: genCustomThemeId(), name: old.name.trim().slice(0, 28), accent: normalizeHex(old.accent) }];
      }
    } catch (err) {
      // nema ni stare teme - prazna lista
    }
    return [];
  }

  function readThemeRgb(variable, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    const parts = raw.split(',').map(value => Number.parseInt(value.trim(), 10));
    return parts.length === 3 && parts.every(Number.isFinite) ? parts : fallback;
  }

  function syncThemeChoices() {
    document.querySelectorAll('[data-theme-option]').forEach(choice => {
      choice.setAttribute('aria-checked', String(choice.dataset.themeOption === activeTheme));
    });
  }

  function setTheme(themeId, persist = true) {
    // "custom:<id>" format (27.7.2026, više sopstvenih tema) - prefiks
    // razdvaja od built-in id-jeva i kaže TAČNO koja sopstvena tema.
    const customId = typeof themeId === 'string' && themeId.startsWith('custom:') ? themeId.slice(7) : null;
    const customMatch = customId ? findCustomTheme(customId) : null;
    activeTheme = customMatch ? ('custom:' + customMatch.id) : (THEME_IDS.has(themeId) ? themeId : 'ai-zdravo');
    clearCustomThemeVariables();
    if (customMatch) {
      document.documentElement.dataset.theme = 'custom';
      applyCustomThemeVariables(customMatch);
    } else if (activeTheme === 'ai-zdravo') {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = activeTheme;
    }
    themeAccentRgb = readThemeRgb('--accent-rgb', [255, 140, 0]);
    themeGlowRgb = readThemeRgb('--accent-glow-rgb', [255, 175, 90]);
    syncThemeChoices();
    if (persist) persistValue(THEME_KEY, activeTheme);
    refreshGridDots();
  }

  customThemes = loadCustomThemes();
  try {
    activeTheme = localStorage.getItem(THEME_KEY) || 'ai-zdravo';
  } catch (err) {
    activeTheme = 'ai-zdravo';
  }
  setTheme(activeTheme, false);

  const GRID_VISIBILITY_KEY = 'aizdravo:grid-visible';
  let gridVisible = true;
  try {
    gridVisible = localStorage.getItem(GRID_VISIBILITY_KEY) !== '0';
  } catch (err) {
    gridVisible = true;
  }
  document.documentElement.classList.toggle('grid-hidden', !gridVisible);

  function setGridVisible(visible, persist = true) {
    gridVisible = visible;
    document.documentElement.classList.toggle('grid-hidden', !visible);
    if (persist) {
      try {
        persistValue(GRID_VISIBILITY_KEY, visible ? '1' : '0');
      } catch (err) {
        // Losing this preference must not break the dashboard.
      }
    }
    refreshGridDots();
  }

  const LAYOUT_LOCK_KEY = 'aizdravo:layout-locked';
  let layoutLocked = false;
  try {
    layoutLocked = localStorage.getItem(LAYOUT_LOCK_KEY) === '1';
  } catch (err) {
    layoutLocked = false;
  }
  document.documentElement.classList.toggle('layout-locked', layoutLocked);

  function setLayoutLocked(locked, persist = true) {
    layoutLocked = !!locked;
    document.documentElement.classList.toggle('layout-locked', layoutLocked);
    const toggle = document.getElementById('layoutLockToggle');
    if (toggle) toggle.setAttribute('aria-checked', String(layoutLocked));
    boardAPIs.forEach(api => {
      if (api && api.setLocked) api.setLocked(layoutLocked);
    });
    if (persist) persistValue(LAYOUT_LOCK_KEY, layoutLocked ? '1' : '0');
    showToast(layoutLocked ? 'Raspored je zaključan.' : 'Raspored je otključan.');
  }

  // Status čuvanja ("Sačuvano" gore desno) - opciono sakrivanje (27.7.2026,
  // Ognjenov zahtjev). Isti obrazac kao layout-locked: klasa na <html>,
  // CSS sakriva element, stanje se pamti preko persistValue.
  const SAVE_STATUS_HIDDEN_KEY = 'aizdravo:save-status-hidden';
  let saveStatusHidden = false;
  try {
    saveStatusHidden = localStorage.getItem(SAVE_STATUS_HIDDEN_KEY) === '1';
  } catch (err) {
    saveStatusHidden = false;
  }
  document.documentElement.classList.toggle('save-status-hidden', saveStatusHidden);

  function setSaveStatusHidden(hidden, persist = true) {
    saveStatusHidden = !!hidden;
    document.documentElement.classList.toggle('save-status-hidden', saveStatusHidden);
    const toggle = document.getElementById('saveStatusToggle');
    if (toggle) toggle.setAttribute('aria-checked', String(!saveStatusHidden));
    if (persist) persistValue(SAVE_STATUS_HIDDEN_KEY, saveStatusHidden ? '1' : '0');
  }

  // Phase offset (in px, always in (-GRID, 0]) that shifts the raw dot
  // grid math (c * GRID, r * GRID) onto the SAME dots the background
  // actually paints. Kept at 0,0 until the board section computes the
  // real value - see alignDotGridToBoard() below.
  let dotPhaseX = 0;
  let dotPhaseY = 0;

  // Same forward-reference pattern as triggerBurst/refreshGridDots above -
  // lets the sidebar collapse toggle (declared before the board section
  // below) re-run the board's own width/dot-phase recalculation once
  // --sidebar-w finishes animating, without the two sections needing to
  // be reordered in the file. updateBoardWidth/alignDotGridToBoard are
  // declared INSIDE the `if (board)` block further down (block-scoped),
  // so nothing outside that block can call them by name directly.
  let recalcBoardLayout = () => {};

  // Same idea again - lets the custom-tabs section (also declared before
  // the board section, further down) set up edge-resize/drag-reorder/
  // persistence on a NEWLY CREATED board the same way Početna's board
  // gets set up, without duplicating that logic. Assigned once, inside
  // `if (board)`, to the real per-board initializer (closes over GRID/
  // COLS_GRID so every board - Početna's or a custom tab's - stays in
  // sync with the same live column count).
  let initBoard = () => {};
  let openSectionRename = () => {};
  let openSectionMove = () => {};
  let requestAddSection = () => {};
  let closeTabModalGlobal = () => {};
  let closeMoveSectionModalGlobal = () => {};
  // Poveži alat sa sekcijom (26.7.2026) - ista forward-reference potreba
  // kao openSectionMove iznad: renderCard (board blok, izvršava se prvo)
  // treba pozvati implementaciju koja živi niže, uz modal/nav
  // infrastrukturu (custom-tabs blok).
  let openAttachAppModal = () => {};
  let closeAttachAppModalGlobal = () => {};
  // App/widget sloj (23.7.2026) - iste forward-reference kao gore:
  // board blok (koji se izvršava prvi) crta widget/folder sadržaj i
  // pločice koje otvaraju app tabove, a stvarne implementacije žive u
  // custom-tabs bloku niže (trebaju modal/nav infrastrukturu).
  let openAppTabGlobal = () => {};
  let openFolderEdit = () => {};
  let closeAppsPanelGlobal = () => {};
  let openAppsPanelGlobal = () => {};
  let renderInstalledAppsGlobal = () => {};
  let renderTopbarIdentityPreviewGlobal = () => {};

  // "Uklonjeni" alati: registrovan alat (script tag i dalje u
  // index.html) koji je korisnik uklonio kroz Podešavanja. Iz browsera
  // se fajl/script linija ne može obrisati, pa je uklanjanje = ova
  // lista + čišćenje svih instanci; fizičko brisanje fajlova je opisano
  // u APPS_AND_WIDGETS.md. Čita se svježe pri svakoj provjeri - jeftino
  // je, a znači da nikad ne može zastarjeti u odnosu na localStorage.
  const DISABLED_APPS_KEY = 'aizdravo:disabled-apps';
  function readDisabledApps() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DISABLED_APPS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
    } catch (err) {
      return [];
    }
  }
  function isAppDisabled(appId) {
    return readDisabledApps().includes(appId);
  }

  // Populated by initBoard() (one entry per board element, keyed by the
  // board itself) so the floating "add section" FAB - global, not scoped
  // to any one tab - can look up whichever board is CURRENTLY active at
  // click time and add a card to exactly that one, without needing its
  // own copy of the resize/persistence wiring.
  const boardAPIs = new Map();

  // Postavlja se NA true neposredno prije namjernog reload-a poslije
  // reset-a/importa: u tom trenutku je localStorage već prepisan novim
  // stanjem, a DOM još pokazuje STARO - pagehide-ov saveLayout bi
  // "istinu iz DOM-a" upisao preko tek uvezenih/obrisanih vrijednosti.
  // Uhvaćeno uživo 23.7.2026: poslije import round-tripa, board koji je
  // postojao u (praznom) DOM-u je pregazio svoj uvezeni layout sa [].
  let suppressUnloadLayoutSave = false;

  window.addEventListener('pagehide', () => {
    if (!suppressUnloadLayoutSave) {
      boardAPIs.forEach(api => {
        if (api && api.saveLayout) api.saveLayout();
      });
    }
    flushStateChanges(true);
  });

  // Same idea, for the FX overlay canvases (glow + burst) - their pixel
  // BUFFERS (canvas.width/height, device px) only get resized on a real
  // window `resize` event, but #fxFrame's own CSS box (position:fixed,
  // left:var(--sidebar-w)) changes width the instant the sidebar
  // collapses/expands, which is NOT a window resize. Left stale, the
  // canvas's internal coordinate space no longer matches its rendered
  // CSS size, so the browser stretches the drawn content to fit - every
  // dot (and the cursor-tracked glow) ends up visibly offset from where
  // the mouse actually is. Confirmed live: Ognjen reported exactly this
  // after collapsing the sidebar.
  let resizeFxOverlay = () => {};

  // ---------------- Tab switching ----------------

  const navItems = Array.from(document.querySelectorAll('.nav-item'));
  const views = Array.from(document.querySelectorAll('.view'));
  const indicator = document.getElementById('navIndicator');
  const nav = document.getElementById('nav');
  const ACTIVE_TAB_KEY = 'aizdravo:active-tab';

  function moveIndicatorTo(el) {
    const navRect = nav.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    indicator.style.transform = `translateY(${rect.top - navRect.top}px)`;
  }

  function activate(viewName) {
    const fallback = navItems[0] ? navItems[0].dataset.view : null;
    const target = navItems.some(n => n.dataset.view === viewName) ? viewName : fallback;
    if (!target) return;
    navItems.forEach(n => n.classList.toggle('is-active', n.dataset.view === target));
    views.forEach(v => v.classList.toggle('is-active', v.dataset.view === target));
    const activeNav = navItems.find(n => n.dataset.view === target);
    if (activeNav) moveIndicatorTo(activeNav);
    // A hidden view reports zero geometry. Re-evaluate the newly visible
    // board after tab switching so its final-track card receives the
    // exact right-safe-space inset, AND so the dot grid's phase is
    // recomputed against THIS board - without recalcBoardLayout() here,
    // switching tabs left the dot grid permanently phased to whichever
    // board was visible at page load (Početna's), so every other tab's
    // section corners silently drifted off the dots underneath them.
    requestAnimationFrame(() => {
      const activeView = views.find(view => view.dataset.view === target);
      const activeBoard = activeView && activeView.querySelector('.board');
      const api = activeBoard && boardAPIs.get(activeBoard);
      if (api && api.refreshRightLimits) api.refreshRightLimits();
      recalcBoardLayout();
    });
    try {
      persistValue(ACTIVE_TAB_KEY, target);
    } catch (err) {
      // Losing the last-open tab preference must not break navigation.
    }
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => activate(item.dataset.view));
  });

  window.addEventListener('resize', () => {
    const active = navItems.find(n => n.classList.contains('is-active'));
    if (active) moveIndicatorTo(active);
  });

  // Re-target whichever item is ACTIVE at frame time, not literally
  // navItems[0] - this rAF fires after the whole script (including the
  // custom-tabs block further down, which synchronously calls
  // activate(savedActiveTab) during load), so hardcoding [0] here
  // overwrote the already-correct indicator position back onto Početna
  // whenever the restored active tab was any other tab. Confirmed live
  // 23.7.2026: view showed "tjgh" active, indicator sat on "AI Zdravo".
  requestAnimationFrame(() => {
    const active = navItems.find(n => n.classList.contains('is-active')) || navItems[0];
    if (active) moveIndicatorTo(active);
  });

  // ---------------- Sidebar collapse ----------------
  // --sidebar-w drives BOTH .sidebar's width and .fx-frame's left edge
  // (both just read var(--sidebar-w)) - registered via @property in
  // style.css so a plain CSS `transition` on it animates the two
  // together from one source of truth, instead of needing a separate
  // transition on each that could drift out of sync.

  const sidebarEl = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const SIDEBAR_KEY = 'aizdravo:sidebar-collapsed';

  function applySidebarCollapsed(collapsed, animate) {
    const root = document.documentElement;
    // On page load we're restoring a PREVIOUS choice, not reacting to a
    // click - without this, a returning visitor who left it collapsed
    // would see it animate in from full width on every single load.
    if (!animate) root.classList.add('no-sidebar-transition');
    sidebarEl.classList.toggle('is-collapsed', collapsed);
    root.style.setProperty('--sidebar-w', collapsed ? '72px' : '264px');
    if (!animate) {
      // force a reflow so the instant value above is actually committed
      // before transitions get re-enabled on the next line - otherwise
      // the browser can coalesce both changes and animate this one too
      void root.offsetHeight;
      root.classList.remove('no-sidebar-transition');
    }
  }

  // Must match --sidebar-motion-duration in style.css. During this short
  // window the board and both FX canvases are synchronized on every
  // animation frame, instead of waiting for one final correction after
  // the sidebar has already stopped. That removes the small end-of-motion
  // jump and keeps the hover dots under the cursor throughout collapse.
  const SIDEBAR_TRANSITION_MS = 420;
  const SIDEBAR_SETTLE_BUFFER_MS = 48;
  let sidebarMotionRun = 0;

  function settleBoardAfterSidebarToggle() {
    recalcBoardLayout();
    resizeFxOverlay();
    const active = navItems.find(n => n.classList.contains('is-active'));
    if (active) moveIndicatorTo(active);
  }

  function trackSidebarMotion() {
    const run = ++sidebarMotionRun;
    const startedAt = performance.now();
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function frame(now) {
      if (run !== sidebarMotionRun) return;
      recalcBoardLayout();
      resizeFxOverlay();
      const active = navItems.find(n => n.classList.contains('is-active'));
      if (active) moveIndicatorTo(active);

      if (!reducedMotion && now - startedAt < SIDEBAR_TRANSITION_MS + SIDEBAR_SETTLE_BUFFER_MS) {
        requestAnimationFrame(frame);
        return;
      }
      settleBoardAfterSidebarToggle();
    }

    requestAnimationFrame(frame);
  }

  if (sidebarEl && sidebarToggle) {
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch (err) {
      collapsed = false;
    }
    applySidebarCollapsed(collapsed, false);
    sidebarToggle.setAttribute('aria-label', collapsed ? 'Proširi meni' : 'Sažmi meni');

    sidebarToggle.addEventListener('click', () => {
      collapsed = !collapsed;
      applySidebarCollapsed(collapsed, true);
      sidebarToggle.setAttribute('aria-label', collapsed ? 'Proširi meni' : 'Sažmi meni');
      try {
        persistValue(SIDEBAR_KEY, collapsed ? '1' : '0');
      } catch (err) {
        // private-browsing/quota-exceeded localStorage throws - losing
        // persistence for this toggle isn't worth breaking it over
      }
      trackSidebarMotion();
    });
  }

  // ---------------- Icons into placeholder cards ----------------

  document.querySelectorAll('.pcard').forEach((card, i) => {
    const icon = card.dataset.icon;
    card.innerHTML = `<div class="pcard-inner">${icon ? `<svg><use href="#icon-${icon}"></use></svg>` : ''}</div>`;
    card.style.animationDelay = `${i * 70}ms`;
  });

  // ---------------- Board: grid infrastructure only, section behavior TBD ----------------
  //
  // 20.7.2026 - stripped back to a clean slate on purpose. Everything that
  // used to live here (per-card {col,row} spans, resize-by-dragging-a-
  // corner-handle, SortableJS drag-reorder, the localStorage layout
  // schema, the FLIP reflow helper for resize) is DELETED, not just
  // disabled - Ognjen wants to rebuild section behavior from scratch as
  // its own deliberate design pass, not keep patching the old mechanic.
  // What's left is only the board/grid PLATFORM those old mechanics sat
  // on top of: board width + column count, and keeping the visible dot
  // grid in phase with the board - both still needed no matter what the
  // new section behavior ends up being.

  const board = document.getElementById('board');

  if (board) {
    const GRID = 28;
    // left/right safe space, in grid units (fractional allowed - the .5
    // here is a fine nudge of exactly one SUB-grid step, 14px, not a
    // whole GRID square). Was 2 (56px), then 1 (28px, "one square left"),
    // then 1.5 (42px, "one small square right" from there) - same
    // leftMargin formula below handles a fractional unit count fine, and
    // alignDotGridToBoard() re-derives the dot phase from the board's
    // ACTUAL rendered position either way, so no separate fix needed
    // anywhere else for a fractional value here.
    const SAFE_UNITS = 1.5;
    const MIN_COLS_GRID = 8;     // keeps the board inside narrow mobile viewports

    // Board width is NOT a fixed number - it fills whatever space is left
    // between two equal, grid-unit safe margins. Before this, the board
    // was a fixed 672px sitting inside a much wider canvas, so the left
    // safe space (56px, 2 grid units, from .view's own padding) and the
    // "right safe space" (whatever was left over past a static board
    // width) were wildly different on any wide window. Computing the
    // board's width live keeps both sides the same, always landing on a
    // real grid line, not just a CSS padding number that happens to work
    // at one specific viewport width.
    let COLS_GRID = 24;

    // The board's width fills whatever room is left after a fixed,
    // grid-unit left margin (SAFE_UNITS * GRID) - see the comment on
    // `let COLS_GRID` above for why the count itself is dynamic.
    const canvasWrapEl = document.getElementById('canvasWrap');
    function updateBoardWidth() {
      if (!canvasWrapEl) return false;
      // Use the element's full border-box width, not clientWidth.
      // clientWidth excludes a classic vertical scrollbar, which made the
      // dashboard's right limit jump left whenever enough sections caused
      // scrolling. The safe-space boundary belongs to the actual far-right
      // edge of the canvas; a scrollbar is only an overlay/control and must
      // not participate in the grid calculation.
      const totalWidth = canvasWrapEl.getBoundingClientRect().width;
      const leftMargin = SAFE_UNITS * GRID;
      // A card's visible right edge is inset 14px from the board track
      // edge by .pcard's right margin. To make that VISIBLE edge land as
      // close as possible to the same 42px safe space used on the left,
      // target one full grid unit (28px) between the board track edge and
      // the canvas edge, then add the card's 14px inset visually. Since
      // the board can only grow in whole 28px columns, round to the nearest
      // possible column count instead of always flooring and leaving an
      // unnecessarily large right gap.
      const targetBoardRightMargin = GRID;
      const available = totalWidth - leftMargin - targetBoardRightMargin;
      const next = Math.max(MIN_COLS_GRID, Math.round(available / GRID));
      const changed = next !== COLS_GRID;
      if (changed) {
        COLS_GRID = next;
        // Set on canvasWrapEl (shared ancestor of EVERY .board, current and
        // future custom tabs alike), NOT on the Početna `board` element
        // specifically - custom properties only cascade DOWN the tree, so
        // setting it on one sibling board would leave every other board
        // reading the CSS fallback (24) instead of the real column count.
        // Caught by code review while adding multi-tab support (21.7.2026)
        // - single-board Početna never exercised this path, since it had
        // no sibling board to diverge from.
        canvasWrapEl.style.setProperty('--cols', COLS_GRID);
      }
      // The left margin is PINNED to a whole GRID multiple so the board's
      // left edge - and therefore the first visible dot column - always
      // lands exactly on the sidebar/canvas boundary (0). Splitting the
      // leftover evenly between both sides (an earlier version of this
      // fix) made the two margins pixel-equal but knocked that edge off
      // a whole-GRID offset, so the whole dot grid drifted out of phase
      // with the boundary - a more visible bug than a small left/right
      // gap. Flooring to a whole column count always leaves 0-27px of
      // slack; that slack goes entirely to the right margin instead.
      const rightMargin = totalWidth - leftMargin - COLS_GRID * GRID;
      // Whole 28px grid tracks leave a small variable remainder on the
      // right. For a card that actually reaches the last track, adjust
      // only its trailing inset so its VISIBLE border lands at the same
      // 42px safe space as the left edge. At the current viewport this is
      // 6px instead of the normal 14px, moving the edge 8px farther right
      // without changing grid math or gaps between ordinary cards.
      const rightLimitInset = Math.max(0, leftMargin - rightMargin);
      canvasWrapEl.style.setProperty('--safe-x', leftMargin + 'px');
      canvasWrapEl.style.setProperty('--safe-x-right', rightMargin + 'px');
      canvasWrapEl.style.setProperty('--right-limit-inset', rightLimitInset + 'px');
      return changed;
    }
    updateBoardWidth();

    // The visible dot pattern is a background-image on #canvasWrap, so its
    // own origin is #canvasWrap's top-left corner - NOT the board's. The
    // board sits below the hero (logo + heading + copy), whose height
    // isn't a clean multiple of GRID, so without this the two grids drift
    // out of phase vertically (confirmed live: ~7px off) even though every
    // card lines up perfectly with every OTHER card. This nudges the
    // background pattern's phase so a real dot lands exactly on the
    // board's own (0,0) - the two grids become the same grid, not just
    // two grids that happen to share a spacing.
    function alignDotGridToBoard() {
      if (!canvasWrapEl) return;
      // NOT the hardcoded Početna `board` - on any other tab that element
      // is the hidden/inert one (zero-size rect), which threw the dot
      // phase off for every custom tab's board. Always resolve whichever
      // board is actually visible right now, falling back to Početna's
      // only if no view is marked active yet (very first paint).
      const activeBoard = document.querySelector('.view.is-active .board') || board;
      const br = activeBoard.getBoundingClientRect();
      const cr = canvasWrapEl.getBoundingClientRect();
      const offsetX = br.left - cr.left + canvasWrapEl.scrollLeft;
      const offsetY = br.top - cr.top + canvasWrapEl.scrollTop;
      const phaseX = ((offsetX % GRID) + GRID) % GRID;
      const phaseY = ((offsetY % GRID) + GRID) % GRID;
      canvasWrapEl.style.setProperty('--dot-phase-x', phaseX + 'px');
      canvasWrapEl.style.setProperty('--dot-phase-y', phaseY + 'px');
      // share with the FX overlay (hover glow, click bursts) so those
      // land on the exact same dots too, not a phase-0 grid of their own
      dotPhaseX = phaseX;
      dotPhaseY = phaseY;
      refreshGridDots();
    }
    alignDotGridToBoard();
    recalcBoardLayout = () => {
      updateBoardWidth();
      alignDotGridToBoard();
      boardAPIs.forEach(api => {
        if (api && api.refreshRightLimits) api.refreshRightLimits();
      });
    };
    window.addEventListener('resize', recalcBoardLayout);
    // web font swap can reflow the hero (and so the board's offset) after
    // this first pass already ran
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(alignDotGridToBoard);
    }

    // ---- Section mechanic, step 3: generalized into initBoard() ----
    // Was written for the ONE Početna board only (hardcoded `board`
    // element + a single localStorage key). 21.7.2026: pulled out into a
    // reusable function so custom tabs (see the section further below)
    // can get the exact same edge-resize/drag-reorder/persistence
    // mechanic on THEIR OWN board, just by calling initBoard(theirBoardEl,
    // theirOwnStorageKey) - not a copy-paste, the same function runs for
    // every board that exists. Closes over GRID/COLS_GRID from the outer
    // scope, so every board this creates stays in sync with the one live
    // column count shared across the whole app.
    //
    // Layout (DOM order + each card's span) is saved as one array keyed by
    // each card's stable data-id - NOT by DOM index, since drag-reorder
    // changes DOM index by definition. cardSpans is a WeakMap rather than
    // reading card.style.gridColumn back out at save time because a card
    // that was never resized has no inline style at all yet (its span
    // still comes from the .pcard CSS default) - the map is the one place
    // that always has a current value regardless of whether resize ever
    // touched that card. Each board gets its OWN WeakMap (declared inside
    // the function) - a card element from one board is never looked up
    // against another board's map, but there's no reason to share one
    // across boards either.
    const MIN_SPAN = 4; // smallest a card can be resized to, in grid units

    initBoard = function (boardEl, storageKey) {
      const cardSpans = new WeakMap();
      // Cleanup funkcije koje widget render vrati (npr. clearTimeout) -
      // pozivaju se kad kartica fizički napušta board (delete/move), da
      // alat ne ostavi tajmere/listenere iza sebe.
      const cardCleanups = new WeakMap();

      function runCardCleanup(card) {
        const cleanup = cardCleanups.get(card);
        if (cleanup) {
          cardCleanups.delete(card);
          try { cleanup(); } catch (err) { /* greška alata pri cleanupu ne smije srušiti board */ }
        }
      }

      // Šta živi u .pcard-inner zavisi od tipa sekcije. Za 'widget' i
      // 'folder' se sadržaj gradi ovdje (i ponovo, npr. poslije izmjene
      // liste aplikacija foldera); 'custom' ostaje prazna površina kao
      // do sada. Widget render ide kroz AIZdravo.renderInto koji hvata
      // greške alata unutar njegove kartice - vidi apps-core.js.
      function renderCardContent(card) {
        const inner = card.querySelector('.pcard-inner');
        if (!inner) return;
        runCardCleanup(card);
        let content = inner.querySelector('.pcard-app-content');
        const type = card.dataset.type;
        if (type !== 'widget' && type !== 'folder') {
          if (content) content.remove();
          return;
        }
        if (!content) {
          content = document.createElement('div');
          content.className = 'pcard-app-content';
          inner.appendChild(content);
        }
        if (type === 'widget') {
          const appId = card.dataset.appId;
          if (window.AIZdravo && !isAppDisabled(appId)) {
            const cleanup = AIZdravo.renderInto(appId, 'widget', content);
            if (cleanup) cardCleanups.set(card, cleanup);
            const app = AIZdravo.getApp(appId);
            card.classList.toggle('pcard-fixed-size', !!app && app.resizable === false);
          } else {
            content.innerHTML = '<div class="app-render-error"><strong>Alat nije dostupan</strong><span>„' + safeAppIdText(appId) + '" nije instaliran ili je uklonjen. Sekcija i njeni podaci su sačuvani.</span></div>';
          }
          return;
        }
        // folder
        let appIds = [];
        try { appIds = JSON.parse(card.dataset.apps || '[]'); } catch (err) { appIds = []; }
        content.innerHTML = '';
        content.classList.add('folder-content');
        const available = appIds
          .map(appId => (window.AIZdravo ? AIZdravo.getApp(appId) : null))
          .filter(app => app && !isAppDisabled(app.id) && !!app.app);
        if (!available.length) {
          const empty = document.createElement('div');
          empty.className = 'folder-empty';
          empty.innerHTML = '<span>Folder je prazan.</span><button type="button">Dodaj aplikacije</button>';
          empty.querySelector('button').addEventListener('click', () => openFolderEdit(card, renderCardContent));
          content.appendChild(empty);
          return;
        }
        available.forEach(app => {
          // Isti "pravi app ikona" izgled kao katalog (23.7.2026) - veliki
          // obojen kvadrat sa ikonicom + ime ispod, bez border kutije oko
          // cijelog tila. Klik otvara aplikaciju, isto ponašanje kao prije.
          const tile = document.createElement('button');
          tile.type = 'button';
          tile.className = 'app-tile';
          tile.title = app.name + ' — ' + app.description;
          tile.innerHTML =
            '<span class="app-icon-tile app-icon-tile--md"><svg><use href="#icon-tabler-' + safeIconName(app.icon) + '"></use></svg></span>' +
            '<span class="app-tile-name"></span>';
          tile.querySelector('.app-tile-name').textContent = app.name;
          tile.addEventListener('click', () => openAppTabGlobal(app.id));
          content.appendChild(tile);
        });
      }

      function saveLayout() {
        const layout = Array.from(boardEl.querySelectorAll('.pcard'))
          .map(card => {
            const spans = cardSpans.get(card);
            // name is optional - the 3 original hardcoded cards never
            // get one, only sections added through the "add section"
            // modal (21.7.2026) do, via card.dataset.name.
            if (!spans) return null;
            const entry = {
              id: card.dataset.id,
              colSpan: spans.colSpan,
              rowSpan: spans.rowSpan,
              name: card.dataset.name || '',
              collapsed: card.classList.contains('is-collapsed'),
              locked: card.classList.contains('is-locked'),
            };
            // App/widget sloj (23.7.2026): 'custom' (prazna, default -
            // stariji zapisi bez type polja se čitaju kao custom),
            // 'widget' (instanca alata iz registra, appId), 'folder'
            // (quick-launch pločice, apps = lista appId-jeva).
            const type = card.dataset.type;
            if (type === 'widget' && card.dataset.appId) {
              entry.type = 'widget';
              entry.appId = card.dataset.appId;
            } else if (type === 'folder') {
              entry.type = 'folder';
              try {
                entry.apps = JSON.parse(card.dataset.apps || '[]');
              } catch (err) {
                entry.apps = [];
              }
            }
            return entry;
          })
          .filter(Boolean);
        try {
          persistValue(storageKey, JSON.stringify(layout));
        } catch (err) {
          // private-browsing/quota-exceeded localStorage throws - losing
          // persistence for this save isn't worth breaking the board over
        }
      }

      function loadLayout() {
        let saved;
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw === null) return;
          saved = JSON.parse(raw);
        } catch (err) {
          saved = null;
        }
        if (!Array.isArray(saved)) return;

        // A stored layout is an authoritative snapshot, including an
        // intentionally empty board. Earlier code only replayed saved
        // entries but never removed hardcoded cards missing from the
        // snapshot, so deleting one of Početna's original cards appeared
        // to work until refresh brought it back. Remove every current card
        // that is not present in the saved id set before rebuilding order.
        const validSaved = saved.filter(entry => entry && typeof entry.id === 'string');
        const savedIds = new Set(validSaved.map(entry => entry.id));
        boardEl.querySelectorAll('.pcard').forEach(card => {
          if (!savedIds.has(card.dataset.id)) card.remove();
        });

        const byId = new Map(Array.from(boardEl.querySelectorAll('.pcard')).map(c => [c.dataset.id, c]));
        // appendChild on an already-attached node MOVES it - replaying the
        // saved id order through appendChild puts the whole board back in
        // that order in one pass. A card added to the HTML after the layout
        // was last saved (no matching id) is simply left wherever it sits.
        validSaved.forEach((entry, entryIndex) => {
          let card = byId.get(entry.id);
          if (!card) {
            // 21.7.2026: a section added via the floating + button (see
            // addCard() below) only ever existed as a DOM element, never
            // in the HTML - on a FRESH page load there's no element for
            // it at all yet, so it used to just silently vanish here
            // every reload (confirmed live: went from 4 cards back down
            // to 3 after reload, before this fix). Recreate it blank -
            // same markup addCard() itself builds, no icon by design -
            // before restoring its saved size below.
            card = document.createElement('div');
            card.className = 'pcard';
            card.dataset.id = entry.id;
            card.innerHTML = '<div class="pcard-inner"></div>';
          }
          card.dataset.name = entry.name || `Sekcija ${entryIndex + 1}`;
          card.classList.toggle('is-collapsed', entry.collapsed === true);
          card.classList.toggle('is-locked', entry.locked === true);
          // Tip sekcije se vraća PRIJE makeEdgeResizable poziva ispod -
          // renderCardContent() unutar njega čita ove dataset vrijednosti
          // da odluči šta ide u .pcard-inner (widget render / folder
          // pločice / ništa za custom).
          if (entry.type === 'widget' && typeof entry.appId === 'string') {
            card.dataset.type = 'widget';
            card.dataset.appId = entry.appId;
          } else if (entry.type === 'folder') {
            card.dataset.type = 'folder';
            card.dataset.apps = JSON.stringify(Array.isArray(entry.apps) ? entry.apps.filter(appId => typeof appId === 'string') : []);
          } else {
            card.dataset.type = 'custom';
          }
          boardEl.appendChild(card);
          // The DESIRED span (what the user saved) goes on dataset,
          // unclamped - only the RENDERED inline style is clamped to the
          // current column count. Clamping the stored value itself
          // silently destroyed user data (confirmed live 23.7.2026): a
          // load in a hidden/zero-width viewport collapses COLS_GRID to
          // MIN_COLS_GRID (8), this clamp then rewrote every span to 8,
          // and the next saveLayout (pagehide fires one) persisted that
          // permanently - colSpan 16/25 layouts came back as 8 forever.
          // makeEdgeResizable reads dataset first, so the true value
          // survives the round-trip no matter how narrow this load is.
          if (entry.colSpan) {
            card.dataset.colSpan = entry.colSpan;
          }
          if (entry.rowSpan) {
            card.dataset.rowSpan = entry.rowSpan;
            card.style.gridRow = `span ${entry.rowSpan}`;
          }
        });
      }

      loadLayout();

      function updateEmptyState() {
        const viewEl = boardEl.closest('.view');
        const cards = boardEl.querySelectorAll('.pcard');
        const existing = boardEl.querySelector('.board-empty');
        // Home tab (23.7.2026) - njegov board je trajno skriven (welcome
        // wizard zauzima taj prostor), nikad ne dobija cards niti empty-
        // state placeholder da ne troši rad na nešto što se nikad ne vidi.
        if (viewEl && viewEl.dataset.view === 'home') return;
        if (cards.length) {
          if (existing) existing.remove();
          return;
        }
        if (existing) return;
        const empty = document.createElement('div');
        empty.className = 'board-empty';
        empty.innerHTML = '<strong>Ovaj tab je spreman za organizaciju</strong>' +
          '<span>Dodaj sekciju, ili izaberi widget iz kataloga aplikacija - to je najbrži put do prvog alata na boardu.</span>' +
          '<div class="board-empty-actions">' +
            '<button type="button" data-empty-action="section">Dodaj sekciju</button>' +
            '<button type="button" data-empty-action="apps">Pogledaj widgete</button>' +
          '</div>';
        empty.querySelector('[data-empty-action="section"]').addEventListener('click', () => requestAddSection());
        // Katalog otvoren pravo na Widgeti prikaz - sa praznog taba
        // korisnik bira ALAT, ne aplikaciju-kao-tab (23.7.2026).
        empty.querySelector('[data-empty-action="apps"]').addEventListener('click', () => openAppsPanelGlobal('widgets'));
        boardEl.appendChild(empty);
      }

      function maxColSpanForCard(card) {
        const boardRect = boardEl.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const startColumn = Math.max(0, Math.round((cardRect.left - boardRect.left) / GRID));
        return Math.max(MIN_SPAN, COLS_GRID - startColumn);
      }

      function refreshRightLimits() {
        requestAnimationFrame(() => {
          boardEl.querySelectorAll('.pcard').forEach(card => {
            const spans = cardSpans.get(card);
            if (!spans) return;
            // Re-render the clamped span from the DESIRED one - when the
            // viewport grows back (or the first real layout pass happens
            // after a zero-width load), a card whose stored size is wider
            // than the narrow render gets its real width back instead of
            // staying stuck at the clamp forever. Skipped mid-drag: the
            // drag handlers own the inline style while active.
            if (!card.classList.contains('is-collapsed')) {
              const rendered = Math.min(COLS_GRID, Math.max(MIN_SPAN, spans.colSpan));
              const current = /span\s+(\d+)/.exec(card.style.gridColumn || '');
              if (!current || parseInt(current[1], 10) !== rendered) {
                card.style.gridColumn = `span ${rendered}`;
              }
            }
            card.classList.toggle('is-at-right-limit', spans.colSpan >= maxColSpanForCard(card));
          });
        });
      }

      function makeEdgeResizable(card) {
        // Starting spans read from the INLINE style (an author-set size in
        // the HTML, or one loadLayout() just restored above) when present,
        // falling back to the .pcard CSS default (16/10) otherwise - NOT
        // from getComputedStyle(). Verified live: gridColumnEnd/gridRowEnd
        // compute to "auto" here, not a resolved track number or even the
        // "span N" string a first attempt at this assumed - parseInt on
        // that is always NaN, so reading computed style silently coerced
        // EVERY card's tracked span to the 16/10 fallback regardless of its
        // real size the moment persistence started reading it.
        const spanFromStyle = (value, fallback) => {
          const m = /span\s+(\d+)/.exec(value || '');
          return m ? parseInt(m[1], 10) : fallback;
        };
        // Prefer the DESIRED span loadLayout()/addCard() stashed on
        // dataset over the rendered inline style - the inline value may
        // already be clamped to a narrow viewport's column count, and
        // seeding the tracked span from it is exactly how user sizes got
        // silently overwritten (see the loadLayout comment above). The
        // tracked span IS what saveLayout persists, so it must always be
        // the user's real choice, never a viewport-clamped echo of it.
        let colSpan = parseInt(card.dataset.colSpan, 10) || spanFromStyle(card.style.gridColumn, 16);
        let rowSpan = parseInt(card.dataset.rowSpan, 10) || spanFromStyle(card.style.gridRow, 10);
        card.dataset.colSpan = colSpan;
        card.dataset.rowSpan = rowSpan;
        card.style.gridColumn = `span ${Math.min(COLS_GRID, colSpan)}`;
        cardSpans.set(card, { colSpan, rowSpan });

        const inner = card.querySelector('.pcard-inner');
        const edgeRight = document.createElement('span');
        edgeRight.className = 'pcard-edge pcard-edge-right';
        const edgeBottom = document.createElement('span');
        edgeBottom.className = 'pcard-edge pcard-edge-bottom';
        inner.appendChild(edgeRight);
        inner.appendChild(edgeBottom);

        const sectionName = card.dataset.name || 'Nova sekcija';
        card.dataset.name = sectionName;
        const header = document.createElement('div');
        header.className = 'pcard-header';
        header.innerHTML = '<button class="pcard-drag-handle" type="button"></button>' +
          '<span class="pcard-name"></span>' +
          '<button class="pcard-menu-toggle" type="button" aria-expanded="false">•••</button>' +
          '<div class="pcard-menu" hidden>' +
            '<button type="button" data-card-action="edit-mode">Uredi</button>' +
            '<button type="button" data-card-action="rename">Preimenuj</button>' +
            '<button type="button" data-card-action="move">Premjesti u drugi tab</button>' +
            '<button type="button" data-card-action="duplicate">Dupliciraj</button>' +
            '<button type="button" data-card-action="collapse">Sažmi sekciju</button>' +
            '<button type="button" data-card-action="lock">Zaključaj sekciju</button>' +
            '<div class="pcard-size-row" aria-label="Veličina sekcije"><button type="button" data-size="s">S</button><button type="button" data-size="m">M</button><button type="button" data-size="l">L</button><button type="button" data-size="full">Puna</button></div>' +
            '<button type="button" class="danger" data-card-action="delete">Obriši sekciju</button>' +
          '</div>';
        const nameEl = header.querySelector('.pcard-name');
        const dragHandle = header.querySelector('.pcard-drag-handle');
        const menuToggle = header.querySelector('.pcard-menu-toggle');
        const menu = header.querySelector('.pcard-menu');
        nameEl.textContent = sectionName;
        dragHandle.setAttribute('aria-label', `Premjesti sekciju „${sectionName}“`);
        menuToggle.setAttribute('aria-label', `Opcije sekcije „${sectionName}“`);
        card.appendChild(header);
        if (card.classList.contains('is-collapsed')) header.querySelector('[data-card-action="collapse"]').textContent = 'Proširi sekciju';
        if (card.classList.contains('is-locked')) header.querySelector('[data-card-action="lock"]').textContent = 'Otključaj sekciju';

        // Folder sekcija dobija dodatnu meni stavku za izmjenu liste
        // aplikacija; widget sa resizable:false gubi size-row (i edge
        // ručke, kroz .pcard-fixed-size CSS) jer mu je veličina fiksna
        // odlukom autora alata (npr. sat koji nema smisla razvlačiti).
        if (card.dataset.type === 'folder') {
          const folderBtn = document.createElement('button');
          folderBtn.type = 'button';
          folderBtn.dataset.cardAction = 'folder-apps';
          folderBtn.textContent = 'Aplikacije foldera';
          menu.insertBefore(folderBtn, menu.querySelector('.pcard-size-row'));
        }
        if (card.dataset.type === 'widget' && window.AIZdravo) {
          const app = AIZdravo.getApp(card.dataset.appId);
          if (app && app.resizable === false) {
            card.classList.add('pcard-fixed-size');
            const sizeRow = menu.querySelector('.pcard-size-row');
            if (sizeRow) sizeRow.hidden = true;
          }
        }
        // Poveži alat sa sekcijom (26.7.2026) - samo za praznu custom
        // sekciju (Ognjenov zahtjev: kad on napravi i podesi veličinu
        // sekcije, taj alat treba PREUZETI tu istu poziciju/veličinu,
        // ne dobiti novu odvojenu karticu iz kataloga). Dugme se
        // uklanja poslije uspješnog povezivanja (openAttachAppModal
        // confirm handler) jer sekcija tad prestaje biti 'custom'.
        if (card.dataset.type === 'custom') {
          const attachBtn = document.createElement('button');
          attachBtn.type = 'button';
          attachBtn.dataset.cardAction = 'attach-app';
          attachBtn.textContent = 'Poveži alat...';
          menu.insertBefore(attachBtn, menu.querySelector('.pcard-size-row'));
        }

        function setCardName(name) {
          const cleanName = String(name || '').trim().slice(0, 60) || 'Nova sekcija';
          card.dataset.name = cleanName;
          nameEl.textContent = cleanName;
          dragHandle.setAttribute('aria-label', `Premjesti sekciju „${cleanName}“`);
          menuToggle.setAttribute('aria-label', `Opcije sekcije „${cleanName}“`);
          saveLayout();
        }

        function closeCardMenu() {
          menu.hidden = true;
          menuToggle.setAttribute('aria-expanded', 'false');
        }

        menuToggle.addEventListener('click', event => {
          event.stopPropagation();
          const willOpen = menu.hidden;
          document.querySelectorAll('.pcard-menu:not([hidden])').forEach(openMenu => { openMenu.hidden = true; });
          document.querySelectorAll('.pcard-menu-toggle[aria-expanded="true"]').forEach(openToggle => openToggle.setAttribute('aria-expanded', 'false'));
          menu.hidden = !willOpen;
          menuToggle.setAttribute('aria-expanded', String(willOpen));
        });

        function applySize(size) {
          const presets = {
            s: { col: 8, row: 6 },
            m: { col: 16, row: 10 },
            l: { col: 24, row: 12 },
            full: { col: maxColSpanForCard(card), row: 12 },
          };
          const preset = presets[size];
          if (!preset) return;
          colSpan = Math.max(MIN_SPAN, Math.min(maxColSpanForCard(card), preset.col));
          rowSpan = Math.max(MIN_SPAN, preset.row);
          card.classList.remove('is-collapsed');
          card.dataset.colSpan = colSpan;
          card.dataset.rowSpan = rowSpan;
          card.style.gridColumn = `span ${colSpan}`;
          card.style.gridRow = `span ${rowSpan}`;
          cardSpans.set(card, { colSpan, rowSpan });
          saveLayout();
          refreshRightLimits();
          showToast(`Veličina sekcije „${card.dataset.name}“ je promijenjena.`);
        }

        menu.querySelectorAll('[data-size]').forEach(button => {
          button.addEventListener('click', event => {
            event.stopPropagation();
            applySize(button.dataset.size);
            closeCardMenu();
          });
        });

        menu.addEventListener('click', async event => {
          const button = event.target.closest('[data-card-action]');
          if (!button) return;
          event.stopPropagation();
          const action = button.dataset.cardAction;
          closeCardMenu();
          if (action === 'edit-mode') {
            const editing = !card.classList.contains('is-editing');
            card.classList.toggle('is-editing', editing);
            button.textContent = editing ? 'Završi uređivanje' : 'Uredi';
            return;
          }
          if (action === 'rename') {
            openSectionRename(card, setCardName);
            return;
          }
          if (action === 'folder-apps') {
            openFolderEdit(card, renderCardContent);
            return;
          }
          if (action === 'attach-app') {
            openAttachAppModal(card);
            return;
          }
          if (action === 'move') {
            openSectionMove(card, boardEl, { colSpan, rowSpan });
            return;
          }
          if (action === 'duplicate') {
            addCard(`${card.dataset.name} kopija`, Object.assign(snapshotCard(card), { locked: false }));
            showToast(`Sekcija „${card.dataset.name}“ je duplicirana.`);
            return;
          }
          if (action === 'collapse') {
            const collapsed = !card.classList.contains('is-collapsed');
            card.classList.toggle('is-collapsed', collapsed);
            button.textContent = collapsed ? 'Proširi sekciju' : 'Sažmi sekciju';
            saveLayout();
            refreshRightLimits();
            return;
          }
          if (action === 'lock') {
            const locked = !card.classList.contains('is-locked');
            card.classList.toggle('is-locked', locked);
            button.textContent = locked ? 'Otključaj sekciju' : 'Zaključaj sekciju';
            saveLayout();
            showToast(locked ? 'Sekcija je zaključana.' : 'Sekcija je otključana.');
            return;
          }
          if (action === 'delete') {
            const approved = await askConfirmation(`Obrisati sekciju „${card.dataset.name}“ i sav njen sadržaj?`, menuToggle);
            if (!approved) return;
            const siblings = Array.from(boardEl.querySelectorAll('.pcard'));
            const snapshot = Object.assign(snapshotCard(card), { index: siblings.indexOf(card) });
            runCardCleanup(card);
            cardSpans.delete(card);
            card.remove();
            saveLayout();
            updateEmptyState();
            refreshRightLimits();
            showToast(`Sekcija „${snapshot.name}“ je obrisana.`, 'Vrati', () => {
              const restored = addCard(snapshot.name, snapshot);
              const currentCards = boardEl.querySelectorAll('.pcard');
              const reference = currentCards[snapshot.index];
              if (reference && reference !== restored) boardEl.insertBefore(restored, reference);
              saveLayout();
              updateEmptyState();
            });
          }
        });

        function startDrag(e, edge) {
          if (card.classList.contains('pcard-fixed-size')) {
            showToast('Ovaj widget ima fiksnu veličinu.');
            return null;
          }
          if (layoutLocked || card.classList.contains('is-locked')) {
            showToast(layoutLocked ? 'Otključaj raspored da promijeniš veličinu.' : 'Otključaj sekciju da promijeniš veličinu.');
            return null;
          }
          e.preventDefault();
          e.stopPropagation();
          edge.setPointerCapture(e.pointerId);
          edge.classList.add('is-active');
          document.body.classList.add('no-select');
          return { startX: e.clientX, startY: e.clientY, startColSpan: colSpan, startRowSpan: rowSpan };
        }

        let widthLimitHit = false;
        function setWidthLimitSignal(hit) {
          if (widthLimitHit === hit) return;
          widthLimitHit = hit;
          card.classList.toggle('is-width-limit', hit);
          edgeRight.classList.toggle('is-limit', hit);
        }

        let dragRight = null;
        edgeRight.addEventListener('pointerdown', (e) => {
          const drag = startDrag(e, edgeRight);
          if (!drag) return;
          // Auto-placed grid items do not have a readable explicit
          // grid-column-start. Derive the current zero-based start track
          // from geometry once, before resizing can cause any reflow.
          drag.maxColSpan = maxColSpanForCard(card);
          dragRight = drag;
          card.classList.toggle('is-at-right-limit', colSpan >= drag.maxColSpan);
          setWidthLimitSignal(false);
        });
        edgeRight.addEventListener('pointermove', (e) => {
          if (!dragRight) return;
          const dx = e.clientX - dragRight.startX;
          const requestedSpan = Math.round(dragRight.startColSpan + dx / GRID);
          // Limiting against the whole board width was not enough for a
          // card that starts partway across a row. A span larger than the
          // remaining tracks made CSS Grid move the card to the next row.
          // Clamp to the tracks remaining from THIS card's start instead.
          const next = Math.max(MIN_SPAN, Math.min(dragRight.maxColSpan, requestedSpan));
          setWidthLimitSignal(requestedSpan > dragRight.maxColSpan);
          card.classList.toggle('is-at-right-limit', next >= dragRight.maxColSpan);
          if (next !== colSpan) {
            colSpan = next;
            card.dataset.colSpan = colSpan;
            card.style.gridColumn = `span ${colSpan}`;
            cardSpans.set(card, { colSpan, rowSpan });
            saveLayout();
          }
        });
        function endRight() {
          if (!dragRight) return;
          dragRight = null;
          setWidthLimitSignal(false);
          edgeRight.classList.remove('is-active');
          document.body.classList.remove('no-select');
          saveLayout();
          refreshRightLimits();
        }
        edgeRight.addEventListener('pointerup', endRight);
        edgeRight.addEventListener('pointercancel', endRight);

        let dragBottom = null;
        edgeBottom.addEventListener('pointerdown', (e) => { dragBottom = startDrag(e, edgeBottom); });
        edgeBottom.addEventListener('pointermove', (e) => {
          if (!dragBottom) return;
          const dy = e.clientY - dragBottom.startY;
          const next = Math.max(MIN_SPAN, Math.round(dragBottom.startRowSpan + dy / GRID));
          if (next !== rowSpan) {
            rowSpan = next;
            card.dataset.rowSpan = rowSpan;
            card.style.gridRow = `span ${rowSpan}`;
            cardSpans.set(card, { colSpan, rowSpan });
            saveLayout();
          }
        });
        function endBottom() {
          if (!dragBottom) return;
          dragBottom = null;
          edgeBottom.classList.remove('is-active');
          document.body.classList.remove('no-select');
          saveLayout();
          refreshRightLimits();
        }
        edgeBottom.addEventListener('pointerup', endBottom);
        edgeBottom.addEventListener('pointercancel', endBottom);

        // Tek na kraju - header/edges/menu su spremni, pa tip-specifičan
        // sadržaj (widget render / folder pločice) može sigurno unutra.
        renderCardContent(card);
      }

      // Adds ONE new section (floating + button, via the "add-section"
      // modal - 21.7.2026: now takes a name, shown top-left on the card
      // via .pcard-name, see makeEdgeResizable() above). No icon by
      // design - sections don't have one, matching the dashed placeholder
      // look everything uses before real content exists. Default size
      // comes from .pcard's own CSS default (span 16/10), same as a card
      // that's never been resized - no inline style needed to get that,
      // matching how the ORIGINAL hardcoded cards in the HTML work too.
      // grid-auto-flow:dense places it automatically; Sortable already
      // watches boardEl's children generically, so a plain appendChild
      // is instantly draggable with zero extra registration - only the
      // resize handles (makeEdgeResizable) and persistence need an
      // explicit call here.
      function addCard(name, options = {}) {
        const id = 'card-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const card = document.createElement('div');
        card.className = 'pcard';
        card.dataset.id = id;
        card.dataset.name = String(name || 'Nova sekcija').trim().slice(0, 60);
        // Tip iz opcija (widget iz Aplikacije panela, folder iz Nova
        // sekcija modala, ili snapshot pri move/duplicate/undo).
        if (options.type === 'widget' && typeof options.appId === 'string') {
          card.dataset.type = 'widget';
          card.dataset.appId = options.appId;
        } else if (options.type === 'folder') {
          card.dataset.type = 'folder';
          card.dataset.apps = JSON.stringify(Array.isArray(options.apps) ? options.apps.filter(appId => typeof appId === 'string') : []);
        } else {
          card.dataset.type = 'custom';
        }
        // Desired span stays unclamped on dataset (makeEdgeResizable
        // seeds its tracked span from there); only the rendered style is
        // clamped - same data-preserving split as loadLayout above, so a
        // card moved/duplicated/restored while the window happens to be
        // narrow keeps its real size for the next wider render.
        const desiredCol = Number(options.colSpan) || 16;
        const startRow = Number(options.rowSpan) || 10;
        card.dataset.colSpan = desiredCol;
        card.dataset.rowSpan = startRow;
        card.style.gridRow = `span ${startRow}`;
        card.classList.toggle('is-collapsed', options.collapsed === true);
        card.classList.toggle('is-locked', options.locked === true);
        card.innerHTML = '<div class="pcard-inner"></div>';
        const empty = boardEl.querySelector('.board-empty');
        if (empty) empty.remove();
        // insertBefore (24.7.2026, widget drag-and-drop) - umeće karticu na
        // tačnu DOM poziciju u odnosu na postojeće (gdje je duh za vrijeme
        // prevlačenja bio), umjesto uvijek na kraj. grid-auto-flow:dense
        // (postojeći CSS) sam pakuje u prvo stvarno slobodno mjesto po
        // izgledu - ovo samo bira gdje u REDOSLIJEDU sekcija, ne piksel
        // poziciju (Ognjenov eksplicitan zahtjev: korisnik ne bira tačnu
        // ćeliju, samo približno mjesto među sekcijama, kao reorder).
        if (options.insertBefore && options.insertBefore.parentNode === boardEl) {
          boardEl.insertBefore(card, options.insertBefore);
        } else {
          boardEl.appendChild(card);
        }
        makeEdgeResizable(card);
        saveLayout();
        updateEmptyState();
        setTimeout(refreshRightLimits, 600);
        return card;
      }

      function snapshotCard(card) {
        const spans = cardSpans.get(card) || { colSpan: 16, rowSpan: 10 };
        const snapshot = {
          name: card.dataset.name || 'Nova sekcija',
          colSpan: spans.colSpan,
          rowSpan: spans.rowSpan,
          collapsed: card.classList.contains('is-collapsed'),
          locked: card.classList.contains('is-locked'),
        };
        // Tip putuje sa snapshotom - premještanje/dupliranje/undo widget
        // ili folder sekcije mora je rekonstruisati kao ISTI tip, ne kao
        // praznu custom karticu.
        if (card.dataset.type === 'widget' && card.dataset.appId) {
          snapshot.type = 'widget';
          snapshot.appId = card.dataset.appId;
        } else if (card.dataset.type === 'folder') {
          snapshot.type = 'folder';
          try { snapshot.apps = JSON.parse(card.dataset.apps || '[]'); } catch (err) { snapshot.apps = []; }
        }
        return snapshot;
      }

      function extractCard(card) {
        if (!card || !boardEl.contains(card)) return null;
        const snapshot = snapshotCard(card);
        runCardCleanup(card);
        cardSpans.delete(card);
        card.remove();
        saveLayout();
        updateEmptyState();
        refreshRightLimits();
        return snapshot;
      }

      let boardSortable = null;
      boardAPIs.set(boardEl, {
        addCard,
        saveLayout,
        refreshRightLimits,
        updateEmptyState,
        extractCard,
        snapshotCard,
        renderCardContent,
        setLocked(locked) {
          if (boardSortable) boardSortable.option('disabled', !!locked);
        },
      });

      boardEl.querySelectorAll('.pcard').forEach(makeEdgeResizable);
      updateEmptyState();
      // Wait for the card entrance transform to finish before geometry is
      // used to identify which card reaches the final grid track.
      setTimeout(refreshRightLimits, 600);

      // Drag-reorder: picking up anywhere on a card except the two resize
      // edges swaps its position in DOM order, and `grid-auto-flow: dense`
      // re-packs everyone else around it. `filter` (+ preventOnFilter) stops
      // Sortable from starting its own drag when the pointerdown actually
      // landed on .pcard-edge-right/-bottom, so resize and reorder can't
      // fight over the same gesture.
      if (window.Sortable) {
        boardSortable = Sortable.create(boardEl, {
          // Same ease as every other deliberate motion on this page (hero
          // rise, card pop-in, nav indicator slide) instead of Sortable's
          // unstyled default (plain CSS `ease` - it only appends an easing
          // keyword to the transition at all when one is set here) - a
          // touch longer than the old 150ms so the settle actually reads.
          animation: 260,
          easing: 'cubic-bezier(.22, 1, .36, 1)',
          draggable: '.pcard',
          // .pcard-delete added 21.7.2026 - same reasoning as .pcard-edge,
          // a pointerdown that actually landed on the delete button
          // shouldn't ALSO be interpreted as picking the card up to drag.
          filter: '.pcard-edge, .pcard-menu, .pcard-menu-toggle, .pcard-inner button, .pcard-inner input, .pcard-inner select, .pcard-inner textarea, .pcard-inner a',
          preventOnFilter: true,
          // ghostClass marks the ORIGINAL element - it stays in the DOM
          // and IS what Sortable repositions live as the pointer moves
          // over other cards (that's the "everyone else shifts" effect).
          // dragClass marks the separate floating CLONE that actually
          // tracks the cursor (only exists because of forceFallback below)
          // - the lift styling belongs on dragClass, not ghostClass/
          // chosenClass, see the .pcard-dragging comment in style.css.
          ghostClass: 'pcard-ghost',
          dragClass: 'pcard-dragging',
          onEnd() {
            saveLayout();
            refreshRightLimits();
          },
          // Mouse/touch-simulated dragging instead of native HTML5 DnD - the
          // resize handles above already use Pointer Events, not native
          // drag, so this keeps both mechanics on the same event model
          // instead of mixing two different browser drag systems on
          // adjacent parts of the same card.
          forceFallback: true,
          // The floating clone is appended to <body>, not left inside the
          // board - boards are `display:grid`, and the clone still carries
          // the .pcard class, so without this it would risk being laid out
          // as an actual grid item instead of a free-floating cursor-locked
          // preview.
          fallbackOnBody: true,
          fallbackTolerance: 3,
          delay: 120,
          delayOnTouchOnly: true,
          touchStartThreshold: 4,
          onMove(event) {
            return !layoutLocked && !event.dragged.classList.contains('is-locked');
          },
        });
        boardSortable.option('disabled', layoutLocked);
      }
    };

    // Početna's board keeps the exact same storage key it always had -
    // no migration needed, this is just the first of what can now be many
    // initBoard() calls.
    initBoard(board, 'aizdravo:board-layout:v1');
  }

  // ---------------- Custom tabs (add/remove) ----------------
  // Tabs the user creates via the sidebar's + button - a name and one of
  // 30 icons. Nothing about a tab lives in the HTML; every one is rebuilt
  // from localStorage on load by replaying createTabDOM() below, which is
  // also exactly what runs the instant a new tab is added. Deleting a
  // custom tab is the one thing this section does NOT generalize from
  // Početna - Početna can't be deleted at all (no delete control is ever
  // attached to it).

  const TABS_KEY = 'aizdravo:tabs:v1';
  const TAB_ICONS = [
    'chart-bar', 'users', 'message-circle', 'folder', 'file-text', 'photo',
    'video', 'mail', 'bell', 'search', 'home', 'star', 'clock', 'map-pin',
    'shield-check', 'database', 'cloud', 'link', 'edit', 'checklist',
    'alert-triangle', 'book', 'rocket', 'target', 'bulb', 'tool', 'credit-card',
    'calendar-event', 'settings', 'layout-grid',
  ];

  const navEl = document.getElementById('nav');
  const navAddBtn = document.getElementById('navAddTab');
  // Own reference, not the `canvasWrap` const declared further down in
  // the FX overlay section below - that one is block-scoped to ITS OWN
  // `if`, and createTabDOM() here runs (both on load and on every future
  // add-tab click) long before that block's const would be initialized.
  const canvasWrapMain = document.getElementById('canvasWrap');
  const addTabOverlay = document.getElementById('addTabOverlay');
  const addTabTitleEl = document.getElementById('addTabTitle');
  const modalNameFieldEl = document.getElementById('modalNameField');
  const addTabNameInput = document.getElementById('addTabName');
  const modalIconFieldEl = document.getElementById('modalIconField');
  const addTabIconGrid = document.getElementById('addTabIconGrid');
  const addTabCancelBtn = document.getElementById('addTabCancel');
  const addTabConfirmBtn = document.getElementById('addTabConfirm');
  const modalHelp = document.getElementById('modalHelp');
  const navEditHomeIconBtn = document.getElementById('navEditHomeIcon');
  const navDuplicateHomeBtn = document.getElementById('navDuplicateHome');
  const navDeleteHomeBtn = document.getElementById('navDeleteHome');
  const moveSectionOverlay = document.getElementById('moveSectionOverlay');
  const moveSectionTarget = document.getElementById('moveSectionTarget');
  const moveSectionCancel = document.getElementById('moveSectionCancel');
  const moveSectionConfirm = document.getElementById('moveSectionConfirm');
  const attachAppOverlay = document.getElementById('attachAppOverlay');
  const attachAppList = document.getElementById('attachAppList');
  const attachAppEmpty = document.getElementById('attachAppEmpty');
  const attachAppCancel = document.getElementById('attachAppCancel');
  const attachAppConfirm = document.getElementById('attachAppConfirm');
  const fabMenu = document.getElementById('fabMenu');
  const fabMenuToggle = document.getElementById('fabMenuToggle');
  const fabActions = document.getElementById('fabActions');
  const fabAddSection = document.getElementById('fabAddSection');
  const fabOpenSettings = document.getElementById('fabOpenSettings');
  const settingsOverlay = document.getElementById('settingsOverlay');
  const settingsClose = document.getElementById('settingsClose');
  const gridToggle = document.getElementById('gridToggle');
  const layoutLockToggle = document.getElementById('layoutLockToggle');
  const saveStatusToggle = document.getElementById('saveStatusToggle');
  const resetDashboard = document.getElementById('resetDashboard');
  const settingsVersionEl = document.getElementById('settingsVersion');
  // 28.7.2026 - broj verzije se čita iz VERSION fajla umjesto da bude
  // hardkodiran tekst u index.html (koji je ostajao zauvijek na "v1.0.0"
  // bez obzira na stvarnu instaliranu verziju - update mehanizam ažurira
  // VERSION fajl, ali nikad nije dirao ovaj hardkodiran string).
  if (settingsVersionEl) {
    fetch('VERSION').then(r => r.ok ? r.text() : null).then(text => {
      const version = (text || '').trim();
      if (version) settingsVersionEl.textContent = `AI Zdravo Dashboard v${version}`;
    }).catch(() => {});
  }
  const themeGrid = document.getElementById('themeGrid');
  const builtInThemeChoices = themeGrid ? Array.from(themeGrid.querySelectorAll('[data-theme-option]')) : [];
  const customThemeOpen = document.getElementById('customThemeOpen');
  const customThemeEditor = document.getElementById('customThemeEditor');
  const customThemeName = document.getElementById('customThemeName');
  const customThemeAccent = document.getElementById('customThemeAccent');
  const customThemeHex = document.getElementById('customThemeHex');
  const customThemePreview = document.getElementById('customThemePreview');
  const customThemeCancel = document.getElementById('customThemeCancel');
  const customThemeDelete = document.getElementById('customThemeDelete');
  const customThemeSave = document.getElementById('customThemeSave');
  const HOME_ICON_KEY = 'aizdravo:home-icon';
  const HOME_NAME_KEY = 'aizdravo:home-name';
  const WELCOME_TAB_MIGRATED_KEY = 'aizdravo:welcome-tab-migrated';
  // Gornja traka - customizable ikonica/naziv "Dashboard" kartice
  // (23.7.2026, Ognjenov zahtjev). 'ai-zdravo-logo' je isti sentinel
  // koji Home tab koristi za "stvaran logo asset umjesto tabler ikone".
  const TOPBAR_ICON_KEY = 'aizdravo:topbar-icon';
  const TOPBAR_LABEL_KEY = 'aizdravo:topbar-label';
  // App/widget sloj (23.7.2026)
  const appsOverlay = document.getElementById('appsOverlay');
  const appsClose = document.getElementById('appsClose');
  const appsSearch = document.getElementById('appsSearch');
  const appsTitle = document.getElementById('appsTitle');
  const appsModeApps = document.getElementById('appsModeApps');
  const appsModeWidgets = document.getElementById('appsModeWidgets');
  const appsGrid = document.getElementById('appsGrid');
  const appsEmpty = document.getElementById('appsEmpty');
  const fabOpenApps = document.getElementById('fabOpenApps');
  const modalTypeField = document.getElementById('modalTypeField');
  const sectionTypeButtons = Array.from(document.querySelectorAll('.section-type-btn'));
  const modalFolderField = document.getElementById('modalFolderField');
  const folderPickList = document.getElementById('folderPickList');
  const folderPickEmpty = document.getElementById('folderPickEmpty');
  const installedAppsList = document.getElementById('installedAppsList');
  const OPEN_APP_TABS_KEY = 'aizdravo:open-app-tabs';

  function setFabMenuOpen(open) {
    if (!fabMenu || !fabMenuToggle) return;
    fabMenu.classList.toggle('is-open', open);
    if (fabActions) fabActions.setAttribute('aria-hidden', String(!open));
    fabMenuToggle.setAttribute('aria-expanded', String(open));
    fabMenuToggle.setAttribute('aria-label', open ? 'Zatvori akcije' : 'Otvori akcije');
    fabMenuToggle.title = open ? 'Zatvori akcije' : 'Otvori akcije';
  }

  function syncGridToggle() {
    if (gridToggle) gridToggle.setAttribute('aria-checked', String(gridVisible));
    if (layoutLockToggle) layoutLockToggle.setAttribute('aria-checked', String(layoutLocked));
    if (saveStatusToggle) saveStatusToggle.setAttribute('aria-checked', String(!saveStatusHidden));
  }

  function setPalettePreview(element, palette, prefix) {
    if (!element || !palette) return;
    Object.entries(palette.preview).forEach(([name, value]) => {
      element.style.setProperty(`--${prefix}-${name}`, value);
    });
  }

  // Koji custom theme se trenutno uređuje u editor panelu - null znači
  // "pravim novu" (27.7.2026, više sopstvenih tema umjesto jedne).
  let editingCustomThemeId = null;

  function themeChoiceNavList() {
    if (!themeGrid) return [];
    return Array.from(themeGrid.querySelectorAll('[data-theme-option]')).filter(choice => !choice.hidden);
  }

  function attachThemeChoiceBehavior(choice) {
    choice.addEventListener('click', () => setTheme(choice.dataset.themeOption));
    choice.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setTheme(choice.dataset.themeOption);
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const visibleChoices = themeChoiceNavList();
      const visibleIndex = visibleChoices.indexOf(choice);
      const direction = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const nextChoice = visibleChoices[(visibleIndex + direction + visibleChoices.length) % visibleChoices.length];
      if (nextChoice) {
        nextChoice.focus();
        setTheme(nextChoice.dataset.themeOption);
      }
    });
  }

  // Svaka sopstvena tema dobija SVOJU karticu (27.7.2026, Ognjenov
  // zahtjev - "moze se jos jedna kartica dodati"), renderovanu dinamički
  // (isti princip kao dinamičan katalog alata) umjesto jedne statične
  // kartice u index.html. div (ne button, ista disciplina kao apps-catalog-tile
  // ranije) da "Uredi" pencil dugme unutra ne bude ugnježđeno dugme-u-dugmetu -
  // vidi APPS_AND_WIDGETS.md self-verify presedan za isti problem.
  function renderCustomThemeTiles() {
    if (!themeGrid) return;
    themeGrid.querySelectorAll('.theme-choice--custom').forEach(el => el.remove());
    customThemes.forEach(theme => {
      const palette = buildCustomPalette(theme.accent);
      const choice = document.createElement('div');
      choice.className = 'theme-choice theme-choice--custom';
      choice.setAttribute('role', 'radio');
      choice.setAttribute('tabindex', '0');
      choice.setAttribute('aria-checked', 'false');
      choice.dataset.themeOption = 'custom:' + theme.id;
      choice.style.setProperty('--preview-bg', palette.preview.bg);
      choice.style.setProperty('--preview-card', palette.preview.card);
      choice.style.setProperty('--preview-accent', palette.preview.accent);
      choice.innerHTML =
        '<span class="theme-palette" aria-hidden="true"><span></span><span></span><span></span></span>' +
        '<span class="theme-choice-name"></span>' +
        '<button type="button" class="theme-choice-edit" aria-label="Uredi temu"><svg><use href="#icon-tabler-edit"></use></svg></button>';
      choice.querySelector('.theme-choice-name').textContent = theme.name;
      choice.querySelector('.theme-choice-edit').addEventListener('click', event => {
        event.stopPropagation();
        openCustomThemeEditorFor(theme.id);
      });
      attachThemeChoiceBehavior(choice);
      themeGrid.appendChild(choice);
    });
    syncThemeChoices();
  }

  function updateCustomThemePreview() {
    if (!customThemeAccent) return;
    const palette = buildCustomPalette(customThemeAccent.value);
    if (customThemeHex) customThemeHex.textContent = palette.accent;
    setPalettePreview(customThemePreview, palette, 'custom-preview');
    if (customThemeSave) customThemeSave.disabled = !customThemeName || !customThemeName.value.trim();
  }

  function setCustomThemeEditorOpen(open) {
    if (!customThemeEditor || !customThemeOpen) return;
    customThemeEditor.hidden = !open;
    customThemeOpen.setAttribute('aria-expanded', String(open));
    if (!open) {
      editingCustomThemeId = null;
      return;
    }
    const editing = editingCustomThemeId ? findCustomTheme(editingCustomThemeId) : null;
    if (customThemeName) customThemeName.value = editing ? editing.name : '';
    if (customThemeAccent) customThemeAccent.value = editing ? editing.accent : '#e879f9';
    // "Obriši temu" ima smisla samo kad se UREĐUJE postojeća tema - kod
    // pravljenja nove (editingCustomThemeId je null) nema šta da se obriše.
    if (customThemeDelete) customThemeDelete.hidden = !editing;
    updateCustomThemePreview();
    if (customThemeName) customThemeName.focus();
  }

  function openCustomThemeEditorFor(id) {
    editingCustomThemeId = id;
    setCustomThemeEditorOpen(true);
  }

  function openSettings() {
    if (!settingsOverlay) return;
    setFabMenuOpen(false);
    syncGridToggle();
    renderCustomThemeTiles();
    syncThemeChoices();
    renderInstalledAppsGlobal();
    renderTopbarIdentityPreviewGlobal();
    settingsOverlay.classList.add('is-open');
    settingsOverlay.setAttribute('aria-hidden', 'false');
    if (settingsClose) settingsClose.focus();
  }

  function closeSettings() {
    if (!settingsOverlay) return;
    setCustomThemeEditorOpen(false);
    settingsOverlay.classList.remove('is-open');
    settingsOverlay.setAttribute('aria-hidden', 'true');
    if (fabMenuToggle) fabMenuToggle.focus();
  }

  syncGridToggle();
  renderCustomThemeTiles();
  if (fabMenuToggle) {
    fabMenuToggle.addEventListener('click', () => {
      setFabMenuOpen(!fabMenu.classList.contains('is-open'));
    });
  }
  if (fabOpenSettings) fabOpenSettings.addEventListener('click', openSettings);
  if (settingsClose) settingsClose.addEventListener('click', closeSettings);
  if (gridToggle) {
    gridToggle.addEventListener('click', () => {
      setGridVisible(!gridVisible);
      syncGridToggle();
    });
  }
  if (layoutLockToggle) layoutLockToggle.addEventListener('click', () => setLayoutLocked(!layoutLocked));
  if (saveStatusToggle) saveStatusToggle.addEventListener('click', () => setSaveStatusHidden(!saveStatusHidden));

  if (resetDashboard) resetDashboard.addEventListener('click', async () => {
    const approved = await askConfirmation('Vratiti cijeli dashboard na početno stanje? Preporučujemo da prvo izvezeš backup.', resetDashboard);
    if (!approved) return;
    Object.keys(collectDashboardState()).forEach(removePersistedValue);
    await flushStateChanges();
    suppressUnloadLayoutSave = true;
    location.reload();
  });
  builtInThemeChoices.forEach(choice => attachThemeChoiceBehavior(choice));
  if (customThemeOpen) {
    customThemeOpen.addEventListener('click', () => {
      const isOpen = customThemeEditor ? !customThemeEditor.hidden : false;
      if (isOpen) { setCustomThemeEditorOpen(false); return; }
      openCustomThemeEditorFor(null);
    });
  }
  if (customThemeName) customThemeName.addEventListener('input', updateCustomThemePreview);
  if (customThemeAccent) customThemeAccent.addEventListener('input', updateCustomThemePreview);
  if (customThemeCancel) customThemeCancel.addEventListener('click', () => setCustomThemeEditorOpen(false));
  if (customThemeDelete) {
    customThemeDelete.addEventListener('click', async () => {
      const theme = editingCustomThemeId ? findCustomTheme(editingCustomThemeId) : null;
      if (!theme) return;
      const ok = await askConfirmation('Trajno obrisati temu „' + theme.name + '“?', customThemeDelete);
      if (!ok) return;
      const wasActive = activeTheme === 'custom:' + theme.id;
      customThemes = customThemes.filter(t => t.id !== theme.id);
      saveCustomThemes();
      if (wasActive) setTheme('ai-zdravo');
      renderCustomThemeTiles();
      setCustomThemeEditorOpen(false);
      showToast('Sopstvena tema je obrisana.');
    });
  }
  if (customThemeSave) {
    customThemeSave.addEventListener('click', () => {
      const name = customThemeName ? customThemeName.value.trim().slice(0, 28) : '';
      if (!name || !customThemeAccent) return;
      const accent = normalizeHex(customThemeAccent.value);
      let targetId = editingCustomThemeId;
      const existing = targetId ? findCustomTheme(targetId) : null;
      if (existing) {
        existing.name = name;
        existing.accent = accent;
      } else {
        targetId = genCustomThemeId();
        customThemes.push({ id: targetId, name, accent });
      }
      saveCustomThemes();
      renderCustomThemeTiles();
      setTheme('custom:' + targetId);
      setCustomThemeEditorOpen(false);
    });
  }
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) closeSettings();
    });
  }
  document.addEventListener('click', (e) => {
    if (fabMenu && fabMenu.classList.contains('is-open') && !fabMenu.contains(e.target)) {
      setFabMenuOpen(false);
    }
    if (!e.target.closest('.pcard-header')) {
      document.querySelectorAll('.pcard-menu:not([hidden])').forEach(menu => { menu.hidden = true; });
      document.querySelectorAll('.pcard-menu-toggle[aria-expanded="true"]').forEach(toggle => toggle.setAttribute('aria-expanded', 'false'));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (confirmOverlay && confirmOverlay.classList.contains('is-open')) return;
    if (addTabOverlay && addTabOverlay.classList.contains('is-open')) return;
    if (moveSectionOverlay && moveSectionOverlay.classList.contains('is-open')) return;
    const appsOverlayEl = document.getElementById('appsOverlay');
    if (appsOverlayEl && appsOverlayEl.classList.contains('is-open')) {
      closeAppsPanelGlobal();
      return;
    }
    if (customThemeEditor && !customThemeEditor.hidden) {
      setCustomThemeEditorOpen(false);
      return;
    }
    if (settingsOverlay && settingsOverlay.classList.contains('is-open')) {
      closeSettings();
      return;
    }
    setFabMenuOpen(false);
  });

  if (navEl && navAddBtn && addTabOverlay) {
    function loadTabs() {
      try {
        const parsed = JSON.parse(localStorage.getItem(TABS_KEY) || '[]');
        const arr = Array.isArray(parsed) ? parsed : [];
        const migrated = localStorage.getItem(WELCOME_TAB_MIGRATED_KEY) === '1';
        if (!migrated) {
          if (!arr.some(tab => tab && tab.id === 'home')) {
            arr.unshift({ id: 'home', name: 'AI Zdravo', icon: 'ai-zdravo-logo', kind: 'welcome' });
          }
          persistValue(TABS_KEY, JSON.stringify(arr));
          persistValue(WELCOME_TAB_MIGRATED_KEY, '1');
        }
        return arr.filter(tab => tab && typeof tab.id === 'string' && typeof tab.name === 'string');
      } catch (err) {
        return [];
      }
    }
    function saveTabs(tabs) {
      try {
        persistValue(TABS_KEY, JSON.stringify(tabs));
      } catch (err) {
        // private-browsing/quota-exceeded localStorage throws - losing
        // the tab list isn't worth breaking the page over
      }
    }
    function boardLayoutKeyFor(tabId) {
      return tabId === 'home' ? 'aizdravo:board-layout:v1' : 'aizdravo:board-layout:' + tabId;
    }

    function saveTabOrderFromDOM() {
      const tabs = loadTabs();
      const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
      const ordered = Array.from(navEl.querySelectorAll('.nav-row[data-tab-id]'))
        .map(row => tabsById.get(row.dataset.tabId))
        .filter(Boolean);

      // Keep any valid persisted tab that is temporarily missing from the
      // DOM instead of silently deleting it during a reorder save.
      const orderedIds = new Set(ordered.map(tab => tab.id));
      tabs.forEach(tab => {
        if (!orderedIds.has(tab.id)) ordered.push(tab);
      });
      saveTabs(ordered);
    }

    // Builds the nav row (switch button + delete button, as SIBLINGS -
    // see the .nav-row comment in style.css for why not nested) and the
    // .view section (heading + its own empty board), wires switching/
    // deletion, and pushes the new button/section into navItems/views -
    // the SAME arrays the tab-switching code at the top of this file
    // already reads from on every click, so activate()/moveIndicatorTo()
    // need zero changes to handle tabs that didn't exist when they were
    // first written.
    function createTabDOM(tab) {
      if (tab.id === 'home') {
        const existing = navEl.querySelector('.nav-row[data-tab-id="home"]');
        if (existing) {
          const label = existing.querySelector('.nav-label');
          if (label) label.textContent = tab.name || 'AI Zdravo';
        }
        return;
      }
      const row = document.createElement('div');
      row.className = 'nav-row';
      row.dataset.tabId = tab.id;

      const dragHandle = document.createElement('button');
      dragHandle.className = 'nav-drag-handle';
      dragHandle.type = 'button';
      dragHandle.title = 'Prevuci za promjenu redoslijeda';
      dragHandle.setAttribute('aria-label', 'Promijeni poziciju taba "' + tab.name + '"');
      dragHandle.innerHTML = '<span aria-hidden="true"></span>';

      const btn = document.createElement('button');
      btn.className = 'nav-item';
      btn.type = 'button';
      btn.dataset.view = tab.id;
      btn.innerHTML = '<svg class="nav-icon"><use href="#icon-tabler-' + safeIconName(tab.icon) + '"></use></svg>' +
        '<span class="nav-label"></span>';
      btn.querySelector('.nav-label').textContent = tab.name;
      btn.addEventListener('click', () => activate(tab.id));

      const actions = document.createElement('div');
      actions.className = 'nav-row-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'nav-edit-icon';
      editBtn.type = 'button';
      editBtn.title = 'Uredi tab';
      editBtn.setAttribute('aria-label', 'Uredi tab "' + tab.name + '"');
      editBtn.innerHTML = '<svg><use href="#icon-tabler-edit"></use></svg>';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Read the CURRENT icon/name straight off the live button, not
        // the `tab` object this closure captured when the row was first
        // built - after a rename/icon-change that object is stale (the
        // edit only ever updates the DOM + localStorage directly, see
        // updateTabMeta() below, never this closure), so re-opening edit
        // a second time would show the OLD values otherwise.
        const use = btn.querySelector('.nav-icon use');
        const icon = use ? use.getAttribute('href').replace('#icon-tabler-', '') : tab.icon;
        const name = btn.querySelector('.nav-label').textContent;
        openTabModal('edit', tab.id, icon, name);
      });

      const duplicateBtn = document.createElement('button');
      duplicateBtn.className = 'nav-duplicate';
      duplicateBtn.type = 'button';
      duplicateBtn.title = 'Dupliciraj tab';
      duplicateBtn.setAttribute('aria-label', 'Dupliciraj tab "' + tab.name + '"');
      duplicateBtn.innerHTML = '<svg><use href="#icon-tabler-file-text"></use></svg>';
      duplicateBtn.addEventListener('click', event => {
        event.stopPropagation();
        duplicateTab(tab.id);
      });

      const del = document.createElement('button');
      del.className = 'nav-delete';
      del.type = 'button';
      del.title = 'Obriši tab';
      del.setAttribute('aria-label', 'Obriši tab "' + tab.name + '"');
      del.innerHTML = '<svg><use href="#icon-tabler-x"></use></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTab(tab.id);
      });

      actions.appendChild(editBtn);
      actions.appendChild(duplicateBtn);
      actions.appendChild(del);
      row.appendChild(dragHandle);
      row.appendChild(btn);
      row.appendChild(actions);
      navEl.insertBefore(row, navAddBtn);
      navItems.push(btn);

      const section = document.createElement('section');
      section.className = 'view';
      section.dataset.view = tab.id;
      section.id = 'view-' + tab.id;
      section.innerHTML = '<div class="view-heading">' +
        '<svg class="view-heading-icon"><use href="#icon-tabler-' + safeIconName(tab.icon) + '"></use></svg>' +
        '<h1></h1></div><div class="board"></div>';
      section.querySelector('h1').textContent = tab.name;
      canvasWrapMain.appendChild(section);
      views.push(section);

      const boardEl = section.querySelector('.board');
      initBoard(boardEl, boardLayoutKeyFor(tab.id));
    }

    function addTab(name, icon) {
      const id = 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const safeName = uniqueTabName(name);
      const tab = { id, name: safeName, icon };
      const tabs = loadTabs();
      tabs.push(tab);
      saveTabs(tabs);
      createTabDOM(tab);
      activate(id);
      showToast(`Tab „${safeName}“ je dodat.`);
    }

    function uniqueTabName(baseName, ignoredId) {
      const names = new Set(loadTabs().filter(tab => tab.id !== ignoredId).map(tab => tab.name.toLocaleLowerCase('sr')));
      let candidate = String(baseName || 'Novi tab').trim().slice(0, 40);
      if (!names.has(candidate.toLocaleLowerCase('sr'))) return candidate;
      let suffix = 2;
      while (names.has(`${candidate} ${suffix}`.toLocaleLowerCase('sr'))) suffix += 1;
      return `${candidate} ${suffix}`.slice(0, 40);
    }

    function duplicateTab(id) {
      const source = loadTabs().find(tab => tab.id === id);
      if (!source) return;
      const newId = 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const copyIcon = source.icon === 'ai-zdravo-logo' ? 'home' : source.icon;
      const copy = { id: newId, name: uniqueTabName(`${source.name} kopija`), icon: copyIcon };
      const tabs = loadTabs();
      const sourceIndex = tabs.findIndex(tab => tab.id === id);
      tabs.splice(sourceIndex + 1, 0, copy);
      const sourceLayout = localStorage.getItem(boardLayoutKeyFor(id));
      if (sourceLayout) persistValue(boardLayoutKeyFor(newId), sourceLayout);
      saveTabs(tabs);
      createTabDOM(copy);
      const newRow = navEl.querySelector(`.nav-row[data-tab-id="${newId}"]`);
      const sourceRow = navEl.querySelector(`.nav-row[data-tab-id="${id}"]`);
      if (newRow && sourceRow) sourceRow.after(newRow);
      activate(newId);
      showToast(`Tab „${source.name}“ je dupliciran.`);
    }

    async function removeTab(id) {
      const section = document.querySelector('.view[data-view="' + id + '"]');
      // "ima nešto u tom tabu" = has at least one card on its board -
      // only reason to warn before deleting, per Ognjen's ask.
      const hasCards = !!(section && section.querySelector('.pcard'));
      if (hasCards) {
        const tabMeta = loadTabs().find(tab => tab.id === id);
        const ok = await askConfirmation(`Obrisati tab „${tabMeta ? tabMeta.name : 'ovaj tab'}“ zajedno sa svim sekcijama i alatima?`, document.activeElement);
        if (!ok) return;
      }
      const tabsBefore = loadTabs();
      const removedIndex = tabsBefore.findIndex(tab => tab.id === id);
      const removedTab = tabsBefore[removedIndex];
      const removedLayout = localStorage.getItem(boardLayoutKeyFor(id));
      const wasActive = !!(section && section.classList.contains('is-active'));

      const row = navEl.querySelector('.nav-row[data-tab-id="' + id + '"]');
      const rowNextSibling = row ? row.nextSibling : null;
      const sectionNextSibling = section ? section.nextSibling : null;
      if (row) row.remove();
      if (section) section.remove();

      const navIdx = navItems.findIndex(n => n.dataset.view === id);
      if (navIdx !== -1) navItems.splice(navIdx, 1);
      const viewIdx = views.findIndex(v => v.dataset.view === id);
      if (viewIdx !== -1) views.splice(viewIdx, 1);
      const removedBoard = section && section.querySelector('.board');
      const removedBoardAPI = removedBoard ? boardAPIs.get(removedBoard) : null;
      if (removedBoard) boardAPIs.delete(removedBoard);

      const remainingTabs = tabsBefore.filter(t => t.id !== id);
      saveTabs(remainingTabs);
      try {
        removePersistedValue(boardLayoutKeyFor(id));
      } catch (err) {
        // as above - non-fatal if this can't be cleared
      }

      if (wasActive && navItems[0]) activate(navItems[0].dataset.view);
      if (!remainingTabs.length) {
        addTab('Moj dashboard', 'layout-grid');
      }
      if (removedTab) {
        showToast(`Tab „${removedTab.name}“ je obrisan.`, 'Vrati', () => {
          const tabs = loadTabs();
          tabs.splice(Math.max(0, removedIndex), 0, removedTab);
          saveTabs(tabs);
          if (removedLayout) persistValue(boardLayoutKeyFor(id), removedLayout);
          if (id === 'home' && row && section) {
            navEl.insertBefore(row, rowNextSibling && rowNextSibling.isConnected ? rowNextSibling : navAddBtn);
            canvasWrapMain.insertBefore(section, sectionNextSibling && sectionNextSibling.isConnected ? sectionNextSibling : null);
            navItems.splice(Math.max(0, navIdx), 0, row.querySelector('.nav-item'));
            views.splice(Math.max(0, viewIdx), 0, section);
            if (removedBoard && removedBoardAPI) boardAPIs.set(removedBoard, removedBoardAPI);
          } else {
            createTabDOM(removedTab);
            const restoredRow = navEl.querySelector(`.nav-row[data-tab-id="${id}"]`);
            const rows = navEl.querySelectorAll('.nav-row[data-tab-id]');
            const reference = rows[removedIndex];
            if (restoredRow && reference && reference !== restoredRow) navEl.insertBefore(restoredRow, reference);
          }
          activate(id);
        });
      }
    }

    function updateTabMeta(tabId, name, icon, silent = false) {
      const safeName = uniqueTabName(name, tabId);
      const tabs = loadTabs();
      const t = tabs.find(x => x.id === tabId);
      if (t) {
        t.icon = tabId === 'home' ? 'ai-zdravo-logo' : icon;
        t.name = safeName;
        saveTabs(tabs);
      }
      const navBtn = document.querySelector('.nav-row[data-tab-id="' + tabId + '"] .nav-item');
      if (navBtn) {
        const navUse = navBtn.querySelector('.nav-icon use');
        if (navUse && tabId !== 'home') navUse.setAttribute('href', '#icon-tabler-' + icon);
        const navLabel = navBtn.querySelector('.nav-label');
        if (navLabel) navLabel.textContent = safeName;
      }
      const row = document.querySelector('.nav-row[data-tab-id="' + tabId + '"]');
      const dragHandle = row && row.querySelector('.nav-drag-handle');
      if (dragHandle) dragHandle.setAttribute('aria-label', 'Promijeni poziciju taba "' + safeName + '"');
      const editButton = row && row.querySelector('.nav-edit-icon');
      if (editButton) editButton.setAttribute('aria-label', 'Uredi tab "' + safeName + '"');
      const duplicateButton = row && row.querySelector('.nav-duplicate');
      if (duplicateButton) duplicateButton.setAttribute('aria-label', 'Dupliciraj tab "' + safeName + '"');
      const deleteButton = row && row.querySelector('.nav-delete');
      if (deleteButton) deleteButton.setAttribute('aria-label', 'Obriši tab "' + safeName + '"');
      const section = document.querySelector('.view[data-view="' + tabId + '"]');
      if (section) {
        const viewUse = section.querySelector('.view-heading-icon use');
        if (viewUse && tabId !== 'home') viewUse.setAttribute('href', '#icon-tabler-' + icon);
        const viewH1 = section.querySelector('.view-heading h1');
        if (viewH1) viewH1.textContent = safeName;
      }
      if (!silent) showToast(`Tab je preimenovan u „${safeName}“.`);
    }

    let modalMode = 'add';
    let editingTabId = null;
    let editingSectionApply = null;
    let selectedIcon = null;
    let modalReturnFocus = null;
    // App/widget sloj: tip nove sekcije ('custom' | 'folder') u
    // add-section modu, i kartica čiji se folder trenutno uređuje u
    // 'edit-folder' modu (plus njen renderCardContent, da se pločice
    // odmah osvježe po potvrdi).
    let selectedSectionType = 'custom';
    let editingFolderCard = null;
    let editingFolderRerender = null;

    function syncSectionTypeButtons() {
      sectionTypeButtons.forEach(btn => {
        const selected = btn.dataset.sectionType === selectedSectionType;
        btn.classList.toggle('is-selected', selected);
        btn.setAttribute('aria-checked', String(selected));
      });
      if (modalFolderField) modalFolderField.hidden = !(modalMode === 'add-section' && selectedSectionType === 'folder') && modalMode !== 'edit-folder';
    }

    // Checkbox lista instaliranih (ne-uklonjenih) aplikacija za folder.
    // Gradi se svježe pri svakom otvaranju - registar se ne mijenja u
    // toku sesije, ali disabled lista može.
    function buildFolderPick(checkedIds) {
      if (!folderPickList) return;
      folderPickList.replaceChildren();
      // folder pločice OTVARAJU aplikaciju - alat bez app forme tu nema
      // šta da radi, pa se ne nudi.
      const apps = (window.AIZdravo ? AIZdravo.listApps() : []).filter(app => !isAppDisabled(app.id) && !!app.app);
      if (folderPickEmpty) folderPickEmpty.hidden = apps.length > 0;
      const checked = new Set(checkedIds || []);
      apps.forEach(app => {
        const label = document.createElement('label');
        label.className = 'folder-pick-item';
        label.innerHTML = '<input type="checkbox"><span class="app-icon-tile app-icon-tile--sm"><svg><use href="#icon-tabler-' + safeIconName(app.icon) + '"></use></svg></span><span class="folder-pick-name"></span>';
        label.querySelector('.folder-pick-name').textContent = app.name;
        const box = label.querySelector('input');
        box.value = app.id;
        box.checked = checked.has(app.id);
        folderPickList.appendChild(label);
      });
    }

    function readFolderPick() {
      return folderPickList
        ? Array.from(folderPickList.querySelectorAll('input:checked')).map(box => box.value)
        : [];
    }

    sectionTypeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        selectedSectionType = btn.dataset.sectionType === 'folder' ? 'folder' : 'custom';
        if (selectedSectionType === 'folder') buildFolderPick([]);
        syncSectionTypeButtons();
        updateAddTabConfirmState();
      });
    });

    TAB_ICONS.forEach(icon => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-grid-btn';
      b.dataset.icon = icon;
      b.title = `Izaberi ikonicu ${icon.replaceAll('-', ' ')}`;
      b.setAttribute('aria-label', b.title);
      b.innerHTML = '<svg><use href="#icon-tabler-' + icon + '"></use></svg>';
      b.addEventListener('click', () => {
        selectedIcon = icon;
        addTabIconGrid.querySelectorAll('.icon-grid-btn').forEach(el => {
          el.classList.toggle('is-selected', el === b);
        });
        updateAddTabConfirmState();
      });
      addTabIconGrid.appendChild(b);
    });

    function updateAddTabConfirmState() {
      // edit-folder nema ni ime ni ikonicu - potvrda je uvijek moguća
      // (prazan izbor aplikacija je legalan folder).
      if (modalMode === 'edit-folder') {
        addTabConfirmBtn.disabled = false;
        if (modalHelp) modalHelp.textContent = 'Označi aplikacije koje folder brzo pokreće.';
        return;
      }
      const nameOk = addTabNameInput.value.trim().length > 0;
      const nameOnlyMode = modalMode === 'add-section' || modalMode === 'edit-section' || modalMode === 'edit-welcome';
      const iconOk = nameOnlyMode || !!selectedIcon;
      addTabConfirmBtn.disabled = !(nameOk && iconOk);
      if (modalHelp) {
        if (!nameOk) modalHelp.textContent = 'Unesi ime za nastavak.';
        else if (!iconOk) modalHelp.textContent = 'Izaberi ikonicu za tab.';
        else if (modalMode === 'add-section' && selectedSectionType === 'folder') modalHelp.textContent = 'Folder pokreće izabrane aplikacije jednim klikom.';
        else if (modalMode === 'add-section' || modalMode === 'edit-section') modalHelp.textContent = 'Ime će biti prikazano u zaglavlju sekcije.';
        else if (modalMode === 'edit-welcome') modalHelp.textContent = 'AI Zdravo logo ostaje ikonica ovog uvodnog taba.';
        else if (modalMode === 'edit-topbar') modalHelp.textContent = 'Ikonica i naziv "Dashboard" kartice na vrhu ekrana.';
        else modalHelp.textContent = 'Ime i ikonicu možeš kasnije promijeniti.';
      }
    }
    addTabNameInput.addEventListener('input', updateAddTabConfirmState);

    const MODAL_TITLES = {
      add: 'Novi tab',
      edit: 'Uredi tab',
      'edit-welcome': 'Uredi AI Zdravo tab',
      'add-section': 'Nova sekcija',
      'edit-section': 'Preimenuj sekciju',
      'edit-folder': 'Aplikacije foldera',
      'edit-topbar': 'Uredi gornju traku',
    };
    const MODAL_NAME_PLACEHOLDERS = {
      add: 'npr. Marketing',
      edit: 'npr. Marketing',
      'edit-welcome': 'AI Zdravo',
      'add-section': 'npr. Ključne metrike',
      'edit-section': 'npr. Ključne metrike',
      'edit-folder': '',
      'edit-topbar': 'Dashboard',
    };

    function openTabModal(mode, tabId, currentIcon, currentName) {
      modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      modalMode = mode;
      editingTabId = mode === 'edit' || mode === 'edit-welcome' ? tabId : null;
      const nameOnlyMode = mode === 'add-section' || mode === 'edit-section' || mode === 'edit-welcome' || mode === 'edit-folder';
      selectedIcon = nameOnlyMode ? null : ((mode === 'edit' || mode === 'edit-topbar') ? currentIcon : null);

      addTabTitleEl.textContent = MODAL_TITLES[mode];
      modalIconFieldEl.classList.toggle('is-hidden', nameOnlyMode);
      addTabConfirmBtn.textContent = mode.startsWith('edit') ? 'Sačuvaj' : 'Dodaj';
      addTabNameInput.placeholder = MODAL_NAME_PLACEHOLDERS[mode];
      addTabNameInput.value = mode.startsWith('edit') && mode !== 'edit-folder' ? (currentName || '') : '';

      // Tip sekcije postoji samo pri dodavanju sekcije; folder pick i u
      // edit-folder modu. Ime se u edit-folder modu potpuno sakriva -
      // uređuje se SAMO lista aplikacija, ime ima svoj rename put.
      if (mode === 'add-section') selectedSectionType = 'custom';
      if (modalTypeField) modalTypeField.hidden = mode !== 'add-section';
      if (modalNameFieldEl) modalNameFieldEl.classList.toggle('is-hidden', mode === 'edit-folder');
      syncSectionTypeButtons();

      addTabIconGrid.querySelectorAll('.icon-grid-btn').forEach(el => {
        el.classList.toggle('is-selected', el.dataset.icon === selectedIcon);
      });
      updateAddTabConfirmState();
      addTabOverlay.classList.add('is-open');
      addTabOverlay.setAttribute('aria-hidden', 'false');
      if (mode !== 'edit-folder') requestAnimationFrame(() => addTabNameInput.select());
    }
    function closeTabModal() {
      addTabOverlay.classList.remove('is-open');
      addTabOverlay.setAttribute('aria-hidden', 'true');
      const returnFocus = modalReturnFocus;
      modalReturnFocus = null;
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }
    closeTabModalGlobal = closeTabModal;

    requestAddSection = () => {
      setFabMenuOpen(false);
      // Home tab je welcome wizard, ne prima sekcije (23.7.2026,
      // Ognjenov zahtjev) - blokirano OVDJE, prije modal otvaranja, da
      // korisnik nikad ne popuni formu za nešto što će biti odbijeno.
      const activeView = document.querySelector('.view.is-active');
      if (activeView && activeView.dataset.view === 'home') {
        showToast('Ovo je uvodni vodič - napravi ili otvori radni tab da dodaš sekciju.');
        return;
      }
      openTabModal('add-section');
    };
    openSectionRename = (card, applyName) => {
      editingSectionApply = applyName;
      openTabModal('edit-section', null, null, card.dataset.name || 'Nova sekcija');
    };

    let pendingSectionMove = null;
    let moveReturnFocus = null;

    function closeMoveSectionModal() {
      if (!moveSectionOverlay) return;
      moveSectionOverlay.classList.remove('is-open');
      moveSectionOverlay.setAttribute('aria-hidden', 'true');
      pendingSectionMove = null;
      const returnFocus = moveReturnFocus;
      moveReturnFocus = null;
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }
    closeMoveSectionModalGlobal = closeMoveSectionModal;

    openSectionMove = (card, sourceBoard) => {
      if (!moveSectionOverlay || !moveSectionTarget) return;
      const sourceView = sourceBoard.closest('.view');
      const destinations = loadTabs().filter(tab => {
        return tab.id !== (sourceView && sourceView.dataset.view) && document.querySelector(`.view[data-view="${tab.id}"]`);
      });
      if (!destinations.length) {
        showToast('Dodaj još jedan tab prije premještanja sekcije.');
        return;
      }
      moveReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      pendingSectionMove = { card, sourceBoard };
      moveSectionTarget.replaceChildren();
      destinations.forEach(tab => {
        const option = document.createElement('option');
        option.value = tab.id;
        option.textContent = tab.name;
        moveSectionTarget.appendChild(option);
      });
      moveSectionOverlay.classList.add('is-open');
      moveSectionOverlay.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => moveSectionTarget.focus());
    };

    if (moveSectionCancel) moveSectionCancel.addEventListener('click', closeMoveSectionModal);
    if (moveSectionOverlay) moveSectionOverlay.addEventListener('click', event => {
      if (event.target === moveSectionOverlay) closeMoveSectionModal();
    });
    if (moveSectionConfirm) moveSectionConfirm.addEventListener('click', () => {
      if (!pendingSectionMove || !moveSectionTarget) return;
      const { card, sourceBoard } = pendingSectionMove;
      const sourceAPI = boardAPIs.get(sourceBoard);
      const targetView = document.querySelector(`.view[data-view="${moveSectionTarget.value}"]`);
      const targetBoard = targetView && targetView.querySelector('.board');
      const targetAPI = targetBoard && boardAPIs.get(targetBoard);
      if (!sourceAPI || !targetAPI) {
        showToast('Sekciju trenutno nije moguće premjestiti.');
        closeMoveSectionModal();
        return;
      }
      const snapshot = sourceAPI.extractCard(card);
      if (!snapshot) return;
      const movedCard = targetAPI.addCard(snapshot.name, snapshot);
      const sourceView = sourceBoard.closest('.view');
      const sourceId = sourceView && sourceView.dataset.view;
      const targetId = targetView.dataset.view;
      closeMoveSectionModal();
      activate(targetId);
      showToast(`Sekcija „${snapshot.name}“ je premještena.`, 'Vrati', () => {
        targetAPI.extractCard(movedCard);
        sourceAPI.addCard(snapshot.name, snapshot);
        if (sourceId) activate(sourceId);
      });
    });

    // ---------------- App/widget sloj (23.7.2026) ----------------
    // Tri komada koji zajedno čine "marketplace" mehaniku: (1) Aplikacije
    // panel - katalog registrovanih alata sa pretragom i Aplikacije/
    // Widgeti prikazom; (2) app tabovi - otvorena aplikacija dobija svoj
    // tab desno od korisničkih, vizuelno drugačiji, sa x za zatvaranje,
    // bez board-a; (3) Podešavanja lista - pregled instaliranih alata i
    // "Ukloni" koje počisti SVE instance bez siročadi.

    openFolderEdit = (card, rerender) => {
      editingFolderCard = card;
      editingFolderRerender = rerender;
      let current = [];
      try { current = JSON.parse(card.dataset.apps || '[]'); } catch (err) { current = []; }
      buildFolderPick(current);
      openTabModal('edit-folder');
    };

    // Poveži alat sa sekcijom (26.7.2026) - pretvara PRAZNU custom
    // sekciju u widget instancu na licu mjesta: card.dataset.id,
    // colSpan/rowSpan i pozicija u DOM redoslijedu (koje Ognjen ručno
    // podesi prije nego zamoli da se alat izgradi) ostaju NETAKNUTI -
    // samo se type/appId dodaju i sadržaj se renderuje unutra, umjesto
    // dodavanja nove, odvojene kartice iz kataloga (koja bi uvijek
    // dobila alat-ov default preset umjesto Ognjenove stvarne veličine).
    let pendingAttachApp = null;
    let attachAppReturnFocus = null;

    function closeAttachAppModal() {
      if (!attachAppOverlay) return;
      attachAppOverlay.classList.remove('is-open');
      attachAppOverlay.setAttribute('aria-hidden', 'true');
      pendingAttachApp = null;
      const returnFocus = attachAppReturnFocus;
      attachAppReturnFocus = null;
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }
    closeAttachAppModalGlobal = closeAttachAppModal;

    function updateAttachAppConfirmState() {
      if (!attachAppConfirm || !attachAppList) return;
      attachAppConfirm.disabled = !attachAppList.querySelector('input:checked');
    }

    openAttachAppModal = (card) => {
      if (!attachAppOverlay || !attachAppList) return;
      // Samo alati sa widget formom - ovo puni jedno POSTOJEĆE polje na
      // gridu, ne otvara aplikaciju u svom tabu.
      const apps = (window.AIZdravo ? AIZdravo.listApps() : []).filter(app => !isAppDisabled(app.id) && !!app.widget);
      attachAppList.replaceChildren();
      if (attachAppEmpty) attachAppEmpty.hidden = apps.length > 0;
      apps.forEach(app => {
        const label = document.createElement('label');
        label.className = 'folder-pick-item';
        label.innerHTML = '<input type="radio" name="attach-app-pick"><span class="app-icon-tile app-icon-tile--sm"><svg><use href="#icon-tabler-' + safeIconName(app.icon) + '"></use></svg></span><span class="folder-pick-name"></span>';
        label.querySelector('.folder-pick-name').textContent = app.name;
        const radio = label.querySelector('input');
        radio.value = app.id;
        radio.addEventListener('change', updateAttachAppConfirmState);
        attachAppList.appendChild(label);
      });
      pendingAttachApp = { card };
      attachAppReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      updateAttachAppConfirmState();
      attachAppOverlay.classList.add('is-open');
      attachAppOverlay.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => {
        const first = attachAppList.querySelector('input');
        if (first) first.focus();
      });
    };

    if (attachAppCancel) attachAppCancel.addEventListener('click', closeAttachAppModal);
    if (attachAppOverlay) attachAppOverlay.addEventListener('click', event => {
      if (event.target === attachAppOverlay) closeAttachAppModal();
    });
    if (attachAppConfirm) attachAppConfirm.addEventListener('click', () => {
      if (!pendingAttachApp) return;
      const { card } = pendingAttachApp;
      const selected = attachAppList.querySelector('input:checked');
      if (!selected || !card.isConnected) { closeAttachAppModal(); return; }
      const appId = selected.value;
      const app = window.AIZdravo ? AIZdravo.getApp(appId) : null;
      card.dataset.type = 'widget';
      card.dataset.appId = appId;
      const attachBtn = card.querySelector('[data-card-action="attach-app"]');
      if (attachBtn) attachBtn.remove();
      if (app && app.resizable === false) {
        card.classList.add('pcard-fixed-size');
        const sizeRow = card.querySelector('.pcard-size-row');
        if (sizeRow) sizeRow.hidden = true;
      }
      const cardBoard = card.closest('.board');
      const api = cardBoard && boardAPIs.get(cardBoard);
      if (api) {
        api.renderCardContent(card);
        api.saveLayout();
      }
      showToast(`Sekcija „${card.dataset.name}“ je povezana sa alatom „${(app && app.name) || appId}“.`);
      closeAttachAppModal();
    });

    // ---- App stranice (gornja traka kartica, 23.7.2026) ----
    // Ognjenov ispravak dizajna: aplikacija NIJE red u lijevom
    // dashboard sidebar-u (prva verzija, istog dana, ranije) - to je
    // potpuno ODVOJENA "browser tab" traka gore. "Dashboard" kartica
    // (uvijek prva, ne zatvara se) prikazuje sve što danas postoji
    // (sidebar+boardovi); klik na app karticu prikazuje SAMO tu
    // aplikaciju preko cijelog ekrana, bez sidebar-a/FAB-a ("bez
    // dashboard funkcija") - vraćanje je klik na Dashboard karticu.
    // Lijevi sidebar-ov aktivni tab (koji tab/board se vidi ISPOD
    // Dashboard kartice) ostaje potpuno nezavisan i netaknut dok se
    // šeta između app stranica - activate()/navItems/views ovdje uopšte
    // ne znaju da aplikacije postoje.

    const topTabBar = document.getElementById('topTabBar');
    const topTabDashboardBtn = document.getElementById('topTabDashboard');
    const appFullscreenPages = document.getElementById('appFullscreenPages');
    const ACTIVE_TOP_TAB_KEY = 'aizdravo:active-top-tab';
    const appPageCleanups = new Map(); // appId -> cleanup fn alata

    function readOpenAppTabs() {
      try {
        const parsed = JSON.parse(localStorage.getItem(OPEN_APP_TABS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
      } catch (err) {
        return [];
      }
    }
    function saveOpenAppTabs(ids) {
      try {
        persistValue(OPEN_APP_TABS_KEY, JSON.stringify(ids));
      } catch (err) {
        // gubitak liste otvorenih app stranica nije fatalan
      }
    }

    function switchTopTab(target) {
      const isDashboard = target === 'dashboard';
      document.body.classList.toggle('is-app-fullscreen', !isDashboard);
      if (topTabDashboardBtn) {
        topTabDashboardBtn.classList.toggle('is-active', isDashboard);
        topTabDashboardBtn.setAttribute('aria-selected', String(isDashboard));
      }
      if (topTabBar) {
        topTabBar.querySelectorAll('.top-tab[data-app-page]').forEach(btn => {
          const active = btn.dataset.appPage === target;
          btn.classList.toggle('is-active', active);
          btn.setAttribute('aria-selected', String(active));
        });
      }
      if (appFullscreenPages) {
        appFullscreenPages.hidden = isDashboard;
        appFullscreenPages.querySelectorAll('.app-page').forEach(page => {
          page.classList.toggle('is-active', page.dataset.appPage === target);
        });
      }
      try { persistValue(ACTIVE_TOP_TAB_KEY, target); } catch (err) { /* nije fatalno */ }
      if (isDashboard) {
        // .app je bio display:none dok je app stranica bila aktivna -
        // ako se prozor u međuvremenu promijenio, board širina/grid faza
        // mogu biti zastarjeli (ništa se ne pokvari, samo ostane stalo
        // dok se ne desi pravi resize) - rekalkuliši čim se sidebar/board
        // ponovo vrate u vidno polje, isti obrazac kao sidebar-collapse.
        requestAnimationFrame(() => {
          recalcBoardLayout();
          resizeFxOverlay();
        });
      }
    }

    function createAppPageDOM(app) {
      if (!topTabBar || !appFullscreenPages) return;

      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'top-tab';
      tabBtn.dataset.appPage = app.id;
      tabBtn.setAttribute('role', 'tab');
      tabBtn.innerHTML =
        '<svg><use href="#icon-tabler-' + safeIconName(app.icon) + '"></use></svg>' +
        '<span class="top-tab-label"></span>' +
        '<span class="top-tab-close" title="Zatvori aplikaciju" aria-label="Zatvori aplikaciju &quot;' + app.name + '&quot;"><svg><use href="#icon-tabler-x"></use></svg></span>';
      tabBtn.querySelector('.top-tab-label').textContent = app.name;
      tabBtn.addEventListener('click', event => {
        if (event.target.closest('.top-tab-close')) return; // ima svoj handler ispod
        switchTopTab(app.id);
      });
      tabBtn.querySelector('.top-tab-close').addEventListener('click', event => {
        event.stopPropagation();
        closeAppPage(app.id);
      });
      topTabBar.appendChild(tabBtn);

      const page = document.createElement('section');
      page.className = 'app-page';
      page.dataset.appPage = app.id;
      page.innerHTML =
        '<div class="app-page-heading">' +
          '<span class="app-icon-tile app-icon-tile--md"><svg><use href="#icon-tabler-' + safeIconName(app.icon) + '"></use></svg></span>' +
          '<div class="app-page-titles"><h1></h1><span class="app-version"></span></div>' +
        '</div>' +
        '<div class="app-page-surface"></div>';
      page.querySelector('h1').textContent = app.name;
      page.querySelector('.app-version').textContent = 'v' + app.version;
      appFullscreenPages.appendChild(page);

      const cleanup = AIZdravo.renderInto(app.id, 'app', page.querySelector('.app-page-surface'));
      if (cleanup) appPageCleanups.set(app.id, cleanup);
    }

    function openAppTab(appId) {
      const app = window.AIZdravo ? AIZdravo.getApp(appId) : null;
      if (!app || isAppDisabled(appId)) {
        showToast('Alat nije dostupan.');
        return;
      }
      if (!app.app) {
        showToast('„' + app.name + '“ postoji samo kao widget - dodaj ga na board iz kataloga.');
        return;
      }
      const existing = topTabBar && topTabBar.querySelector('.top-tab[data-app-page="' + appId + '"]');
      if (existing) {
        // Već otvorena - samo fokus, nikad druga kartica iste aplikacije.
        switchTopTab(appId);
        return;
      }
      createAppPageDOM(app);
      const open = readOpenAppTabs();
      if (!open.includes(appId)) {
        open.push(appId);
        saveOpenAppTabs(open);
      }
      switchTopTab(appId);
    }
    openAppTabGlobal = openAppTab;

    function closeAppPage(appId) {
      const cleanup = appPageCleanups.get(appId);
      if (cleanup) {
        appPageCleanups.delete(appId);
        try { cleanup(); } catch (err) { /* greška alata pri cleanupu ne ruši dashboard */ }
      }
      const tabBtn = topTabBar && topTabBar.querySelector('.top-tab[data-app-page="' + appId + '"]');
      const page = appFullscreenPages && appFullscreenPages.querySelector('.app-page[data-app-page="' + appId + '"]');
      const wasActive = !!(tabBtn && tabBtn.classList.contains('is-active'));
      if (tabBtn) tabBtn.remove();
      if (page) page.remove();
      saveOpenAppTabs(readOpenAppTabs().filter(id => id !== appId));
      // Zatvaranje UVIJEK vraća na Dashboard (Ognjenov zahtjev) - ne na
      // "gdje si bio prije", to pojednostavljenje uklanja cijelu klasu
      // ranijih return-view knjigovodstva jer app stranice više nisu dio
      // dashboard tab sistema.
      if (wasActive) switchTopTab('dashboard');
    }
    if (topTabDashboardBtn) topTabDashboardBtn.addEventListener('click', () => switchTopTab('dashboard'));

    // ---- Gornja traka: customizable ikonica/naziv (23.7.2026) ----

    function readTopbarIdentity() {
      let icon = 'ai-zdravo-logo';
      let label = 'Dashboard';
      try { icon = localStorage.getItem(TOPBAR_ICON_KEY) || icon; } catch (err) { /* default ostaje */ }
      try { label = localStorage.getItem(TOPBAR_LABEL_KEY) || label; } catch (err) { /* default ostaje */ }
      return { icon, label };
    }
    function topbarIconMarkup(icon) {
      return icon === 'ai-zdravo-logo'
        ? '<img src="assets/logo.png" alt="">'
        : '<svg><use href="#icon-tabler-' + safeIconName(icon) + '"></use></svg>';
    }
    function applyTopbarIdentity() {
      if (!topTabDashboardBtn) return;
      const { icon, label } = readTopbarIdentity();
      const iconSlot = topTabDashboardBtn.querySelector('.top-tab-icon-slot');
      if (iconSlot) iconSlot.innerHTML = topbarIconMarkup(icon).replace('<img ', '<img class="top-tab-logo" ');
      const labelEl = topTabDashboardBtn.querySelector('.top-tab-label');
      if (labelEl) labelEl.textContent = label;
    }
    function renderTopbarIdentityPreview() {
      const iconEl = document.getElementById('topbarIdentityPreviewIcon');
      const labelEl = document.getElementById('topbarIdentityPreviewLabel');
      if (!iconEl || !labelEl) return;
      const { icon, label } = readTopbarIdentity();
      iconEl.innerHTML = topbarIconMarkup(icon);
      labelEl.textContent = label;
    }
    renderTopbarIdentityPreviewGlobal = renderTopbarIdentityPreview;

    const topbarIdentityEditBtn = document.getElementById('topbarIdentityEdit');
    if (topbarIdentityEditBtn) {
      topbarIdentityEditBtn.addEventListener('click', () => {
        const { icon, label } = readTopbarIdentity();
        openTabModal('edit-topbar', null, icon, label);
      });
    }

    // ---- Aplikacije panel ----

    let appsMode = 'apps'; // 'apps' | 'widgets'
    // Cleanup funkcije žive-renderovanih widget pregleda u katalogu
    // (23.7.2026, vidi renderAppsGrid) - moraju se pozvati prije nego
    // se grid ponovo iscrta (search/mode promjena) ili panel zatvori, da
    // preview instanca ne ostavi tajmer/listener iza sebe.
    let previewCleanups = [];
    function clearPreviewCleanups() {
      previewCleanups.forEach(fn => { try { fn(); } catch (err) { /* alat je pukao pri cleanupu */ } });
      previewCleanups = [];
    }

    function setAppsMode(mode) {
      appsMode = mode === 'widgets' ? 'widgets' : 'apps';
      if (appsModeApps) {
        appsModeApps.classList.toggle('is-active', appsMode === 'apps');
        appsModeApps.setAttribute('aria-selected', String(appsMode === 'apps'));
      }
      if (appsModeWidgets) {
        appsModeWidgets.classList.toggle('is-active', appsMode === 'widgets');
        appsModeWidgets.setAttribute('aria-selected', String(appsMode === 'widgets'));
      }
      // Naslov i search placeholder prate izabrani prikaz (27.7.2026) -
      // "Katalog" eyebrow ostaje fiksan, h2 ispod njega i placeholder
      // se mijenjaju Aplikacije <-> Widgeti.
      if (appsTitle) appsTitle.textContent = appsMode === 'widgets' ? 'Widgeti' : 'Aplikacije';
      if (appsSearch) {
        const placeholder = appsMode === 'widgets' ? 'Pretraži widgete...' : 'Pretraži aplikacije...';
        appsSearch.placeholder = placeholder;
        appsSearch.setAttribute('aria-label', placeholder.replace('...', ''));
      }
      renderAppsGrid();
    }

    function addWidgetToActiveTab(app, sizeKey) {
      if (!app.widget) {
        showToast('„' + app.name + '“ nema widget formu - otvori je kao aplikaciju.');
        return;
      }
      const size = app.sizes[sizeKey] || app.sizes[app.defaultSize];
      // Home je welcome wizard (23.7.2026) - NIKAD validna meta iako
      // tehnički ima svoj (trajno skriven) .board element, zato je
      // eksplicitno isključen ovdje umjesto oslanjanja na generičko
      // ".view.is-active .board".
      let activeBoard = document.querySelector('.view.is-active:not([data-view="home"]) .board');
      let boardNote = '';
      if (!activeBoard) {
        // Aktivan tab nema board (app stranica, ili je Home wizard) -
        // padni na PRVI RADNI tab (bilo koji osim home) da klik nikad ne
        // propadne u prazno, ali i ne završi nevidljivo na wizardu.
        const fallbackItem = navItems.find(item => item.dataset.view !== 'home');
        if (!fallbackItem) {
          showToast('Napravi prvo radni tab (+ Dodaj tab) - Welcome vodič ne prima widgete.');
          return;
        }
        activate(fallbackItem.dataset.view);
        activeBoard = document.querySelector('.view.is-active .board');
        boardNote = ' (na prvi radni tab - aktivni tab nije imao board)';
      }
      const api = activeBoard && boardAPIs.get(activeBoard);
      if (!api) {
        showToast('Nijedan tab sa sekcijama nije aktivan.');
        return;
      }
      api.addCard(app.name, {
        type: 'widget',
        appId: app.id,
        colSpan: size.col,
        rowSpan: size.row,
      });
      closeAppsPanel();
      showToast('Widget „' + app.name + '“ je dodat' + boardNote + '.');
    }

    // ---- Widget drag-and-drop plasman (24.7.2026, preprojektovano istog
    // dana na Ognjenov eksplicitan zahtjev) ----
    // Prevlačenje pločice iz Widgeti kataloga na board: panel se zatvara,
    // pojavljuje se tačkasti grid + duh (ghost) pločice u STANDARDNOJ
    // (default) veličini widgeta. NAMJERNO nema slobodnog pozicioniranja
    // piksel-po-piksel (prvobitni pokušaj, colStart/rowStart preko
    // addCard-a) - Ognjen je eksplicitno tražio da korisnik NEMA moć da
    // stavi widget bilo gdje, nego da mjesto prevlačenja samo određuje
    // GDJE U REDOSLIJEDU sekcija se widget umeće (isto ponašanje kao
    // premještanje/reorder postojećih sekcija preko SortableJS-a), a
    // STVARNU ćeliju određuje `grid-auto-flow: dense` sam - "prvo slobodno
    // mjesto" umjesto "tačno tu gdje sam pustio". Ghost je zato PRAVI grid
    // učesnik (direktno dijete `.board`-a sa plain `span N` bez starta,
    // ubačen na tačnu DOM poziciju preko `insertBefore`) - browser-ov
    // vlastiti dense-packing algoritam ga automatski slaže bez preklapanja
    // i to JE tačan live preview, ne moja aproksimacija (stari pokušaj je
    // imao bag: getComputedStyle(gridColumnStart) na auto-placed kartici
    // vraća bukvalno "span N", ne razriješenu liniju - kolizija se nikad
    // nije ni detektovala). Native HTML5 DnD (dragstart/dragover/drop) -
    // SortableJS (forceFallback:true, pointer-simulacija) i dalje radi
    // isključivo reorder UNUTAR boarda, oba mehanizma koegzistiraju bez
    // sukoba jer nikad ne dijele isti event.
    let widgetDrag = null;
    const widgetDragImg = new Image();
    widgetDragImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

    // Kartica najbliža kursoru (Euklidsko odstojanje centara) + da li
    // umetnuti PRIJE ili POSLIJE nje - ista "reading order" heuristika kao
    // tipični drag-reorder alati: ispod reda te kartice (ili u istom redu
    // ali desno od centra) = poslije, inače prije. Krajnja tačna ćelija je
    // svejedno na browseru (dense packing) - ovo samo bira PRIBLIŽNO mjesto
    // u redoslijedu, ne piksel poziciju.
    function widgetDragFindInsertion(board, clientX, clientY) {
      const cards = Array.from(board.querySelectorAll(':scope > .pcard'));
      if (!cards.length) return null;
      let best = null;
      let bestDist = Infinity;
      let insertAfter = false;
      cards.forEach(card => {
        const r = card.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dist = Math.hypot(clientX - cx, clientY - cy);
        if (dist < bestDist) {
          bestDist = dist;
          best = card;
          const sameRow = clientY >= r.top && clientY <= r.bottom;
          insertAfter = sameRow ? clientX > cx : clientY > cy;
        }
      });
      return { refCard: best, insertAfter };
    }

    function widgetDragMoveGhost(board, ghost, clientX, clientY) {
      const insertion = widgetDragFindInsertion(board, clientX, clientY);
      if (!insertion) {
        board.appendChild(ghost);
        return;
      }
      const { refCard, insertAfter } = insertion;
      board.insertBefore(ghost, insertAfter ? refCard.nextSibling : refCard);
    }

    function beginWidgetDrag(app, dragEvent) {
      const size = app.sizes[app.defaultSize];
      if (!size) { dragEvent.preventDefault(); return; }
      let board = document.querySelector('.view.is-active:not([data-view="home"]) .board');
      if (!board) {
        const fallbackItem = navItems.find(item => item.dataset.view !== 'home');
        if (fallbackItem) {
          activate(fallbackItem.dataset.view);
          board = document.querySelector('.view.is-active .board');
        }
      }
      const api = board && boardAPIs.get(board);
      if (!board || !api) {
        dragEvent.preventDefault();
        showToast('Napravi prvo radni tab (+ Dodaj tab) - Welcome vodič ne prima widgete.');
        return;
      }
      // dataTransfer setup MORA ostati sinhrono unutar dragstart (spec) -
      // sve ostalo (zatvaranje panela, ghost, grid) se NAMJERNO odgađa
      // jedan tick preko setTimeout(0). Uživo otkriveno 24.7.2026: pozivanje
      // closeAppsPanel() ODMAH ovdje sakriva panel (i time OVU pločicu,
      // koja je njegovo dijete) iz vidljivog stabla PRIJE nego browser
      // završi hvatanje native drag snapshot-a - browser to tumači kao
      // "izvor prevlačenja je nestao" i TIHO OTKAŽE cio drag (meni nestane,
      // ali dalje prevlačenje na board više ne radi nikako). Odgađanje za
      // jedan tick pušta browser da prvo stabilno "uhvati" drag pa tek
      // onda mijenja DOM.
      if (dragEvent.dataTransfer) {
        dragEvent.dataTransfer.effectAllowed = 'copy';
        try { dragEvent.dataTransfer.setData('text/plain', app.id); } catch (err) { /* neki browseri traže setData da drag uopšte krene */ }
        dragEvent.dataTransfer.setDragImage(widgetDragImg, 0, 0);
      }
      setTimeout(() => {
        closeAppsPanel();
        const ghost = document.createElement('div');
        ghost.className = 'widget-drop-ghost';
        ghost.style.gridColumn = 'span ' + size.col;
        ghost.style.gridRow = 'span ' + size.row;
        board.appendChild(ghost);
        widgetDrag = {
          app, board, api, ghost,
          colSpan: size.col, rowSpan: size.row,
          gridWasVisible: gridVisible,
        };
        setGridVisible(true, false);
      }, 0);
    }

    function updateWidgetDragOver(dragEvent) {
      if (!widgetDrag) return;
      dragEvent.preventDefault();
      if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = 'copy';
      const { board, ghost } = widgetDrag;
      const rect = board.getBoundingClientRect();
      // .board je auto-visine (shrink-wrap na trenutni sadržaj, vidi CSS) -
      // ispod POSLJEDNJE kartice rect.bottom prestaje iako canvasWrap ide
      // dalje i izgleda kao prazan prostor za korisnika. Zato se donja
      // granica uzima sa canvasWrap-a (vidljivi/skrolabilni okvir), a
      // lijeva/desna sa boarda (stvarna širina kolona, canvasWrap ima svoj
      // padding pa je širi) - grid-auto-rows sam proširi board kad kartica
      // stvarno stane na red dalje od trenutnog sadržaja.
      const wrapRect = canvasWrapMain.getBoundingClientRect();
      const within = dragEvent.clientX >= rect.left && dragEvent.clientX <= rect.right &&
        dragEvent.clientY >= rect.top && dragEvent.clientY <= wrapRect.bottom;
      ghost.style.display = within ? '' : 'none';
      if (!within) return;
      widgetDragMoveGhost(board, ghost, dragEvent.clientX, dragEvent.clientY);
    }

    function finishWidgetDrop(dragEvent) {
      if (!widgetDrag) return;
      dragEvent.preventDefault();
      const { app, api, board, ghost, colSpan, rowSpan } = widgetDrag;
      // Ghost je već na TAČNOJ DOM poziciji (posljednji updateWidgetDragOver)
      // - stvarna kartica ide na isto mjesto (nextSibling kao insertBefore
      // referenca, null = ghost je bio posljednji dijete = dodaj na kraj),
      // pa se uklanja ghost. Position u redoslijedu, NE piksel-pozicija -
      // grid-auto-flow:dense (postojeći CSS, netaknut) sam pakuje u prvo
      // stvarno slobodno mjesto, isti mehanizam kao i za sve ostale kartice.
      const insertBeforeEl = ghost.nextSibling;
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      api.addCard(app.name, {
        type: 'widget',
        appId: app.id,
        colSpan, rowSpan,
        insertBefore: insertBeforeEl && insertBeforeEl.parentNode === board ? insertBeforeEl : null,
      });
      showToast('Widget „' + app.name + '“ je postavljen.');
    }

    function endWidgetDrag() {
      if (!widgetDrag) return;
      const { ghost, gridWasVisible } = widgetDrag;
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      setGridVisible(gridWasVisible, false);
      widgetDrag = null;
    }

    function renderAppsGrid() {
      if (!appsGrid) return;
      const query = (appsSearch ? appsSearch.value : '').trim().toLocaleLowerCase('sr');
      // Prikaz filtrira i po FORMI: "Aplikacije" lista samo alate sa app
      // formom, "Widgeti" samo one sa widget formom (23.7.2026 - forme
      // su opcione pojedinačno, alat može biti samo jedno od toga).
      const installed = (window.AIZdravo ? AIZdravo.listApps() : [])
        .filter(app => !isAppDisabled(app.id))
        .filter(app => (appsMode === 'apps' ? !!app.app : !!app.widget));
      const matches = installed.filter(app =>
        !query || app.name.toLocaleLowerCase('sr').includes(query) || app.description.toLocaleLowerCase('sr').includes(query));

      // Prethodni pregledi (ako je Widgeti prikaz upravo bio otvoren) se
      // moraju ugasiti PRIJE appsGrid.replaceChildren() - to je jedini
      // trenutak DOM zaista uklanja te čvorove, pa je ovo posljednja
      // šansa da se pozovu cleanup funkcije alata bez curenja.
      clearPreviewCleanups();
      appsGrid.replaceChildren();
      appsGrid.classList.toggle('is-widgets-mode', appsMode === 'widgets');
      if (appsEmpty) appsEmpty.hidden = installed.length > 0;
      if (installed.length && !matches.length) {
        const none = document.createElement('p');
        none.className = 'apps-no-results';
        none.textContent = 'Nijedan alat ne odgovara pretrazi „' + query + '“.';
        appsGrid.appendChild(none);
        return;
      }

      // Aplikacije prikaz: springboard/iPhone stil, veliki obojen kvadrat
      // + ime ispod (isti app-tile komponenta kao folder pločice/pick
      // lista). Klik = otvori aplikaciju, tačno kao dodir na pravu app
      // ikonicu. Opis/verzija idu u title tooltip.
      if (appsMode === 'apps') {
        matches.forEach(app => {
          // div wrapper (ne button) - "Ukloni trajno" (27.7.2026) treba
          // svoje dugme koje ne smije biti UGNIJEŽĐENO u drugi <button>
          // (nevažeći HTML). Klik-da-otvori sad je poseban header button.
          const tile = document.createElement('div');
          tile.className = 'app-tile apps-catalog-tile';
          const header = document.createElement('button');
          header.type = 'button';
          header.className = 'app-tile-header';
          header.title = app.name + ' — v' + app.version + ' — ' + app.description;
          header.innerHTML =
            '<span class="app-icon-tile app-icon-tile--lg"><svg><use href="#icon-tabler-' + safeIconName(app.icon) + '"></use></svg></span>' +
            '<span class="app-tile-name"></span>';
          header.querySelector('.app-tile-name').textContent = app.name;
          header.addEventListener('click', () => {
            closeAppsPanel();
            openAppTab(app.id);
          });
          tile.appendChild(header);
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'app-tile-delete';
          deleteBtn.title = 'Obriši trajno';
          deleteBtn.setAttribute('aria-label', 'Obriši „' + app.name + '“ trajno');
          deleteBtn.innerHTML = '<svg><use href="#icon-tabler-x"></use></svg>';
          deleteBtn.addEventListener('click', event => {
            event.stopPropagation();
            deleteAppPermanently(app, deleteBtn);
          });
          tile.appendChild(deleteBtn);
          appsGrid.appendChild(tile);
        });
        return;
      }

      // Widgeti prikaz (23.7.2026, Ognjenov zahtjev): pored ikonice+imena,
      // ŽIVO renderovan pregled kako widget stvarno izgleda - isti
      // AIZdravo.renderInto put koji puni pravu karticu na boardu, samo
      // u malom neinteraktivnom okviru (inert + pointer-events:none, pa
      // klik na pregled prolazi kroz na header ispod - nikad ne otvara
      // tuđi textarea/dugme slučajno). NIJE <button> spolja (kao
      // Aplikacije tile) jer bi ugnježđivanje pravih interaktivnih
      // elemenata alata (textarea, dugmad) unutar <button> bilo
      // nevažeća/riskantna HTML struktura - klik-akcija ide na header
      // red (ikonica+ime), pregled je čist sadržaj ispod.
      matches.forEach(app => {
        const tile = document.createElement('div');
        tile.className = 'app-tile app-tile--widget';
        // Prevlačenje direktno na board (24.7.2026) - dodaje u DEFAULT
        // (standardnoj) veličini, bez obzira koja je pilula posljednja
        // klikana; pilule ostaju za precizan klik-dodaj po veličini.
        tile.draggable = true;
        tile.addEventListener('dragstart', (e) => beginWidgetDrag(app, e));
        tile.addEventListener('dragend', endWidgetDrag);

        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'app-tile-header';
        header.title = app.name + ' — v' + app.version + ' — ' + app.description;
        header.innerHTML =
          '<span class="app-icon-tile app-icon-tile--sm"><svg><use href="#icon-tabler-' + safeIconName(app.icon) + '"></use></svg></span>' +
          '<span class="app-tile-name"></span>';
        header.querySelector('.app-tile-name').textContent = app.name;
        header.addEventListener('click', () => addWidgetToActiveTab(app, app.defaultSize));
        tile.appendChild(header);
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'app-tile-delete';
        deleteBtn.title = 'Obriši trajno';
        deleteBtn.setAttribute('aria-label', 'Obriši „' + app.name + '“ trajno');
        deleteBtn.innerHTML = '<svg><use href="#icon-tabler-x"></use></svg>';
        deleteBtn.addEventListener('click', event => {
          event.stopPropagation();
          deleteAppPermanently(app, deleteBtn);
        });
        tile.appendChild(deleteBtn);

        const preview = document.createElement('div');
        preview.className = 'app-tile-preview';
        preview.setAttribute('aria-hidden', 'true');
        preview.inert = true; // i tastatura/fokus, ne samo klik - vidi komentar iznad
        const previewSize = app.sizes[app.defaultSize];
        if (previewSize) {
          preview.style.aspectRatio = previewSize.col + ' / ' + previewSize.row;
          // A widget whose default size is noticeably wider than tall
          // (e.g. a 26:11 report list) reads as cramped/squeezed - or,
          // before the width:100% CSS fix above, literally overflowed its
          // own tile - if forced into the same single narrow grid track
          // as a compact widget like Brze bilješke (8:6). Let a wide
          // widget's tile CLAIM more of those tracks instead of fighting
          // its own aspect ratio inside one. 1.5 is just past a 3:2
          // landscape ratio - anything more "panoramic" than that earns
          // an extra column; capped at 3 so one tile can't eat the whole
          // picker on an extreme ratio.
          const aspect = previewSize.col / previewSize.row;
          const span = Math.min(3, Math.max(1, Math.round(aspect / 1.5)));
          if (span > 1) tile.style.gridColumn = 'span ' + span;
        }
        tile.appendChild(preview);
        const previewCleanup = AIZdravo.renderInto(app.id, 'widget', preview);
        if (previewCleanup) previewCleanups.push(previewCleanup);

        const sizeKeys = ['s', 'm', 'l'].filter(key => app.sizes[key]);
        if (sizeKeys.length > 1) {
          // Više od jedne veličine: mala pilula-traka bira KONKRETNU
          // veličinu - svaki klik je sam po sebi "dodaj u toj veličini".
          // Klik na header (ikonica/ime) i dalje dodaje default.
          const sizeRow = document.createElement('div');
          sizeRow.className = 'app-tile-sizes';
          sizeKeys.forEach(key => {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'app-tile-size-pill' + (key === app.defaultSize ? ' is-default' : '');
            pill.textContent = key.toUpperCase();
            pill.title = app.sizes[key].col + '×' + app.sizes[key].row + ' polja';
            pill.addEventListener('click', () => addWidgetToActiveTab(app, key));
            sizeRow.appendChild(pill);
          });
          tile.appendChild(sizeRow);
        }
        if (app.resizable === false) {
          const fixed = document.createElement('span');
          fixed.className = 'app-tile-fixed-note';
          fixed.textContent = 'fiksna veličina';
          tile.appendChild(fixed);
        }
        appsGrid.appendChild(tile);
      });
    }

    function openAppsPanel(mode) {
      if (!appsOverlay) return;
      setFabMenuOpen(false);
      if (appsSearch) appsSearch.value = '';
      setAppsMode(mode || 'apps');
      appsOverlay.classList.add('is-open');
      appsOverlay.setAttribute('aria-hidden', 'false');
      if (appsSearch) requestAnimationFrame(() => appsSearch.focus());
    }

    function closeAppsPanel() {
      if (!appsOverlay) return;
      appsOverlay.classList.remove('is-open');
      appsOverlay.setAttribute('aria-hidden', 'true');
      // Živi widget pregledi ne treba da rade dok je panel zatvoren -
      // sljedeće otvaranje ionako poziva renderAppsGrid() i pravi svježe.
      clearPreviewCleanups();
    }
    closeAppsPanelGlobal = closeAppsPanel;
    openAppsPanelGlobal = openAppsPanel;

    if (fabOpenApps) fabOpenApps.addEventListener('click', () => openAppsPanel('apps'));
    if (appsClose) appsClose.addEventListener('click', closeAppsPanel);
    if (appsOverlay) appsOverlay.addEventListener('click', event => {
      if (event.target === appsOverlay) closeAppsPanel();
    });
    if (appsSearch) appsSearch.addEventListener('input', renderAppsGrid);
    if (appsModeApps) appsModeApps.addEventListener('click', () => setAppsMode('apps'));
    if (appsModeWidgets) appsModeWidgets.addEventListener('click', () => setAppsMode('widgets'));

    // Delegirano na #canvasWrap (dijeljeni predak SVIH boardova, tekućih i
    // budućih) umjesto na pojedinačan board element - board se pravi/gasi
    // dinamički po tabu, canvasWrap ne. widgetDrag pamti KOJI je board
    // ciljan (postavljen u beginWidgetDrag), pa ovi listeneri ne moraju
    // sami da ga traže iz event.target-a.
    if (canvasWrapMain) {
      canvasWrapMain.addEventListener('dragover', updateWidgetDragOver);
      canvasWrapMain.addEventListener('drop', finishWidgetDrop);
    }

    // ---- Podešavanja: instalirani alati ----

    function countAppTraces(appId) {
      const widgetCards = document.querySelectorAll('.pcard[data-app-id="' + appId + '"]');
      let folderRefs = 0;
      document.querySelectorAll('.pcard[data-type="folder"]').forEach(card => {
        try {
          if (JSON.parse(card.dataset.apps || '[]').includes(appId)) folderRefs += 1;
        } catch (err) { /* pokvaren dataset ne ruši brojanje */ }
      });
      const openTab = !!(topTabBar && topTabBar.querySelector('.top-tab[data-app-page="' + appId + '"]'));
      return { widgets: widgetCards.length, folders: folderRefs, openTab };
    }

    async function removeAppEverywhere(app, trigger) {
      const traces = countAppTraces(app.id);
      const total = traces.widgets + traces.folders + (traces.openTab ? 1 : 0);
      if (total > 0) {
        const parts = [];
        if (traces.widgets) parts.push(traces.widgets + (traces.widgets === 1 ? ' widget sekciju' : ' widget sekcije'));
        if (traces.folders) parts.push('pločice u ' + traces.folders + (traces.folders === 1 ? ' folderu' : ' foldera'));
        if (traces.openTab) parts.push('otvoren tab');
        const ok = await askConfirmation('Ukloniti alat „' + app.name + '“? Nestaće: ' + parts.join(', ') + '. Podaci alata ostaju sačuvani za slučaj ponovne instalacije.', trigger);
        if (!ok) return;
      }
      // 1) widget instance sa SVIH boardova (extractCard radi cleanup +
      // saveLayout po boardu)
      document.querySelectorAll('.pcard[data-app-id="' + app.id + '"]').forEach(card => {
        const boardEl = card.closest('.board');
        const api = boardEl && boardAPIs.get(boardEl);
        if (api) api.extractCard(card);
      });
      // 2) reference iz foldera
      document.querySelectorAll('.pcard[data-type="folder"]').forEach(card => {
        let apps = [];
        try { apps = JSON.parse(card.dataset.apps || '[]'); } catch (err) { apps = []; }
        if (!apps.includes(app.id)) return;
        card.dataset.apps = JSON.stringify(apps.filter(id => id !== app.id));
        const boardEl = card.closest('.board');
        const api = boardEl && boardAPIs.get(boardEl);
        if (api) {
          api.renderCardContent(card);
          api.saveLayout();
        }
      });
      // 3) otvorena app stranica
      closeAppPage(app.id);
      // 4) registar zapis (disabled lista - script tag ostaje u
      // index.html dok ga korisnik fizički ne ukloni, vidi
      // APPS_AND_WIDGETS.md)
      const disabled = readDisabledApps();
      if (!disabled.includes(app.id)) {
        disabled.push(app.id);
        persistValue(DISABLED_APPS_KEY, JSON.stringify(disabled));
      }
      renderInstalledApps();
      renderAppsGrid();
      showToast('Alat „' + app.name + '“ je uklonjen.');
    }

    // Trajno brisanje iz kataloga (27.7.2026, Ognjenov zahtjev - "opcija
    // brisanja aplikacije i widgeta iz kataloga alata, uz poruku da je
    // brisanje permanentno"). Suprotno od removeAppEverywhere iznad (koja
    // samo SAKRIJE alat, fajlovi i podaci ostaju za reinstalaciju) - ovo
    // stvarno briše apps/<id>/ folder na disku preko servera, pa čisti
    // sve tragove na klijentskoj strani ODMAH (uključujući ctx.storage
    // podatke, koje soft-ukloni namjerno čuva).
    async function deleteAppPermanently(app, trigger) {
      const traces = countAppTraces(app.id);
      const total = traces.widgets + traces.folders + (traces.openTab ? 1 : 0);
      const parts = [];
      if (traces.widgets) parts.push(traces.widgets + (traces.widgets === 1 ? ' widget sekciju' : ' widget sekcije'));
      if (traces.folders) parts.push('pločice u ' + traces.folders + (traces.folders === 1 ? ' folderu' : ' foldera'));
      if (traces.openTab) parts.push('otvoren tab');
      const tracesMsg = total ? ' Nestaće: ' + parts.join(', ') + '.' : '';
      const ok = await askConfirmation(
        'Trajno obrisati „' + app.name + '“? Ovo briše apps/' + app.id + '/ sa diska i sve podatke alata - ne može se vratiti.' + tracesMsg,
        trigger
      );
      if (!ok) return;

      let response;
      try {
        response = await fetch('/api/apps/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: app.id }),
        });
      } catch (err) {
        showToast('Server nije dostupan - „' + app.name + '“ nije obrisan.');
        return;
      }
      let data = null;
      try { data = await response.json(); } catch (err) { /* nevažeći JSON iz servera */ }
      if (!response.ok || !data || !data.ok) {
        showToast('Brisanje nije uspjelo: ' + ((data && data.message) || ('HTTP ' + response.status)));
        return;
      }

      // Widget instance sa svih boardova + folder reference + otvoren tab -
      // ista tri koraka kao removeAppEverywhere iznad.
      document.querySelectorAll('.pcard[data-app-id="' + app.id + '"]').forEach(card => {
        const boardEl = card.closest('.board');
        const api = boardEl && boardAPIs.get(boardEl);
        if (api) api.extractCard(card);
      });
      document.querySelectorAll('.pcard[data-type="folder"]').forEach(card => {
        let apps = [];
        try { apps = JSON.parse(card.dataset.apps || '[]'); } catch (err) { apps = []; }
        if (!apps.includes(app.id)) return;
        card.dataset.apps = JSON.stringify(apps.filter(id => id !== app.id));
        const boardEl = card.closest('.board');
        const api = boardEl && boardAPIs.get(boardEl);
        if (api) {
          api.renderCardContent(card);
          api.saveLayout();
        }
      });
      closeAppPage(app.id);
      // Trajno - za razliku od soft-ukloni, podaci alata se NE čuvaju.
      removePersistedValue('aizdravo:app:' + app.id);
      if (window.AIZdravo && AIZdravo.unregisterApp) AIZdravo.unregisterApp(app.id);
      renderAppsGrid();
      renderInstalledApps();
      showToast('„' + app.name + '“ je trajno obrisan.');
    }

    function renderInstalledApps() {
      if (!installedAppsList) return;
      installedAppsList.replaceChildren();
      const apps = window.AIZdravo ? AIZdravo.listApps() : [];
      if (!apps.length) {
        const none = document.createElement('p');
        none.className = 'installed-apps-empty';
        none.textContent = 'Nijedan alat još nije instaliran.';
        installedAppsList.appendChild(none);
      }
      apps.forEach(app => {
        const disabled = isAppDisabled(app.id);
        const traces = countAppTraces(app.id);
        const row = document.createElement('div');
        row.className = 'installed-app-row' + (disabled ? ' is-disabled' : '');
        row.innerHTML =
          '<span class="installed-app-icon"><svg><use href="#icon-tabler-' + safeIconName(app.icon) + '"></use></svg></span>' +
          '<div class="installed-app-meta"><strong></strong><span></span></div>' +
          '<button type="button" class="installed-app-action"></button>';
        row.querySelector('strong').textContent = app.name + ' v' + app.version;
        const forms = [app.widget ? 'widget' : null, app.app ? 'app' : null].filter(Boolean).join(' + ');
        row.querySelector('.installed-app-meta span').textContent = disabled
          ? 'Uklonjen - fajlovi su i dalje u apps/ folderu'
          : (forms + ' · ' + traces.widgets + (traces.widgets === 1 ? ' widget' : ' widgeta') + (traces.openTab ? ', tab otvoren' : ''));
        const actionBtn = row.querySelector('.installed-app-action');
        actionBtn.textContent = disabled ? 'Vrati' : 'Ukloni';
        actionBtn.classList.toggle('danger', !disabled);
        actionBtn.addEventListener('click', () => {
          if (disabled) {
            persistValue(DISABLED_APPS_KEY, JSON.stringify(readDisabledApps().filter(id => id !== app.id)));
            renderInstalledApps();
            renderAppsGrid();
            showToast('Alat „' + app.name + '“ je ponovo dostupan.');
          } else {
            removeAppEverywhere(app, actionBtn);
          }
        });
        installedAppsList.appendChild(row);
      });

      // ODBIJENI alati (23.7.2026) - pokvaren manifest je do sad bio
      // vidljiv samo u konzoli; gledalac koji je loše zalijepio alat
      // mora RAZLOG vidjeti ovdje, ne kopati po dev tools-u.
      const rejected = window.AIZdravo ? AIZdravo.rejected : [];
      rejected.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'installed-app-row is-rejected';
        row.innerHTML =
          '<span class="installed-app-icon"><svg><use href="#icon-tabler-alert-triangle"></use></svg></span>' +
          '<div class="installed-app-meta"><strong></strong><span></span></div>';
        row.querySelector('strong').textContent = 'Odbijen: ' + entry.id;
        row.querySelector('.installed-app-meta span').textContent = entry.reason;
        installedAppsList.appendChild(row);
      });

      // Podaci alata koji VIŠE NE POSTOJI (script linija uklonjena) -
      // namjerno se čuvaju za reinstalaciju, ali korisnik mora moći da
      // ih vidi i svjesno obriše umjesto da se tiho gomilaju zauvijek.
      const knownIds = new Set(apps.map(app => app.id));
      const orphanKeys = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('aizdravo:app:') && !knownIds.has(key.slice('aizdravo:app:'.length))) {
            orphanKeys.push(key);
          }
        }
      } catch (err) { /* storage blokiran - preskoči sekciju */ }
      orphanKeys.forEach(key => {
        const orphanId = key.slice('aizdravo:app:'.length);
        const size = (localStorage.getItem(key) || '').length;
        const row = document.createElement('div');
        row.className = 'installed-app-row is-orphan';
        row.innerHTML =
          '<span class="installed-app-icon"><svg><use href="#icon-tabler-database"></use></svg></span>' +
          '<div class="installed-app-meta"><strong></strong><span></span></div>' +
          '<button type="button" class="installed-app-action danger">Obriši podatke</button>';
        row.querySelector('strong').textContent = orphanId;
        row.querySelector('.installed-app-meta span').textContent =
          'Podaci alata koji nije instaliran (' + Math.max(1, Math.round(size / 1024)) + 'KB) - čuvaju se za reinstalaciju';
        row.querySelector('button').addEventListener('click', async event => {
          const ok = await askConfirmation('Trajno obrisati sačuvane podatke alata „' + orphanId + '“? Reinstalacija poslije ovoga kreće od nule.', event.currentTarget);
          if (!ok) return;
          removePersistedValue(key);
          renderInstalledApps();
          showToast('Podaci alata „' + orphanId + '“ su obrisani.');
        });
        installedAppsList.appendChild(row);
      });
    }
    renderInstalledAppsGlobal = renderInstalledApps;

    // ---- Host binding: alati dobijaju persist/toast/openApp kroz ctx ----
    if (window.AIZdravo) {
      AIZdravo._bindHost({
        persist: persistValue,
        toast: showToast,
        openApp: openAppTab,
      });
    }

    // ---- Welcome wizard kontroler (23.7.2026, treći prolaz) ----
    // Naslov (h2) i opis (p) su sad ODVOJENI od mockup boxa (živi u
    // #wizardStepTitle / .wizard-step-desc, ne unutar svakog mockupa) -
    // ova funkcija sinhronizuje sva tri (mockup, opis, naslov) preko
    // istog wizardIndex-a. Wraparound (kraj -> 1, 1 -> kraj) namjerno -
    // ovo je showcase, ne linearna forma gdje bi wraparound bio
    // zbunjujuć. Pozicija se NE pamti kroz reload (uvijek kreće od
    // koraka 1) - to je u redu za kratak uvodni vodič.
    (function initWelcomeWizard() {
      const mockups = Array.from(document.querySelectorAll('.wizard-mockup[data-step]'));
      const descs = Array.from(document.querySelectorAll('.wizard-step-desc[data-step]'));
      const dots = Array.from(document.querySelectorAll('.wizard-dot'));
      const titleEl = document.getElementById('wizardStepTitle');
      const prevBtn = document.getElementById('wizardPrev');
      const nextBtn = document.getElementById('wizardNext');
      if (!mockups.length) return;
      let wizardIndex = 0;

      function renderWizardStep() {
        mockups.forEach((el, i) => el.classList.toggle('is-active', i === wizardIndex));
        descs.forEach((el, i) => el.classList.toggle('is-active', i === wizardIndex));
        dots.forEach((dot, i) => {
          const active = i === wizardIndex;
          dot.classList.toggle('is-active', active);
          dot.setAttribute('aria-selected', String(active));
        });
        if (titleEl && descs[wizardIndex]) titleEl.textContent = descs[wizardIndex].dataset.title || '';
      }
      function wizardGo(delta) {
        wizardIndex = (wizardIndex + delta + mockups.length) % mockups.length;
        renderWizardStep();
      }
      if (prevBtn) prevBtn.addEventListener('click', () => wizardGo(-1));
      if (nextBtn) nextBtn.addEventListener('click', () => wizardGo(1));
      dots.forEach((dot, i) => dot.addEventListener('click', () => { wizardIndex = i; renderWizardStep(); }));
    })();

    navAddBtn.addEventListener('click', () => openTabModal('add'));
    if (navEditHomeIconBtn) {
      navEditHomeIconBtn.addEventListener('click', () => {
        const homeBtn = document.querySelector('[data-view="home"]');
        const name = homeBtn.querySelector('.nav-label').textContent;
        openTabModal('edit-welcome', 'home', null, name);
      });
    }
    // Floating "add section" FAB lives here (not its own top-level
    // section) now that it opens this same modal for a name instead of
    // silently adding a blank card - it's coupled to the modal's
    // existence the same way navAddBtn already is.
    if (fabAddSection) {
      fabAddSection.addEventListener('click', requestAddSection);
    }
    addTabCancelBtn.addEventListener('click', closeTabModal);
    // Click on the dim backdrop closes it, click inside the panel itself
    // must not - e.target === overlay is only true for the backdrop
    // itself, never for anything inside .modal, since clicks on children
    // don't retarget e.target to an ancestor.
    addTabOverlay.addEventListener('click', (e) => {
      if (e.target === addTabOverlay) closeTabModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && addTabOverlay.classList.contains('is-open')) closeTabModal();
    });
    addTabConfirmBtn.addEventListener('click', () => {
      if (modalMode === 'edit-folder') {
        if (editingFolderCard && editingFolderCard.isConnected) {
          editingFolderCard.dataset.apps = JSON.stringify(readFolderPick());
          if (editingFolderRerender) editingFolderRerender(editingFolderCard);
          const cardBoard = editingFolderCard.closest('.board');
          const api = cardBoard && boardAPIs.get(cardBoard);
          if (api) api.saveLayout();
          showToast('Aplikacije foldera su ažurirane.');
        }
        editingFolderCard = null;
        editingFolderRerender = null;
        closeTabModal();
        return;
      }
      const name = addTabNameInput.value.trim();
      if (!name) return;
      if (modalMode === 'edit') {
        if (!selectedIcon) return;
        updateTabMeta(editingTabId, name, selectedIcon);
        closeTabModal();
        return;
      }
      if (modalMode === 'edit-welcome') {
        updateTabMeta(editingTabId, name, 'ai-zdravo-logo');
        closeTabModal();
        return;
      }
      if (modalMode === 'edit-topbar') {
        if (!selectedIcon) return;
        persistValue(TOPBAR_ICON_KEY, selectedIcon);
        persistValue(TOPBAR_LABEL_KEY, name);
        applyTopbarIdentity();
        renderTopbarIdentityPreview();
        closeTabModal();
        showToast('Gornja traka je ažurirana.');
        return;
      }
      if (modalMode === 'edit-section') {
        if (editingSectionApply) editingSectionApply(name);
        editingSectionApply = null;
        closeTabModal();
        showToast(`Sekcija je preimenovana u „${name.slice(0, 60)}“.`);
        return;
      }
      if (modalMode === 'add-section') {
        const activeBoard = document.querySelector('.view.is-active .board');
        const api = activeBoard && boardAPIs.get(activeBoard);
        if (api) {
          if (selectedSectionType === 'folder') api.addCard(name, { type: 'folder', apps: readFolderPick() });
          else api.addCard(name);
        }
        closeTabModal();
        return;
      }
      if (!selectedIcon) return;
      addTab(name, selectedIcon);
      closeTabModal();
    });
    addTabNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !addTabConfirmBtn.disabled) addTabConfirmBtn.click();
    });

    // Rebuild every persisted tab on load - each one re-runs the exact
    // same createTabDOM() a freshly-added tab uses, so "load" and "add"
    // can never drift into two different code paths that render tabs
    // slightly differently from each other.
    const initialTabs = loadTabs();
    const persistedWelcome = initialTabs.find(tab => tab.id === 'home');
    if (!persistedWelcome) {
      const homeRow = navEl.querySelector('.nav-row[data-tab-id="home"]');
      const homeView = document.querySelector('.view[data-view="home"]');
      const homeBoard = homeView && homeView.querySelector('.board');
      if (homeRow) homeRow.remove();
      if (homeView) homeView.remove();
      const homeNavIndex = navItems.findIndex(item => item.dataset.view === 'home');
      if (homeNavIndex !== -1) navItems.splice(homeNavIndex, 1);
      const homeViewIndex = views.findIndex(view => view.dataset.view === 'home');
      if (homeViewIndex !== -1) views.splice(homeViewIndex, 1);
      if (homeBoard) boardAPIs.delete(homeBoard);
    }
    initialTabs.forEach(createTabDOM);
    initialTabs.forEach(tab => {
      const row = navEl.querySelector(`.nav-row[data-tab-id="${tab.id}"]`);
      if (row) navEl.insertBefore(row, navAddBtn);
    });
    if (persistedWelcome) updateTabMeta('home', persistedWelcome.name || 'AI Zdravo', 'ai-zdravo-logo', true);
    if (navDuplicateHomeBtn) navDuplicateHomeBtn.addEventListener('click', event => {
      event.stopPropagation();
      duplicateTab('home');
    });
    if (navDeleteHomeBtn) navDeleteHomeBtn.addEventListener('click', event => {
      event.stopPropagation();
      removeTab('home');
    });

    // Custom tabs can be reordered from their dedicated grip on the left.
    // Početna has no data-tab-id and therefore never enters this Sortable
    // list, while the add button and indicator are not draggable rows at
    // all. The DOM order is replayed into TABS_KEY on every successful
    // drop, so the existing server-backed persistence restores it in any
    // browser on the same dashboard server.
    if (window.Sortable) {
      Sortable.create(navEl, {
        draggable: '.nav-row[data-tab-id]',
        handle: '.nav-drag-handle',
        animation: 260,
        easing: 'cubic-bezier(.22, 1, .36, 1)',
        ghostClass: 'nav-tab-ghost',
        dragClass: 'nav-tab-dragging',
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: 3,
        onStart() {
          document.body.classList.add('no-select');
        },
        onEnd() {
          document.body.classList.remove('no-select');
          saveTabOrderFromDOM();
          const active = navItems.find(item => item.classList.contains('is-active'));
          if (active) {
            requestAnimationFrame(() => moveIndicatorTo(active));
            setTimeout(() => moveIndicatorTo(active), 280);
          }
        },
      });
    }

    // Otvorene app stranice prežive reload - rekonstruišu se odvojeno od
    // dashboard tabova (koje su lijevi sidebar tab i koji AIZdravo top-
    // tab su dvije nezavisne persistencije). Alat koji je u međuvremenu
    // uklonjen/nestao se tiho izbacuje iz liste (bez rušenja, bez duha
    // u traci).
    const openAppIdsToRestore = readOpenAppTabs();
    const restorableAppIds = openAppIdsToRestore.filter(appId =>
      window.AIZdravo && AIZdravo.getApp(appId) && !isAppDisabled(appId));
    if (restorableAppIds.length !== openAppIdsToRestore.length) saveOpenAppTabs(restorableAppIds);
    restorableAppIds.forEach(appId => createAppPageDOM(AIZdravo.getApp(appId)));

    let savedActiveTab = 'home';
    try {
      savedActiveTab = localStorage.getItem(ACTIVE_TAB_KEY) || 'home';
    } catch (err) {
      savedActiveTab = 'home';
    }
    activate(savedActiveTab);

    let savedActiveTopTab = 'dashboard';
    try {
      savedActiveTopTab = localStorage.getItem(ACTIVE_TOP_TAB_KEY) || 'dashboard';
    } catch (err) {
      savedActiveTopTab = 'dashboard';
    }
    if (savedActiveTopTab !== 'dashboard' && !restorableAppIds.includes(savedActiveTopTab)) savedActiveTopTab = 'dashboard';
    switchTopTab(savedActiveTopTab);
    applyTopbarIdentity();
  }

  function visibleFocusable(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.hidden && element.getClientRects().length > 0);
  }

  document.addEventListener('keydown', event => {
    const appsOverlayEl = document.getElementById('appsOverlay');
    const openLayer = [confirmOverlay, addTabOverlay, moveSectionOverlay, attachAppOverlay, appsOverlayEl, settingsOverlay]
      .find(layer => layer && layer.classList.contains('is-open'));
    if (!openLayer) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (openLayer === confirmOverlay) closeConfirmation(false);
      else if (openLayer === addTabOverlay) closeTabModalGlobal();
      else if (openLayer === moveSectionOverlay) closeMoveSectionModalGlobal();
      else if (openLayer === attachAppOverlay) closeAttachAppModalGlobal();
      else if (openLayer === appsOverlayEl) closeAppsPanelGlobal();
      else if (openLayer === settingsOverlay) closeSettings();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = visibleFocusable(openLayer);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // ---------------- Fixed FX overlay: local dot glow + click connections ----------------

  const canvasWrap = document.getElementById('canvasWrap');
  const fxFrame = document.getElementById('fxFrame');
  const glowCanvas = document.getElementById('glowCanvas');
  const burstCanvas = document.getElementById('burstCanvas');

  if (canvasWrap && fxFrame && glowCanvas && burstCanvas && !reduceMotion) {
    const BGRID = 28;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    // --- EVERY grid dot is drawn here, not just the ones near the cursor -
    // dim/white always, with an amber boost layered on top of the exact
    // same (gx,gy) point when the cursor is nearby. This used to be two
    // separate mechanisms (a CSS background-image radial-gradient for the
    // static dots, this canvas for the hover boost) which, despite sharing
    // the same phase math, rendered through genuinely different engines
    // (CSS background tiling vs canvas arc-fill) - close enough on paper
    // that every numeric check passed, but not pixel-identical on a real
    // Retina display, which is what actually reads as "two different
    // grids" to the eye. Drawing both layers from ONE loop over ONE set of
    // (gx,gy) coordinates makes that class of mismatch structurally
    // impossible - there's only one place a dot's position is computed.
    // The grid tiles with the scrolled CONTENT (the CSS version used
    // background-attachment:local for this), but this overlay is a fixed
    // layer that doesn't scroll, so scroll position has to be folded into
    // the content->viewport mapping by hand and the whole grid redrawn on
    // scroll (see the scroll listener below).
    const gctx = glowCanvas.getContext('2d');
    const GLOW_RADIUS = 66;
    let lastVx = -99999, lastVy = -99999; // cursor pos, fx-frame space; far off-canvas = no boost anywhere

    function resizeGlowCanvas() {
      const r = fxFrame.getBoundingClientRect();
      glowCanvas.width = r.width * dpr;
      glowCanvas.height = r.height * dpr;
      gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeGlowCanvas();

    function redrawGrid() {
      const w = glowCanvas.width / dpr;
      const h = glowCanvas.height / dpr;
      gctx.clearRect(0, 0, w, h);
      if (!gridVisible) return;

      const scrollTop = canvasWrap.scrollTop;
      // dot columns/rows visible in the current viewport, in the grid's
      // own phase - a small overscan margin (1 extra step either side)
      // avoids dots popping in/out right at the edge during scroll/resize
      const startCol = Math.floor((0 - dotPhaseX) / BGRID) - 1;
      const endCol = Math.ceil((w - dotPhaseX) / BGRID) + 1;
      const startRow = Math.floor((scrollTop - dotPhaseY) / BGRID) - 1;
      const endRow = Math.ceil((scrollTop + h - dotPhaseY) / BGRID) + 1;

      // One dot per (gx,gy): a dim white base circle, plus - if the cursor
      // is within GLOW_RADIUS of THIS SAME point - an amber circle drawn
      // on top at the identical center. radius/hoverPeak are the only
      // things that differ between the corner grid-line dots and the
      // smaller sub-dot at each cell's center (below) - same shared logic,
      // so the two can never drift out of sync with each other either.
      function drawDot(gx, gy, radius, hoverPeak) {
        gctx.beginPath();
        gctx.arc(gx, gy, radius, 0, Math.PI * 2);
        gctx.fillStyle = 'rgba(255,255,255,0.03)';
        gctx.fill();

        const d = Math.hypot(gx - lastVx, gy - lastVy);
        if (d <= GLOW_RADIUS) {
          const alpha = (1 - d / GLOW_RADIUS) * hoverPeak;
          gctx.beginPath();
          gctx.arc(gx, gy, radius, 0, Math.PI * 2);
          gctx.fillStyle = `rgba(${themeGlowRgb.join(',')},${alpha})`;
          gctx.fill();
        }
      }

      for (let c = startCol; c <= endCol; c++) {
        for (let r = startRow; r <= endRow; r++) {
          const gx = c * BGRID + dotPhaseX;
          const gy = r * BGRID + dotPhaseY - scrollTop;
          // 21.7.2026 - corner dot now uses the SAME radius/hoverPeak as
          // the sub-dots below (was 1.5/.4, marking it as visually
          // "primary") - Ognjen wanted every dot in the mesh to read as
          // one uniform texture, no big/small distinction, now that the
          // sub-grid makes every 14px point a real dot anyway.
          drawDot(gx, gy, 0.8, 0.3);

          // finer sub-grid: one smaller dot at the CENTER of this cell,
          // not just at its corners - same phase, same draw logic.
          drawDot(gx + BGRID / 2, gy + BGRID / 2, 0.8, 0.3);

          // 21.7.2026 - two more sub-dots, one at the midpoint of the top
          // edge (horizontally between this corner and the next one over)
          // and one at the midpoint of the left edge (vertically between
          // this corner and the next one down). Previewed live first at
          // real opacity before adding for real - reads as a finer mesh,
          // not a second competing grid. Same drawDot helper/sizing as
          // the center dot above, so all three sub-dots stay visually
          // identical to each other.
          drawDot(gx + BGRID / 2, gy, 0.8, 0.3);
          drawDot(gx, gy + BGRID / 2, 0.8, 0.3);
        }
      }
    }
    redrawGrid();
    refreshGridDots = redrawGrid;
    window.addEventListener('resize', () => { resizeGlowCanvas(); redrawGrid(); });
    canvasWrap.addEventListener('scroll', redrawGrid, { passive: true });

    canvasWrap.addEventListener('pointermove', (e) => {
      const rect = fxFrame.getBoundingClientRect();
      lastVx = e.clientX - rect.left;
      lastVy = e.clientY - rect.top;
      redrawGrid();
    });
    canvasWrap.addEventListener('pointerleave', () => {
      lastVx = -99999;
      lastVy = -99999;
      redrawGrid();
    });

    // --- click: brief constellation of connecting dots ---
    const bctx = burstCanvas.getContext('2d');

    function resizeBurstCanvas() {
      const r = fxFrame.getBoundingClientRect();
      burstCanvas.width = r.width * dpr;
      burstCanvas.height = r.height * dpr;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeBurstCanvas();
    window.addEventListener('resize', resizeBurstCanvas);
    resizeFxOverlay = () => { resizeGlowCanvas(); resizeBurstCanvas(); redrawGrid(); };

    const BURST_RADIUS = 130;
    const PROPAGATE = 260;   // ms: nearest -> farthest point "connecting"
    const HOLD = 60;         // ms: brief pause once fully connected
    const FADE = 220;        // ms: whole signal fades out
    const BURST_DURATION = PROPAGATE + HOLD + FADE;
    let activeBursts = [];
    let burstLoopRunning = false;

    // 21.7.2026 - was stepping in whole BGRID (28px) units, so the burst
    // could only ever snap to the big corner dots even after redrawGrid()
    // started drawing a full dot at every 14px point (center + two edge
    // sub-dots per cell, see the "Finiji pod-grid" notes above). FINE
    // matches that same 14px spacing, so every point this can connect to
    // is a dot that's actually visible on screen, not just the sparse
    // subset of them.
    const FINE = BGRID / 2;

    function collectPoints(cx, cy) {
      const pts = [];
      const adjX = cx - dotPhaseX;
      const adjY = cy - dotPhaseY;
      const startCol = Math.round((adjX - BURST_RADIUS) / FINE);
      const endCol = Math.round((adjX + BURST_RADIUS) / FINE);
      const startRow = Math.round((adjY - BURST_RADIUS) / FINE);
      const endRow = Math.round((adjY + BURST_RADIUS) / FINE);
      for (let c = startCol; c <= endCol; c++) {
        for (let r = startRow; r <= endRow; r++) {
          const x = c * FINE + dotPhaseX, y = r * FINE + dotPhaseY;
          const d = Math.hypot(x - cx, y - cy);
          if (d <= BURST_RADIUS) pts.push({ x, y, d });
        }
      }
      pts.sort((a, b) => a.d - b.d);
      return pts.slice(0, 16);
    }

    // A fixed, readable shape: from the origin, two hops to a fork point
    // (picking a random one of the few nearest unclaimed points each hop,
    // not always the literal closest), then it splits into two arms - one
    // continues two more hops, the other stops after just one.
    function growBranches(pts) {
      const origin = pts[0];
      origin.rawArrival = 0;
      const used = new Set([origin]);
      const edges = [];

      function stepFrom(from) {
        const candidates = pts
          .filter(p => !used.has(p))
          .map(p => ({ p, d: Math.hypot(p.x - from.x, p.y - from.y) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 3);
        if (!candidates.length) return null;
        const pick = candidates[(Math.random() * candidates.length) | 0];
        pick.p.rawArrival = from.rawArrival + pick.d;
        edges.push({ parent: from, child: pick.p });
        used.add(pick.p);
        return pick.p;
      }

      let cursor = origin;
      for (let i = 0; i < 2; i++) {
        const next = stepFrom(cursor);
        if (!next) break;
        cursor = next;
      }
      const forkPoint = cursor;

      let armA = forkPoint;
      for (let i = 0; i < 2; i++) {
        const next = stepFrom(armA);
        if (!next) break;
        armA = next;
      }

      stepFrom(forkPoint);

      const visited = [...used];
      const maxRaw = Math.max(...visited.map(p => p.rawArrival), 1);
      visited.forEach(p => { p.arrival = (p.rawArrival / maxRaw) * PROPAGATE; });
      edges.forEach(e => { e.t0 = e.parent.arrival; e.t1 = e.child.arrival; });
      return { pts: visited, edges };
    }

    function burstAt(cx, cy) {
      const { pts, edges } = growBranches(collectPoints(cx, cy));
      activeBursts.push({ pts, edges, start: performance.now() });
      if (!burstLoopRunning) {
        burstLoopRunning = true;
        requestAnimationFrame(burstTick);
      }
    }

    function burstTick(now) {
      const w = burstCanvas.width / dpr;
      const h = burstCanvas.height / dpr;
      bctx.clearRect(0, 0, w, h);

      activeBursts = activeBursts.filter(b => now - b.start < BURST_DURATION);

      activeBursts.forEach(b => {
        const elapsed = now - b.start;
        const fadeMul = elapsed <= PROPAGATE + HOLD
          ? 1
          : Math.max(0, 1 - (elapsed - PROPAGATE - HOLD) / FADE);
        if (fadeMul <= 0) return;

        b.edges.forEach(({ parent, child, t0, t1 }) => {
          if (elapsed < t0) return;
          const growing = elapsed < t1;
          const frac = growing ? Math.max(0, (elapsed - t0) / Math.max(1, t1 - t0)) : 1;
          const ex = parent.x + (child.x - parent.x) * frac;
          const ey = parent.y + (child.y - parent.y) * frac;
          const alpha = (growing ? 0.65 : 0.4) * fadeMul;
          bctx.strokeStyle = `rgba(${themeAccentRgb.join(',')},${alpha})`;
          bctx.lineWidth = 1;
          bctx.beginPath();
          bctx.moveTo(parent.x, parent.y);
          bctx.lineTo(ex, ey);
          bctx.stroke();
        });

        b.pts.forEach(p => {
          if (elapsed < p.arrival) return;
          const popIn = Math.min(1, (elapsed - p.arrival) / 70);
          bctx.beginPath();
          bctx.arc(p.x, p.y, 2 * popIn, 0, Math.PI * 2);
          bctx.fillStyle = `rgba(${themeGlowRgb.join(',')},${popIn * fadeMul})`;
          bctx.fill();
        });
      });

      if (activeBursts.length) {
        requestAnimationFrame(burstTick);
      } else {
        burstLoopRunning = false;
      }
    }

    canvasWrap.addEventListener('click', (e) => {
      if (e.target.closest('.pcard, button, a')) return;
      const rect = fxFrame.getBoundingClientRect();
      burstAt(e.clientX - rect.left, e.clientY - rect.top);
    });

    triggerBurst = burstAt;
  }

  // ---------------- Ember particles rising from the flame ----------------

  const emberCanvas = document.getElementById('emberCanvas');

  if (emberCanvas && !reduceMotion) {
    const ctx = emberCanvas.getContext('2d');
    const flameEl = document.querySelector('.hero-mark .flame');
    let particles = [];
    let w = 0, h = 0, spawnX = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      const rect = emberCanvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      emberCanvas.width = w * dpr;
      emberCanvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // spawn embers from the flame's actual horizontal center, not the
      // canvas's - the logo is left-aligned in its box, not centered.
      if (flameEl) {
        const fr = flameEl.getBoundingClientRect();
        spawnX = (fr.left - rect.left) + fr.width / 2;
      } else {
        spawnX = w / 2;
      }
    }
    resize();
    window.addEventListener('resize', resize);

    function spawn() {
      particles.push({
        x: spawnX + (Math.random() - 0.5) * 16,
        y: h - 22,
        vy: -0.35 - Math.random() * 0.5,
        vx: (Math.random() - 0.5) * 0.25,
        life: 0,
        maxLife: 90 + Math.random() * 70,
        r: 1 + Math.random() * 1.6,
      });
    }

    let frame = 0;
    function tick() {
      frame++;
      if (frame % 14 === 0 && particles.length < 24) spawn();

      ctx.clearRect(0, 0, w, h);
      particles.forEach(p => {
        p.life++;
        p.x += p.vx;
        p.y += p.vy;
        p.vy -= 0.0015;
        const t = p.life / p.maxLife;
        const alpha = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (1 - t * 0.4), 0, Math.PI * 2);
        const emberRgb = themeAccentRgb.map((channel, index) => (
          Math.round(channel + (themeGlowRgb[index] - channel) * t)
        ));
        ctx.fillStyle = `rgba(${emberRgb.join(',')},${alpha * 0.85})`;
        ctx.fill();
      });
      particles = particles.filter(p => p.life < p.maxLife);

      requestAnimationFrame(tick);
    }
    tick();
  }
})();
