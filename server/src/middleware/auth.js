/**
 * JWT Authentication Middleware
 *
 * Extracts and verifies JSON Web Tokens from the Authorization header.
 * Attaches decoded user payload to req.user.
 */

import jwt from "jsonwebtoken";
import { config } from "../config/env.js";

const REFRESH_SECRET = (config.jwtSecret || "dev-secret") + "_refresh";

/**
 * Generate a short-lived Access Token (15 minutes).
 */
export function generateAccessToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "15m" });
}

/**
 * Generate a long-lived Refresh Token (30 days).
 */
export function generateRefreshToken(payload) {
  return jwt.sign(
    { id: payload.id, username: payload.username, sessionId: payload.sessionId, type: "refresh" },
    REFRESH_SECRET,
    { expiresIn: "30d" }
  );
}

/**
 * Generate an Access Token and Refresh Token pair.
 */
export function generateTokenPair(payload) {
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
    expiresIn: 900, // 15 mins in seconds
    tokenType: "Bearer",
  };
}

/**
 * Verify a Refresh Token.
 */
export function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, REFRESH_SECRET);
    if (decoded.type !== "refresh") return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Legacy single JWT generator (backwards-compatible alias).
 */
export function generateToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

/**
 * Verify and decode an Access JWT.
 * @param {string} token - The JWT to verify
 * @returns {object | null} Decoded payload or null
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/**
 * Required auth middleware — rejects unauthenticated requests.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Missing or invalid Authorization header. Expected: Bearer <token>",
    });
  }

  const token = authHeader.slice(7);
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token.",
    });
  }

  req.user = decoded;
  next();
}

/**
 * Optional auth middleware — attaches user if token present, but doesn't reject.
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const decoded = verifyToken(token);
    if (decoded) {
      req.user = decoded;
    }
  }

  next();
}
