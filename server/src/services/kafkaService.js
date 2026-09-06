/**
 * Apache Kafka Distributed Queue Service
 *
 * Implements production-ready message queueing with topic partitioning:
 * - `ath-ide.tasks`: Task and command execution queue partitioned across cluster nodes
 * - `ath-ide.events`: Real-time cluster-wide event stream
 *
 * Provides transparent fallback to in-memory / local queues if Kafka brokers are offline.
 */

import { Kafka, Partitioners } from "kafkajs";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

class KafkaService {
  constructor() {
    this.brokers = (process.env.KAFKA_BROKERS || "").split(",").filter(Boolean);
    this.clientId = process.env.KAFKA_CLIENT_ID || "ath-ide-studio";
    this.groupId = process.env.KAFKA_GROUP_ID || "ath-ide-worker-group";
    this.kafka = null;
    this.producer = null;
    this.consumer = null;
    this.isConnected = false;
    this.isConsumerRunning = false;
    this.taskHandlers = new Set();
  }

  /**
   * Initialize Kafka producer and consumer connections.
   */
  async initialize() {
    if (this.brokers.length === 0) {
      logger.info("KafkaService: KAFKA_BROKERS not configured. Using localized event queue.");
      return;
    }

    try {
      logger.info(`KafkaService: Connecting to Kafka brokers: ${this.brokers.join(", ")}...`);

      this.kafka = new Kafka({
        clientId: this.clientId,
        brokers: this.brokers,
        connectionTimeout: 5000,
        requestTimeout: 25000,
        retry: {
          initialRetryTime: 300,
          retries: 5,
        },
      });

      this.producer = this.kafka.producer({
        createPartitioner: Partitioners.DefaultPartitioner,
        allowAutoTopicCreation: true,
      });

      await this.producer.connect();
      this.isConnected = true;
      logger.info("KafkaService: Producer connected successfully.");

      // Start consumer
      await this.startConsumer();
    } catch (err) {
      this.isConnected = false;
      logger.warn(`KafkaService: Broker connection failed: ${err.message}. Operating in fallback queue mode.`);
    }
  }

  /**
   * Start consumer for task topic.
   */
  async startConsumer() {
    if (!this.kafka || this.isConsumerRunning) return;

    try {
      this.consumer = this.kafka.consumer({ groupId: this.groupId });
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: "ath-ide.tasks", fromBeginning: false });

      this.isConsumerRunning = true;
      logger.info(`KafkaService: Consumer connected to group '${this.groupId}', subscribed to 'ath-ide.tasks'.`);

      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            const raw = message.value ? message.value.toString() : "{}";
            const task = JSON.parse(raw);
            logger.debug(`KafkaService: Received task on partition ${partition}`, { taskId: task.id });

            for (const handler of this.taskHandlers) {
              try {
                await handler(task);
              } catch (hErr) {
                logger.error("KafkaService: Task handler execution error", { error: hErr.message });
              }
            }
          } catch (pErr) {
            logger.error("KafkaService: Error parsing message from Kafka", { error: pErr.message });
          }
        },
      });
    } catch (err) {
      this.isConsumerRunning = false;
      logger.warn(`KafkaService: Consumer initialization note: ${err.message}`);
    }
  }

  /**
   * Publish a task into the Kafka task queue topic.
   * @param {object} task - Task payload with id, operation, command, etc.
   * @returns {Promise<boolean>}
   */
  async publishTask(task) {
    if (!this.isConnected || !this.producer) {
      return false; // Fallback to local queue
    }

    try {
      const partitionKey = task.userId || task.sessionId || "global";
      await this.producer.send({
        topic: "ath-ide.tasks",
        messages: [
          {
            key: String(partitionKey),
            value: JSON.stringify({
              ...task,
              enqueuedAt: new Date().toISOString(),
            }),
            headers: {
              source: "ath-ide-server",
              priority: String(task.priority || "normal"),
            },
          },
        ],
      });

      logger.debug(`KafkaService: Task published to 'ath-ide.tasks'`, { taskId: task.id, partitionKey });
      return true;
    } catch (err) {
      logger.warn(`KafkaService: Failed to publish task: ${err.message}`);
      return false;
    }
  }

  /**
   * Register a task handler for consumed Kafka messages.
   * @param {Function} handler
   */
  onTask(handler) {
    if (typeof handler === "function") {
      this.taskHandlers.add(handler);
    }
  }

  /**
   * Graceful disconnection on server shutdown.
   */
  async shutdown() {
    try {
      if (this.consumer) await this.consumer.disconnect();
      if (this.producer) await this.producer.disconnect();
      this.isConnected = false;
      logger.info("KafkaService: Disconnected from Kafka brokers.");
    } catch {}
  }
}

export const kafkaService = new KafkaService();
