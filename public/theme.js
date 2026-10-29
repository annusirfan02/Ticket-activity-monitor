// Light / dark theme, shared by the dashboard, /live and /hourly.
// Loaded in <head> (not deferred) so the saved theme applies before first paint.
// The choice is kept per browser in localStorage ('am_theme'); default is dark
// unless the page sets data-default-theme on <html>.
(function () {
  var KEY = 'am_theme';
  var css = [
    ':root[data-theme="light"]{',
    '  --bg:#f3f5f9;--surface:#ffffff;--card:#ffffff;--border:#dde2ec;',
    '  --accent:#00a676;--warn:#a86f00;--danger:#d12f4b;--info:#2766cc;--purple:#7442d4;--orange:#c25f00;',
    '  --muted:#e4e8f0;--text:#1a1f2e;--dim:#5b637d;',
    '}',
    ':root[data-theme="light"] th{background:#f7f8fb}',
    ':root[data-theme="light"] tr:hover td{background:#f8f9fc}',
    ':root[data-theme="light"] .multi label:hover{background:#f3f5f9}',
    ':root[data-theme="light"] input[type=date]{color-scheme:light}',
    ':root:not([data-theme="light"]) input[type=date]{color-scheme:dark}',
    '.theme-btn{background:transparent;border:1px solid var(--border);color:var(--dim);border-radius:6px;padding:5px 10px;font-size:12px;font-family:var(--mono);cursor:pointer;white-space:nowrap}',
    '.theme-btn:hover{border-color:var(--accent);color:var(--accent)}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function current() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function label() { return current() === 'light' ? '☾ Dark' : '☀ Light'; }
  function paintButtons() {
    var btns = document.querySelectorAll('.theme-btn');
    for (var i = 0; i < btns.length; i++) { btns[i].textContent = label(); btns[i].title = 'Switch to ' + (current() === 'light' ? 'dark' : 'light') + ' mode'; }
  }
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
    paintButtons();
    try { window.dispatchEvent(new Event('themechange')); } catch (e) {}
  }
  window.toggleTheme = function () {
    var next = current() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  };
  // a CSS variable's current value, for things drawn in JS (charts)
  window.themeVar = function (name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); };

  // a page can set its own default with <html data-default-theme="light">
  function fallback() { return document.documentElement.getAttribute('data-default-theme') || 'dark'; }
  apply(saved() || fallback());
  document.addEventListener('DOMContentLoaded', paintButtons);
  // another tab changed the theme
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(e.newValue || fallback()); });
})();
