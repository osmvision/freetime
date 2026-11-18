// Runs before the page is drawn (a plain script in <head>), so night mode and high contrast
// never flash the day colours at startup. js/display.js takes over once the app loads.
(function () {
  var theme = null;
  var contrast = null;
  try {
    theme = localStorage.getItem('freetime.theme');
    contrast = localStorage.getItem('freetime.contrast');
  } catch (e) {}
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (contrast === 'high') root.setAttribute('data-contrast', 'high');
})();
