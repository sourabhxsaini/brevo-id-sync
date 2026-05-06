# Brevo ID Sync

Polls Brevo every 2 minutes for new contacts and copies their contact ID into the `BREVO_ID` attribute.

## Setup

1. Create a `BREVO_ID` attribute in Brevo:
   - Go to **Contacts → Settings → Contact Attributes**
   - Add new attribute: Name `BREVO_ID`, Type `Text`

2. Add env var:
BREVO_API_KEY=your_key_here

3. Deploy to Railway:
- Push to GitHub
- Connect repo on railway.app
- Add BREVO_API_KEY env var
- Deploy

## Email template usage

Once running, use this in your Brevo email template CTA:
https://app.brevo.com/contact/index/{{ contact.BREVO_ID }}
