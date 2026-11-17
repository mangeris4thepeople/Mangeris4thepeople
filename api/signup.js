const { neon } = require('@neondatabase/serverless');

/* Stores a signup from the Join or Volunteer form. One row per submission. */
function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  /* Bots fill the hidden field. Answer politely and store nothing. */
  if (clean(body.company, 100)) {
    return res.status(200).json({ ok: true });
  }

  const email = clean(body.email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'email' });
  }
  const form = body.form === 'volunteer' ? 'volunteer' : 'join';
  const name = clean(body.first || body.name, 120);
  const zip = clean(body.zip, 12);
  const phone = clean(body.phone, 30);
  const help = clean(body.help, 200);
  const source = clean(body.source, 200);

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`INSERT INTO campaign_signups (form, name, email, zip, phone, help, source)
              VALUES (${form}, ${name}, ${email}, ${zip}, ${phone}, ${help}, ${source})`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('signup insert failed', err && err.message);
    return res.status(500).json({ ok: false });
  }
};
