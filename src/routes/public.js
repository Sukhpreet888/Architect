'use strict';
const router = require('express').Router();
const { PLANS } = require('../config');

router.get('/', (req, res) => {
  if (req.user && req.user.email_verified) return res.redirect('/dashboard');
  res.render('landing', { title: 'ARCHFLOW — Architecture practice management', plans: Object.values(PLANS) });
});

module.exports = router;
