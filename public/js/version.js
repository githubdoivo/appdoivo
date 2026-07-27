// Small, unobtrusive version reference in the corner of every page, so it's
// easy to tell whether QA and prod are running the same code when reporting
// a bug (see GET /api/version in src/routes.js).
export async function wireVersionBadge() {
  const el = document.getElementById('version-badge');
  if (!el) return;
  try {
    const res = await fetch('/api/version');
    const { version, env } = await res.json();
    if (version) el.textContent = env ? `${env} v${version}` : `v${version}`;
  } catch {
    // Not worth surfacing - it's a reference detail, not a feature.
  }
}
