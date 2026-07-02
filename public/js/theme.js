// Small shared theme toggle. The initial theme is applied inline in <head>
// (before paint, to avoid a flash); this just wires up the toggle button.
(function () {
  function current() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('lv-theme', theme); } catch (_) {}
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  window.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.textContent = current() === 'dark' ? '☀️' : '🌙';
    btn.addEventListener('click', function () {
      apply(current() === 'dark' ? 'light' : 'dark');
    });
  });
})();
