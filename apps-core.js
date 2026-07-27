// AI Zdravo Dashboard - apps-core.js
//
// Javni API za alate (aplikacije + widgete). Ovaj fajl se učitava PRIJE
// foldera apps/ i prije app.js, tako da svaki alat u apps/<id>/app.js
// može odmah pozvati AIZdravo.registerApp(...) običnim <script src>
// učitavanjem - nema fetch-a, nema build koraka, radi i pod file://.
//
// Pun kontrakt za autore alata: APPS_AND_WIDGETS.md u root-u repoa.
//
// Dizajn-odluke koje ovaj fajl čuva:
// - Registracija NIKAD ne smije srušiti dashboard. Nevalidan manifest se
//   odbija uz console.warn i završi u AIZdravo.rejected (Podešavanja ga
//   mogu prikazati), a sve ostalo nastavlja normalno raditi.
// - widget()/app() render pozivi alata se izvršavaju kroz try/catch na
//   strani hosta (app.js) - greška alata prikaže poruku unutar njegove
//   kartice/taba, nikad bijeli ekran cijelog dashboarda.
// - Ovaj fajl NE zna ništa o board-u/tabovima/localStorage šemi - host
//   (app.js) se veže kroz _bindHost() i daje alatima ctx (storage,
//   openApp, toast). Time autor alata nikad ne dira interne ključeve.

