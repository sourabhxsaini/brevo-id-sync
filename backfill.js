require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;

if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY is missing!');
  process.exit(1);
}

const headers = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

async function getAllContacts() {
  let allContacts = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    console.log(`📥 Fetching contacts ${offset} to ${offset + limit}...`);

    const res = await axios.get('https://api.brevo.com/v3/contacts', {
      headers,
      params: { limit, offset, sort: 'desc' }
    });

    const contacts = res.data.contacts || [];
    if (contacts.length === 0) break;

    allContacts = allContacts.concat(contacts);
    offset += limit;

    if (contacts.length < limit) break; // last page
  }

  return allContacts;
}

async function backfill() {
  console.log('🚀 Starting backfill of BREVO_ID for all contacts...\n');

  const contacts = await getAllContacts();
  console.log(`\n📊 Total contacts found: ${contacts.length}\n`);

  let updated = 0;
  let skipped = 0;
  let failed  = 0;

  for (const contact of contacts) {
    const { id, email, attributes } = contact;

    // Skip if already has BREVO_ID
    if (attributes?.BREVO_ID) {
      skipped++;
      continue;
    }

    try {
      await axios.put(
        `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
        { attributes: { BREVO_ID: String(id) } },
        { headers }
      );
      console.log(`✅ ${email} → BREVO_ID: ${id}`);
      updated++;

      // Small delay to avoid hitting API rate limits
      await new Promise(r => setTimeout(r, 100));

    } catch (err) {
      console.error(`❌ Failed for ${email}:`, err.response?.data || err.message);
      failed++;
    }
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Updated : ${updated}
⏭️  Skipped : ${skipped} (already had BREVO_ID)
❌ Failed  : ${failed}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 Backfill complete!
  `);
}

backfill().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
