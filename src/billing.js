'use strict';
/**
 * Subscription billing. Card processing is simulated through a small provider interface so a real
 * gateway (Stripe, Razorpay, ...) can be dropped in by replacing `provider.charge`.
 * Test cards: any 16 digits succeeds, except numbers ending in 0002 which are declined.
 */
const db = require('./db');
const { PLANS, ADDONS } = require('./config');
const { today, addDays } = require('./util');

const provider = {
  charge({ last4, amount }) {
    if (last4 === '0002') return { ok: false, error: 'Your card was declined.' };
    if (!(amount >= 0)) return { ok: false, error: 'Invalid amount.' };
    return { ok: true, id: `ch_${Date.now()}` };
  },
};

function monthlyAmount(org) {
  const plan = PLANS[org.plan];
  const base = plan && plan.price ? plan.price : 0;
  const addons = (org.extra_users || 0) * ADDONS.users.price
    + ((org.extra_projects || 0) / ADDONS.projects.unit) * ADDONS.projects.price
    + ((org.extra_storage_mb || 0) / ADDONS.storage.unit) * ADDONS.storage.price;
  return Math.round((base + addons) * 100) / 100;
}

function parseCard(body) {
  const digits = String(body.card_number || '').replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return { error: 'Enter a valid card number.' };
  if (!/^\d{2}\/\d{2}$/.test(String(body.card_expiry || '').trim())) return { error: 'Enter expiry as MM/YY.' };
  if (!/^\d{3,4}$/.test(String(body.card_cvc || '').trim())) return { error: 'Enter a valid CVC.' };
  const brand = digits.startsWith('4') ? 'Visa' : digits.startsWith('5') ? 'Mastercard' : digits.startsWith('3') ? 'Amex' : 'Card';
  return { last4: digits.slice(-4), brand };
}

async function record(orgId, kind, description, amount, status) {
  await db.insert('billing_events', { org_id: orgId, kind, description, amount, status });
}

const trialActive = (org) => org.plan_status === 'trial' && org.trial_ends_at >= today();

/**
 * Activate a plan.
 * - During the free trial a card is OPTIONAL: the plan is simply selected (a card, if given, is verified with a
 *   zero-amount authorisation). Billing starts when the trial ends, and the card is required then.
 * - After the trial a card is required and the first month is charged now.
 */
async function activatePlan(org, planKey, card, custom = {}) {
  const plan = PLANS[planKey];
  if (!plan) return { ok: false, error: 'Unknown plan.' };
  const inTrial = trialActive(org);
  if (!card && !inTrial) return { ok: false, error: 'Your free trial has ended — add a card to activate the plan.' };
  const draft = { ...org, plan: planKey };
  const amount = inTrial ? 0 : monthlyAmount(draft);
  if (card) {
    const res = provider.charge({ last4: card.last4, amount });
    if (!res.ok) { await record(org.id, 'payment', `${plan.name} plan activation`, amount, 'failed'); return { ok: false, error: res.error }; }
  }
  const update = {
    plan: planKey, ...(card ? { card_last4: card.last4, card_brand: card.brand } : {}),
    plan_status: inTrial ? 'trial' : 'active',
    next_billing_date: inTrial ? org.trial_ends_at : addDays(today(), 30),
  };
  if (planKey === 'enterprise') {
    update.custom_users = custom.users || 50; update.custom_projects = custom.projects || 200; update.custom_storage_mb = (custom.storageGb || 500) * 1024;
  }
  await db.update('orgs', org.id, update);
  await record(org.id, 'subscription', `${plan.name} plan ${inTrial ? (card ? 'selected (billing starts after trial)' : 'selected — add a card before the trial ends') : 'activated'}`, amount, 'paid');
  return { ok: true, amount, inTrial };
}

/** Charge the recurring amount for an org whose billing date has arrived. */
async function chargeRenewal(org) {
  const amount = monthlyAmount(org);
  const res = provider.charge({ last4: org.card_last4, amount });
  if (!res.ok) {
    await db.update('orgs', org.id, { plan_status: 'past_due' });
    await record(org.id, 'renewal', `${PLANS[org.plan].name} plan renewal`, amount, 'failed');
    return { ok: false, error: res.error, amount };
  }
  await db.update('orgs', org.id, { plan_status: 'active', next_billing_date: addDays(org.next_billing_date || today(), 30) });
  await record(org.id, 'renewal', `${PLANS[org.plan].name} plan — monthly subscription`, amount, 'paid');
  return { ok: true, amount };
}

async function buyAddon(org, key, qty) {
  const a = ADDONS[key];
  if (!a || !(qty >= 1)) return { ok: false, error: 'Invalid add-on.' };
  if (!org.card_last4) return { ok: false, error: 'Add a payment method first.' };
  const amount = a.price * qty;
  const res = provider.charge({ last4: org.card_last4, amount });
  if (!res.ok) { await record(org.id, 'addon', `${a.name} ×${qty}`, amount, 'failed'); return { ok: false, error: res.error }; }
  const col = key === 'users' ? 'extra_users' : key === 'projects' ? 'extra_projects' : 'extra_storage_mb';
  await db.run(`UPDATE orgs SET ${col} = ${col} + ? WHERE id = ?`, a.unit * qty, org.id);
  await record(org.id, 'addon', `${a.name} ${a.label} ×${qty} (monthly)`, amount, 'paid');
  return { ok: true, amount, description: `${a.name} ×${qty}` };
}

module.exports = { provider, trialActive, monthlyAmount, parseCard, activatePlan, chargeRenewal, buyAddon, record };
