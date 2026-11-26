# Stable Audio 3 (Pinokio): driving it over HTTP

Checked 26 Nov 2026. **Short answer: yes.** The Small SFX app can be driven over HTTP with no clicking. A 4-second effect comes back in about 1–3 seconds on the RTX 4060 Ti.

Nothing in Pinokio was changed. The only files added are in this folder.

## Where it runs

| | |
|---|---|
| URL | `http://127.0.0.1:7860` (only this PC can reach it; it isn't shared on the network) |
| Port | **7860** (Gradio's default). Pinokio reports it as `ready_url` |
| Pinokio app | `stable-audio-3-small.pinokio.git`, menu item "Start Small SFX" (`start.js` with `model=small-sfx`) |
| Gradio version | 6.3.0 (so the API is under `/gradio_api/...`, not the older `/info`) |
| Full API description | `gradio_api_info.json` in this folder (a copy of `http://127.0.0.1:7860/gradio_api/info`) |

The Music and SFX models share port 7860 and only one runs at a time. **Check the SFX model is the one loaded**: the app's Terminal in Pinokio shows `--model small-sfx`, and the page title says "Stable Audio 3 Small SFX".

### Starting it without clicking

Pinokio itself has to be open first (the `Pinokio.exe` desktop app). Its control server is on port 42000. Then:

```bash
/c/pinokio/bin/npm/pterm.cmd run "C:\\pinokio\\api\\stable-audio-3-small.pinokio.git" --default "start.js?model=small-sfx"
/c/pinokio/bin/npm/pterm.cmd status stable-audio-3-small.pinokio.git   # wait for "ready": true
```

It's ready in about 20–40 seconds.

**Important:** the app runs only while that `pterm run` command keeps running. When the command ends (or its output is cut off), Pinokio stops the app. So run it in the background and leave it alone. Clicking "Start Small SFX" in Pinokio instead has no such catch.

## The endpoint: `/generate`

Every input has to be sent as one list, **in this exact order**, plus **one extra `null` at the end** for a hidden setting the API listing doesn't show (the sampling-schedule "state"; the server fills in its default). Without that `null`, the call fails with "needed: 29, got: 28".

| # | Name | Default | What it is |
|---|---|---|---|
| 1 | `prompt` | "cinematic whoosh impact" | Text description |
| 2 | `negative_prompt` | none | What to avoid (use `""` for none) |
| 3 | `seconds_total` | 120 | Length, 0–120. **Whole numbers only**: `4.0` or `2.5` crashes the app's save step |
| 4 | `cfg_scale` | 1.0 | Prompt strength (0–25) |
| 5 | `steps` | 8 | Sampling steps (1–500) |
| 6 | `preview_every` | 0 | Spectrogram previews; leave at 0 |
| 7 | `seed` | -1 | -1 = random. A fixed seed gives the identical file again (tested) |
| 8 | `sampler_type` | "pingpong" | Only option |
| 9 | `sigma_max` | 1.0 | |
| 10 | `cfg_interval_min` | 0.0 | |
| 11 | `cfg_interval_max` | 1.0 | |
| 12 | `cfg_rescale` | 0.0 | |
| 13 | `cfg_norm_threshold` | 0.0 | |
| 14 | `apg_scale` | 1.0 | |
| 15 | `file_format` | "wav" | Also flac, mp3 320k/v0/128k |
| 16 | `file_naming` | "verbose" | verbose / prompt / output.wav |
| 17 | `cut_to_seconds_total` | true | Trims to the requested length |
| 18 | `init_audio` | null | Audio-to-audio input (file) |
| 19 | `init_noise_level` | 0.9 | |
| 20 | `mask_maskstart` | null | Inpainting start (seconds, as text) |
| 21 | `mask_maskend` | null | Inpainting end |
| 22 | `inpaint_audio` | null | Inpainting input (file) |
| 23 | `init_audio_type` | "Init audio" | |
| 24 | `inversion_steps` | 100 | |
| 25 | `inversion_gamma` | 0 | |
| 26 | `inversion_unconditional` | false | |
| 27 | `duration_padding_sec` | 6.0 | Extra length generated, then trimmed |
| 28 | `batch_size` | 1 | |
| 29 | *(hidden)* | `null` | Always send `null` |

**It returns** two things: (1) the audio file, as `{path, url, orig_name, ...}`, and (2) a spectrogram picture (`.webp`) in a gallery list.

Other endpoints (`/update_dist_shift_state*`, `/init_audio_type_switch`, `/lambda*`, `/_prompt_assistant_or_download`) are page helpers. They aren't needed.

## Working examples

### Python helper (recommended; needs nothing extra installed)

`sa3_sfx.py` in this folder reads the parameter order from the running app, so it keeps working if the app adds options.

```bash
python "S:/Youtube video ideas/Stable Audio/sa3_sfx.py" "single wooden door creak, small stone room, close" 4 "door.wav" --seed 12345
# options: --steps 8  --cfg 1.0  --negative "music, voice"  --base http://127.0.0.1:7860
```

From another Python script: `from sa3_sfx import generate; generate(prompt, 4, "out.wav", seed=12345)`.

### curl (two steps: submit, then read the result)

```bash
# 1. submit: returns {"event_id": "..."}
curl -s -X POST http://127.0.0.1:7860/gradio_api/call/generate -H "Content-Type: application/json" -d '{"data": ["single wooden door creak, small stone room, close", "", 4, 1.0, 8, 0, 12345, "pingpong", 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, "wav", "verbose", true, null, 0.9, null, null, null, "Init audio", 100, 0, false, 6.0, 1, null]}'

# 2. wait for the result (it stays open until it's done)
curl -s -N http://127.0.0.1:7860/gradio_api/call/generate/<event_id>
#   event: complete
#   data: [{"path": "C:\\pinokio\\...\\GRADIO_TEMP_DIR\\<hash>\\<name>.wav", "url": "http://127.0.0.1:7860/gradio_api/file=...", ...}, [...spectrogram...]]
#   (an "event: error / data: null" reply means look at the app's Terminal in Pinokio for the Python error)

# 3. download it: the url works, but URL-encode the part after "file=" (it has spaces)
```

`gradio_client` (pip) would also work, but isn't needed. If you do use it, it fills in the hidden `null` for you.

## Where the output lands

Each call writes the WAV in **two places on C:**:

1. `C:\pinokio\api\stable-audio-3-small.pinokio.git\app\<name>.wav`: the app's own folder. The verbose name is `<prompt>.cfg<cfg>.<seed>.wav`, for example `single wooden door creak, small stone room, close.cfg1.0.12345.wav`. These pile up and aren't cleaned automatically.
2. `C:\pinokio\api\stable-audio-3-small.pinokio.git\cache\GRADIO_TEMP_DIR\<hash>\<name>.wav`: this is the copy the API returns as `path` / `url`.

Download the file over the `url` (as `sa3_sfx.py` does) instead of reading those folders directly. That way the caller doesn't depend on Pinokio's folders, and the same code would work from another machine if network sharing is ever turned on.

Format: 16-bit WAV, 44.1 kHz, stereo.

## Test result (26 Nov 2026)

- Prompt "single wooden door creak, small stone room, close", 4 s, seed 12345, 8 steps, CFG 1.0
- Output: exactly 4.000 s, peak −5.0 dB, mean −31.7 dB. Copies are in `test_output\` (not checked by ear yet)
- **Time per call: 2.8 s for the first call, then 1.1 s** (submit to finished file; the model was already loaded)
- Running the same seed again through `sa3_sfx.py` gave a byte-for-byte identical file
