require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

if (!BREVO_API_KEY || !HUBSPOT_API_KEY) {
  console.error('❌ Missing BREVO_API_KEY or HUBSPOT_API_KEY env vars!');
  process.exit(1);
}

const BREVO_HEADERS = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

const HUBSPOT_HEADERS = {
  'Authorization': `Bearer ${HUBSPOT_API_KEY}`,
  'Content-Type': 'application/json'
};

// Fetch company name from HubSpot by email
async function getCompanyFromHubSpot(email) {
  try {
    const res = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'email',
                operator: 'EQ',
                value: email
              }
            ]
          }
        ],
        properties: ['email', 'company']
      },
      { headers: HUBSPOT_HEADERS }
    );

    const results = res.data.results;
    if (!results || results.length === 0) return null;

    return results[0].properties?.company || null;

  } catch (err) {
    console.error(`[HubSpot] Error for ${email}:`, err.response?.data || err.message);
    return null;
  }
}

// Get ALL Brevo contacts
async function getAllBrevoContacts() {
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

    allContacts = allContacts.concat(contacts);

    offset += limit;
    if (contacts.length < limit) break;
  }

  return allContacts;
}

// Update COMPANYNAME on Brevo contact
async function updateBrevoCompany(email, companyName) {
  await axios.put(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
    { attributes: { COMPANYNAME: companyName } },
    { headers: BREVO_HEADERS }
  );
}

async function poll() {
  try {
    console.log(`\n🔍 [${new Date().toISOString()}] Checking contacts missing COMPANYNAME...`);

    const contacts = await getAllBrevoContacts();
    console.log(`   Found ${contacts.length} total contact(s) to process`);

    if (contacts.length === 0) return;

    let updated = 0;
    let notFound = 0;

    for (const contact of contacts) {
      const email = contact.email;
      if (!email) continue;

      // Get company from HubSpot
      const companyName = await getCompanyFromHubSpot(email);

      if (!companyName) {
        notFound++;
        continue;
      }

      // Update Brevo
      try {
        await updateBrevoCompany(email, companyName);
        console.log(`   ✅ ${email} → ${companyName}`);
        updated++;
      } catch (err) {
        console.error(`   ❌ Failed to update ${email}:`, err.response?.data || err.message);
      }

      // Small delay to respect API rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`   Done — Updated: ${updated} | Not in HubSpot: ${notFound}`);

  } catch (err) {
    console.error('❌ Poll error:', err.response?.data || err.message);
  }
}

async function main() {
  console.log('🚀 Brevo ↔ HubSpot Company Sync started — polling every 5 minutes...');
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main();
