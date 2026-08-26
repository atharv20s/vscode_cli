/**
 * Structured Logging with Winston
 *
 * JSON-formatted logs with request correlation IDs.
 */

import winston from "winston";
import { config } from "./env.js";

const { combine, timestamp, printf, colorize, json } = winston.format;

// Pretty format for development
const devFormat = combine(
  colorize(),
  timestamp({ format: "HH:mm:ss" }),
  printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

// Structured JSON format for production
const prodFormat = combine(timestamp(), json());

export const logger = winston.createLogger({
  level: config.isDev ? "debug" : "info",
  format: config.isDev ? devFormat : prodFormat,
  transports: [new winston.transports.Console()],
});
