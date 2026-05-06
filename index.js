require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY is missing! Add it as an environment variable.');
  process.exit(1);
}

console.log('✅ BREVO_API_KEY found, starting...');

const headers = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

let lastChecked = new Date(Date.now() - POLL_INTERVAL_MS).toISOString();

async function getRecentContacts() {
  const res = await axios.get('https://api.brevo.com/v3/contacts', {
    headers,
    params: {
      limit: 50,
      sort: 'desc'
    }
  });
  return res.data.contacts || [];
}

async function updateBrevoId(contact) {
  const { id, email, attributes } = contact;

  // Skip if BREVO_ID already set
  if (attributes?.BREVO_ID) return;

  await axios.put(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
    { attributes: { BREVO_ID: String(id) } },
    { headers }
  );

  console.log(`✅ Updated BREVO_ID for ${email} → ${id}`);
}

async function poll() {
  try {
    console.log(`🔍 Checking contacts at ${new Date().toISOString()}...`);

    const contacts = await getRecentContacts();

    if (contacts.length === 0) {
      console.log('   No contacts found.');
      return;
    }

    // Filter only contacts created since last check
    const newContacts = contacts.filter(c => {
      return new Date(c.createdAt) >= new Date(lastChecked);
    });

    console.log(`   ${newContacts.length} new contact(s) since last check.`);

    for (const contact of newContacts) {
      try {
        await updateBrevoId(contact);
      } catch (err) {
        console.error(`❌ Failed for ${contact.email}:`, err.response?.data || err.message);
      }
    }

  } catch (err) {
    console.error('❌ Poll error:', err.response?.data || err.message);
  } finally {
    lastChecked = new Date().toISOString();
  }
}

async function main() {
  console.log('🚀 Brevo ID Sync started — polling every 2 minutes...');
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main();
