'use strict';
// Run the email reminder job once (e.g. from an external cron: `npm run reminders`).
const { runReminders } = require('../src/scheduler');

(await runReminders())
  .then((r) => { console.log('Reminder emails sent:', r); setTimeout(() => process.exit(0), 5000); }) // let SMTP sends flush
  .catch((e) => { console.error(e); process.exit(1); });
