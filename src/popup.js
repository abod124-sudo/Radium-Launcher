// The notification pop-up (see desktop_notify.rs and the pop-up section of
// app.js). Cards arrive already written; everything here is layout, timing
// and reporting the stack's height back to the window.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const SHOW_MS = 6000;
  const MAX_CARDS = 3;
  const LEAVE_MS = 220;
  const RETRO_LEAVE_MS = 300;
  const stack = document.getElementById('stack');
  const timers = new WeakMap();

  // Only these may be restyled from the launcher's snapshot.
  const STYLE_VARS = ['bg', 'bg-image', 'border', 'radius', 'shadow', 'fg', 'muted', 'accent', 'font',
                      'system-bg', 'avatar-radius'];

  function applyStyle(style) {
    if (!style || typeof style !== 'object') return;
    for (const key of STYLE_VARS) {
      const value = style[key];
      if (typeof value === 'string' && value.length < 2000) {
        document.documentElement.style.setProperty(`--pop-${key}`, value);
      }
    }
    document.body.classList.toggle('no-motion', style.motion === false);
    document.body.classList.toggle('retro', style.retro === true);
    // Liquid Glass: let the desktop show through the card.
    document.body.classList.toggle('glass', style.glass === true);
  }

  // The window is resized as little as possible. A resize moves and sizes the
  // window in one go, and the page inside is redrawn a frame later, so every
  // card on screen jumped — the flicker when one of several left. So the
  // window opens tall enough for a full stack, only ever grows while cards
  // are showing, and shrinks (hides) only once the last one has gone.
  const ROOM_FOR_STACK = 3 * 110 + 2 * 8;
  const TOP_ROOM = 24;
  let windowHeight = 0;

  let layoutQueued = false;
  function layout() {
    if (layoutQueued) return;
    layoutQueued = true;
    // After the browser has laid the change out, so the height is real.
    setTimeout(() => {
      layoutQueued = false;
      let height = 0;
      if (stack.children.length) {
        const needed = Math.ceil(stack.getBoundingClientRect().height) + TOP_ROOM;
        height = Math.max(windowHeight, needed, ROOM_FOR_STACK + TOP_ROOM);
      }
      placeBackdrop();
      if (height === windowHeight) return;
      windowHeight = height;
      if (!height) backdrop = null;
      invoke('desktop_notif_layout', { height, frost: document.body.classList.contains('glass') })
        .then((b) => {
          if (b && b.url) {
            backdrop = b;
            document.documentElement.style.setProperty('--pop-backdrop', `url("${b.url}")`);
            placeBackdrop();
          }
        })
        .catch(() => {});
    }, 0);
  }

  // Liquid Glass: the frost is a blurred picture of the screen behind the
  // window, taken by the backend as the window appears (frost.rs). Each card
  // shows the part of it that lies under the card, so the picture stays put
  // while the cards stack and move.
  let backdrop = null;   // { url, width, height } in CSS pixels

  function placeBackdrop() {
    if (!backdrop) return;
    const origin = stack.getBoundingClientRect();
    // The picture is pinned to the window's bottom-right, as the stack is.
    const left = innerWidth - backdrop.width;
    const top = innerHeight - backdrop.height;
    for (const c of stack.children) {
      // The card's resting place, ignoring the transforms it animates with.
      const x = origin.left + c.offsetLeft - left;
      const y = origin.top + c.offsetTop - top;
      c.style.setProperty('--bd-pos', `${-x}px ${-y}px`);
    }
    document.documentElement.style.setProperty('--pop-backdrop-size', `${backdrop.width}px ${backdrop.height}px`);
  }

  function motionOn() {
    return !document.body.classList.contains('no-motion')
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /// Take a card out, sliding the cards above it down into the gap rather
  /// than letting them snap.
  function removeCard(card) {
    const others = [...stack.children].filter(c => c !== card);
    const before = new Map(others.map(c => [c, c.getBoundingClientRect().top]));
    card.remove();
    if (motionOn()) {
      for (const c of others) {
        const dy = before.get(c) - c.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) {
          c.animate(
            [{ translate: `0 ${dy}px` }, { translate: '0 0' }],
            { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
          );
        }
      }
    }
    layout();
  }

  function dismiss(card) {
    if (!card || card.classList.contains('leaving')) return;
    clearTimeout(timers.get(card));
    card.classList.add('leaving');
    const ms = document.body.classList.contains('retro') ? RETRO_LEAVE_MS : LEAVE_MS;
    setTimeout(() => removeCard(card), motionOn() ? ms : 0);
  }

  function arm(card) {
    clearTimeout(timers.get(card));
    timers.set(card, setTimeout(() => dismiss(card), SHOW_MS));
  }

  function avatar(data) {
    if (data.icon) {
      const box = document.createElement('span');
      box.className = 'avatar system';
      const glyph = document.createElement('span');
      glyph.className = `glyph glyph-${['thumb', 'bell', 'info'].includes(data.icon) ? data.icon : 'info'}`;
      box.appendChild(glyph);
      return box;
    }
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    // Only the launcher's own thumbnail scheme or bundled images. A missing
    // or broken picture gets the placeholder avatar (the same one app.js
    // uses); this used to be images.png, the Radium logo, on what are
    // Vanilla notifications.
    const placeholder = './assets/default-avatar.png';
    const src = String(data.avatar || '');
    img.src = /^(http:\/\/radiumimg\.localhost\/|radiumimg:\/\/|\.\/)/.test(src) ? src : placeholder;
    img.onerror = () => { img.onerror = null; img.src = placeholder; };
    return img;
  }

  function show(data) {
    const card = document.createElement('div');
    card.className = 'pop';
    card.setAttribute('role', 'status');
    card.appendChild(avatar(data));

    const body = document.createElement('div');
    body.className = 'body';
    const app = document.createElement('span');
    app.className = 'app';
    app.textContent = String(data.app || 'Vanilla');
    const text = document.createElement('span');
    text.className = 'text';
    for (const part of Array.isArray(data.parts) ? data.parts : []) {
      const node = document.createElement(part && part.b ? 'strong' : 'span');
      node.textContent = String(part && part.t != null ? part.t : '');
      text.appendChild(node);
    }
    body.append(app, text);
    card.appendChild(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(card);
    });
    card.appendChild(close);

    card.addEventListener('click', () => {
      invoke('desktop_notif_open', { card: { id: data.id ?? null, sender: data.sender ?? null } }).catch(() => {});
      dismiss(card);
    });
    card.addEventListener('mouseenter', () => clearTimeout(timers.get(card)));
    card.addEventListener('mouseleave', () => arm(card));

    stack.appendChild(card);
    arm(card);

    const live = stack.querySelectorAll('.pop:not(.leaving)');
    for (let i = 0; i < live.length - MAX_CARDS; i++) dismiss(live[i]);
  }

  async function collect() {
    let cards = [];
    try {
      cards = await invoke('desktop_notif_take');
    } catch (e) {
      return;
    }
    for (const data of cards) {
      if (!data || typeof data !== 'object') continue;
      applyStyle(data.style);
      show(data);
    }
    if (cards.length) layout();
  }

  listen('desktop-notif-ready', collect);
  collect();
})();
