'use strict';
const { config } = require('./src/config');
const app = require('./src/app');
const scheduler = require('./src/scheduler');

app.listen(config.port, () => {
  console.log(`ARCHFLOW running at ${config.appUrl} (port ${config.port})`);
  console.log(config.mail.host ? `Email: SMTP ${config.mail.host}:${config.mail.port}` : 'Email: SMTP not configured — emails are recorded in the Email log only');
  scheduler.start();
});
