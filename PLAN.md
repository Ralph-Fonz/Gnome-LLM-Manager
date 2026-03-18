# GNOME LLM Manager — Extension Project Plan

> A GNOME Shell extension to monitor and control local LLM services (Ollama) from the top bar.

## System Baseline

| Component       | Version / Detail                          |
|-----------------|-------------------------------------------|
| OS              | Manjaro (Arch-based)                      |
| GNOME Shell     | 49.4 (ESModules, GNOME 45+ API)          |
| GJS             | 1.86.0                                    |
| Ollama          | 0.18.1 (`/usr/local/bin/ollama`)          |
| GPU             | AMD RX 6600 XT (eGPU via OCuLink)        |
| Node.js         | v25.6.1                                   |

---

## Feature Tiers

### Must Have
- [x] Top-bar panel icon with LLM service status (green/red/grey)
- [ ] Detect running LLMs and service state via Ollama API
- [ ] Dropdown listing loaded models
- [ ] Start / Stop / Restart Ollama service from the menu

### Possible
- [ ] Display model context window size (via `/api/show`)
- [ ] GPU utilization (AMD sysfs: `gpu_busy_percent`)
- [ ] GPU VRAM usage (`mem_info_vram_used`)
- [ ] CPU load (`/proc/stat`)

### Nice to Have
- [ ] GSettings preferences panel (`prefs.js`)
- [ ] Publish to [extensions.gnome.org](https://extensions.gnome.org)
- [ ] AUR package

---

## Architecture

```
ollama (localhost:11434)
        │
        ▼
┌───────────────────┐
│  GNOME Extension  │
│                   │
│  PanelMenu.Button │ ◄── top-bar icon
│  ├─ Model list    │
│  ├─ Status badges │
│  ├─ Start/Stop    │
│  ├─ GPU / CPU     │
│  └─ Context info  │
└───────────────────┘
        │
        ▼
  Gio.Subprocess ──► systemctl start/stop ollama
  Soup.Session   ──► GET/POST localhost:11434/api/*
  GLib.File      ──► /sys/class/drm/card*/device/*
  GLib.timeout   ──► poll loop (configurable interval)
```

---

## File Structure

```
gnome-llm-manager/
├── PLAN.md                          # This file
├── src/
│   ├── metadata.json                # Extension ID, shell versions, etc.
│   ├── extension.js                 # Main entry (ESModule)
│   ├── prefs.js                     # Settings UI
│   ├── stylesheet.css               # Panel & popup styles
│   ├── icons/
│   │   └── llm-symbolic.svg         # Top-bar symbolic icon
│   └── schemas/
│       └── org.gnome.shell.extensions.llm-manager.gschema.xml
├── polkit/
│   └── org.llm-manager.manage.policy  # Passwordless systemctl (optional)
├── scripts/
│   ├── install.sh                   # ln -s to ~/.local/share/gnome-shell/extensions/
│   └── pack.sh                      # gnome-extensions pack wrapper
├── .gitignore
├── LICENSE
└── README.md
```

---

## Phases

### Phase 1 — Scaffold & Panel Icon
1. Create `metadata.json` targeting GNOME Shell 49.
2. Implement `extension.js` with a `PanelMenu.Button`.
3. Add a symbolic SVG icon.
4. Icon colour reflects Ollama service state:
   - **Green** — service running, models loaded
   - **Yellow** — service running, no models loaded
   - **Red** — service stopped
   - **Grey** — unknown / checking
5. Symlink into `~/.local/share/gnome-shell/extensions/` for dev testing.
6. Test: `gnome-extensions enable llm-manager@gnome.local`

### Phase 2 — Service Detection & Control
7. Poll `GET http://localhost:11434/api/tags` on a GLib timer.
8. Parse response → list model names, sizes, families in the dropdown.
9. Add Start / Stop / Restart menu items calling `systemctl` via `Gio.Subprocess`.
10. (Optional) Install polkit policy for passwordless service control.

### Phase 3 — Context Window & Model Info
11. For each model, call `POST /api/show` → extract:
    - `context_length`
    - `parameter_size`
    - `quantization_level`
12. Display as sub-items or a detail popup.

### Phase 4 — GPU / CPU Monitoring
13. Read AMD GPU utilization: `/sys/class/drm/card*/device/gpu_busy_percent`
14. Read VRAM: `/sys/class/drm/card*/device/mem_info_vram_used` + `mem_info_vram_total`
15. Read CPU from `/proc/stat` (calculate delta-based %).
16. Render as text labels or mini progress bars in the dropdown.

### Phase 5 — Settings & Publish
17. Add `prefs.js` with configurable:
    - Poll interval (seconds)
    - Ollama host + port
    - Toggle GPU/CPU display
18. Add GSettings schema + compile step.
19. Package: `gnome-extensions pack src/`
20. Submit `.zip` to [extensions.gnome.org](https://extensions.gnome.org).
21. (Optional) Create AUR `PKGBUILD`.

---

## Key APIs & References

| Resource | URL |
|----------|-----|
| GNOME Shell Extension Guide (45+) | https://gjs.guide/extensions/ |
| GJS API Docs | https://gjs-docs.gnome.org/ |
| Ollama API | https://github.com/ollama/ollama/blob/main/docs/api.md |
| AMD GPU sysfs | `gpu_busy_percent`, `mem_info_vram_used` under `/sys/class/drm/` |
| EGO Review Guidelines | https://gjs.guide/extensions/review-guidelines/review-guidelines.html |
| Polkit Manual | `man polkit`, `man pkexec` |

---

## Dev Workflow

```bash
# Install for development (symlink)
ln -sf "$(pwd)/src" ~/.local/share/gnome-shell/extensions/llm-manager@gnome.local

# Compile schemas
glib-compile-schemas src/schemas/

# Reload GNOME Shell (Wayland: log out/in; X11: Alt+F2 → r)
busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…")'

# Enable
gnome-extensions enable llm-manager@gnome.local

# View logs
journalctl -f -o cat /usr/bin/gnome-shell

# Pack for release
gnome-extensions pack src/ --extra-source=icons --extra-source=schemas
```

---

## Notes
- GNOME 49 requires ESModule syntax (`import` / `export default class`).
- Wayland does not support `Alt+F2 → r` restart; must log out/in or use nested shell for testing.
- AMD sysfs paths may vary by kernel version; detect card dynamically.
- Ollama API is unauthenticated by default on localhost — no auth handling needed initially.
