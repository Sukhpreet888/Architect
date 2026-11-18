'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const B = require('../billing');
const S = require('../services');
const { PLANS, config } = require('../config');
const { requireAuth, requireOrg, perm } = require('../mw');
const { addDays, today, int } = require('../util');

router.get('/onboarding/workspace', requireAuth, (req, res) => {
  res.render('onboarding/workspace', { title: 'Create your workspace', form: { billing_email: req.user.email } });
});
router.post('/onboarding/workspace', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(422).render('onboarding/workspace', { title: 'Create your workspace', form: req.body, errors: ['Organisation name is required.'] });
  const orgId = await db.tx(async () => {
    const id = await db.insert('orgs', {
      name, phone: req.body.phone, address: req.body.address, currency: req.body.currency || 'INR',
      area_unit: req.body.area_unit || 'sqft', billing_email: req.body.billing_email || req.user.email,
      plan_status: 'trial', trial_ends_at: addDays(today(), config.trialDays),
    });
    await db.insert('memberships', { org_id: id, user_id: req.user.id, role: 'admin' }); // first user = Organisation Admin
    await S.ensureDefaultTemplate(id, req.user.id);
    return id;
  });
  req.session.orgId = orgId;
  await N.workspaceCreated(await db.get('SELECT * FROM orgs WHERE id = ?', orgId), req.user);
  req.flash('success', `Workspace created. Your ${config.trialDays}-day free trial is active.`);
  res.redirect('/onboarding/plan');
});

// ---- plan selection & checkout (shared by onboarding and billing upgrades)
router.get(['/onboarding/plan', '/billing/plans'], requireOrg, perm('billing'), (req, res) => {
  res.render('billing/plans', { title: 'Select a subscription plan', plans: Object.values(PLANS), onboarding: req.path.startsWith('/onboarding') });
});
router.get('/billing/checkout', requireOrg, perm('billing'), async (req, res) => {
  const plan = PLANS[req.query.plan];
  if (!plan) return res.redirect('/billing/plans');
  const usage = await S.orgUsage(req.org.id);
  res.render('billing/checkout', { title: `Checkout — ${plan.name}`, plan, usage, onboarding: req.query.onboarding === '1' });
});
router.post('/billing/checkout', requireOrg, perm('billing'), async (req, res) => {
  const plan = PLANS[req.body.plan];
  const onboarding = req.body.onboarding === '1';
  const fail = (msg) => { req.flash('error', msg); return res.redirect(`/billing/checkout?plan=${req.body.plan}${onboarding ? '&onboarding=1' : ''}`); };
  if (!plan) return fail('Choose a plan.');
  const usage = await S.orgUsage(req.org.id);
  const custom = { users: int(req.body.custom_users), projects: int(req.body.custom_projects), storageGb: int(req.body.custom_storage_gb) };
  const limits = S.orgLimits({ ...req.org, plan: plan.key, custom_users: custom.users, custom_projects: custom.projects, custom_storage_mb: custom.storageGb && custom.storageGb * 1024 });
  if (usage.users > limits.users || usage.projects > limits.projects) {
    return fail(`The ${plan.name} plan allows ${limits.users} users and ${limits.projects} active projects, but you currently use ${usage.users} users and ${usage.projects} projects.`);
  }
  let card;
  if (req.body.use_saved === '1' && req.org.card_last4) card = { last4: req.org.card_last4, brand: req.org.card_brand };
  else { card = B.parseCard(req.body); if (card.error) return fail(card.error); }
  const result = await B.activatePlan(req.org, plan.key, card, custom);
  const org = await db.get('SELECT * FROM orgs WHERE id = ?', req.org.id);
  if (!result.ok) {
    await N.paymentFailed(org, result.error);
    req.flash('error', `Subscription not activated: ${result.error} Retry the payment or choose another plan.`);
    return res.redirect(onboarding ? '/onboarding/plan' : '/billing/plans');
  }
  await N.subscriptionActivated(org);
  if (result.amount > 0) await N.billingReceipt(org, `${plan.name} plan — first month`, result.amount);
  req.flash('success', `${plan.name} plan activated${result.inTrial ? ' — billing starts when your trial ends' : ''}. New limits applied.`);
  res.redirect(onboarding ? '/dashboard' : '/billing');
});

router.post('/switch-org', requireAuth, async (req, res) => {
  const m = await db.get('SELECT * FROM memberships WHERE user_id = ? AND org_id = ? AND active = 1', req.user.id, req.body.org_id);
  if (m) req.session.orgId = m.org_id;
  res.redirect('/dashboard');
});

module.exports = router;
