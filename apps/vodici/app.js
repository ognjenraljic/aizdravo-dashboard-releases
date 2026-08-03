// Vodiči - biblioteka kratkih vodiča za rad na lokalnim alatima i
// widgetima u AI Zdravo Dashboardu. Struktura: kategorije (lijevi
// sidebar, sa search poljem gore) -> vodiči unutar kategorije, svaki
// sa svojom ikonicom -> sadržaj vodiča desno. Kategorije: "Dashboard"
// (vodič "Dobrodošli" - isti onboarding sadržaj kao welcome wizard koji
// se prikaže prvi put uz dashboard, prvi u listi) i "Aplikacije i
// widgeti" (vodič "Izgradnja" - četiri koraka koje Ognjen prolazi
// svaki put kad gradi novu aplikaciju/widget).
//
// Samo aplikacija (nema widget formu) - biblioteka se otvara kao
// sopstveni tab. `hideChrome: true` sklanja generički host header
// (ikonica/ime/verzija) jer ovo nije klasičan jedan-alat prikaz nego
// biblioteka sa sopstvenim zaglavljem ("Vodiči").
//
// Boje idu preko dashboard varijabli (var(--accent) itd.) - default
// tema dashboarda već JESTE AI Zdravo brending (#ff8c00 na #121212),
// pa alat automatski prati i ostalih 5 tema ako se promijene.

