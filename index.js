require('dotenv').config();
const path = require('path');
const { createHttpClient, formatHttpError } = require('./lib/http-client');
const { loadState, saveState } = require('./lib/runtime-state');
const { mapWithConcurrency } = require('./lib/async-pool');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL;
const SENDER_EMAIL  = process.env.SENDER_EMAIL;

const LIST_RULES = [
  { listId: 41, templateId: 86, name: 'Global Leads' },
  { listId: 42, templateId: 87, name: 'Enterprise Leads' },
  { listId: 46, templateId: 89, name: 'Korean Leads' },
  { listId: 40, templateId: 88, name: 'Japanese Leads' },
  { listId: 38, templateId: 90, name: 'WhatsApp Reachout Leads' },
  { listId: 55, templateId: 96, name: 'Participants Recruitment Leads' },
  { listId: 51, templateId: 97, name: 'Platform Signup Leads' },
];

// ─────────────────────────────────────────
// Category field maps (index → label)
// Brevo stores category fields as numeric indexes internally
// ─────────────────────────────────────────
const UXA_SOURCE_MAP = {
  1: 'Platform Signup',
  2: 'Demo Form',
};

const PLAN_NAME_MAP = {
  1: 'Free',
  2: 'Starter',
  3: 'Pro',
  4: 'Enterprise',
};

const PAYMENT_RECURRING_TYPE_MAP = {
  1: 'Free',
  2: 'Monthly',
  3: 'Annual',
};

function resolveCategory(map, value) {
  if (!value && value !== 0) return '';
  return map[value] || String(value);
}

if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY is missing!');
  process.exit(1);
}

if (!NOTIFY_EMAIL || !SENDER_EMAIL) {
  console.error('❌ NOTIFY_EMAIL or SENDER_EMAIL is missing!');
  process.exit(1);
}

console.log('✅ BREVO_API_KEY found, starting...');

const BREVO_HEADERS = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

const http = createHttpClient(BREVO_HEADERS);

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const WORKER_CONCURRENCY = Number(process.env.SYNC_WORKER_CONCURRENCY || 4);
const STATE_PATH = path.join(__dirname, '.runtime', 'index-state.json');
const DEFAULT_SINCE = new Date(Date.now() - POLL_INTERVAL_MS).toISOString();

const state = loadState(STATE_PATH, {
  lastCheckedAllContacts: DEFAULT_SINCE,
  lastCheckedMap: {}
});

// Track last checked time per list to avoid mixing polls
const lastCheckedMap = {};
LIST_RULES.forEach(r => {
  lastCheckedMap[r.listId] = state.lastCheckedMap[r.listId] || DEFAULT_SINCE;
});
let lastCheckedAllContacts = state.lastCheckedAllContacts || DEFAULT_SINCE;
let isPolling = false;

function toDateOnly(isoValue) {
  return String(isoValue || '').split('T')[0];
}

async function markNotifiedWithFallback(email, attrName, isoValue) {
  try {
    await http.put(
      `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
      { attributes: { [attrName]: isoValue } }
    );
    return;
  } catch (err) {
    if (err?.response?.status !== 400) {
      throw err;
    }
  }

  const dateOnly = toDateOnly(isoValue);
  await http.put(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
    { attributes: { [attrName]: dateOnly } }
  );
  console.log(`   ℹ️  ${email} ${attrName} saved as date-only (${dateOnly})`);
}

// ─────────────────────────────────────────
// SYNC 1: All new contacts → BREVO_ID + SMS
// ─────────────────────────────────────────
async function syncAllNewContacts(since) {

  let allContacts = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await http.get('https://api.brevo.com/v3/contacts', {
      params: { limit, offset, sort: 'desc' }
    });

    const contacts = res.data.contacts || [];
    if (contacts.length === 0) break;

    const recent = contacts.filter(c => new Date(c.createdAt) >= new Date(since));
    allContacts = allContacts.concat(recent);

    if (recent.length < contacts.length) break;
    offset += limit;
    if (contacts.length < limit) break;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`   BREVO_ID+SMS: ${allContacts.length} new contact(s)`);

  let failedCount = 0;
  const workerResults = await mapWithConcurrency(allContacts, WORKER_CONCURRENCY, async (contact) => {
    const { id, email, attributes } = contact;
    if (!email) return;

    const updates = {};
    if (!attributes?.BREVO_ID) updates.BREVO_ID = String(id);

    const sms = attributes?.SMS;
    if (sms) {
      if (attributes?.MOBILEPHONENUMBER !== sms) updates.MOBILEPHONENUMBER = sms;
      if (attributes?.WHATSAPP !== sms)          updates.WHATSAPP = sms;
      if (attributes?.PHONENUMBER !== sms)        updates.PHONENUMBER = sms;
    }

    if (Object.keys(updates).length === 0) return;

    try {
      await http.put(
        `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
        { attributes: updates }
      );
      console.log(`   ✅ ${email} → ${JSON.stringify(updates)}`);
      await new Promise(r => setTimeout(r, 80));
      return { ok: true };
    } catch (err) {
      failedCount += 1;
      console.error(`   ❌ ${formatHttpError(`syncAllNewContacts:${email}`, err)}`);
      return { ok: false, email };
    }
  });

  const thrownFailures = workerResults.filter(r => r && r.error).length;
  return failedCount + thrownFailures;
}

