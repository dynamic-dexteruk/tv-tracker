// Auto-update stats and row style when an episode is toggled
addEventListener('change', async (e) => {
  if (!e.target.matches('.toggle')) return;

  const tr = e.target.closest('tr');
  const id = tr?.dataset?.episodeId;
  if (!id) return;

  try {
    const res = await fetch(`/episode/${id}/toggle`, { method: 'POST' });
    if (!res.ok) throw new Error('Toggle failed');
    const data = await res.json(); // { watched: true|false }

    // Visually mark/unmark the row
    tr.classList.toggle('watched', !!data.watched);

    // Recalculate stats (no reload)
    const total = document.querySelectorAll('.toggle').length;
    const watched = document.querySelectorAll('.toggle:checked').length;

    const watchedEl = document.getElementById('watchedCount');
    const totalEl   = document.getElementById('totalCount');
    const pctEl     = document.getElementById('pctCount');

    if (watchedEl) watchedEl.textContent = watched;
    if (totalEl)   totalEl.textContent   = total;
    if (pctEl)     pctEl.textContent     = total ? Math.round((watched / total) * 100) : 0;

  } catch (err) {
    // Roll back UI if the server failed
    e.target.checked = !e.target.checked;
    alert('Could not toggle watched state.');
  }
});

