// routes/payroll-config/index.js — mounts every domain sub-router.
// Each domain keeps its own file/table/logic (see individual files);
// this is purely wiring, not shared business logic.
const express = require('express');
const router = express.Router();

router.use('/legal-entities', require('./legal-entities'));
router.use('/jkk-risk-classes', require('./jkk-risk-classes'));
router.use('/rule-sets', require('./rule-sets'));
router.use('/holidays', require('./holidays'));
router.use('/work-patterns', require('./work-patterns'));
router.use('/employee-assignments', require('./employee-assignments'));
router.use('/salary', require('./salary-components'));
router.use('/work-calendars', require('./work-calendars'));

module.exports = router;
