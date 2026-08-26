/**
 * JWT Authentication Middleware
 *
 * Extracts and verifies JSON Web Tokens from the Authorization header.
 * Attaches decoded user payload to req.user.
 */

import jwt from "jsonwebtoken";
import { config } from "../config/env.js";

/**
 * Generate a JWT for a user.
 * @param {object} payload - User data to encode
 * @param {string} [expiresIn='7d'] - Token expiration
 * @returns {string} Signed JWT
 */
export function generateToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

/**
 * Verify and decode a JWT.
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
