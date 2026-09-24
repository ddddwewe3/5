'use strict';

/**
 * Base class for video engines. Implementations:
 *   LocalComfyUIProvider      – ComfyUI running locally (default, primary engine)
 *   LocalVideoModelProvider   – open-source models run directly by a local Python/diffusers worker
 *   OptionalExternalProvider  – hosted API (off unless configured; costs money per generation)
 *
 * Contract for generate():
 *   request: { mode: 't2v'|'i2v', prompt, negativePrompt, imagePath, width, height, frames, fps,
 *              steps, cfg, shift, seed, outDir, engine, tiledDecode }
 *   ctx:     { signal, stage(stage, fraction, message), step(step, total), log(message) }
 *   returns: { video: <path to intermediate MP4 at generation size>, width, height, fps, frames, model }
 */
class VideoProvider {
  constructor(id, label, kind) {
    this.id = id;
    this.label = label;
    this.kind = kind; // local | external
  }

  /** @returns {Promise<{id,label,kind,available:boolean,status:string,message:string,engines?:object[],gpu?:object,details?:string}>} */
  async health() {
    throw new Error('not implemented');
  }

  /**
   * Picks the concrete model/workflow for a mode. Throws AppError when nothing suitable exists.
   * @returns {Promise<{id,label,family,t2v:boolean,i2v:boolean,distilled?:boolean,overrides?:object}>}
   */
  async selectEngine(_mode) {
    throw new Error('not implemented');
  }

  async generate(_request, _ctx) {
    throw new Error('not implemented');
  }

  /** Optional: release GPU memory / background processes. */
  async shutdown() {}
}

module.exports = { VideoProvider };