(function injectStyles() {
  if (document.getElementById('vodici-styles')) return;
  const style = document.createElement('style');
  style.id = 'vodici-styles';
  style.textContent = `
    /* Cijeli tab (app-page-surface) centrira ovaj blok i vertikalno i
       horizontalno - na velikom ekranu sadržaj inače ostane zalijepljen
       gore-lijevo sa mnogo praznog prostora oko sebe. Skopirano na ovaj
       konkretan tab (data-app-page="vodici"), ne mijenja generičko
       .app-page-surface ponašanje za druge alate. */
    .app-page[data-app-page="vodici"] .app-page-surface {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .vd-app {
      width: 100%;
      max-width: 1720px;
      margin: 0 auto;
      box-sizing: border-box;
    }
    .vd-app * { box-sizing: border-box; }

    .vd-title {
      font: 700 clamp(20px, 2.2vw, 25px)/1.2 "Inter", -apple-system, "Segoe UI", sans-serif;
      letter-spacing: -0.01em;
      color: var(--text);
      margin: 0 0 22px;
    }

    /* ---- Shell: sidebar + sadržaj ---- */
    .vd-shell {
      display: flex;
      align-items: flex-start;
      gap: 28px;
    }
    .vd-sidebar-wrap {
      flex: none;
      width: 220px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
      border-radius: 14px;
      background: rgba(255, 255, 255, .045);
    }

    .vd-search {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 8px;
      background: rgba(255, 255, 255, .04);
      border: 1px solid var(--border);
      margin-bottom: 4px;
    }
    .vd-search svg {
      width: 14px;
      height: 14px;
      stroke: var(--text-faint);
      fill: none;
      flex: none;
    }
    .vd-search input {
      all: unset;
      flex: 1;
      min-width: 0;
      font: 600 12.5px/1.3 "Inter", sans-serif;
      color: var(--text);
    }
    .vd-search input::placeholder { color: var(--text-faint); }

    .vd-sidebar-nav {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .vd-cat-toggle {
      all: unset;
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 8px 6px;
      cursor: pointer;
      font: 700 11px/1 "Inter", sans-serif;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--text-faint);
      border-radius: 8px;
    }
    .vd-cat-toggle:hover { color: var(--text-soft); background: rgba(255,255,255,.03); }
    .vd-cat-icon {
      width: 14px;
      height: 14px;
      flex: none;
      stroke: currentColor;
      fill: none;
    }
    .vd-cat-toggle span { flex: 1; text-align: left; }
    .vd-cat-chevron {
      width: 12px;
      height: 12px;
      flex: none;
      stroke: currentColor;
      transition: transform .15s ease;
    }
    .vd-cat.is-collapsed .vd-cat-chevron { transform: rotate(-90deg); }
    .vd-cat-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 2px 0 10px;
    }
    .vd-cat.is-collapsed .vd-cat-list { display: none; }
    .vd-guide-item {
      all: unset;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      font: 600 13px/1.3 "Inter", sans-serif;
      color: var(--text-soft);
    }
    .vd-guide-item:hover { color: var(--text); background: rgba(255,255,255,.04); }
    .vd-guide-item.is-active {
      color: var(--accent);
      background: rgba(var(--accent-rgb), .12);
    }
    .vd-guide-icon {
      width: 15px;
      height: 15px;
      flex: none;
      stroke: currentColor;
      fill: none;
    }

    .vd-content { flex: 1; min-width: 0; }
    .vd-guide-mount { width: 100%; }

    .vd-h1 {
      font: 700 clamp(30px, 3.4vw, 44px)/1.2 "Inter", -apple-system, "Segoe UI", sans-serif;
      letter-spacing: -0.01em;
      color: var(--text);
      margin: 0 0 14px;
    }
    .vd-h1 em {
      font-style: normal;
      color: var(--accent);
    }
    .vd-lede {
      font: 500 clamp(16px, 1.4vw, 19px)/1.5 "Inter", -apple-system, "Segoe UI", sans-serif;
      color: var(--text-soft);
      margin: 0 0 40px;
    }

    .vd-steps {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 24px;
      position: relative;
    }
    .vd-connector {
      position: absolute;
      top: 16px;
      left: calc(12.5% + 4px);
      right: calc(12.5% + 4px);
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--border) 8%, var(--border) 92%, transparent);
      z-index: 0;
    }

    .vd-step-item {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .vd-num {
      font: 700 12px/1 "SF Mono", "JetBrains Mono", ui-monospace, monospace;
      color: var(--accent);
      background: var(--card);
      border: 1px solid rgba(var(--accent-rgb), .35);
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .vd-step {
      width: 100%;
      flex: 1;
      background: rgba(255, 255, 255, .035);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 34px 26px 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 16px;
      transition: border-color .15s ease, transform .15s ease;
    }
    .vd-step-item:hover .vd-step {
      border-color: rgba(var(--accent-rgb), .35);
      transform: translateY(-2px);
    }
    .vd-icon-box {
      width: 76px;
      height: 76px;
      border-radius: 20px;
      background: rgba(var(--accent-rgb), .14);
      border: 1px solid rgba(var(--accent-rgb), .2);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-bottom: 2px;
    }
    .vd-icon-box svg {
      width: 38px;
      height: 38px;
      stroke: var(--accent);
      fill: none;
    }
    .vd-step h3 {
      margin: 0;
      color: var(--text);
      font: 700 20px/1.3 "Inter", sans-serif;
      letter-spacing: -.01em;
    }
    .vd-step p {
      margin: 0;
      color: var(--text-soft);
      font: 500 15px/1.6 "Inter", sans-serif;
    }

    /* ---- Article stil (npr. Dobrodošli) - vertikalna lista sekcija ----
       Sopstven, uži max-width (za razliku od vd-app/vd-steps) - protočan
       tekst ostaje čitljiv na širokom ekranu umjesto da razvuče redove
       preko cijelog centriranog bloka. */
    .vd-article {
      display: flex;
      flex-direction: column;
      gap: 24px;
      max-width: 900px;
    }
    .vd-article-item {
      display: flex;
      gap: 18px;
    }
    .vd-article-num {
      flex: none;
      width: 32px;
      height: 32px;
      border-radius: 9px;
      background: var(--card);
      border: 1px solid rgba(var(--accent-rgb), .3);
      color: var(--accent);
      font: 700 14px/1 "SF Mono", "JetBrains Mono", ui-monospace, monospace;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .vd-article-body h3 {
      margin: 0 0 6px;
      color: var(--text);
      font: 700 18px/1.3 "Inter", sans-serif;
      letter-spacing: -.01em;
    }
    .vd-article-body p {
      margin: 0;
      color: var(--text-soft);
      font: 500 15px/1.65 "Inter", sans-serif;
    }
    .vd-article-body code {
      background: var(--card);
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 4px;
      font: 13px "SF Mono", "JetBrains Mono", ui-monospace, monospace;
      color: var(--accent-highlight, var(--accent));
    }
    .vd-article-body strong { color: var(--text); }

    @media (max-width: 860px) {
      .vd-shell { flex-direction: column; }
      .vd-sidebar-wrap { width: 100% !important; }
      .vd-sidebar-nav { flex-direction: row; flex-wrap: wrap; }
    }
    @media (max-width: 640px) {
      .vd-steps { grid-template-columns: 1fr; }
      .vd-connector { display: none; }
    }
  `;
  document.head.appendChild(style);
})();

