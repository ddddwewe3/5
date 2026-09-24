# Workflows / ملفات سير العمل

This folder holds **ComfyUI workflows in API format**. The backend loads them, fills in the
placeholders, and sends them to your local ComfyUI at `COMFYUI_URL`.

| File | Used when | Model files it expects |
|---|---|---|
| `wan2.1_i2v_480p_api.json` | 1 image (and fallback for 2 images) | `wan2.1_i2v_480p_14B_fp8_e4m3fn.safetensors` |
| `wan2.1_flf2v_720p_api.json` | 2 images (first frame → last frame) | `wan2.1_flf2v_720p_14B_fp8_e4m3fn.safetensors` |

Both also need `umt5_xxl_fp8_e4m3fn_scaled.safetensors`, `wan_2.1_vae.safetensors` and
`clip_vision_h.safetensors`. See the main README for download links and folders.

The file names are set in `.env` (`COMFYUI_WORKFLOW`, `COMFYUI_WORKFLOW_TWO_IMAGES`).

## Using your own workflow / استخدام سير عمل خاص بك

1. Build and test the workflow in ComfyUI.
2. Enable **Settings → Dev mode**, then **Workflow → Export (API)** / **Save (API Format)**.
   A normal "Save" (UI format with `nodes`/`links`) is rejected with a clear error.
3. Replace values with placeholders (as a whole string value → the number/text type is kept):

| Placeholder | Value |
|---|---|
| `{{IMAGE_1}}` / `{{IMAGE_2}}` | Uploaded image names (put in a `LoadImage` node) |
| `{{PROMPT}}` / `{{NEGATIVE_PROMPT}}` | Prompt text (motion hint appended automatically) |
| `{{WIDTH}}` / `{{HEIGHT}}` | 480×832 (9:16), 832×480 (16:9), 624×624 (1:1) |
| `{{FRAMES}}` | Frame count, 4n+1 at 16 fps (3s→49, 5s→81, 8s→129) |
| `{{FPS}}` | 16 |
| `{{SEED}}` | Random seed |
| `{{DURATION}}` | 3, 5 or 8 |
| `{{MOTION}}` | 0.3 / 0.6 / 0.9 (low / medium / high) |
| `{{FILENAME_PREFIX}}` | Output prefix for the Save node |

4. Save the file here and set its name in `.env`.

The output node may be `SaveAnimatedWEBP`, `SaveWEBM`, `SaveVideo`, VideoHelperSuite's
`VHS_VideoCombine`, or a `SaveImage` of frames — the backend converts all of them to MP4 with FFmpeg.

**Low VRAM tip:** 8-second videos need a lot of VRAM. Start with 3 seconds. On small GPUs you
can swap the `UNETLoader` for a quantized GGUF version of the Wan2.1 I2V model
(via the free `ComfyUI-GGUF` custom node), then re-export in API format.
