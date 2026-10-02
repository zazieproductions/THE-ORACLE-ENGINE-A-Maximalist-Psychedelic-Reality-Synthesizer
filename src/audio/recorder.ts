/**
 * Session recorder.
 *
 * ADR-025: capture is taken from a MediaStreamDestination tapped off the
 * master bus *before* the limiter's makeup gain, so the recording is the
 * mix and not the safety net. MediaRecorder is used rather than an
 * offline-render bounce because the oracle is a live generative instrument —
 * there is no score to render. The trade-off (lossy opus) is documented in
 * the UI rather than hidden.
 */

export class Recorder {
  private dest: MediaStreamAudioDestinationNode;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = '';

  constructor(ctx: AudioContext, private readonly source: AudioNode) {
    this.dest = ctx.createMediaStreamDestination();
    source.connect(this.dest);
    this.mime = Recorder.pickMime();
  }

  static pickMime(): string {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  get supported(): boolean { return this.mime !== ''; }
  get recording(): boolean { return this.rec !== null && this.rec.state === 'recording'; }

  start(): boolean {
    if (!this.supported || this.recording) return false;
    this.chunks = [];
    const rec = new MediaRecorder(this.dest.stream, { mimeType: this.mime });
    rec.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) this.chunks.push(e.data); };
    rec.start(250);
    this.rec = rec;
    return true;
  }

  stop(): Promise<Blob | null> {
    const rec = this.rec;
    if (!rec) return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        this.rec = null;
        const blob = this.chunks.length > 0
          ? new Blob(this.chunks, { type: this.mime || 'audio/webm' })
          : null;
        this.chunks = [];
        resolve(blob);
      };
      if (rec.state !== 'inactive') rec.stop();
      else { this.rec = null; resolve(null); }
    });
  }

  dispose(): void {
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); } catch { /* noop */ }
    this.rec = null;
    try { this.source.disconnect(this.dest); } catch { /* noop */ }
  }
}
