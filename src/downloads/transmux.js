function sameBytes(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function findTsSyncOffset(bytes) {
  const max = Math.min(bytes.byteLength, 188 * 3);
  for (let offset = 0; offset < max; offset += 1) {
    if (bytes[offset] !== 0x47) continue;
    if (offset + 188 >= bytes.byteLength || bytes[offset + 188] === 0x47) return offset;
  }
  return -1;
}

export function normalizeTsBytes(bytes) {
  const offset = findTsSyncOffset(bytes);
  return offset > 0 ? bytes.slice(offset) : bytes;
}

export class TsTransmuxSink {
  constructor(baseSink, muxjs = globalThis.muxjs) {
    if (!muxjs?.mp4?.Transmuxer) throw new Error("mux.js 不可用，无法把 TS 转封装为 MP4。");
    this.baseSink = baseSink;
    this.transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, remux: true });
    this.initSegment = null;
    this.current = null;
    this.transmuxer.on("data", (segment) => {
      if (!this.current) return;
      if (segment.initSegment) this.current.initSegments.push(segment.initSegment);
      if (segment.data) this.current.data.push(segment.data);
    });
    this.transmuxer.on("done", () => {
      if (this.current && !this.current.done) {
        this.current.done = true;
        this.current.resolve();
      }
    });
  }

  get filename() {
    return this.baseSink.filename;
  }

  get bytesWritten() {
    return this.baseSink.bytesWritten;
  }

  async write(bytes, metadata = {}) {
    if (metadata.discontinuity && typeof this.transmuxer.reset === "function") this.transmuxer.reset();
    const current = { initSegments: [], data: [], resolve: null, done: false };
    const done = new Promise((resolve, reject) => {
      current.resolve = resolve;
      current.timeout = setTimeout(() => reject(new Error("TS 转封装超时。")), 15000);
    });
    this.current = current;
    try {
      this.transmuxer.push(normalizeTsBytes(bytes));
      this.transmuxer.flush();
      await done;
      for (const init of current.initSegments) {
        if (this.initSegment && !sameBytes(this.initSegment, init)) throw new Error("媒体编码配置中途变化，需要 FFmpeg 本地增强模式。");
        if (!this.initSegment) await this.baseSink.write(init);
        this.initSegment = init.slice();
      }
      for (const data of current.data) await this.baseSink.write(data);
      if (!current.data.length) throw new Error("mux.js 没有从该分片生成 MP4 数据。");
    } catch (error) {
      throw error;
    } finally {
      clearTimeout(current.timeout);
      this.current = null;
    }
  }

  close() {
    return this.baseSink.close();
  }

  abort(reason) {
    return this.baseSink.abort(reason);
  }
}
