// Pre-paint bootstrap: applies the saved theme, animation and network
// classes before the stylesheet renders, so the window never flashes the
// wrong skin or brand. Lives in its own file rather than inline so the CSP
// can forbid inline script entirely.
// Instant theme and animation state application to prevent flash of default theme
try {
  const savedTheme = localStorage.getItem('radium-theme');
  if (savedTheme === 'custom') {
    // A custom theme is not a class in the stylesheet — it is generated at
    // runtime, after the config arrives over IPC. Adding a bare `theme-custom`
    // here matched no rules at all, so the window painted the :root defaults
    // (the Steam 2003 Green palette) until that IPC landed, then snapped to
    // the real theme. applyTheme caches its output for exactly this, so replay
    // it: the structural classes first, then the palette and the generated
    // sheet in the same order applyTheme appends them, because glass mode
    // redefines the palette variables at equal specificity and document order
    // is what decides the winner.
    //
    // Only theme-* class names are honoured, on the same reasoning as the font
    // pack below: a hand-edited value must not be able to stamp an arbitrary
    // class onto <body>.
    const cls = localStorage.getItem('radium-custom-classes') || 'theme-custom';
    cls.split(' ').forEach(function (c) {
      if (/^theme-[a-z0-9-]+$/.test(c)) document.body.classList.add(c);
    });

    const vars = localStorage.getItem('radium-custom-vars') || '';
    const css = localStorage.getItem('radium-custom-css') || '';
    if (vars || css) {
      const style = document.createElement('style');
      // applyTheme removes this by id as soon as it builds the real one, so
      // the cache never lingers alongside it or outlives a theme change.
      style.id = 'custom-theme-boot';
      style.textContent = vars + '\n' + css;
      document.head.appendChild(style);
    }
  } else if (savedTheme && savedTheme !== 'steam-green') {
    document.body.classList.add('theme-' + savedTheme);
  }
  const anims = localStorage.getItem('radium-animations');
  if (anims !== 'false') {
    document.body.classList.add('animations-enabled');
  }
  // Network brand, applied before paint for the same reason as the theme.
  const savedNetwork = localStorage.getItem('radium-network');
  document.body.classList.add(savedNetwork === 'vanilla' ? 'network-vanilla' : 'network-radium');
  // Font pack, likewise. The packs change the body font size and the sidebar
  // wordmark size, so landing it after the config IPC reflows the layout in
  // front of the user on every launch. Validated against the same list
  // applyFont uses, so a hand-edited value cannot stamp a junk class.
  const savedFont = localStorage.getItem('radium-font');
  if (savedFont && ['ios', 'minecraft', 'radium'].indexOf(savedFont) !== -1) {
    document.body.classList.add('font-' + savedFont);
  }
} catch (e) {}
