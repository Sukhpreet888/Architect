'use strict';
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { config } = require('./config');
const { token } = require('./util');
const S = require('./services');

const DOC_EXT = ['.pdf', '.dwg', '.dxf', '.jpg', '.jpeg', '.png', '.docx', '.xlsx', '.doc', '.xls', '.pptx', '.skp', '.rvt', '.ifc', '.zip', '.txt', '.csv', '.webp'];
const PROOF_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];

function make(exts) {
  return multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${token(8)}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = exts.includes(path.extname(file.originalname).toLowerCase());
      if (!ok) req.uploadError = `File type not allowed. Allowed: ${exts.join(', ')}`;
      cb(null, ok);
    },
  });
}

/** Wrap multer so errors become flash messages and the org storage limit is enforced. */
function single(field, exts = DOC_EXT) {
  const mw = make(exts).single(field);
  return (req, res, next) => mw(req, res, (err) => {
    if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 100 MB.' : err.message;
    if (req.file && req.org) {
      const usage = S.orgUsage(req.org.id); const limits = S.orgLimits(req.org);
      if (usage.storageBytes + req.file.size > limits.storageMb * 1048576) {
        removeFile(req.file.filename); req.file = undefined;
        req.uploadError = 'Storage limit reached for your plan. Upgrade or buy a storage add-on.';
        require('./notify').usageLimitReached(req.org, 'storage');
      }
    }
    next();
  });
}
function removeFile(name) { try { fs.unlinkSync(path.join(config.uploadDir, path.basename(name))); } catch { /* ignore */ } }
const filePath = (name) => path.join(config.uploadDir, path.basename(name));

module.exports = { single, removeFile, filePath, DOC_EXT, PROOF_EXT };
