// Pre-paint bootstrap: applies the saved theme, animation and network
// classes before the stylesheet renders, so the window never flashes the
// wrong skin or brand. Lives in its own file rather than inline so the CSP
// can forbid inline script entirely.
// Instant theme and animation state application to prevent flash of default theme
try {
  const savedTheme = localStorage.getItem('radium-theme');
  if (savedTheme && savedTheme !== 'steam-green') {
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
