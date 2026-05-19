require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;

if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY is missing!');
  process.exit(1);
}

const BREVO_HEADERS = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

const LIST_RULES = [
  { listId: 41, name: 'Global Leads' },
  { listId: 42, name: 'Enterprise Leads' },
  { listId: 46, name: 'Korean Leads' },
  { listId: 40, name: 'Japanese Leads' },
  { listId: 38, name: 'WhatsApp Reachout Leads' },
  { listId: 55, name: 'New Signup' },              // ← add
  { listId: 51, name: 'Platform Signup Leads' },   // ← add
];

function toDateOnly(isoValue) {
  return String(isoValue || '').split('T')[0];
}

async function getContact(email) {
  const res = await axios.get(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
    { headers: BREVO_HEADERS }
  );
  return res.data;
}

async function markNotified(email, attrName, value) {
  try {
    await axios.put(
      `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
      { attributes: { [attrName]: value } },
      { headers: BREVO_HEADERS }
    );
    return;
  } catch (err) {
    if (err?.response?.status !== 400) {
      throw err;
    }
  }

  const dateOnly = toDateOnly(value);
  await axios.put(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
    { attributes: { [attrName]: dateOnly } },
    { headers: BREVO_HEADERS }
  );
}

async function backfillList(rule) {
  const { listId, name } = rule;
  const attrName = `NOTIFIED_LIST_${listId}`;
  const markTime = new Date().toISOString();

  let offset = 0;
  const limit = 100;
  let total = 0;
  let updated = 0;
  let skipped = 0;

  console.log(`\n📌 Backfilling ${name} (List ${listId}) using ${attrName}`);

  while (true) {
    const res = await axios.get(
      `https://api.brevo.com/v3/contacts/lists/${listId}/contacts`,
      { headers: BREVO_HEADERS, params: { limit, offset, sort: 'desc' } }
    );

    const contacts = res.data.contacts || [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      const email = c.email;
      if (!email) continue;
      total += 1;

      try {
        const full = await getContact(email);
        const attrs = full.attributes || {};

        if (attrs[attrName]) {
          skipped += 1;
          continue;
        }

        await markNotified(email, attrName, markTime);
        updated += 1;
        console.log(`   ✅ ${email}`);
        await new Promise(r => setTimeout(r, 120));
      } catch (err) {
        console.error(`   ❌ ${email}:`, err.response?.data || err.message);
      }
    }

    offset += limit;
    if (contacts.length < limit) break;
    await new Promise(r => setTimeout(r, 120));
  }

  console.log(`   Summary: ${total} total, ${updated} marked, ${skipped} already marked`);
}

async function main() {
  console.log('🚀 Starting one-time NOTIFIED_LIST backfill...');

  for (const rule of LIST_RULES) {
    await backfillList(rule);
  }

  console.log('\n✅ Backfill complete.');
}

main().catch(err => {
  console.error('❌ Backfill failed:', err.response?.data || err.message);
  process.exit(1);
});
