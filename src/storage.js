'use strict';
/**
 * File storage for documents/drawings and payment proofs.
 * - With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: files go to a PRIVATE Supabase Storage bucket and
 *   downloads use short-lived signed URLs (after ARCHFLOW's own permission checks).
 * - Otherwise: files stay on local disk in DATA_DIR/uploads.
 * Multer always writes the upload to a local temp file first; save() moves it to its final home.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const useSupabase = !!(config.supabase.url && config.supabase.serviceKey);
let client = null;
function sb() {
  if (!client) {
    const { createClient } = require('@supabase/supabase-js');
    client = createClient(config.supabase.url, config.supabase.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}
const local = (name) => path.join(config.uploadDir, path.basename(name));

let bucketReady = null;
function ensureBucket() {
  if (!useSupabase) return Promise.resolve();
  if (!bucketReady) {
    bucketReady = (async () => {
      const { data } = await sb().storage.getBucket(config.supabase.bucket);
      if (!data) {
        const { error } = await sb().storage.createBucket(config.supabase.bucket, { public: false, fileSizeLimit: '100MB' });
        if (error && !/already exists/i.test(error.message)) throw new Error(`Supabase Storage bucket: ${error.message}`);
      }
    })().catch((e) => { bucketReady = null; throw e; });
  }
  return bucketReady;
}

/** Persist a multer file; returns the stored name. */
async function save(file) {
  if (!useSupabase) return file.filename;
  await ensureBucket();
  const { error } = await sb().storage.from(config.supabase.bucket)
    .upload(file.filename, fs.createReadStream(file.path), { contentType: file.mimetype || 'application/octet-stream', duplex: 'half', upsert: false });
  fs.promises.unlink(file.path).catch(() => {});
  if (error) throw new Error(`Upload to Supabase Storage failed: ${error.message}`);
  return file.filename;
}

async function remove(name) {
  if (!name) return;
  if (useSupabase) { await sb().storage.from(config.supabase.bucket).remove([path.basename(name)]).catch(() => {}); return; }
  fs.promises.unlink(local(name)).catch(() => {});
}

/** Discard a temp upload that was rejected before save(). */
function discardTemp(file) { if (file && file.path) fs.promises.unlink(file.path).catch(() => {}); }

/** Send the file to the browser. Returns false if it does not exist. */
async function send(res, name, originalName) {
  if (useSupabase) {
    const { data, error } = await sb().storage.from(config.supabase.bucket).createSignedUrl(path.basename(name), 60, { download: originalName });
    if (error || !data) return false;
    res.redirect(data.signedUrl);
    return true;
  }
  if (!fs.existsSync(local(name))) return false;
  res.download(local(name), originalName);
  return true;
}

module.exports = { useSupabase, ensureBucket, save, remove, discardTemp, send };
