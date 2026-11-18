'use strict';
const router = require('express').Router();
const db = require('../db');
const S = require('../services');
const R = require('../reports');
const { requireOrg, perm, loadProject, httpError } = require('../mw');
const { mapSeq } = require('../util');

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

router.get('/reports', perm('reports_view'), async (req, res) => {
  const projects = await mapSeq(await S.visibleProjects(req.org.id, req.user, req.role), async (p) => ({ ...p, prog: await S.phaseProgress(p.id) }));
  res.render('reports/index', { title: 'Reports & analytics', projects, pay: req.can('financial_reports') ? await S.paymentsSummary(req.org.id) : null });
});
router.get('/reports/organisation', perm('reports_view'), async (req, res) => await output(req, res, await R.orgReport(req.org), 'organisation-report'));
router.get('/reports/financial', perm('financial_reports'), async (req, res) => await output(req, res, await R.financialReport(req.org), 'financial-report'));
router.get('/reports/projects/:pid', loadProject, async (req, res) => await output(req, res, await R.projectReport(req.org, req.project), `project-${req.project.code}`));

module.exports = router;
