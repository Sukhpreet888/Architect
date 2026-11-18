'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const B = require('../billing');
const S = require('../services');
const { PLANS, ADDONS } = require('../config');
const { requireOrg, perm } = require('../mw');
const { int } = require('../util');

router.use('/billing', requireOrg, perm('billing'));

router.get('/billing', (req, res) => {
  const org = req.org;
  res.render('billing/index', {
    title: 'Billing & subscription', plan: PLANS[org.plan], limits: S.orgLimits(org), usage: S.orgUsage(org.id),
    monthly: B.monthlyAmount(org), addons: Object.values(ADDONS),
    history: db.all('SELECT * FROM billing_events WHERE org_id = ? ORDER BY id DESC LIMIT 50', org.id),
  });
});

router.post('/billing/addon', (req, res) => {
  const r = B.buyAddon(req.org, req.body.addon, int(req.body.qty) || 1);
  if (!r.ok) { req.flash('error', r.error); return res.redirect('/billing'); }
  const org = db.get('SELECT * FROM orgs WHERE id = ?', req.org.id);
  if (org.plan_status === 'past_due') db.update('orgs', org.id, { plan_status: 'active' });
  N.billingReceipt(org, r.description, r.amount);
  req.flash('success', `${r.description} added. New limits applied.`);
  res.redirect('/billing');
});

router.post('/billing/payment-method', (req, res) => {
  const card = B.parseCard(req.body);
  if (card.error) { req.flash('error', card.error); return res.redirect('/billing'); }
  const check = B.provider.charge({ last4: card.last4, amount: 0 });
  if (!check.ok) { req.flash('error', check.error); return res.redirect('/billing'); }
  db.update('orgs', req.org.id, { card_last4: card.last4, card_brand: card.brand, billing_email: req.body.billing_email || req.org.billing_email });
  B.record(req.org.id, 'payment_method', `Payment method updated to ${card.brand} •••• ${card.last4}`, 0, 'ok');
  // retry a failed renewal straight away
  const org = db.get('SELECT * FROM orgs WHERE id = ?', req.org.id);
  if (org.plan_status === 'past_due') {
    const r = B.chargeRenewal(org);
    if (r.ok) { N.billingReceipt(org, 'Subscription renewal (retry)', r.amount); req.flash('success', 'Payment succeeded — subscription re-activated.'); }
    else { N.paymentFailed(org, r.error); req.flash('error', r.error); }
  } else req.flash('success', 'Payment method updated.');
  res.redirect('/billing');
});

router.post('/billing/cancel', (req, res) => {
  db.update('orgs', req.org.id, { plan_status: 'cancelled' });
  B.record(req.org.id, 'subscription', 'Subscription cancelled', 0, 'ok');
  N.paymentFailed(db.get('SELECT * FROM orgs WHERE id = ?', req.org.id), 'Your subscription was cancelled and the workspace is now read-only.');
  req.flash('success', 'Subscription cancelled. Choose a plan any time to re-activate.');
  res.redirect('/billing');
});

module.exports = router;
