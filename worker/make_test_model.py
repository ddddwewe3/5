#!/usr/bin/env python3
"""
Creates a TINY, RANDOMLY-INITIALISED LTX-Video pipeline for testing the generation machinery
(model loading/caching, progress, cancel, frame export, FFmpeg encoding, scene extension) on
machines without a GPU or without internet access. It is built the same way diffusers' own unit
tests build their dummy components.

Its output is visual noise — it is NOT a usable video model. For real videos use
Lightricks/LTX-Video (default) or ComfyUI with the models listed in the README.

Usage:  python worker/make_test_model.py [output_dir]   (default: models/test-tiny-ltx)
"""
import json
import os
import sys


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "models", "test-tiny-ltx")
    out = os.path.abspath(out)
    import torch
    from diffusers import AutoencoderKLLTXVideo, FlowMatchEulerDiscreteScheduler, LTXPipeline, LTXVideoTransformer3DModel
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast, T5Config, T5EncoderModel

    torch.manual_seed(0)
    transformer = LTXVideoTransformer3DModel(
        in_channels=8, out_channels=8, patch_size=1, patch_size_t=1, num_attention_heads=4, attention_head_dim=8,
        cross_attention_dim=32, num_layers=1, caption_channels=32,
    )
    vae = AutoencoderKLLTXVideo(
        in_channels=3, out_channels=3, latent_channels=8, block_out_channels=(8, 8, 8, 8),
        decoder_block_out_channels=(8, 8, 8, 8), layers_per_block=(1, 1, 1, 1, 1), decoder_layers_per_block=(1, 1, 1, 1, 1),
        # Same compression as the real LTX VAE (32x spatial, 8x temporal) so token counts stay realistic.
        spatio_temporal_scaling=(True, True, True, False), decoder_spatio_temporal_scaling=(True, True, True, False),
        decoder_inject_noise=(False, False, False, False, False), upsample_residual=(False, False, False, False),
        upsample_factor=(1, 1, 1, 1), timestep_conditioning=False, patch_size=4, patch_size_t=1,
        encoder_causal=True, decoder_causal=False,
    )
    vae.use_framewise_encoding = False
    vae.use_framewise_decoding = False
    scheduler = FlowMatchEulerDiscreteScheduler()

    words = ["<pad>", "</s>", "<unk>"] + sorted(set(
        "a the man woman person product bottle talking walking room studio light camera cinematic shot slow push in close up "
        "wide golden hour city street night neon ocean forest mountain smiling holding showing new video scene of on at with "
        "and in to is from for soft warm cool style realistic motion smooth".split()))
    tok = Tokenizer(models.WordLevel({w: i for i, w in enumerate(words)}, unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.Whitespace()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=tok, pad_token="<pad>", eos_token="</s>", unk_token="<unk>")
    text_encoder = T5EncoderModel(T5Config(vocab_size=len(words), d_model=32, d_kv=8, d_ff=37, num_layers=2, num_heads=4,
                                           relative_attention_num_buckets=8, dropout_rate=0.0, pad_token_id=0, eos_token_id=1))
    pipe = LTXPipeline(transformer=transformer, vae=vae, scheduler=scheduler, text_encoder=text_encoder, tokenizer=tokenizer)
    os.makedirs(out, exist_ok=True)
    pipe.save_pretrained(out)
    with open(os.path.join(out, "TEST_MODEL_README.txt"), "w") as f:
        f.write("Tiny randomly-initialised LTX pipeline for pipeline tests only. Output is noise, not real video.\n")
    print(json.dumps({"ok": True, "path": out, "spatial_compression": vae.spatial_compression_ratio,
                      "temporal_compression": vae.temporal_compression_ratio}))


if __name__ == "__main__":
    main()
