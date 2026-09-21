const express = require('express');

const {protect} = require("../middleware/authMiddleware");

const {
    recommendExams , 
    discoverExams ,
    getExamById
} = require("../controllers/examController");

const router = express.Router();

router.get("/recommend" , protect , recommendExams);

// Discovery API (Phase 2.3). Registered before "/:id" so "discover"
// is not captured as an exam id.
router.get("/discover" , protect , discoverExams);

router.get("/:id" , protect , getExamById);

module.exports = router;

