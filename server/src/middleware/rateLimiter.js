import rateLimit from "express-rate-limit";

/**
 * Relaxed rate limiters for smooth development and multi-user testing.
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000, // High ceiling
  standardHeaders: true,
  legacyHeaders: false,
});

export const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

export const githubLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000, // Relaxed from 10 to 1000
  standardHeaders: true,
  legacyHeaders: false,
});
