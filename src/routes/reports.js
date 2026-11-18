'use strict';
const router = require('express').Router();
const db = require('../db');
const S = require('../services');
const R = require('../reports');
const { requireOrg, perm, loadProject, httpError } = require('../mw');

router.use('/reports', requireOrg);

async function output(req, res, report, filename) {
  const f = req.query.format;
  if (f === 'xlsx') {
    const buf = await R.toXlsx(report);
    res.attachment(`${filename}.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
  } else if (f === 'pdf') {
    const buf = await R.toPdf(report);
    res.attachment(`${filename}.pdf`).type('application/pdf').send(buf);
  } else {
    res.render('reports/show', { title: report.title, report, exportBase: req.path });
  }
}

router.get('/reports', perm('reports_view'), (req, res) => {
  const projects = S.visibleProjects(req.org.id, req.user, req.role).map((p) => ({ ...p, prog: S.phaseProgress(p.id) }));
  res.render('reports/index', { title: 'Reports & analytics', projects, pay: req.can('financial_reports') ? S.paymentsSummary(req.org.id) : null });
});
router.get('/reports/organisation', perm('reports_view'), (req, res) => output(req, res, R.orgReport(req.org), 'organisation-report'));
router.get('/reports/financial', perm('financial_reports'), (req, res) => output(req, res, R.financialReport(req.org), 'financial-report'));
router.get('/reports/projects/:pid', loadProject, (req, res) => output(req, res, R.projectReport(req.org, req.project), `project-${req.project.code}`));

module.exports = router;
