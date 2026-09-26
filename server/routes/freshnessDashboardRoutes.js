const express = require("express");

const { protect } = require("../middleware/authMiddleware");
const { freshnessDashboardController } = require("../controllers/freshnessDashboardController");

const router = express.Router();

router.get("/", protect, freshnessDashboardController);

module.exports = router;
