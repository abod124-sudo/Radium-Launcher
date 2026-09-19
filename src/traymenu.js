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

  function show(state) {
    if (!state) return;
    applyStyle(state.style);
    build(state);
    menu.classList.remove('in');
    open = true;
    // Measured now, laid out but not yet on screen.
    const rect = menu.getBoundingClientRect();
    // Under Liquid Glass the backend returns the blurred screen behind the
    // menu, which is its frost (frost.rs). The menu fades in once it has it.
    const frost = document.body.classList.contains('glass');
    document.documentElement.style.removeProperty('--tm-backdrop');
    invoke('tray_menu_show', { width: Math.ceil(rect.width), height: Math.ceil(rect.height), frost })
      .then((url) => {
        if (url) document.documentElement.style.setProperty('--tm-backdrop', `url("${url}")`);
        if (open) menu.classList.add('in');
      }).catch(() => { open = false; });
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
    open = false;
    menu.classList.remove('in');
    invoke('tray_menu_pick', { id: btn.dataset.id }).catch(() => {});
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
  listen('tray-menu-dismiss', close);

  // A right-click that came before this page finished loading.
  invoke('tray_menu_state').then(show).catch(() => {});
})();
