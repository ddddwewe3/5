# Workflows / ملفات سير العمل

This folder holds **ComfyUI workflows in API format**. The backend loads them, fills in the
placeholders, and sends them to your local ComfyUI at `COMFYUI_URL`.

[`models.json`](models.json) lists every model: its workflow per mode (`t2v`, `i2v`, `flf2v`),
resolutions, durations, fps and the model files with download links. The engine checks ComfyUI's
`/object_info` to show which models are installed. Download files with
`python scripts/download_models.py --model <id> --comfyui <path>` (from the repository root).

| Model id | Workflows | Model files |
|---|---|---|
| `wan2.2-ti2v-5b` (default) | `wan2.2_ti2v_5b_t2v_api.json`, `wan2.2_ti2v_5b_i2v_api.json` | `wan2.2_ti2v_5B_fp16`, `umt5_xxl_fp8_e4m3fn_scaled`, `wan2.2_vae` |
| `ltxv-2b` | `ltxv_2b_t2v_api.json`, `ltxv_2b_i2v_api.json` | `ltx-video-2b-v0.9.5`, `t5xxl_fp16` |
| `wan2.1-i2v-14b` | `wan2.1_i2v_480p_api.json`, `wan2.1_flf2v_720p_api.json` | `wan2.1_i2v_480p_14B_fp8_e4m3fn` (+ optional `wan2.1_flf2v_720p_14B_fp8_e4m3fn`), `umt5_xxl_fp8_e4m3fn_scaled`, `wan_2.1_vae`, `clip_vision_h` |

All workflows were validated against ComfyUI 0.37's node definitions.

## Using your own workflow / استخدام سير عمل خاص بك

1. Build and test the workflow in ComfyUI.
2. Enable **Settings → Dev mode**, then **Workflow → Export (API)** / **Save (API Format)**.
   A normal "Save" (UI format with `nodes`/`links`) is rejected with a clear error.
3. Replace values with placeholders (as a whole string value → the number/text type is kept):

| Placeholder | Value |
|---|---|
| `{{IMAGE_1}}` / `{{IMAGE_2}}` | Uploaded image names (put in a `LoadImage` node) |
| `{{PROMPT}}` / `{{NEGATIVE_PROMPT}}` | Prompt text (motion hint appended automatically) |
| `{{WIDTH}}` / `{{HEIGHT}}` | From the model's `resolutions` for the chosen resolution and aspect ratio |
| `{{FRAMES}}` | Frame count = round(duration × fps / frame_multiple) × frame_multiple + 1 |
| `{{FPS}}` | The model's fps from `models.json` |
| `{{STEPS}}` | The model's sampling steps from `models.json` |
| `{{SEED}}` | Random seed |
| `{{DURATION}}` | 3, 5 or 8 |
| `{{MOTION}}` | 0.3 / 0.6 / 0.9 (low / medium / high) |
| `{{FILENAME_PREFIX}}` | Output prefix for the Save node |

4. Save the file here and add/extend an entry in `models.json` (id, provider `"comfyui"`, workflows,
   resolutions, fps, `frame_multiple`, files). Restart the engine.

The output node may be `SaveAnimatedWEBP`, `SaveWEBM`, `SaveVideo`, VideoHelperSuite's
`VHS_VideoCombine`, or a `SaveImage` of frames — the backend converts all of them to MP4 with FFmpeg.

**Low VRAM tip:** 8-second videos need a lot of VRAM. Start with 3 seconds. On small GPUs you
can swap the `UNETLoader` for a quantized GGUF version of the Wan2.1 I2V model
(via the free `ComfyUI-GGUF` custom node), then re-export in API format.
