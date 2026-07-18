# LoRA Lab

Spectral health checker + fixer for LoRA checkpoints — built for the **krea2
LoRA stacking problem**, works on any `lora_A/lora_B`-style safetensors.

![type](https://img.shields.io/badge/tauri-v2-blue) ![type](https://img.shields.io/badge/frontend-vanilla_js-yellow) ![type](https://img.shields.io/badge/math-numpy-green)

## The problem this solves

LoRA training on krea2 grows an effectively **rank-1 spectral spike** in each
layer's weight update — one direction at σ ≈ 14–28 where healthy adapters top
out around 4.5, concentrated on the SwiGLU `mlp.gate` layers. It grows with
training steps and happens with every optimizer (adamw8bit, automagic, ...).

One spiked LoRA looks fine on its own. **Stack any two and fine detail
collapses into blobs** — the widely-reported "krea2 LoRAs don't work together"
issue. Full-rank LoKr is immune; plain LoRA is not.

The fix is simple once you can see it: cap each layer's singular values at ~5.
This app lets you **see it** and **fix it**.

## Features

- **Scan** a folder (recursive) for `.safetensors` checkpoints
- **Analyze** any file in seconds: per-module σ_max and stable rank via SVD,
  health verdict, sorted spectrum chart with hover inspection, top offenders
- **Verdict badges** on every analyzed file — triage a whole folder of
  checkpoints at a glance (results cached)
- **Clip**: cap singular values at a chosen limit (presets 4 / 5 / 8), writes a
  `*_sclipN.safetensors` copy next to the original, shows before/after.
  Non-destructive, ~30 s per file, no retraining.
- Detects LoKr vs LoRA (LoKr is analyzed but not clipped — it doesn't need it)

## Requirements

- **Windows** (built/tested); should build on other platforms via Tauri
- **A Python with numpy** — that's the only Python dependency. The app tries
  the interpreter set in the gear menu (⚙), then `python` on your PATH.

### Python setup (pick whichever fits you)

**Already run ComfyUI portable?** You have everything — just point the gear
menu (⚙) at ComfyUI's bundled interpreter, e.g.:

```
C:\path\to\ComfyUI\python_embeded\python.exe
```

**Have Python installed?** Make a small venv for LoRA Lab (keeps your system
Python clean) and install numpy — one-time, ~30 seconds:

```powershell
python -m venv C:\lora-lab-venv
C:\lora-lab-venv\Scripts\python -m pip install numpy
```

Then open the gear menu (⚙) in LoRA Lab and set the python path to:

```
C:\lora-lab-venv\Scripts\python.exe
```

**No Python at all?** Install it from https://www.python.org/downloads/
(tick "Add python.exe to PATH" in the installer), then run
`python -m pip install numpy`. LoRA Lab will find it on PATH automatically.

If the app shows a "failed to launch python" error, it's always one of the
above — the gear-menu path is the fix.

## Install

Grab the installer from [Releases](../../releases), or build from source:

```powershell
bun install
bun run tauri build     # release exe + installer in src-tauri/target/release
bun run tauri:dev       # development
```

## Usage

1. Point it at your LoRA folder → **Scan**
2. Click a file → read the verdict. Peak σ ≤ ~5 = stackable as-is.
   Peak σ in the teens with stable rank ≈ 1 = will break stacking.
3. **Clip → new file** (cap 5 is the proven default) → use the `_sclip5` file
   in ComfyUI instead of the original. Raise LoRA strength a touch if the
   effect feels softer.

## How it works

- Frontend: Tauri v2, vanilla JS, canvas chart
- Math: a single embedded Python script (stdlib + numpy). Per layer it QR-reduces
  the low-rank factors and SVDs only the tiny rank×rank core, so analysis never
  materializes full weight matrices. Clipping re-factors `B·A` with singular
  values clamped and writes standard bf16 safetensors.

Verdict thresholds: healthy = peak σ ≤ 5.5 · spiked = peak ≥ 8 with median
stable rank < 3 · borderline = between.

## Related

- On-the-fly alternative for ComfyUI: the `sigma_cap` control in
  [comfyui-lora-loader](https://github.com/CoreyCorza/comfyui-lora-loader)
  applies the same clamp at LoRA load time — no pre-processed files needed.