// ─────────────────────────────────────────
// SYNC 2: List-specific → Send email template
// ─────────────────────────────────────────
async function syncListEmails(sinceMap, pollStartedAt) {
  const successfulLists = [];

  for (const rule of LIST_RULES) {
    const { listId, templateId, name } = rule;
    const notifiedAttr = `NOTIFIED_LIST_${listId}`;
    const since = sinceMap[listId] || DEFAULT_SINCE;

    let newContacts = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const res = await http.get(
        `https://api.brevo.com/v3/contacts/lists/${listId}/contacts`,
        { params: { limit, offset, sort: 'desc' } }
      );

      const contacts = res.data.contacts || [];
      if (contacts.length === 0) break;

      const recent = contacts.filter(c =>
        new Date(c.modifiedAt || c.createdAt) >= new Date(since)
      );
      newContacts.push(...recent);

      if (recent.length < contacts.length) break;
      offset += limit;
      if (contacts.length < limit) break;
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`   List "${name}" (${listId}): ${newContacts.length} new contact(s) → Template ${templateId}`);

    try {
      let listFailures = 0;
      const workerResults = await mapWithConcurrency(newContacts, WORKER_CONCURRENCY, async (contact) => {
        const { email } = contact;
        if (!email) return { ok: true, skipped: true };

        try {
          // Fetch FULL contact details to get all attributes
          const fullRes = await http.get(
            `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`
          );
          const full   = fullRes.data;
          const attrs  = full.attributes || {};
          const fullId = full.id;

          // Deduplicate per list: once notified for this list, skip forever.
          if (attrs[notifiedAttr]) {
            console.log(`   ⏭️  Skip ${email} — already notified for list ${listId}`);
            return { ok: true, skipped: true };
          }

          await http.post(
            'https://api.brevo.com/v3/smtp/email',
            {
              sender: { name: 'UXArmy', email: SENDER_EMAIL },
              to: [{ name: 'Kuldeep', email: NOTIFY_EMAIL }],
              templateId,
              params: {
                FIRSTNAME:              attrs.FIRSTNAME || '',
                LASTNAME:               attrs.LASTNAME  || '',
                EMAIL:                  email           || '',
                PHONE:                  attrs.SMS || attrs.MOBILEPHONENUMBER || '',
                MESSAGE:                attrs.ADDITIONAL_NOTES || '',
                CONTACT_URL:            `https://app.brevo.com/contact/index/${fullId}`,
                // Resolved from category indexes → human-readable labels
                UXA_SOURCE:             resolveCategory(UXA_SOURCE_MAP,             attrs.UXA_SOURCE),
                PLAN_NAME:              resolveCategory(PLAN_NAME_MAP,              attrs.PLAN_NAME),
                PAYMENT_RECURRING_TYPE: resolveCategory(PAYMENT_RECURRING_TYPE_MAP, attrs.PAYMENT_RECURRING_TYPE),
              }
            },
            { __retryable: false }
          );

          await markNotifiedWithFallback(email, notifiedAttr, pollStartedAt);

          console.log(`   📧 Email sent for ${email} → ${attrs.FIRSTNAME} ${attrs.LASTNAME}`);
          await new Promise(r => setTimeout(r, 150));
          return { ok: true };

        } catch (err) {
          listFailures += 1;
          console.error(`   ❌ ${formatHttpError(`syncListEmails:list${listId}:${email}`, err)}`);
          return { ok: false, email };
        }
      });

      const thrownFailures = workerResults.filter(r => r && r.error).length;
      const totalFailures = listFailures + thrownFailures;

      if (totalFailures === 0) {
        successfulLists.push(listId);
      } else {
        console.log(`   ⚠️  List ${listId} checkpoint not advanced (${totalFailures} failed contact(s))`);
      }
    } catch (err) {
      console.error(`   ❌ ${formatHttpError(`syncListEmails:list${listId}`, err)}`);
    }
  }

  return successfulLists;
}

// ─────────────────────────────────────────
// Main poll
// ─────────────────────────────────────────
async function poll() {
  if (isPolling) {
    console.log('   ⏳ Previous poll still running, skipping this cycle.');
    return;
  }

  isPolling = true;
  try {
    console.log(`\n⚡ [${new Date().toISOString()}] Polling...`);
    const pollStartedAt = new Date().toISOString();
    const sinceAll = lastCheckedAllContacts;
    const sinceMapSnapshot = { ...lastCheckedMap };

    const allContactsFailures = await syncAllNewContacts(sinceAll);
    if (allContactsFailures === 0) {
      lastCheckedAllContacts = pollStartedAt;
    } else {
      console.log(`   ⚠️  All-contacts checkpoint not advanced (${allContactsFailures} failed update(s))`);
    }

    const successfulLists = await syncListEmails(sinceMapSnapshot, pollStartedAt);
    for (const listId of successfulLists) {
      lastCheckedMap[listId] = pollStartedAt;
    }

    saveState(STATE_PATH, {
      lastCheckedAllContacts,
      lastCheckedMap,
    });
  } catch (err) {
    console.error(`❌ ${formatHttpError('poll', err)}`);
  } finally {
    isPolling = false;
  }
}

function scheduleNextPoll() {
  setTimeout(async () => {
    await poll();
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

async function main() {
  console.log('🚀 Brevo Sync started');
  console.log('   ⚡ BREVO_ID + SMS: all new contacts every 2 min');
  console.log('   📧 Email alerts:  list-specific every 2 min');
  LIST_RULES.forEach(r => console.log(`      → List ${r.listId} (${r.name}) → Template ${r.templateId}`));
  console.log();

  await poll();
  scheduleNextPoll();
}

main();
