// API smoke test. Usage: node scripts/smoke.js <ADMIN_TOKEN> [port]
const admin = process.argv[2];
const port = process.argv[3] || 3001;
const base = `http://localhost:${port}/api`;
if (!admin) { console.error('Missing admin token.'); process.exit(1); }

const call = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const log = (label, r) => console.log(`${label}: ${r.status}`, JSON.stringify(r.data));

(async () => {
  log('me(admin)', await call('/me', { token: admin }));

  const created = await call('/admin/users', { method: 'POST', token: admin, body: { name: 'Teste' } });
  log('create user', created);
  const userToken = created.data.token;

  log('open voting', await call('/admin/settings', { method: 'PUT', token: admin, body: { votingOpenHour: 0, votingCloseHour: 24 } }));

  const c1 = await call('/admin/contestants', { method: 'POST', token: admin, body: { name: 'Concorrente A' } });
  const c2 = await call('/admin/contestants', { method: 'POST', token: admin, body: { name: 'Concorrente B' } });
  log('contestant A', c1); log('contestant B', c2);

  log('suggest consequence', await call('/consequences', { method: 'POST', token: userToken, body: { text: 'Faz 10 flexoes' } }));
  log('suggest 2nd time (should 409)', await call('/consequences', { method: 'POST', token: userToken, body: { text: 'outra' } }));
  log('reveal', await call('/admin/consequences/reveal', { method: 'POST', token: admin }));
  log('current', await call('/consequences/current', { token: userToken }));

  log('vote A', await call('/votes', { method: 'POST', token: userToken, body: { contestantId: c1.data.id } }));
  log('vote 2nd time (should fail)', await call('/votes', { method: 'POST', token: userToken, body: { contestantId: c2.data.id } }));
  log('votes (admin)', await call('/admin/votes', { token: admin }));

  // restore default settings
  log('restore voting 22-24', await call('/admin/settings', { method: 'PUT', token: admin, body: { votingOpenHour: 22, votingCloseHour: 24 } }));
})().catch((e) => { console.error(e); process.exit(1); });
