// The tray icon's right-click menu (see the tray menu section of
// background.rs, and trayMenuStyle() in app.js for where its look comes from).
//
// The backend asks for the menu with the launcher's current state; this page
// builds it, measures it, and asks the backend to place the window by the
// cursor. A choice goes back to the backend, which carries it out.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const menu = document.getElementById('menu');

  // Only these may be restyled from the launcher's snapshot.
  const STYLE_VARS = ['bg', 'bg-image', 'border', 'radius', 'shadow', 'pad', 'fg', 'font', 'size', 'weight',
                      'item-pad', 'item-radius', 'hover-bg', 'hover-fg', 'sel-weight', 'sel-bg', 'sel-fg',
                      'sep-top', 'sep-bottom', 'sep-shadow', 'sep-bg', 'sep-height', 'sep-margin'];

  function applyStyle(style) {
    if (!style || typeof style !== 'object') return;
    for (const key of STYLE_VARS) {
      const value = style[key];
      if (typeof value === 'string' && value.length < 2000) {
        document.documentElement.style.setProperty(`--tm-${key}`, value);
      }
    }
    document.body.classList.toggle('motion', style.motion !== false);
    document.body.classList.toggle('glass', style.glass === true);
  }

  function item(id, label, { icon, glyph, cls } = {}) {
    const btn = document.createElement('button');
    btn.className = 'item' + (cls ? ` ${cls}` : '');
    btn.setAttribute('role', 'menuitem');
    btn.dataset.id = id;
    if (icon) {
      const img = document.createElement('img');
      img.className = 'icon';
      img.src = icon;
      img.alt = '';
      btn.appendChild(img);
    } else if (glyph) {
      const g = document.createElement('span');
      g.className = `glyph glyph-${glyph}`;
      g.setAttribute('aria-hidden', 'true');
      btn.appendChild(g);
    }
    const text = document.createElement('span');
    text.textContent = label;
    btn.appendChild(text);
    return btn;
  }

  function sep() {
    const el = document.createElement('div');
    el.className = 'sep';
    el.setAttribute('role', 'separator');
    return el;
  }

  function header(label) {
    const el = document.createElement('div');
    el.className = 'header';
    el.textContent = label;
    return el;
  }

  function build({ network, gameRunning }) {
    const vanilla = network === 'vanilla';
    const rows = [
      gameRunning
        ? item('play', 'Stop Game', { glyph: 'stop', cls: 'play' })
        : item('play', `Play ${vanilla ? 'Vanilla' : 'Radium'}`, { glyph: 'play', cls: 'play' }),
      sep(),
      item('tab:home', 'Home'),
      item('tab:rooms', 'Rooms'),
      item('tab:people', 'People'),
      // The Feed page exists on Vanilla only, as in the sidebar.
      ...(vanilla ? [item('tab:feed', 'Feed')] : []),
      item('tab:settings', 'Settings'),
      sep(),
      header('Network'),
      item('network:radium', 'Radium', { icon: 'logo.png', cls: vanilla ? '' : 'selected' }),
      item('network:vanilla', 'Vanilla', { icon: 'assets/vanilla-logo.png', cls: vanilla ? 'selected' : '' }),
      sep(),
      item('open', 'Open Radium Launcher'),
      item('quit', 'Quit'),
    ];
    menu.replaceChildren(...rows);
  }

  let open = false;

  /// Settle the webfont before anything is measured.
  ///
  /// The launcher's menus are set in Inter under the modern skins, so that is
  /// what `--tm-font` asks for — and a webfont only starts loading when
  /// something uses it, which is `build()` above. Measuring straight after it
  /// therefore measured the fallback face: 317px tall against Inter's 308px
  /// for the same menu, so the very first menu of a session was sized 9px too
  /// tall and then reflowed inside a window that no longer fitted it. Every
  /// menu after that measured correctly, because by then the font was loaded —
  /// which is exactly why only the first one opened differently.
  ///
  /// Resolved immediately once the font is in, so this costs nothing after the
  /// first menu. The race is there so a font that never arrives cannot leave
  /// the menu invisible.
  ///
  /// The layout read is not redundant, and `document.fonts.status` cannot
  /// stand in for it: a webfont is only requested when something actually
  /// needs it, so before the menu has been laid out nothing is pending and the
  /// status reads "loaded" — the one value that looks like "nothing to wait
  /// for". Forcing layout here is what puts the face in flight, and only then
  /// does `ready` mean what it says.
  function fontsSettled() {
    if (!document.fonts) return Promise.resolve();
    menu.getBoundingClientRect();
    if (document.fonts.status === 'loaded') return Promise.resolve();
    return Promise.race([
      document.fonts.ready,
      new Promise((done) => setTimeout(done, 400)),
    ]);
  }

  /// Hand the backend the menu's size so it can place the window, and return
  /// the frost it captured (Liquid Glass only — see frost.rs).
  ///
  /// `tray_menu_show` places the window by the stored cursor anchor, so
  /// calling it again while the menu is up simply resizes it in place. That is
  /// what an in-menu network switch needs: Vanilla's menu carries a Feed row
  /// that Radium's does not, 28px the window has to grow by.
  async function place() {
    await fontsSettled();
    const rect = menu.getBoundingClientRect();
    const frost = document.body.classList.contains('glass');
    return invoke('tray_menu_show', {
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
      frost,
    });
  }

  async function show(state) {
    if (!state) return;
    applyStyle(state.style);
    build(state);
    menu.classList.remove('in');
    open = true;
    document.documentElement.style.removeProperty('--tm-backdrop');
    try {
      const url = await place();
      // The menu fades in once it has its frost.
      //
      // Deliberately not deferred to a `requestAnimationFrame` first. Waiting
      // a frame here looks like the careful thing to do — start the animation
      // once the window is really on screen — but rAF does not reliably fire
      // in a window that has only just been shown, and nothing is what this
      // class guards: `#menu` is `opacity: 0` until it arrives, so a callback
      // that never runs is a menu that never appears. The cold-renderer
      // problem it was meant to cover is handled where it belongs, by giving
      // the webview a frame at startup (`warm_tray_menu` in background.rs).
      if (url) document.documentElement.style.setProperty('--tm-backdrop', `url("${url}")`);
      if (open) menu.classList.add('in');
    } catch (e) {
      open = false;
    }
  }

  /// Redraw an open menu after the launcher's state changed under it — which
  /// is what picking a network row does. No entrance animation and no new
  /// frost: the menu is already on screen and stays put, only its contents and
  /// its height change.
  async function update(state) {
    if (!state || !open) return;
    applyStyle(state.style);
    build(state);
    try {
      await place();
    } catch (e) {
      /* The menu is still up and still correct; only its size may lag. */
    }
  }

  /// Blank the menu, let that frame reach the screen, then hide the window,
  /// so the next time it is shown Windows doesn't flash this menu first.
  function close() {
    if (!open) return;
    open = false;
    menu.classList.remove('in');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      invoke('tray_menu_hide').catch(() => {});
    }));
  }

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('.item');
    if (!btn || !open) return;
    const id = btn.dataset.id;

    // The network rows are a selection, not a command: the menu stays up and
    // the tick moves, the way a radio group in a menu behaves. The launcher
    // switches underneath and reports back through `tray-menu-update`, which
    // rebuilds the rest of the menu — the Play row's label, and Vanilla's Feed
    // row. The tick is moved here too so it follows the click immediately
    // rather than after the round trip; a switch the launcher refuses puts it
    // back on the next update.
    if (id.startsWith('network:')) {
      if (btn.classList.contains('selected')) return;
      for (const row of menu.querySelectorAll('.item[data-id^="network:"]')) {
        row.classList.toggle('selected', row === btn);
      }
      invoke('tray_menu_pick', { id }).catch(() => {});
      return;
    }

    open = false;
    menu.classList.remove('in');
    invoke('tray_menu_pick', { id }).catch(() => {});
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll('.item')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next].focus();
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());

  listen('tray-menu-open', (event) => show(event.payload));
  listen('tray-menu-update', (event) => update(event.payload));
  listen('tray-menu-dismiss', close);

  // Fetch the menu's face now rather than when the first menu is measured.
  // This page is normally built well before any right-click (see
  // `warm_tray_menu`), so by the time a menu is drawn the font is already
  // in and `fontsSettled()` has nothing to wait for. traymenu.css declares one
  // webface over the whole weight range, so this is all of it.
  if (document.fonts) {
    document.fonts.load('400 12px Inter').catch(() => {});
    document.fonts.load('700 12px Inter').catch(() => {});
  }

  // A right-click that came before this page finished loading.
  invoke('tray_menu_state').then(show).catch(() => {});
})();