const VD_ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  rocket: '<path d="M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3 -5a9 9 0 0 0 6 -8a3 3 0 0 0 -3 -3a9 9 0 0 0 -8 6a6 6 0 0 0 -5 3"/><path d="M7 14a6 6 0 0 0 -3 6a6 6 0 0 0 6 -3"/><circle cx="15" cy="9" r="1"/>',
  settings: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><circle cx="12" cy="12" r="3"/>',
  tool: '<path d="M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5"/>',
  folder: '<path d="M5 4h4l3 3h7a1 1 0 0 1 1 1v9a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-12a1 1 0 0 1 1 -1"/>',
  home: '<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/>',
  flag: '<path d="M5 21v-16"/><path d="M5 5h13l-2.5 4l2.5 4h-13"/>',
};

const VD_IZGRADNJA_STEPS = [
  {
    icon: 'search',
    title: 'Istraživanje',
    text: 'Definišeš šta aplikacija treba da radi, ko je koristi i koji alati/podaci su ti potrebni prije nego napišeš prvi red koda.',
  },
  {
    icon: 'rocket',
    title: 'Inicijalna verzija',
    text: 'Uz AI generišeš prvu radnu verziju, grubu, ali funkcionalnu. Cilj je nešto što možeš odmah otvoriti, isprobati i vidjeti da li ima smisla.',
  },
  {
    icon: 'settings',
    title: 'Prilagođavanje',
    text: 'Doteruješ izgled, dodaješ funkcije koje ti stvarno trebaju i uklanjaš sve što je suvišno, dok ne odgovara tvom radu.',
  },
  {
    icon: 'tool',
    title: 'Testiranje',
    text: 'Probaš rubne slučajeve, tražiš gdje puca, i potvrđuješ da aplikacija radi pouzdano prije nego je stvarno počneš koristiti.',
  },
];

