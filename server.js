'use strict';
const { config } = require('./src/config');
const db = require('./src/db');
const storage = require('./src/storage');
const app = require('./src/app');
const scheduler = require('./src/scheduler');

(async () => {
  await db.ready();
  await storage.ensureBucket();
  app.listen(config.port, () => {
    console.log(`ARCHFLOW running at ${config.appUrl} (port ${config.port})`);
    console.log(`Database: ${db.driver() === 'postgres' ? 'Supabase / PostgreSQL (DATABASE_URL)' : 'embedded local Postgres (set DATABASE_URL to use Supabase)'}`);
    console.log(`File storage: ${storage.useSupabase ? `Supabase Storage bucket "${config.supabase.bucket}"` : 'local disk'}`);
    console.log(config.mail.host ? `Email: SMTP ${config.mail.host}:${config.mail.port}` : 'Email: SMTP not configured — emails are recorded in the Email log only');
    scheduler.start();
  });
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
