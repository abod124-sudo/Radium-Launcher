// Pre-paint bootstrap: applies the saved skin, the Liquid Glass effect and the
// animation and network classes before the stylesheet renders, so the window
// never flashes the wrong look. Lives in its own file rather than inline so the
// CSP can forbid inline script entirely.
//
// Everything here is replayed from localStorage, which the real applyTheme()
// writes on every change. The config only arrives over IPC a moment later; until
// it does, this is all the launcher knows about how it should look.
try {
  // Only a skin name, and only one that could have come from the dropdown:
  // localStorage is hand-editable, and a stray value must not be able to stamp
  // an arbitrary class onto <body>.
  var savedTheme = localStorage.getItem('radium-theme');
  var glassCss = localStorage.getItem('radium-glass-css') || '';

  if (glassCss) {
    // Glass stands in for the skin entirely — it repaints every colour token
    // and brings its own layout — so it is applied instead of the skin class,
    // exactly as applyTheme() does once the config lands.
    document.body.classList.add('theme-moderndark', 'glass-enabled');

    var style = document.createElement('style');
    // applyTheme removes this by id as soon as it builds the real one, so the
    // cache never lingers alongside it or outlives a theme change.
    style.id = 'glass-boot-style';
    style.textContent = glassCss;
    document.head.appendChild(style);
  } else if (savedTheme && savedTheme !== 'steam-green' && /^[a-z0-9-]+$/.test(savedTheme)) {
    // steam-green needs no class: it is the base stylesheet's own palette.
    document.body.classList.add('theme-' + savedTheme);
  }

  var anims = localStorage.getItem('radium-animations');
  if (anims !== 'false') {
    document.body.classList.add('animations-enabled');
  }
  // Network brand, applied before paint for the same reason as the skin.
  var savedNetwork = localStorage.getItem('radium-network');
  document.body.classList.add(savedNetwork === 'vanilla' ? 'network-vanilla' : 'network-radium');
} catch (e) {}
