// Runs before CSS paints so a saved/system dark theme does not flash white.
(() => {
    const key = 'cvse_theme';
    const modes = ['system', 'light', 'dark'];
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const normalize = value => modes.includes(value) ? value : 'system';
    let mode = 'system';
    try { mode = normalize(localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }

    function apply() {
        const theme = mode === 'system' ? (media?.matches ? 'dark' : 'light') : mode;
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
        const select = document.getElementById('themeSelect');
        if (select) select.value = mode;
    }

    apply();
    document.addEventListener('DOMContentLoaded', apply, { once: true });
    document.addEventListener('change', event => {
        if (event.target.id !== 'themeSelect') return;
        mode = normalize(event.target.value);
        try { localStorage.setItem(key, mode); } catch { /* Switching still works for this tab. */ }
        apply();
    });
    media?.addEventListener('change', () => { if (mode === 'system') apply(); });
    window.addEventListener('storage', event => {
        if (event.key === key || event.key === null) {
            mode = normalize(event.newValue);
            apply();
        }
    });
})();
