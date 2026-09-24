# Custom ComfyUI workflows

OpenReel Studio builds ComfyUI workflows automatically for LTX-Video and Wan 2.x. To use any other
model or node setup (for example LTX-2, HunyuanVideo, or a workflow with LoRAs), put it here:

1. Build the workflow in ComfyUI and make sure it produces video frames (`PreviewImage`, `SaveImage`,
   `SaveVideo` or VideoHelperSuite's `VHS_VideoCombine`).
2. Export it with **Workflow → Export (API)** and save the `.json` file in this folder.
3. Replace input values with placeholders — OpenReel fills them in for every generation:

| Placeholder    | Value                                        |
| -------------- | -------------------------------------------- |
| `{{PROMPT}}`   | the enhanced cinematic prompt                |
| `{{NEGATIVE}}` | negative prompt                              |
| `{{WIDTH}}` `{{HEIGHT}}` | generation size                    |
| `{{FRAMES}}`   | number of frames                             |
| `{{FPS}}`      | frame rate                                   |
| `{{SEED}}` `{{STEPS}}` `{{CFG}}` | sampler settings           |
| `{{IMAGE}}`    | uploaded reference image (makes it image-to-video) |

   A placeholder that is the whole value (e.g. `"width": "{{WIDTH}}"`) is inserted as a number.

4. Optional: add `"_openreel": { "label": "My flow", "fps": 24, "frameStep": 8, "maxFrames": 121 }`
   at the top level to describe the model's frame rate and frame-count rules.

The workflow then appears in **Settings → ComfyUI → Model / workflow**.
