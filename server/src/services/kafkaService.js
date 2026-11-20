/**
 * Kafka transport for durable ATH IDE domain events.
 * Redis remains responsible for leases, heartbeats and ephemeral fan-out.
 * PostgreSQL remains the source of truth for application/job state.
 */
import os from "node:os";
import { Kafka, Partitioners } from "kafkajs";
import { logger } from "../config/logger.js";

const MAX_EVENT_BYTES = 512 * 1024;

function isValidEvent(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.eventId === "string" && value.eventId.length > 0 && value.eventId.length <= 128 &&
    typeof value.type === "string" && value.type.length > 0 && value.type.length <= 128 &&
    typeof value.workspaceId === "string" && value.workspaceId.length > 0 &&
    Number.isFinite(value.timestamp) && value.payload && typeof value.payload === "object" && !Array.isArray(value.payload));
}

class KafkaService {
  constructor() {
    this.brokers = (process.env.KAFKA_BROKERS || "").split(",").map(value => value.trim()).filter(Boolean);
    this.clientId = process.env.KAFKA_CLIENT_ID || "ath-ide";
    this.topic = process.env.KAFKA_EVENT_TOPIC || "ath-ide.events";
    this.groupId = process.env.KAFKA_EVENT_GROUP_ID || "ath-ide-gateway-" + os.hostname();
    this.kafka = null;
    this.producer = null;
    this.consumer = null;
    this.isConnected = false;
    this.isConsumerRunning = false;
    this.onEvent = null;
    this.consumerRun = null;
  }

  async initialize({ onEvent } = {}) {
    if (this.isConnected) {
      if (onEvent) this.onEvent = onEvent;
      return true;
    }
    if (!this.brokers.length) {
      const error = new Error("KAFKA_BROKERS is required when Kafka transport is enabled.");
      if ((process.env.KAFKA_REQUIRED || "false").toLowerCase() === "true") throw error;
      logger.info("Kafka transport disabled: KAFKA_BROKERS is not configured.");
      return false;
    }

    this.onEvent = onEvent || this.onEvent;
    this.kafka = new Kafka({
      clientId: this.clientId,
      brokers: this.brokers,
      connectionTimeout: 5000,
      requestTimeout: 25000,
      retry: { initialRetryTime: 300, retries: 8 },
    });

    try {
      this.producer = this.kafka.producer({
        createPartitioner: Partitioners.DefaultPartitioner,
        allowAutoTopicCreation: true,
        idempotent: true,
        maxInFlightRequests: 5,
      });
      await this.producer.connect();
      this.isConnected = true;

      this.consumer = this.kafka.consumer({ groupId: this.groupId });
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });
      this.consumerRun = this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const raw = message.value?.toString("utf8") || "";
          if (Buffer.byteLength(raw, "utf8") > MAX_EVENT_BYTES) {
            await this._deadLetter({ topic, partition, offset: message.offset, reason: "event_too_large", raw: raw.slice(0, 4096) });
            return;
          }
          let event;
          try { event = JSON.parse(raw); }
          catch {
            await this._deadLetter({ topic, partition, offset: message.offset, reason: "invalid_json", raw: raw.slice(0, 4096) });
            return;
          }
          if (!isValidEvent(event)) {
            await this._deadLetter({ topic, partition, offset: message.offset, reason: "invalid_event_envelope", raw: raw.slice(0, 4096) });
            return;
          }
          // Do not swallow local-delivery errors: KafkaJS must retry the record.
          if (this.onEvent) await this.onEvent(event);
        },
      }).catch(error => {
        this.isConsumerRunning = false;
        logger.error("Kafka event consumer stopped", { error: error.message });
      });
      this.isConsumerRunning = true;
      logger.info("Kafka event transport connected", { brokers: this.brokers, topic: this.topic, groupId: this.groupId });
      return true;
    } catch (error) {
      logger.error("Kafka event transport initialization failed", { error: error.message });
      await Promise.allSettled([this.consumer?.disconnect(), this.producer?.disconnect()]);
      this.consumer = null;
      this.producer = null;
      this.isConnected = false;
      this.isConsumerRunning = false;
      if ((process.env.KAFKA_REQUIRED || "false").toLowerCase() === "true") throw error;
      return false;
    }
  }

  async publishEvent(event, topic = this.topic) {
    if (!this.isConnected || !this.producer) throw new Error("Kafka producer is not connected.");
    if (!isValidEvent(event)) throw new Error("Refusing to publish an invalid ATH IDE event.");
    const value = JSON.stringify(event);
    if (Buffer.byteLength(value, "utf8") > MAX_EVENT_BYTES) throw new Error("ATH IDE event exceeds the Kafka event size limit.");
    const key = String(event.workspaceId || event.sessionId || "global");
    await this.producer.send({
      topic,
      acks: -1,
      timeout: 30000,
      messages: [{
        key,
        value,
        headers: { eventId: event.eventId, eventType: event.type, source: "ath-ide" },
      }],
    });
  }

  async _deadLetter({ topic, partition, offset, reason, raw }) {
    if (!this.producer) return;
    try {
      await this.producer.send({
        topic: this.topic + ".dlq",
        acks: -1,
        messages: [{
          key: String(offset || "unknown"),
          value: JSON.stringify({ sourceTopic: topic, sourcePartition: partition, sourceOffset: offset, reason, raw, failedAt: new Date().toISOString() }),
        }],
      });
    } catch (error) {
      logger.error("Kafka dead-letter publish failed", { error: error.message, reason });
      throw error;
    }
  }

  getStatus() {
    return { connected: this.isConnected, brokers: this.brokers, topic: this.topic, consumerActive: this.isConsumerRunning, groupId: this.groupId };
  }

  async shutdown() {
    this.isConsumerRunning = false;
    await Promise.allSettled([this.consumer?.stop(), this.consumer?.disconnect(), this.producer?.disconnect()]);
    this.consumer = null;
    this.producer = null;
    this.kafka = null;
    this.isConnected = false;
    this.consumerRun = null;
    logger.info("Kafka event transport disconnected.");
  }
}

export const kafkaService = new KafkaService();
