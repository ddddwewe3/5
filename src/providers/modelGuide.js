'use strict';

/**
 * Recommended free/open-source models and where their files go. Used by the Settings page and by
 * scripts/download-models.js. All weights are openly licensed and downloaded from Hugging Face.
 */
const COMFY_MODELS = [
  {
    id: 'ltxv-2b',
    label: 'LTX-Video 2B distilled (recommended — fastest: ~8 steps, text+image to video, ~8 GB VRAM)',
    family: 'ltxv',
    files: [
      { folder: 'checkpoints', name: 'ltxv-2b-0.9.8-distilled.safetensors', url: 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltxv-2b-0.9.8-distilled.safetensors', sizeGB: 6.3,
        // Fallbacks if a file was renamed upstream (the first one that downloads wins).
        alternatives: [
          { name: 'ltxv-2b-0.9.6-distilled-04-25.safetensors', url: 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltxv-2b-0.9.6-distilled-04-25.safetensors' },
          { name: 'ltx-video-2b-v0.9.5.safetensors', url: 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors' },
        ] },
      { folder: 'text_encoders', name: 't5xxl_fp8_e4m3fn_scaled.safetensors', url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors', sizeGB: 5.2 },
    ],
  },
  {
    id: 'wan22-5b',
    label: 'Wan 2.2 TI2V 5B (higher quality, text+image to video, ~12 GB VRAM)',
    family: 'wan22',
    files: [
      { folder: 'diffusion_models', name: 'wan2.2_ti2v_5B_fp16.safetensors', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', sizeGB: 10 },
      { folder: 'text_encoders', name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', sizeGB: 6.7 },
      { folder: 'vae', name: 'wan2.2_vae.safetensors', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors', sizeGB: 1.4 },
    ],
  },
  {
    id: 'wan21-1.3b',
    label: 'Wan 2.1 T2V 1.3B (small, text to video only, ~8 GB VRAM)',
    family: 'wan',
    files: [
      { folder: 'diffusion_models', name: 'wan2.1_t2v_1.3B_fp16.safetensors', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', sizeGB: 2.8 },
      { folder: 'text_encoders', name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', sizeGB: 6.7 },
      { folder: 'vae', name: 'wan_2.1_vae.safetensors', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', sizeGB: 0.25 },
    ],
  },
];

const LOCAL_MODELS = [
  { id: 'Lightricks/LTX-Video', label: 'LTX-Video (diffusers, text+image to video)', family: 'ltxv' },
  { id: 'Wan-AI/Wan2.2-TI2V-5B-Diffusers', label: 'Wan 2.2 TI2V 5B (diffusers, text+image to video)', family: 'wan22' },
  { id: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers', label: 'Wan 2.1 T2V 1.3B (diffusers, text to video)', family: 'wan' },
];

module.exports = { COMFY_MODELS, LOCAL_MODELS };