// Isti tekst kao welcome wizard (#welcomeWizard u index.html) koji se
// prikaže prvi put uz dashboard - ovaj vodič ga čini dostupnim i kasnije,
// kad se wizard jednom zatvori.
const VD_DOBRODOSLI_SECTIONS = [
  {
    title: 'Pokretanje u Claude Code / Codex',
    text: 'Otvori <strong>Claude Desktop</strong> aplikaciju, prijavi se, klikni na <strong>Code</strong> tab pa <strong>Novu sesiju</strong> - za "Project folder" izaberi ovaj preuzeti folder. Ili otvori <strong>ChatGPT desktop</strong> aplikaciju, iz padajućeg menija gore lijevo izaberi <strong>Codex</strong>, pa <strong>Otvori folder</strong> i izaberi isti folder. Nema terminala - sve je klik kroz aplikaciju. Alat kreće TAČNO u ovom folderu (gdje su <code>index.html</code>, <code>app.js</code>, <code>apps/</code>) i sam pročita uputstva: provjeri imaš li Python (i ponudi da ga instalira ako nemaš), pa pokrene dashboard i otvori ga na <code>localhost:8100</code>. Sačuvaj tu stranicu u Bookmarks (Cmd+D) - odsad samo klikni taj bookmark. Ako se laptop restartuje i bookmark prestane da se učitava, dvoklikni <code>start-mac.command</code> (ili <code>start-windows.bat</code>) u ovom folderu - ne moraš opet kroz Claude/Codex.',
  },
  {
    title: 'Tabovi i sekcije',
    text: 'Napravi tab za svaku temu. Svaki tab ima svoj nezavisan raspored sekcija - prevlačiš, razvlačiš po mreži, premještaš između tabova, sve se pamti samo.',
  },
  {
    title: 'Katalog instaliranih alata',
    text: 'Katalog svih instaliranih alata - otvori bilo koji kao punu aplikaciju, ili dodaj njegov widget na board. Primjer: vremenska prognoza kao mali widget.',
  },
  {
    title: 'Napravi svoj alat',
    text: 'Dva puta do novog alata: opiši Claude-u ili Codex-u šta želiš (ili zalijepi gotov prompt) - sam napiše kod i registruje ga. Ili prevuci gotov folder u <code>apps/</code> (npr. sa drugog dashboarda) i reci mu da ga učita. Widget odmah dodaješ na board iz kataloga, ili ga povežeš sa već pripremljenom sekcijom preko njenog menija ("Poveži alat").',
  },
  {
    title: 'Otvaranje aplikacije',
    text: 'Klik na app ikonicu je otvara kao novu karticu gore, preko cijelog ekrana. Klik na x je zatvara i vraća te tačno gdje si stao.',
  },
  {
    title: 'Tvoj stil',
    text: 'Šest ugrađenih tema, plus generator sopstvene palete iz jedne akcentne boje - dugmad, ivice sekcija i akcenti se prebojavaju odmah, svugdje.',
  },
  {
    title: 'Backup i prenos',
    text: 'Cijeli dashboard je samo jedan folder na disku - kopiraj ga na drugi računar (USB, cloud, AirDrop) i pokreni <code>start-mac.command</code> (ili <code>start-windows.bat</code>) tamo. Sve ide sa njim: tabovi, sekcije, teme, instalirani alati i njihovi podaci.',
  },
];

// Biblioteka: kategorije -> vodiči. Novi vodič = nov unos u guides
// niz odgovarajuće kategorije (ili nova kategorija), plus render funkcija.
// icon = ključ iz VD_ICON_PATHS (svaka kategorija i svaki vodič nosi
// sopstvenu ikonicu u sidebaru). "Dashboard" je prva kategorija - njen
// vodič "Dobrodošli" je i default prikaz kad se Vodiči otvore.
const VD_CATEGORIES = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'home',
    guides: [
      {
        id: 'dobrodosli',
        label: 'Dobrodošli',
        icon: 'flag',
        render: renderDobrodosliGuide,
      },
    ],
  },
  {
    id: 'aplikacije-widgeti',
    label: 'Aplikacije i widgeti',
    icon: 'folder',
    guides: [
      {
        id: 'izgradnja',
        label: 'Izgradnja',
        icon: 'rocket',
        render: renderIzgradnjaGuide,
      },
    ],
  },
];

function renderIzgradnjaGuide(mount) {
  const stepsHtml = VD_IZGRADNJA_STEPS
    .map(
      (s, i) => `
      <div class="vd-step-item">
        <div class="vd-num">${String(i + 1).padStart(2, '0')}</div>
        <div class="vd-step">
          <div class="vd-icon-box">
            <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${VD_ICON_PATHS[s.icon]}</svg>
          </div>
          <h3>${s.title}</h3>
          <p>${s.text}</p>
        </div>
      </div>`
    )
    .join('');

  mount.innerHTML = `
    <h1 class="vd-h1">Kako napraviti <em>sopstvenu aplikaciju ili widget</em></h1>
    <p class="vd-lede">Četiri koraka koja prolaziš svaki put kad gradiš vlastiti alat uz AI, od ideje do gotove, testirane verzije.</p>
    <div class="vd-steps">
      <div class="vd-connector"></div>
      ${stepsHtml}
    </div>`;
}

function renderDobrodosliGuide(mount) {
  const sectionsHtml = VD_DOBRODOSLI_SECTIONS
    .map(
      (s, i) => `
      <div class="vd-article-item">
        <div class="vd-article-num">${i + 1}</div>
        <div class="vd-article-body">
          <h3>${s.title}</h3>
          <p>${s.text}</p>
        </div>
      </div>`
    )
    .join('');

  mount.innerHTML = `
    <h1 class="vd-h1">Dobrodošli u Vaš <em>personalni operativni sistem</em></h1>
    <p class="vd-lede">Isti pregled kao welcome vodič koji se prikaže prvi put uz dashboard - dostupan i kasnije, kad god ti zatreba podsjetnik.</p>
    <div class="vd-article">${sectionsHtml}</div>`;
}

