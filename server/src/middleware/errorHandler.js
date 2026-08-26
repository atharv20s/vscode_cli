/**
 * Global Error Handler Middleware
 *
 * Catches all unhandled errors and returns structured JSON responses.
 * In development mode, includes stack traces.
 */

import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

/**
 * 404 handler — catches requests to undefined routes.
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.originalUrl} does not exist.`,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Global error handler — Express error middleware (4 args).
 */
export function errorHandler(err, req, res, _next) {
  // Default to 500 if no status code set
  const statusCode = err.statusCode || err.status || 500;

  // Log the error
  if (statusCode >= 500) {
    logger.error("Unhandled server error", {
      method: req.method,
      url: req.originalUrl,
      statusCode,
      message: err.message,
      stack: err.stack,
    });
  } else {
    logger.warn("Client error", {
      method: req.method,
      url: req.originalUrl,
      statusCode,
      message: err.message,
    });
  }

  const response = {
    error: err.name || "InternalServerError",
    message: err.message || "An unexpected error occurred.",
    statusCode,
    timestamp: new Date().toISOString(),
  };

  // Include stack trace in development
  if (config.isDev) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

/**
 * Create a custom HTTP error.
 * @param {number} statusCode
 * @param {string} message
 * @returns {Error}
 */
export function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.name = statusCode === 400 ? "BadRequest"
    : statusCode === 401 ? "Unauthorized"
    : statusCode === 403 ? "Forbidden"
    : statusCode === 404 ? "NotFound"
    : statusCode === 409 ? "Conflict"
    : statusCode === 429 ? "TooManyRequests"
    : "InternalServerError";
  return error;
}
