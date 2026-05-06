require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY  = process.env.BREVO_API_KEY;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours (16k contacts is heavy)

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

// STEP 1: Fetch ALL HubSpot contacts and build email → company map
async function buildHubSpotCompanyMap() {
  const emailToCompany = {};
  let after = undefined;
  let page = 1;

  console.log('📥 Fetching all HubSpot contacts...');

  while (true) {
    const params = {
      limit: 100,
      properties: ['email', 'company'],
    };
    if (after) params.after = after;

    const res = await axios.get(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      { headers: HUBSPOT_HEADERS, params }
    );

    const results = res.data.results || [];

    for (const contact of results) {
      const email   = contact.properties?.email?.toLowerCase();
      const company = contact.properties?.company;
      if (email && company) {
        emailToCompany[email] = company;
      }
    }

    console.log(`   Page ${page} — ${results.length} contacts fetched (total mapped: ${Object.keys(emailToCompany).length})`);
    page++;

    after = res.data.paging?.next?.after;
    if (!after) break;

    // Small delay to respect HubSpot rate limits
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`✅ HubSpot map built — ${Object.keys(emailToCompany).length} contacts with company`);
  return emailToCompany;
}

// STEP 2: Fetch ALL Brevo contacts
async function getAllBrevoContacts() {
  let allContacts = [];
  let offset = 0;
  const limit = 100;
  let page = 1;

  console.log('📥 Fetching all Brevo contacts...');

  while (true) {
    const res = await axios.get('https://api.brevo.com/v3/contacts', {
      headers: BREVO_HEADERS,
      params: { limit, offset, sort: 'desc' }
    });

    const contacts = res.data.contacts || [];
    if (contacts.length === 0) break;

    allContacts = allContacts.concat(contacts);
    console.log(`   Page ${page} — ${contacts.length} contacts fetched (total: ${allContacts.length})`);
    page++;

    offset += limit;
    if (contacts.length < limit) break;

    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`✅ Brevo total contacts: ${allContacts.length}`);
  return allContacts;
}

// STEP 3: Update COMPANYNAME on Brevo contact
async function updateBrevoCompany(email, companyName) {
  await axios.put(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
    { attributes: { COMPANYNAME: companyName } },
    { headers: BREVO_HEADERS }
  );
}

async function poll() {
  try {
    console.log(`\n🚀 [${new Date().toISOString()}] Starting company sync...`);
    const startTime = Date.now();

    // Build HubSpot map first (bulk fetch)
    const hubspotMap = await buildHubSpotCompanyMap();

    // Fetch all Brevo contacts
    const brevoContacts = await getAllBrevoContacts();

    console.log(`\n🔄 Syncing company names...`);

    let updated  = 0;
    let skipped  = 0;
    let notFound = 0;
    let failed   = 0;

    for (const contact of brevoContacts) {
      const email = contact.email?.toLowerCase();
      if (!email) continue;

      const companyName = hubspotMap[email];

      if (!companyName) {
        notFound++;
        continue;
      }

      // Skip if already same value
      if (contact.attributes?.COMPANYNAME === companyName) {
        skipped++;
        continue;
      }

      try {
        await updateBrevoCompany(email, companyName);
        updated++;

        if (updated % 100 === 0) {
          console.log(`   ⏳ Progress: ${updated} updated so far...`);
        }

        // Respect Brevo rate limit: 10 RPS = 100ms delay
        await new Promise(r => setTimeout(r, 100));

      } catch (err) {
        console.error(`   ❌ Failed for ${email}:`, err.response?.data || err.message);
        failed++;
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Updated  : ${updated}
⏭️  Skipped  : ${skipped} (already up to date)
❓ Not found : ${notFound} (not in HubSpot)
❌ Failed   : ${failed}
⏱️  Duration : ${duration}s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

  } catch (err) {
    console.error('❌ Sync error:', err.response?.data || err.message);
  }
}

async function main() {
  console.log('🚀 Brevo ↔ HubSpot Company Sync started');
  console.log(`   Polling every ${POLL_INTERVAL_MS / 3600000} hours for 16k contacts\n`);
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main();
