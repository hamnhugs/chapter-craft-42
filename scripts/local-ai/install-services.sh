#!/usr/bin/env bash
# Install the local edition's AI services. Runs as YOUR user (no sudo),
# idempotent — re-running skips whatever is already in place.
#
#   Ollama models   chat, vision, research, embeddings
#   Piper           text-to-speech (+3 voices)                -> venv
#   whisper.cpp     speech-to-text, Vulkan build (+base.en)   -> built from source
#   sd.cpp          image generation, Vulkan build (+Z-Image-Turbo) -> built from source
#
# Everything lands in ~/.local/share/chapter-craft-local (override: CC_HOME).
# Sizes: ~9 GB of models on top of what Ollama already has.
set -euo pipefail

CC_HOME="${CC_HOME:-$HOME/.local/share/chapter-craft-local}"
SRC="$CC_HOME/src"; PREFIX="$CC_HOME/prefix"; VENV="$CC_HOME/venv"
JOBS="$(nproc)"
say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

mkdir -p "$SRC" "$PREFIX" "$CC_HOME/voices" "$CC_HOME/image-models"

# --- Ollama models ---------------------------------------------------------
# Choices and evidence: docs/local-ai/PLAN.md, docs/local-ai/results/.
if have ollama; then
  for m in hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K qwen3:4b-instruct-2507-q4_K_M qwen3.5:4b qwen3:8b embeddinggemma:300m; do
    if ollama show "$m" >/dev/null 2>&1; then say "ollama: $m present"; else say "ollama pull $m"; ollama pull "$m"; fi
  done
else
  echo "Ollama is not installed (pacman -S ollama ollama-vulkan). Skipping models." >&2
fi

# --- Python venv: Piper + cmake (cmake via pip: no system package needed) ---
if [ ! -x "$VENV/bin/python" ]; then say "creating venv"; python3 -m venv "$VENV"; fi
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/python" -c "import piper" 2>/dev/null || { say "installing piper-tts"; "$VENV/bin/pip" install -q "piper-tts[http]"; }
[ -x "$VENV/bin/cmake" ] || { say "installing cmake"; "$VENV/bin/pip" install -q cmake; }
CMAKE="$VENV/bin/cmake"

for v in en_US-lessac-medium en_US-amy-medium en_GB-alan-medium; do
  [ -f "$CC_HOME/voices/$v.onnx" ] || { say "voice $v"; "$VENV/bin/python" -m piper.download_voices --download-dir "$CC_HOME/voices" "$v"; }
done

# --- Vulkan + SPIR-V headers (header-only; Arch's vulkan-headers would need root)
clone() { [ -d "$SRC/$2" ] || git clone -q --depth 1 ${3:-} "$1" "$SRC/$2"; }
clone https://github.com/KhronosGroup/Vulkan-Headers.git Vulkan-Headers
clone https://github.com/KhronosGroup/SPIRV-Headers.git SPIRV-Headers
if [ ! -d "$PREFIX/share/cmake/SPIRV-Headers" ] && [ ! -d "$PREFIX/share/SPIRV-Headers" ]; then
  say "installing SPIRV-Headers to $PREFIX"
  "$CMAKE" -S "$SRC/SPIRV-Headers" -B "$SRC/SPIRV-Headers/build" -DCMAKE_INSTALL_PREFIX="$PREFIX" -DSPIRV_HEADERS_ENABLE_TESTS=OFF >/dev/null
  "$CMAKE" --install "$SRC/SPIRV-Headers/build" >/dev/null
fi
cp -r "$SRC/Vulkan-Headers/include/." "$PREFIX/include/"
have glslc || { echo "glslc missing (pacman -S shaderc) — needed for the Vulkan builds." >&2; exit 1; }
VK_FLAGS=(-DCMAKE_PREFIX_PATH="$PREFIX" -DVulkan_INCLUDE_DIR="$PREFIX/include" -DGGML_CCACHE=OFF -DCMAKE_BUILD_TYPE=Release)

# --- whisper.cpp (speech-to-text) -------------------------------------------
clone https://github.com/ggml-org/whisper.cpp.git whisper.cpp
if [ ! -x "$SRC/whisper.cpp/build/bin/whisper-server" ]; then
  say "building whisper.cpp (Vulkan)"
  "$CMAKE" -S "$SRC/whisper.cpp" -B "$SRC/whisper.cpp/build" -DGGML_VULKAN=ON -DWHISPER_BUILD_TESTS=OFF "${VK_FLAGS[@]}" >/dev/null
  "$CMAKE" --build "$SRC/whisper.cpp/build" -j"$JOBS" --target whisper-server >/dev/null
fi
[ -f "$SRC/whisper.cpp/models/ggml-base.en.bin" ] || { say "whisper model base.en"; bash "$SRC/whisper.cpp/models/download-ggml-model.sh" base.en >/dev/null; }

# --- stable-diffusion.cpp (images) -------------------------------------------
clone https://github.com/leejet/stable-diffusion.cpp.git stable-diffusion.cpp "--recursive --shallow-submodules"
if [ ! -x "$SRC/stable-diffusion.cpp/build/bin/sd-server" ]; then
  say "building stable-diffusion.cpp (Vulkan)"
  "$CMAKE" -S "$SRC/stable-diffusion.cpp" -B "$SRC/stable-diffusion.cpp/build" -DSD_VULKAN=ON "${VK_FLAGS[@]}" >/dev/null
  "$CMAKE" --build "$SRC/stable-diffusion.cpp/build" -j"$JOBS" >/dev/null
fi
IM="$CC_HOME/image-models"
dl() { [ -s "$IM/$1" ] || { say "downloading $1"; curl -fSL --retry 3 -o "$IM/$1.part" "$2" && [ "$(stat -c%s "$IM/$1.part")" -gt 1000000 ] && mv "$IM/$1.part" "$IM/$1"; }; }
dl TwinFlow_Z_Image_Turbo_exp-Q4_K.gguf https://huggingface.co/wbruna/TwinFlow-Z-Image-Turbo-sdcpp-GGUF/resolve/main/TwinFlow_Z_Image_Turbo_exp-Q4_K.gguf
# Comfy-Org mirror: black-forest-labs/FLUX.1-schnell is gated (needs a login).
dl ae.safetensors https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors
# Text encoder = Qwen3-4B-Instruct-2507 Q4_K_M, the same file as Ollama's Q4 chat
# model: link Ollama's blob instead of downloading 2.5 GB twice.
TE="$IM/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
if [ ! -s "$TE" ]; then
  BLOB="$(ollama show qwen3:4b-instruct-2507-q4_K_M --modelfile 2>/dev/null | awk '/^FROM \//{print $2; exit}')"
  if [ -n "$BLOB" ] && [ -r "$BLOB" ]; then ln -sf "$BLOB" "$TE"; say "text encoder linked from Ollama"
  else rm -f "$TE"; dl Qwen3-4B-Instruct-2507-Q4_K_M.gguf https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf; fi
fi

say "done. Start everything with: scripts/local-up.sh"
