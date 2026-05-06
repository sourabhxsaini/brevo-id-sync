require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;

if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY is missing!');
  process.exit(1);
}

console.log('✅ BREVO_API_KEY found, starting...');

const BREVO_HEADERS = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

const POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

let lastChecked = new Date(Date.now() - POLL_INTERVAL_MS).toISOString();

async function getRecentContacts() {
  let allContacts = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await axios.get('https://api.brevo.com/v3/contacts', {
      headers: BREVO_HEADERS,
      params: { limit, offset, sort: 'desc' }
    });

    const contacts = res.data.contacts || [];
    if (contacts.length === 0) break;

    const recent = contacts.filter(c => new Date(c.createdAt) >= new Date(lastChecked));
    allContacts = allContacts.concat(recent);

    // Stop if we've gone past the lastChecked window
    if (recent.length < contacts.length) break;

    offset += limit;
    if (contacts.length < limit) break;
    await new Promise(r => setTimeout(r, 100));
  }

  return allContacts;
}

async function poll() {
  try {
    console.log(`\n⚡ [${new Date().toISOString()}] Checking for new contacts...`);

    const contacts = await getRecentContacts();
    console.log(`   ${contacts.length} new contact(s) found`);

    if (contacts.length === 0) return;

    let updated = 0;

    for (const contact of contacts) {
      const { id, email, attributes } = contact;
      if (!email) continue;

      const updates = {};

      // Copy BREVO_ID if missing
      if (!attributes?.BREVO_ID) {
        updates.BREVO_ID = String(id);
      }

      // Copy SMS → all phone fields
      const sms = attributes?.SMS;
      if (sms) {
        if (attributes?.MOBILEPHONENUMBER !== sms) updates.MOBILEPHONENUMBER = sms;
        if (attributes?.WHATSAPP !== sms)          updates.WHATSAPP = sms;
        if (attributes?.PHONENUMBER !== sms)        updates.PHONENUMBER = sms;
      }

      if (Object.keys(updates).length === 0) continue;

      try {
        await axios.put(
          `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
          { attributes: updates },
          { headers: BREVO_HEADERS }
        );
        console.log(`   ✅ ${email} → ${JSON.stringify(updates)}`);
        updated++;
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`   ❌ ${email}:`, err.response?.data || err.message);
      }
    }

    console.log(`   Done — ${updated} contact(s) updated`);
    lastChecked = new Date().toISOString();

  } catch (err) {
    console.error('❌ Poll error:', err.response?.data || err.message);
  }
}

async function main() {
  console.log('🚀 Brevo Sync started');
  console.log('   ⚡ Syncing BREVO_ID + SMS fields every 2 minutes\n');

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main();
