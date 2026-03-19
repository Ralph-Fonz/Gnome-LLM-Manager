# LLM Manager — Arch Linux - GNOME Shell Extension

A GNOME Shell panel extension to monitor and control local LLM services (Ollama) from the top bar.

## Features

- **Panel icon** with colour-coded status (green / yellow / red)
- **Model list** — see loaded and available models
- **Start / Stop / Restart** Ollama service directly from the menu
- **GPU stats** — AMD GPU utilization and VRAM usage
- **CPU stats** — overall CPU load
- **Click a model** to see context window size, parameter count, and quantisation level

## Requirements

- GNOME Shell 47–49
- [Ollama](https://ollama.com) installed and configured as a systemd service
- AMD GPU (for GPU stats — optional)

## Install (Development)

```bash
bash scripts/install.sh
```

Then log out and back in (Wayland) or press `Alt+F2 → r` (X11).

## Build for Release

```bash
bash scripts/pack.sh
```

Produces a `.shell-extension.zip` in the project root, ready for upload to [extensions.gnome.org](https://extensions.gnome.org).

## Configuration

Open GNOME Extensions app → LLM Manager → Settings, or:

```bash
gnome-extensions prefs llm-manager@gnome.local
```

| Setting | Default | Description |
|---------|---------|-------------|
| Host | `127.0.0.1` | Ollama server address |
| Port | `11434` | Ollama server port |
| Poll Interval | `5` sec | Status check frequency |
| Show GPU Stats | `true` | Display GPU utilisation |
| Show CPU Stats | `false` | Display CPU load |

## License

MIT
