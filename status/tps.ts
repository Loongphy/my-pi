/**
 * Token Speed Engine — TPS + TTFT Tracking
 *
 * Tracks two metrics during assistant streaming:
 *   1. TPS (tokens per second) — real-time via char/4 heuristic, final via usage.output
 *   2. TTFT (time to first token) — wall-clock from HTTP request to first text/thinking delta
 *
 * TTFT is always a real time measurement (no estimation), so it is the same
 * whether read during streaming or from the finalised message_end.
 */

export class TokenSpeedEngine {
  private _isStreaming = false;
  private _finished = false;

  // Char-based estimation state
  private _charCount = 0;
  private _approxTokenCount = 0;
  private _tokenTimestamps: number[] = [];
  private _windowStartIndex = 0;

  // Real token count (from message_end usage)
  private _realOutputTokens = 0;

  // Timing — excludes TTFT for TPS calculation
  private _messageStartTime = 0;
  private _httpRequestStartTime = 0;
  private _generationStartTime = 0;
  private _generationEndTime = 0;
  private _firstTokenArrived = false;

  // TTFT
  private _ttftMs = 0;

  private readonly TPS_WINDOW_MS = 1000;
  private readonly COMPACTION_THRESHOLD = 5000;

  get isStreaming() { return this._isStreaming; }

  /** Best token count available: real provider-reported when finished, otherwise approx char/4. */
  get tokenCount(): number {
    return this._finished && this._realOutputTokens > 0
      ? this._realOutputTokens
      : this._approxTokenCount;
  }

  /** Elapsed ms since generation started (excludes TTFT). Frozen at finish(). */
  get elapsedMs(): number {
    if (this._generationStartTime === 0) return 0;
    const end = this._finished && this._generationEndTime > 0 ? this._generationEndTime : Date.now();
    return end - this._generationStartTime;
  }
  get elapsedSeconds(): number { return this.elapsedMs / 1000; }

  /**
   * TTFT in seconds.
   *
   * Before first token arrives: returns a live (Date.now() - httpRequestStart) value
   * so the status header shows a counting-up timer while the user waits.
   *
   * After first token: returns the frozen measured TTFT.
   */
  get ttftSec(): number {
    // First token has arrived — show the frozen measured value
    if (this._firstTokenArrived) return this._ttftMs / 1000;
    // Waiting for first token — live count-up from http request start
    if (this._isStreaming && this._httpRequestStartTime > 0) {
      return (Date.now() - this._httpRequestStartTime) / 1000;
    }
    return this._ttftMs / 1000;
  }

  /**
   * Tokens per second.
   *
   * During streaming: sliding-window over timestamps (1 s window),
   * falling back to overall average when elapsed < 1 s.
   *
   * After finish(): uses provider-reported real output tokens and
   * wall time from generation start (excludes TTFT).
   */
  get tps(): number {
    // Finished — use real provider-reported tokens (time frozen at finish())
    if (this._finished && this._realOutputTokens > 0) {
      const elapsed = this.elapsedMs;
      return elapsed === 0 ? 0 : this._realOutputTokens / (elapsed / 1000);
    }

    // Streaming — sliding window
    if (this._generationStartTime === 0) return 0;
    if (this.elapsedMs < this.TPS_WINDOW_MS) return this.tps_avg;

    const now = Date.now();
    const windowStart = now - this.TPS_WINDOW_MS;
    while (
      this._windowStartIndex < this._tokenTimestamps.length &&
      this._tokenTimestamps[this._windowStartIndex] < windowStart
    ) {
      this._windowStartIndex++;
    }
    const windowCount = this._tokenTimestamps.length - this._windowStartIndex;
    if (windowCount === 0) return this.tps_avg;
    const duration = (now - this._tokenTimestamps[this._windowStartIndex]) / 1000;
    if (duration === 0) return 0;
    return windowCount / duration;
  }

  /** Overall average TPS (used as fallback when < 1 s of data). */
  get tps_avg(): number {
    return this.elapsedSeconds === 0 ? 0 : this.tokenCount / this.elapsedSeconds;
  }

  /**
   * Call on before_provider_request.
   * Records the time when HTTP request is about to be sent.
   */
  recordHttpRequest() {
    this._httpRequestStartTime = Date.now();
  }

  /**
   * Call on message_start (assistant).
   * Records message-start wall time for TTFT calculation.
   */
  start() {
    this._isStreaming = true;
    this._finished = false;
    this._charCount = 0;
    this._approxTokenCount = 0;
    this._realOutputTokens = 0;
    // Use HTTP request time as TTFT start point if available
    this._messageStartTime = this._httpRequestStartTime > 0
      ? this._httpRequestStartTime
      : Date.now();
    this._generationStartTime = 0;
    this._firstTokenArrived = false;
    this._ttftMs = 0;
    this._tokenTimestamps = [];
    this._windowStartIndex = 0;
  }

  /**
   * Call on each text_delta / thinking_delta.
   *
   * Uses pi's own chars/4 heuristic (see estimateTokens() in compaction.ts)
   * to approximate real token count from the delta string.
   *
   * On the first call, records generation start time and TTFT.
   */
  recordToken(delta: string) {
    if (!this._isStreaming) return;

    // First token → mark generation start and measure TTFT
    if (!this._firstTokenArrived) {
      this._firstTokenArrived = true;
      this._generationStartTime = Date.now();
      this._ttftMs = this._generationStartTime - this._messageStartTime;
    }

    this._charCount += delta.length;

    // Pi's own estimateTokens heuristic: chars/4, minimum 1
    const approxTokens = Math.max(1, Math.round(delta.length / 4));
    this._approxTokenCount += approxTokens;

    // Push a timestamp per approx-token for sliding-window accuracy
    const now = Date.now();
    for (let i = 0; i < approxTokens; i++) {
      this._tokenTimestamps.push(now);
    }

    // Compact timestamp array to prevent unbounded growth
    if (this._windowStartIndex >= this.COMPACTION_THRESHOLD) {
      this._tokenTimestamps = this._tokenTimestamps.slice(this._windowStartIndex);
      this._windowStartIndex = 0;
    }
  }

  /**
   * Call on message_end (assistant).
   * Injects provider-reported real output token count so the final
   * status render shows the accurate TPS.
   */
  finish(realOutputTokens?: number) {
    this._isStreaming = false;
    this._finished = true;
    this._generationEndTime = Date.now();  // freeze time for stable TPS
    if (realOutputTokens !== undefined && realOutputTokens > 0) {
      this._realOutputTokens = realOutputTokens;
    }
    // Keep stats alive so the final status render reads real TPS
  }

  /** Full reset (e.g. on session_shutdown). */
  stop() {
    this._isStreaming = false;
    this._finished = false;
    this._httpRequestStartTime = 0;
    this._generationEndTime = 0;
    this._tokenTimestamps = [];
    this._windowStartIndex = 0;
  }
}
