const express = require('express');

const {protect} = require("../middleware/authMiddleware");

const {
    recommendExams , 
    discoverExams ,
    getExamById ,
    updateExamEligibility
} = require("../controllers/examController");

const router = express.Router();

router.get("/recommend" , protect , recommendExams);

// Discovery API (Phase 2.3). Registered before "/:id" so "discover"
// is not captured as an exam id.
router.get("/discover" , protect , discoverExams);

// Manual eligibility correction (operator only — same auth as reads).
// Registered before "/:id" so "eligibility" is not captured as an exam id.
router.patch("/:id/eligibility" , protect , updateExamEligibility);

router.get("/:id" , protect , getExamById);

module.exports = router;