(function () {
  'use strict';

  var registry = new Map();
  var rejected = [];
  var host = null; // postavlja app.js kroz _bindHost()

  var ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var SIZE_KEYS = ['s', 'm', 'l'];

  function fail(id, reason) {
    rejected.push({ id: String(id || '(bez id-a)'), reason: reason });
    // Namjerno warn a ne error - error bi završio u errors.jsonl kao da
    // se dashboard pokvario, a ovo je autorska greška JEDNOG alata.
    console.warn('[aizdravo:apps] Alat odbijen: ' + reason, id);
    return false;
  }

  function validSize(size) {
    return size && typeof size === 'object' &&
      Number.isInteger(size.col) && size.col >= 4 && size.col <= 40 &&
      Number.isInteger(size.row) && size.row >= 4 && size.row <= 40;
  }

  function registerApp(manifest) {
    if (!manifest || typeof manifest !== 'object') return fail(null, 'manifest nije objekat');
    var id = manifest.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return fail(id, 'id mora biti kebab-case string (npr. "video-kompresor")');
    if (registry.has(id)) return fail(id, 'id "' + id + '" je već registrovan - svaki alat mora imati jedinstven id');
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) return fail(id, 'name je obavezan');
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) return fail(id, 'description je obavezan');
    if (typeof manifest.version !== 'string' || !manifest.version.trim()) return fail(id, 'version je obavezan (npr. "1.0.0")');
    if (typeof manifest.icon !== 'string' || !manifest.icon.trim()) return fail(id, 'icon je obavezan (ime tabler simbola, npr. "video")');
    // Ikonica se u host-u (app.js) ubacuje u innerHTML kao dio href="#icon-tabler-<ovo>"
    // (27.7.2026, Codex bezbjednosni audit) - bez ovog charset filtera, tool sa
    // zlonamjernim/pokvarenim icon poljem bi mogao ubaciti proizvoljan HTML/JS.
    if (!ID_RE.test(manifest.icon.trim())) return fail(id, 'icon mora biti kebab-case ime (samo a-z, 0-9, crtica) - "' + manifest.icon + '" nije bezbjedno');
    // 23.7.2026: forme su OPCIONE pojedinačno - alat može biti samo
    // widget (npr. sat) ili samo aplikacija (npr. složen editor bez
    // smislene mini forme). Bar JEDNA mora postojati.
    var hasWidget = typeof manifest.widget === 'function';
    var hasApp = typeof manifest.app === 'function';
    if (manifest.widget !== undefined && !hasWidget) return fail(id, 'widget mora biti funkcija (el, ctx) ako postoji');
    if (manifest.app !== undefined && !hasApp) return fail(id, 'app mora biti funkcija (el, ctx) ako postoji');
    if (!hasWidget && !hasApp) return fail(id, 'alat mora imati bar jednu formu: widget(el,ctx) i/ili app(el,ctx)');

    // sizes su obavezne SAMO za alat koji ima widget formu - app-only
    // alat nema šta da smješta na grid.
    var cleanSizes = {};
    var defaultSize = null;
    if (hasWidget) {
      var sizes = manifest.sizes;
      if (!sizes || typeof sizes !== 'object') return fail(id, 'sizes je obavezan objekat za alat sa widget formom, bar jedna od s/m/l');
      SIZE_KEYS.forEach(function (key) {
        if (sizes[key] !== undefined) {
          if (validSize(sizes[key])) cleanSizes[key] = { col: sizes[key].col, row: sizes[key].row };
          else console.warn('[aizdravo:apps] Alat "' + id + '": veličina "' + key + '" nije validna ({col,row} cijeli brojevi 4-40), preskočena.');
        }
      });
      if (!Object.keys(cleanSizes).length) return fail(id, 'sizes ne sadrži nijednu validnu veličinu (s/m/l = {col,row})');
      defaultSize = manifest.defaultSize;
      if (!cleanSizes[defaultSize]) {
        defaultSize = SIZE_KEYS.find(function (key) { return cleanSizes[key]; });
      }
    }

    registry.set(id, {
      id: id,
      name: manifest.name.trim().slice(0, 40),
      description: manifest.description.trim().slice(0, 160),
      icon: manifest.icon.trim(),
      version: manifest.version.trim().slice(0, 20),
      sizes: cleanSizes,
      defaultSize: defaultSize,
      resizable: manifest.resizable !== false,
      widget: hasWidget ? manifest.widget : null,
      app: hasApp ? manifest.app : null,
    });
    return true;
  }

  function getApp(id) {
    return registry.get(id) || null;
  }

  function listApps() {
    return Array.from(registry.values());
  }

  // Trajno brisanje (27.7.2026, katalog "Ukloni trajno") - uklanja alat
  // iz LIVE registra odmah, bez čekanja reload-a poslije fizičkog
  // brisanja apps/<id>/ foldera na serveru. Ne postoji suprotna
  // "unregister poziv sam alat" javna putanja - ovo zove samo host
  // (app.js) poslije potvrđenog server-side brisanja.
  function unregisterApp(id) {
    return registry.delete(id);
  }

  // ---- host veza (samo app.js ovo zove) ----

  function _bindHost(hostApi) {
    host = hostApi;
  }

  // ctx koji alat dobija u widget(el, ctx) / app(el, ctx). storage je
  // namespaced po alatu (jedan aizdravo:app:<id> ključ, JSON objekat
  // unutra) - alat NIKAD ne piše svoje ključeve direktno u localStorage,
  // pa ne može pregaziti ni dashboard stanje ni podatke drugog alata, a
  // host-ov persist put automatski sinhronizuje i server sidecar.
  // ---- Event bus (23.7.2026) ----
  // Minimalan pub/sub za komunikaciju MEĐU alatima (i među formama istog
  // alata na različitim mjestima ekrana): jedan widget može uživo
  // prikazivati ono što drugi objavi. Imena događaja su globalna po
  // dogovoru "<app-id>:<naziv>" (npr. "quick-notes:changed") da se alati
  // ne sudaraju. Handler greška se guta uz warn - tuđi pokvaren listener
  // ne smije oboriti emitera. ctx.on vraća unsubscribe funkciju; alat je
  // zove u svom cleanupu.
  var busListeners = new Map(); // eventName -> Set<fn>

  function busOn(eventName, handler) {
    if (typeof eventName !== 'string' || typeof handler !== 'function') return function () {};
    if (!busListeners.has(eventName)) busListeners.set(eventName, new Set());
    var set = busListeners.get(eventName);
    set.add(handler);
    return function unsubscribe() { set.delete(handler); };
  }

  function busEmit(eventName, payload) {
    var set = busListeners.get(eventName);
    if (!set) return 0;
    var delivered = 0;
    set.forEach(function (handler) {
      try {
        handler(payload);
        delivered += 1;
      } catch (err) {
        console.warn('[aizdravo:apps] Listener za "' + eventName + '" je javio grešku:', err);
      }
    });
    return delivered;
  }

  // localStorage ukupno drzi ~5MB po origin-u, a i serverski sidecar ima
  // 1MB cap za CIJELO stanje - jedan alat koji sacuva ogroman blob (npr.
  // base64 sliku/video) bi tiho pojeo prostor svih ostalih. Zato tvrdi
  // per-alat cap, uz VIDLJIVU gresku (toast + warn) umjesto tihog pada -
  // autor alata odmah sazna da podatke te velicine ne drzi ovdje.
  var MAX_APP_STORAGE_BYTES = 200 * 1024;

  function makeCtx(appId) {
    var storageKey = 'aizdravo:app:' + appId;
    function readAll() {
      try {
        var parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (err) {
        return {};
      }
    }
    function writeAll(all) {
      var serialized = JSON.stringify(all);
      if (serialized.length > MAX_APP_STORAGE_BYTES) {
        console.warn('[aizdravo:apps] Alat "' + appId + '" pokušava sačuvati ' +
          Math.round(serialized.length / 1024) + 'KB - limit je ' +
          Math.round(MAX_APP_STORAGE_BYTES / 1024) + 'KB po alatu. Upis odbijen.');
        if (host && host.toast) host.toast('Alat „' + appId + '“ pokušava sačuvati previše podataka - upis je odbijen.');
        return false;
      }
      if (host && host.persist) host.persist(storageKey, serialized);
      else { try { localStorage.setItem(storageKey, serialized); } catch (err) { return false; } }
      return true;
    }
    return {
      appId: appId,
      storage: {
        get: function (key, fallback) {
          var all = readAll();
          return key in all ? all[key] : (fallback !== undefined ? fallback : null);
        },
        set: function (key, value) {
          var all = readAll();
          all[key] = value;
          return writeAll(all);
        },
        remove: function (key) {
          var all = readAll();
          delete all[key];
          return writeAll(all);
        },
      },
      openApp: function (id) { if (host && host.openApp) host.openApp(id || appId); },
      toast: function (message) { if (host && host.toast) host.toast(String(message).slice(0, 160)); },
      // Među-alat komunikacija - vidi "Event bus" komentar gore i
      // APPS_AND_WIDGETS.md ("Komunikacija među alatima").
      emit: function (eventName, payload) { return busEmit(eventName, payload); },
      on: function (eventName, handler) { return busOn(eventName, handler); },
    };
  }

  // Render sa zaštitom: greška unutar alata postane poruka u NJEGOVOM
  // elementu, ne pad cijelog dashboarda. Vraća cleanup funkciju alata
  // (ako je alat vrati) da je host pozove pri uklanjanju elementa.
  function renderInto(appId, mode, el) {
    var app = registry.get(appId);
    if (!app) {
      el.innerHTML = '<div class="app-render-error"><strong>Alat nije dostupan</strong><span>„' + appId + '" nije instaliran u ovom dashboardu.</span></div>';
      return null;
    }
    var renderFn = mode === 'app' ? app.app : app.widget;
    if (typeof renderFn !== 'function') {
      // App-only alat pozvan kao widget (ili obrnuto) - ne bi trebalo da
      // se desi kroz UI (panel/folderi filtriraju po formi), ali stariji
      // layout zapis može referencirati formu koju nova verzija alata
      // više nema.
      el.innerHTML = '<div class="app-render-error"><strong>Forma nije dostupna</strong><span>„' + (app.name || appId) + '" nema ' + (mode === 'app' ? 'punu aplikaciju' : 'widget formu') + ' u ovoj verziji.</span></div>';
      return null;
    }
    try {
      el.innerHTML = '';
      var cleanup = renderFn(el, makeCtx(appId));
      return typeof cleanup === 'function' ? cleanup : null;
    } catch (err) {
      console.warn('[aizdravo:apps] Alat "' + appId + '" je javio grešku pri renderu (' + mode + '):', err);
      el.innerHTML = '<div class="app-render-error"><strong>Alat je javio grešku</strong><span>„' + (app.name || appId) + '" se nije uspješno prikazao. Ostatak dashboarda radi normalno.</span></div>';
      return null;
    }
  }

  window.AIZdravo = {
    registerApp: registerApp,
    getApp: getApp,
    listApps: listApps,
    unregisterApp: unregisterApp,
    rejected: rejected,
    renderInto: renderInto,
    _bindHost: _bindHost,
  };
})();
