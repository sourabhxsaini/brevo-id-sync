require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL;
const SENDER_EMAIL  = process.env.SENDER_EMAIL;

// List → Template mapping for email notifications
const LIST_RULES = [
  { listId: 41, templateId: 86, name: 'Global Leads' },
  { listId: 42, templateId: 87, name: 'Enterprise Leads' },
  { listId: 46, templateId: 89, name: 'Korean Leads' },
  { listId: 40, templateId: 88, name: 'Japanese Leads' },
  { listId: 38, templateId: 90, name: 'WhatsApp Reachout Leads' }
];

if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY is missing!');
  process.exit(1);
}

console.log('✅ BREVO_API_KEY found, starting...');

const BREVO_HEADERS = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

const POLL_INTERVAL_MS = 2 * 60 * 1000;
let lastChecked = new Date(Date.now() - POLL_INTERVAL_MS).toISOString();

// ─────────────────────────────────────────
// SYNC 1: All new contacts → BREVO_ID + SMS
// ─────────────────────────────────────────
async function syncAllNewContacts() {
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

    if (recent.length < contacts.length) break;
    offset += limit;
    if (contacts.length < limit) break;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`   BREVO_ID+SMS: ${allContacts.length} new contact(s)`);

  for (const contact of allContacts) {
    const { id, email, attributes } = contact;
    if (!email) continue;

    const updates = {};
    if (!attributes?.BREVO_ID) updates.BREVO_ID = String(id);

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
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.error(`   ❌ ${email}:`, err.response?.data || err.message);
    }
  }
}

// ─────────────────────────────────────────
// SYNC 2: Specific lists → Send email template
// ─────────────────────────────────────────
async function syncListEmails() {
  if (!NOTIFY_EMAIL || !SENDER_EMAIL) {
    console.log('   ⚠️  NOTIFY_EMAIL or SENDER_EMAIL not set — skipping email sync');
    return;
  }

  for (const rule of LIST_RULES) {
    const { listId, templateId, name } = rule;

    // Fetch contacts recently added to this list
    let offset = 0;
    const limit = 100;
    const newContacts = [];

    while (true) {
      const res = await axios.get(
        `https://api.brevo.com/v3/contacts/lists/${listId}/contacts`,
        { headers: BREVO_HEADERS, params: { limit, offset, sort: 'desc' } }
      );

      const contacts = res.data.contacts || [];
      if (contacts.length === 0) break;

      const recent = contacts.filter(c =>
        new Date(c.modifiedAt || c.createdAt) >= new Date(lastChecked)
      );
      newContacts.push(...recent);

      if (recent.length < contacts.length) break;
      offset += limit;
      if (contacts.length < limit) break;
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`   List "${name}" (${listId}): ${newContacts.length} new contact(s) → Template ${templateId}`);

    for (const contact of newContacts) {
      const { id, email, attributes } = contact;
      if (!email) continue;

      try {
        await axios.post(
          'https://api.brevo.com/v3/smtp/email',
          {
            sender: { name: 'UXArmy', email: SENDER_EMAIL },
            to: [{ name: 'Kuldeep', email: NOTIFY_EMAIL }],
            templateId,
            params: {
              FIRSTNAME:   attributes?.FIRSTNAME        || '',
              LASTNAME:    attributes?.LASTNAME         || '',
              EMAIL:       email                        || '',
              PHONE:       attributes?.SMS              || attributes?.MOBILEPHONENUMBER || '',
              MESSAGE:     attributes?.ADDITIONAL_NOTES || '',
              CONTACT_URL: `https://app.brevo.com/contact/index/${id}`
            }
          },
          { headers: BREVO_HEADERS }
        );
        console.log(`   📧 Email sent for ${email}`);
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`   ❌ Email failed for ${email}:`, err.response?.data || err.message);
      }
    }
  }
}

// ─────────────────────────────────────────
// Main poll
// ─────────────────────────────────────────
async function poll() {
  try {
    console.log(`\n⚡ [${new Date().toISOString()}] Polling...`);

    // Run both independently
    await syncAllNewContacts();
    await syncListEmails();

    lastChecked = new Date().toISOString();

  } catch (err) {
    console.error('❌ Poll error:', err.response?.data || err.message);
  }
}

async function main() {
  console.log('🚀 Brevo Sync started');
  console.log('   ⚡ BREVO_ID + SMS: all new contacts every 2 min');
  console.log('   📧 Email alerts:  list-specific every 2 min');
  LIST_RULES.forEach(r => console.log(`      → List ${r.listId} (${r.name}) → Template ${r.templateId}`));
  console.log();

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main();
