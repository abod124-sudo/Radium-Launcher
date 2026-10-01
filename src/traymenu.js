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

  const NETWORK_ROWS = [
    ['radium', 'Radium', 'logo.png'],
    ['vanilla', 'Vanilla', 'assets/vanilla-logo.png'],
    ['stella', 'Stella', 'assets/stella-logo.png'],
  ];

  /// The menu's rows, each keyed (`data-key`) so a redraw can tell which rows
  /// are the same row with new contents and which have come or gone.
  function build({ network, gameRunning }) {
    const active = NETWORK_ROWS.find(([id]) => id === network) || NETWORK_ROWS[0];
    const vanilla = active[0] === 'vanilla';
    // Stella has no Rooms or People pages, as in the sidebar.
    const social = active[0] !== 'stella';
    const rows = [
      gameRunning
        ? item('play', 'Stop Game', { glyph: 'stop', cls: 'play' })
        : item('play', `Play ${active[1]}`, { glyph: 'play', cls: 'play' }),
      sep(),
      item('tab:home', 'Home'),
      ...(social ? [item('tab:rooms', 'Rooms'), item('tab:people', 'People')] : []),
      // The Feed page exists on Vanilla only, as in the sidebar.
      ...(vanilla ? [item('tab:feed', 'Feed')] : []),
      item('tab:settings', 'Settings'),
      sep(),
      header('Network'),
      ...NETWORK_ROWS.map(([id, label, icon]) =>
        item(`network:${id}`, label, { icon, cls: id === active[0] ? 'selected' : '' })),
      sep(),
      item('open', 'Open Radium Launcher'),
      item('quit', 'Quit'),
    ];
    // Separators and headers are counted among their own kind, not by
    // position, which shifts with every row a network adds or drops.
    const seen = {};
    for (const row of rows) {
      const n = (seen[row.className] = (seen[row.className] ?? -1) + 1);
      row.dataset.key = row.dataset.id || `${row.className}:${n}`;
    }
    return rows;
  }

  /// A row's box and opacity as drawn right now, in keyframe form — halfway
  /// through an animation if it is in one.
  function frame(el) {
    const cs = getComputedStyle(el);
    return {
      height: `${el.getBoundingClientRect().height}px`,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
      opacity: cs.opacity,
    };
  }

  /// Bring an open menu's rows to `rows`, keeping every row that is still
  /// there as the same element — so the one under the cursor keeps its hover,
  /// and its icon isn't reloaded — and inserting the new ones in place.
  ///
  /// Returns the rows whose size has to change, each with where it starts
  /// from: a new row from nothing, a row that is going from its full size,
  /// and a row caught mid-animation by a second network pick from wherever
  /// it had got to, so the menu carries on from there rather than jumping.
  /// Rows that are going stay in, marked `.leaving`, until the caller's
  /// `settle()`.
  function reconcile(rows) {
    const live = new Map([...menu.querySelectorAll('.moving')].map((el) => [el, frame(el)]));
    for (const el of menu.children) {
      for (const a of el.getAnimations()) a.cancel();
      el.classList.remove('moving');
    }
    const keys = new Set(rows.map((row) => row.dataset.key));
    const old = new Map([...menu.children].map((el) => [el.dataset.key, el]));
    const moves = [];
    let prev = null;
    for (const row of rows) {
      let el = old.get(row.dataset.key);
      if (el) {
        // Also takes `.leaving` off a row the new menu has back.
        if (el.className !== row.className) el.className = row.className;
        if (el.innerHTML !== row.innerHTML) el.replaceChildren(...row.childNodes);
        if (live.has(el)) moves.push({ el, from: live.get(el), to: 'open' });
      } else {
        el = row;
        moves.push({ el, from: null, to: 'open' });
        if (prev) prev.after(el);
        else menu.prepend(el);
      }
      prev = el;
    }
    for (const [key, el] of old) {
      if (keys.has(key)) continue;
      el.classList.add('leaving');
      moves.push({ el, from: live.get(el) || null, to: 'shut' });
    }
    return moves;
  }

  /// End a redraw: drop the rows that went, and let the rest be laid out as
  /// themselves again.
  function settle() {
    for (const el of menu.querySelectorAll('.leaving')) el.remove();
    for (const el of menu.children) {
      for (const a of el.getAnimations()) a.cancel();
      el.classList.remove('moving');
    }
  }

  const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

  /// Grow the new rows out of nothing and fold the departing ones away, so
  /// the menu's height glides to its new size and the rows below slide with
  /// it. Returned paused: the caller starts them once the window is big
  /// enough to hold the menu at its larger size.
  function animate(moves) {
    const gap = parseFloat(getComputedStyle(menu).rowGap) || 0;
    // A row folded to nothing still has the menu's gap beside it; the
    // negative margin takes that up too, so removing it at the end is not a
    // 1px jump.
    const shut = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: `${-gap}px`, marginBottom: '0px', opacity: '0' };
    const size = [];
    const fade = [];
    for (const { el, from, to } of moves) {
      // Measured at rest: nothing is animating it at this point.
      const full = { ...frame(el), opacity: '1' };
      const start = from || (to === 'open' ? shut : full);
      const end = to === 'open' ? full : shut;
      const box = (f) => ({ height: f.height, paddingTop: f.paddingTop, paddingBottom: f.paddingBottom,
                            marginTop: f.marginTop, marginBottom: f.marginBottom });
      el.classList.add('moving');
      // Coming in, the row opens and its text fades up once there is room for
      // it. Going out, the text fades first and the row folds a beat later:
      // folded while still visible, neighbouring rows' labels squash into
      // one another.
      const opening = to === 'open';
      size.push(el.animate([box(start), box(end)], opening
        ? { duration: 260, easing: EASE }
        : { duration: 220, delay: from ? 0 : 40, easing: EASE, fill: 'both' }));
      fade.push(el.animate([{ opacity: start.opacity }, { opacity: end.opacity }], opening
        ? { duration: 180, delay: from ? 0 : 90, easing: 'ease-out', fill: 'backwards' }
        : { duration: 90, easing: 'ease-out', fill: 'forwards' }));
    }
    const all = [...size, ...fade];
    for (const a of all) a.pause();
    return {
      play: () => all.forEach((a) => a.play()),
      finished: Promise.all(size.map((a) => a.finished)),
    };
  }

  function motion() {
    return document.body.classList.contains('motion') && !matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  /// The window is sized by `roomFor`, not by the menu on show, so switching
  /// network never has to resize it. `tray_menu_show` places the window by
  /// the stored cursor anchor, so calling it again while the menu is up
  /// resizes it in place — which now only a skin change does (`resize`).
  async function place(state, { resize = false } = {}) {
    await fontsSettled();
    const { width, height } = roomFor(state);
    if (resize && placedSize?.width === width && placedSize?.height === height) return null;
    const frost = document.body.classList.contains('glass');
    const placed = await invoke('tray_menu_show', { width, height, frost });
    placedSize = { width, height };
    document.body.classList.toggle('above', placed?.above !== false);
    return placed?.frost;
  }

  /// The window's size as last placed, in CSS pixels.
  let placedSize = null;

  const probe = menu.cloneNode(false);
  probe.removeAttribute('id');
  probe.removeAttribute('role');
  probe.removeAttribute('aria-label');
  probe.setAttribute('aria-hidden', 'true');
  probe.classList.add('probe');
  document.body.appendChild(probe);

  /// Room for the menu whichever network is picked: the largest of the
  /// networks' menus, measured in `probe` under the current skin. Vanilla's
  /// has a Feed row that Radium's doesn't, and Stella's has no Rooms or
  /// People, so the menu's height changes as you switch, but the window
  /// doesn't have to. Resizing it with the menu flickered: Windows moves and
  /// sizes the window a frame before the webview draws to the new size.
  function roomFor(state) {
    let width = 0;
    let height = 0;
    for (const [network] of NETWORK_ROWS) {
      probe.replaceChildren(...build({ ...state, network }));
      const rect = probe.getBoundingClientRect();
      width = Math.max(width, Math.ceil(rect.width));
      height = Math.max(height, Math.ceil(rect.height));
    }
    probe.replaceChildren();
    return { width, height };
  }

  /// Bumped by every redraw, so an animation that a newer one has overtaken
  /// leaves the rows to it.
  let generation = 0;

  async function show(state) {
    if (!state) return;
    generation++;
    applyStyle(state.style);
    menu.replaceChildren(...build(state));
    menu.classList.remove('in');
    open = true;
    document.documentElement.style.removeProperty('--tm-backdrop');
    try {
      const url = await place(state);
      // The menu fades in once it has its frost.
      //
      // Deliberately not deferred to a `requestAnimationFrame` first. Waiting
      // a frame here looks like the careful thing to do — start the animation
      // once the window is really on screen — but rAF does not reliably fire
      // in a window that has only just been shown, and nothing is what this
      // class guards: `.menu` is `opacity: 0` until it arrives, so a callback
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
  ///
  /// When rows come or go (Stella has no Rooms or People), the height change
  /// is animated, entirely inside the window: it already has room for every
  /// network's menu (`roomFor`), and the menu is pinned to its edge by the
  /// cursor, so the rest of it is just clear.
  async function update(state) {
    if (!state || !open) return;
    const gen = ++generation;
    applyStyle(state.style);
    const moves = reconcile(build(state));
    // Started from their first frame now, before anything awaits, so the
    // rows' new layout is never drawn ahead of the animation.
    const run = moves.length && motion() ? animate(moves) : null;
    if (!run) settle();
    try {
      // A skin change can make every menu bigger or smaller; a network switch
      // doesn't change the room needed, and makes no call.
      await place(state, { resize: true });
      if (!run || gen !== generation) return;
      run.play();
      // A backstop for the frames, as in `close`: finished rows must not be
      // left in the menu if this window stops ticking animations.
      await Promise.race([run.finished, new Promise((done) => setTimeout(done, 600))]);
      if (gen !== generation) return;
      settle();
    } catch (e) {
      /* The menu is still up and still correct; only its size may lag. */
      if (gen === generation) settle();
    }
  }

  /// Blank the menu, let that frame reach the screen, then hide the window,
  /// so the next time it is shown Windows doesn't flash this menu first.
  ///
  /// The timer is a backstop for the frames. `requestAnimationFrame` does not
  /// always run in this window (see `show`), and if it didn't here, a blanked
  /// but still-shown window would sit on top of everything by the taskbar,
  /// invisible and catching clicks. Whichever comes first hides it; neither
  /// does if the menu has been opened again in the meantime.
  function close() {
    if (!open) return;
    open = false;
    menu.classList.remove('in');
    let done = false;
    const hide = () => {
      if (done || open) return;
      done = true;
      invoke('tray_menu_hide').catch(() => {});
    };
    requestAnimationFrame(() => requestAnimationFrame(hide));
    setTimeout(hide, 150);
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
    const items = [...menu.querySelectorAll('.item:not(.leaving)')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next].focus();
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // The window is taller than a shorter network's menu (see `roomFor`), and
  // that clear strip is still this window. A click there is a click outside
  // the menu, so it closes it, as a click anywhere else would.
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest?.('.menu')) close();
  });

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
