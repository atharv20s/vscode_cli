const DEFAULT_MAX_BYTES = 1024 * 1024;

class TextCapture {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.headBytes = Math.floor(maxBytes / 2);
    this.tailBytes = maxBytes - this.headBytes;
    this.totalBytes = 0;
    this.buffer = Buffer.alloc(0);
    this.head = null;
    this.tail = null;
  }

  append(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (!chunk.length) return;
    this.totalBytes += chunk.length;

    if (!this.head) {
      const combined = Buffer.concat([this.buffer, chunk]);
      if (combined.length <= this.maxBytes) {
        this.buffer = combined;
        return;
      }
      this.head = combined.subarray(0, this.headBytes);
      this.tail = combined.subarray(-this.tailBytes);
      this.buffer = Buffer.alloc(0);
      return;
    }

    this.tail = Buffer.concat([this.tail, chunk]).subarray(-this.tailBytes);
  }

  snapshot() {
    const truncated = this.totalBytes > this.maxBytes;
    const text = truncated
      ? Buffer.concat([
          this.head,
          Buffer.from(`\n...[ ${this.totalBytes - this.maxBytes} bytes omitted ]...\n`),
          this.tail,
        ]).toString("utf8")
      : this.buffer.toString("utf8");
    return {
      text,
      totalBytes: this.totalBytes,
      truncated,
      truncatedBytes: Math.max(0, this.totalBytes - this.maxBytes),
    };
  }
}

/**
 * Bounded capture for subprocess output. It preserves the beginning and end
 * of each stream plus the combined arrival order, while counting all bytes.
 */
export class BoundedOutputCapture {
  constructor({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) {
      throw new Error("maxBytes must be a safe integer of at least 128.");
    }
    this.combined = new TextCapture(maxBytes);
    this.stdout = new TextCapture(maxBytes);
    this.stderr = new TextCapture(maxBytes);
  }

  append(stream, chunk) {
    if (stream !== "stdout" && stream !== "stderr") {
      throw new Error("Output stream must be stdout or stderr.");
    }
    this.combined.append(chunk);
    this[stream].append(chunk);
  }

  snapshot() {
    const combined = this.combined.snapshot();
    const stdout = this.stdout.snapshot();
    const stderr = this.stderr.snapshot();
    return {
      output: combined.text,
      stdout: stdout.text,
      stderr: stderr.text,
      totalBytes: combined.totalBytes,
      truncated: combined.truncated,
      truncatedBytes: combined.truncatedBytes,
      streams: {
        stdout: { totalBytes: stdout.totalBytes, truncated: stdout.truncated, truncatedBytes: stdout.truncatedBytes },
        stderr: { totalBytes: stderr.totalBytes, truncated: stderr.truncated, truncatedBytes: stderr.truncatedBytes },
      },
    };
  }
}

export { DEFAULT_MAX_BYTES };
