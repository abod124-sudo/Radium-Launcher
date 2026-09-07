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
} catch (e) {}
