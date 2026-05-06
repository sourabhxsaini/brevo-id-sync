require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

const headers = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

// Track last checked time
let lastChecked = new Date(Date.now() - POLL_INTERVAL_MS).toISOString();

async function getRecentContacts() {
  try {
    const res = await axios.get('https://api.brevo.com/v3/contacts', {
      headers,
      params: {
        limit: 50,
        sort: 'desc', // newest first
        createdSince: lastChecked
      }
    });
    return res.data.contacts || [];
  } catch (err) {
    console.error('❌ Error fetching contacts:', err.response?.data || err.message);
    return [];
  }
}

async function updateContactBrEVOId(contact) {
  const { id, email, attributes } = contact;

  // Skip if BREVO_ID already set
  if (attributes?.BREVO_ID) {
    return;
  }

  try {
    await axios.put(
      `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
      {
        attributes: {
          BREVO_ID: String(id)
        }
      },
      { headers }
    );
    console.log(`✅ Updated BREVO_ID for ${email} → ${id}`);
  } catch (err) {
    console.error(`❌ Failed to update ${email}:`, err.response?.data || err.message);
  }
}

async function poll() {
  console.log(`🔍 Checking for new contacts since ${lastChecked}...`);

  const contacts = await getRecentContacts();

  if (contacts.length === 0) {
    console.log('   No new contacts found.');
  } else {
    console.log(`   Found ${contacts.length} contact(s). Processing...`);
    for (const contact of contacts) {
      await updateContactBrEVOId(contact);
    }
  }

  // Update last checked time
  lastChecked = new Date().toISOString();
}

async function main() {
  console.log('🚀 Brevo ID Sync started — polling every 2 minutes...');

  // Run immediately on start
  await poll();

  // Then run every 2 minutes
  setInterval(poll, POLL_INTERVAL_MS);
}

main();
