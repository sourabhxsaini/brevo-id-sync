require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY  = process.env.BREVO_API_KEY;
const SENDER_EMAIL   = process.env.SEQUENCE_SENDER_EMAIL || process.env.SENDER_EMAIL;
const SENDER_NAME    = process.env.SEQUENCE_SENDER_NAME || 'Scott Head';

if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY is missing!');
  process.exit(1);
}

const BREVO_HEADERS = {
  'api-key': BREVO_API_KEY,
  'Content-Type': 'application/json'
};

// ─────────────────────────────────────────
// Sequence config — List 51 → 5 emails
// ─────────────────────────────────────────
const SEQUENCE_CONFIG = {
  listId: 49,
  name: 'Signup Sequence',
  steps: [
    { stage: 1, templateId: 95, delayDays: 0  }, // Day 1  — send immediately
    { stage: 2, templateId: 94, delayDays: 3  }, // Day 4  — 3 days after stage 1
    { stage: 3, templateId: 93, delayDays: 5  }, // Day 9  — 5 days after stage 2
    { stage: 4, templateId: 92, delayDays: 8  }, // Day 17 — 8 days after stage 3
    { stage: 5, templateId: 91, delayDays: 8  }, // Day 25 — 8 days after stage 4
  ]
};

const POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes
const TEST_EMAIL = process.env.TEST_EMAIL || 'kuldeepk@uxarmy.com'; // sends all emails immediately
let lastChecked = new Date(Date.now() - POLL_INTERVAL_MS).toISOString();

// ─────────────────────────────────────────
// Get full contact details
// ─────────────────────────────────────────
async function getContact(email) {
  const res = await axios.get(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
    { headers: BREVO_HEADERS }
  );
  return res.data;
}

// ─────────────────────────────────────────
// Update contact sequence attributes
// ─────────────────────────────────────────
async function updateSequenceAttrs(email, stage, nextSendDate, listId) {
  await axios.put(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`,
    {
      attributes: {
        SEQ_STAGE:     String(stage),
        SEQ_NEXT_SEND: nextSendDate,
        SEQ_LIST_ID:   String(listId)
      }
    },
    { headers: BREVO_HEADERS }
  );
}

// ─────────────────────────────────────────
// Send sequence email
// ─────────────────────────────────────────
async function sendSequenceEmail(contact, templateId, stage) {
  const { email, attributes, id } = contact;

  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
        subject: 'Reg. your user research',
      to: [{ email }],
      templateId,
      params: {
        FIRSTNAME:   attributes?.FIRSTNAME || '',
        LASTNAME:    attributes?.LASTNAME  || '',
        EMAIL:       email                 || '',
        CONTACT_URL: `https://app.brevo.com/contact/index/${id}`
      }
    },
    { headers: BREVO_HEADERS }
  );

  console.log(`   📧 Stage ${stage} sent → ${email} (Template ${templateId})`);
}

// ─────────────────────────────────────────
// Add days to a date
// ─────────────────────────────────────────
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ─────────────────────────────────────────
// SYNC 1: New contacts added to list → start sequence
// ─────────────────────────────────────────
async function startNewSequences() {
  const { listId, name, steps } = SEQUENCE_CONFIG;
  const since = lastChecked;

  let newContacts = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await axios.get(
      `https://api.brevo.com/v3/contacts/lists/${listId}/contacts`,
      { headers: BREVO_HEADERS, params: { limit, offset, sort: 'desc' } }
    );

    const contacts = res.data.contacts || [];
    if (contacts.length === 0) break;

    // New = added recently OR not yet in sequence
    for (const c of contacts) {
      const isRecent = new Date(c.modifiedAt || c.createdAt) >= new Date(since);
      if (isRecent) newContacts.push(c);
    }

    // Stop paginating if all contacts on this page are older than since
    const allOld = contacts.every(c =>
      new Date(c.modifiedAt || c.createdAt) < new Date(since)
    );
    if (allOld) break;
    offset += limit;
    if (contacts.length < limit) break;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`   List "${name}" (${listId}): ${newContacts.length} new contact(s) to start sequence`);

  for (const contact of newContacts) {
    const { email } = contact;
    if (!email) continue;

    try {
      const full = await getContact(email);
      const attrs = full.attributes || {};

      // Skip if already in a sequence
      if (attrs.SEQ_STAGE && attrs.SEQ_LIST_ID === String(listId)) {
        console.log(`   ⏭️  ${email} already in sequence (stage ${attrs.SEQ_STAGE})`);
        continue;
      }

      // TEST MODE: send all emails immediately
      if (email.toLowerCase() === TEST_EMAIL.toLowerCase()) {
        console.log(`   🧪 TEST MODE: sending all ${steps.length} emails immediately for ${email}`);
        for (const step of steps) {
          await sendSequenceEmail({ ...full, email }, step.templateId, step.stage);
          await new Promise(r => setTimeout(r, 500));
        }
        await updateSequenceAttrs(email, 'DONE', '', listId);
        console.log(`   ✅ TEST complete for ${email} — all ${steps.length} emails sent`);
        continue;
      }

      const firstStep = steps[0];

      // Send first email immediately
      await sendSequenceEmail({ ...full, email }, firstStep.templateId, firstStep.stage);

      // Set next send date for stage 2
      const nextStep = steps[1];
      const nextSendDate = addDays(new Date(), nextStep.delayDays);

      // Update sequence attributes
      await updateSequenceAttrs(email, firstStep.stage, nextSendDate, listId);

      console.log(`   ✅ ${email} → Stage 1 sent, Stage 2 scheduled for ${nextSendDate.split('T')[0]}`);
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.error(`   ❌ ${email}:`, err.response?.data || err.message);
    }
  }
}

