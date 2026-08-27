import { Router } from "express";
import { authLimiter } from "../middleware/rateLimiter.js";
import { requireAuth } from "../middleware/auth.js";
import {
  register,
  login,
  guestAuth,
  connectGithubToken,
  tokenLogin,
  getMe,
  logout,
} from "../controllers/authController.js";

const router = Router();

router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/guest", authLimiter, guestAuth);
router.post("/connect-github", authLimiter, requireAuth, connectGithubToken);
router.post("/token-login", authLimiter, tokenLogin);
router.get("/me", requireAuth, getMe);
router.post("/logout", requireAuth, logout);

export default router;
