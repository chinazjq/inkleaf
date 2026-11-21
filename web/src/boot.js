// Runs before first paint so the window opens in the saved theme and layout without flashing.
(function () {
  let prefs = {};
  try {
    const raw = localStorage.getItem('inkleaf.prefs');
    prefs = JSON.parse(raw || '{}') || {};
  } catch {}
  const theme = prefs.theme || 'auto';
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  if (prefs.fontSize) root.style.setProperty('--doc-size', prefs.fontSize + 'px');
  if (prefs.width) root.dataset.width = prefs.width;
  if (prefs.sidebar === false) root.dataset.sidebar = 'off';
})();