// ─────────────────────────────────────────
// SYNC 2: Check existing contacts due for next email
// Uses Brevo search to find only contacts in sequence
// ─────────────────────────────────────────
async function processSequenceQueue() {
  const { listId, steps } = SEQUENCE_CONFIG;
  const now = new Date();
  const dueContacts = [];

  try {
    // Fetch contacts from the sequence list and check who is due
    let offset = 0;
    const limit = 100;

    while (true) {
      const res = await axios.get(
        `https://api.brevo.com/v3/contacts/lists/${listId}/contacts`,
        { headers: BREVO_HEADERS, params: { limit, offset, sort: 'desc' } }
      );

      const contacts = res.data.contacts || [];
      if (contacts.length === 0) break;

      for (const c of contacts) {
        if (!c.email) continue;
        try {
          const full = await getContact(c.email);
          const attrs = full.attributes || {};
          const stage     = parseInt(attrs.SEQ_STAGE);
          const nextSend  = attrs.SEQ_NEXT_SEND;
          const seqListId = attrs.SEQ_LIST_ID;

          if (!stage || attrs.SEQ_STAGE === 'DONE' || seqListId !== String(listId)) continue;
          if (nextSend && new Date(nextSend) <= now) {
            dueContacts.push({ ...full, email: c.email, currentStage: stage });
          }
          await new Promise(r => setTimeout(r, 80));
        } catch (err) { /* skip */ }
      }

      offset += limit;
      if (contacts.length < limit) break;
      await new Promise(r => setTimeout(r, 100));
    }
  } catch (err) {
    console.log('   ⚠️  Queue check skipped:', err.message);
  }

  console.log(`   Sequence queue: ${dueContacts.length} contact(s) due for next email`);

  for (const contact of dueContacts) {
    const { email, currentStage } = contact;

    const nextStageIndex = steps.findIndex(s => s.stage === currentStage + 1);

    if (nextStageIndex === -1) {
      // Sequence complete — clear attributes
      await updateSequenceAttrs(email, 'DONE', '', listId);
      console.log(`   🎉 ${email} → Sequence complete!`);
      continue;
    }

    const nextStep = steps[nextStageIndex];

    try {
      // Send next email
      await sendSequenceEmail(contact, nextStep.templateId, nextStep.stage);

      // Schedule the one after that (if exists)
      const afterNext = steps[nextStageIndex + 1];
      const nextSendDate = afterNext
        ? addDays(new Date(), afterNext.delayDays)
        : '';

      await updateSequenceAttrs(email, nextStep.stage, nextSendDate, listId);

      if (afterNext) {
        console.log(`   ✅ ${email} → Stage ${nextStep.stage} sent, Stage ${afterNext.stage} scheduled for ${nextSendDate.split('T')[0]}`);
      } else {
        console.log(`   ✅ ${email} → Stage ${nextStep.stage} sent (last email)`);
      }

      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.error(`   ❌ ${email}:`, err.response?.data || err.message);
    }
  }
}

// ─────────────────────────────────────────
// Main poll
// ─────────────────────────────────────────
async function poll() {
  try {
    console.log(`\n📬 [${new Date().toISOString()}] Sequence sync...`);
    await startNewSequences();
    await processSequenceQueue();
    lastChecked = new Date().toISOString();
  } catch (err) {
    console.error('❌ Sequence poll error:', err.response?.data || err.message);
  }
}

async function main() {
  console.log('🚀 Email Sequence started');
  console.log('   List 51 (Platform Signup) → 5 emails over 25 days');
  console.log('   Day 1 → Day 4 → Day 9 → Day 17 → Day 25\n');

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main();
