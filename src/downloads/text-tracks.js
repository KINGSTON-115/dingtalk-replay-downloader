export class WebVttConcatSink {
  constructor(baseSink) {
    this.baseSink = baseSink;
    this.started = false;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  get filename() {
    return this.baseSink.filename;
  }

  get bytesWritten() {
    return this.baseSink.bytesWritten;
  }

  async write(bytes) {
    let text = this.decoder.decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!this.started) {
      if (!/^WEBVTT(?:\s|$)/.test(text)) text = `WEBVTT\n\n${text}`;
      this.started = true;
      await this.baseSink.write(this.encoder.encode(text.trimEnd() + "\n"));
      return;
    }

    if (/^WEBVTT(?:\s|$)/.test(text)) {
      const lines = text.split("\n");
      let index = 1;
      while (index < lines.length && lines[index].trim() !== "") index += 1;
      while (index < lines.length && lines[index].trim() === "") index += 1;
      text = lines.slice(index).join("\n");
    }
    if (text.trim()) await this.baseSink.write(this.encoder.encode(`\n${text.trim()}\n`));
  }

  close() {
    return this.baseSink.close();
  }

  abort(reason) {
    return this.baseSink.abort(reason);
  }
}
