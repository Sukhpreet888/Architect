'use strict';
// Run the email reminder job once (e.g. from an external cron: `npm run reminders`).
const { runReminders } = require('../src/scheduler');
const r = runReminders();
console.log('Reminder emails sent:', r);
setTimeout(() => process.exit(0), 3000); // allow SMTP sends to flush