AIZdravo.registerApp({
  id: 'vodici',
  name: 'Vodiči',
  description: 'Biblioteka kratkih vodiča za rad na lokalnim alatima i widgetima.',
  icon: 'book',
  version: '1.1.0',
  hideChrome: true,
  // Ne pojavljuje se u katalogu (Alati -> Aplikacije) niti kao folder
  // quick-launch opcija - jedini ulaz je "Vodiči" dugme u Globalnim
  // podešavanjima (settingsVodiciBtn u app.js), koje samo poziva
  // openAppTabGlobal('vodici') i zatvori Podešavanja.
  hideFromCatalog: true,

  app(el) {
    const sidebarHtml = VD_CATEGORIES
      .map(
        (cat) => `
      <div class="vd-cat" data-cat="${cat.id}">
        <button type="button" class="vd-cat-toggle" aria-expanded="true">
          <svg class="vd-cat-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${VD_ICON_PATHS[cat.icon]}</svg>
          <span>${cat.label}</span>
          <svg class="vd-cat-chevron" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="vd-cat-list">
          ${cat.guides
            .map(
              (g) => `<button type="button" class="vd-guide-item" data-guide="${g.id}">
                <svg class="vd-guide-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${VD_ICON_PATHS[g.icon]}</svg>
                <span>${g.label}</span>
              </button>`
            )
            .join('')}
        </div>
      </div>`
      )
      .join('');

    el.innerHTML = `
      <div class="vd-app">
        <h2 class="vd-title">Vodiči</h2>
        <div class="vd-shell">
          <div class="vd-sidebar-wrap">
            <div class="vd-search">
              <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${VD_ICON_PATHS.search}</svg>
              <input type="text" class="vd-search-input" placeholder="Pretraži vodiče...">
            </div>
            <nav class="vd-sidebar-nav">${sidebarHtml}</nav>
          </div>
          <div class="vd-content"><div class="vd-guide-mount"></div></div>
        </div>
      </div>`;

    // Kategorije: collapse/expand.
    el.querySelectorAll('.vd-cat-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cat = btn.closest('.vd-cat');
        const collapsed = cat.classList.toggle('is-collapsed');
        btn.setAttribute('aria-expanded', String(!collapsed));
      });
    });

    // Pretraga: filtrira vodiče po nazivu (i po nazivu kategorije),
    // sakriva kategoriju ako nijedan njen vodič ne zadovoljava upit.
    const searchInput = el.querySelector('.vd-search-input');
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      el.querySelectorAll('.vd-cat').forEach((catEl) => {
        const catLabel = catEl.querySelector('.vd-cat-toggle span').textContent.toLowerCase();
        let anyMatch = false;
        catEl.querySelectorAll('.vd-guide-item').forEach((item) => {
          const label = item.querySelector('span').textContent.toLowerCase();
          const match = !query || label.includes(query) || catLabel.includes(query);
          item.style.display = match ? '' : 'none';
          if (match) anyMatch = true;
        });
        catEl.style.display = anyMatch ? '' : 'none';
        if (query && anyMatch) catEl.classList.remove('is-collapsed');
      });
    });

    // Vodiči: klik prebacuje aktivan sadržaj.
    const mount = el.querySelector('.vd-guide-mount');
    const guideItems = el.querySelectorAll('.vd-guide-item');
    const allGuides = VD_CATEGORIES.flatMap((cat) => cat.guides);

    function showGuide(guideId) {
      const guide = allGuides.find((g) => g.id === guideId) || allGuides[0];
      if (!guide) return;
      guideItems.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.guide === guide.id));
      guide.render(mount);
    }

    guideItems.forEach((btn) => {
      btn.addEventListener('click', () => showGuide(btn.dataset.guide));
    });

    showGuide(allGuides[0] && allGuides[0].id);
  },
});
