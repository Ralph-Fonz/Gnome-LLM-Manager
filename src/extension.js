/**
 * LLM Manager — GNOME Shell Extension
 *
 * Monitors and controls local LLM services (Ollama) from the top bar.
 * Requires GNOME Shell 45+ (ESModule format).
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const GPU_DROPIN_DIR = '/etc/systemd/system/ollama.service.d';
const GPU_DROPIN_FILE = `${GPU_DROPIN_DIR}/99-gpu.conf`;

// Curated model catalog — shown in "Download a Model" submenus.
// prefix matching against _availableModels to mark pulled/loaded status.
const POPULAR_MODELS = [
    {
        family: 'Llama 3',
        models: [
            {name: 'llama3.2:1b',  desc: '1B · ultralight'},
            {name: 'llama3.2:3b',  desc: '3B · light'},
            {name: 'llama3:8b',    desc: '8B · balanced'},
            {name: 'llama3:70b',   desc: '70B · powerful'},
        ],
    },
    {
        family: 'Mistral',
        models: [
            {name: 'mistral:7b',     desc: '7B'},
            {name: 'mistral-small',  desc: 'Small'},
            {name: 'mistral-large',  desc: 'Large'},
        ],
    },
    {
        family: 'Gemma 3',
        models: [
            {name: 'gemma3:1b',   desc: '1B'},
            {name: 'gemma3:4b',   desc: '4B'},
            {name: 'gemma3:12b',  desc: '12B'},
            {name: 'gemma3:27b',  desc: '27B'},
        ],
    },
    {
        family: 'Phi 4',
        models: [
            {name: 'phi4-mini', desc: '3.8B · fast'},
            {name: 'phi4',      desc: '14B'},
        ],
    },
    {
        family: 'Qwen 2.5',
        models: [
            {name: 'qwen2.5:7b',        desc: '7B'},
            {name: 'qwen2.5:14b',       desc: '14B'},
            {name: 'qwen2.5:32b',       desc: '32B'},
            {name: 'qwen2.5-coder:7b',  desc: 'Coder 7B'},
        ],
    },
    {
        family: 'DeepSeek R1',
        models: [
            {name: 'deepseek-r1:7b',  desc: '7B'},
            {name: 'deepseek-r1:14b', desc: '14B'},
            {name: 'deepseek-r1:32b', desc: '32B'},
        ],
    },
    {
        family: 'Code',
        models: [
            {name: 'codellama:7b',       desc: 'CodeLlama 7B'},
            {name: 'codellama:13b',      desc: 'CodeLlama 13B'},
            {name: 'qwen2.5-coder:14b',  desc: 'Qwen2.5 Coder 14B'},
        ],
    },
    {
        family: 'Embeddings',
        models: [
            {name: 'nomic-embed-text',   desc: 'Nomic Embed'},
            {name: 'mxbai-embed-large',  desc: 'MixedBread Embed'},
        ],
    },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Read a single-line sysfs file and return its trimmed contents, or null.
 */
function readSysfs(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (ok) {
            const decoder = new TextDecoder();
            return decoder.decode(contents).trim();
        }
    } catch (_e) {
        // file may not exist on this system
    }
    return null;
}

/**
 * Find the AMD GPU sysfs directory (first card with amdgpu driver).
 */
function findAmdGpuSysfs() {
    const drmDir = '/sys/class/drm';
    try {
        const dir = Gio.File.new_for_path(drmDir);
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.startsWith('card') || name.includes('-')) continue;
            const gpuBusy = `${drmDir}/${name}/device/gpu_busy_percent`;
            if (GLib.file_test(gpuBusy, GLib.FileTest.EXISTS)) {
                return `${drmDir}/${name}/device`;
            }
        }
    } catch (_e) {
        // ignore
    }
    return null;
}

/**
 * Get a human-readable GPU name from its sysfs device path.
 * Falls back to VRAM-based labels (dGPU vs APU) or a generic index label.
 */
function getGpuName(devicePath, fallbackIndex) {
    const product = readSysfs(`${devicePath}/product_name`);
    if (product) return product;

    const vramTotal = readSysfs(`${devicePath}/mem_info_vram_total`);
    if (vramTotal) {
        const gb = parseInt(vramTotal) / (1024 ** 3);
        return gb < 2
            ? `Integrated GPU / APU (${gb.toFixed(1)} GB)`
            : `Discrete GPU (${gb.toFixed(0)} GB VRAM)`;
    }
    return `GPU ${fallbackIndex}`;
}

// ---------------------------------------------------------------------------
// CPU load tracker (delta-based from /proc/stat)
// ---------------------------------------------------------------------------

class CpuTracker {
    constructor() {
        this._prev = null;
    }

    /** Returns CPU usage percent (0-100) since last call, or -1 if unavailable. */
    sample() {
        const line = readSysfs('/proc/stat');
        if (!line) return -1;

        // First line: cpu  user nice system idle iowait irq softirq steal ...
        const firstLine = line.split('\n')[0];
        const parts = firstLine.split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + parts[4]; // idle + iowait
        const total = parts.reduce((a, b) => a + b, 0);

        if (!this._prev) {
            this._prev = {idle, total};
            return -1;
        }

        const dTotal = total - this._prev.total;
        const dIdle = idle - this._prev.idle;
        this._prev = {idle, total};

        if (dTotal === 0) return 0;
        return Math.round(((dTotal - dIdle) / dTotal) * 100);
    }
}

// ---------------------------------------------------------------------------
// Main Extension
// ---------------------------------------------------------------------------

export default class LlmManagerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._soupSession = new Soup.Session({timeout: 5});
        this._models = [];
        this._availableModels = [];
        this._serviceRunning = false;
        this._gpuSysfs = findAmdGpuSysfs();
        this._cpuTracker = new CpuTracker();
        this._gpus = [];          // detected AMD GPU list [{devicePath, name, rocmIndex}]
        this._pullingModel = null; // name of model currently being pulled

        this._buildUI();
        this._startPolling();
    }

    disable() {
        this._stopPolling();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }

        this._settings = null;
        this._cpuTracker = null;
        this._gpus = null;
        this._pullingModel = null;
    }

    // -----------------------------------------------------------------------
    // UI Construction
    // -----------------------------------------------------------------------

    _buildUI() {
        this._indicator = new PanelMenu.Button(0.0, 'LLM Manager', false);

        // Panel icon
        const iconPath = this.path + '/icons/llm-symbolic.svg';
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon,
            style_class: 'system-status-icon llm-icon-unknown',
        });
        this._indicator.add_child(this._icon);

        // --- Popup menu ---
        const menu = this._indicator.menu;

        // Status header
        this._statusItem = new PopupMenu.PopupMenuItem('Ollama: checking…', {reactive: false});
        menu.addMenuItem(this._statusItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Model list section
        this._modelSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._modelSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // GPU / CPU stats section
        this._statsSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._statsSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // GPU switcher section
        this._gpuSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._gpuSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Service control buttons
        this._startItem = new PopupMenu.PopupMenuItem('▶  Start Ollama');
        this._startItem.connect('activate', () => this._controlService('start'));
        menu.addMenuItem(this._startItem);

        this._stopItem = new PopupMenu.PopupMenuItem('■  Stop Ollama');
        this._stopItem.connect('activate', () => this._controlService('stop'));
        menu.addMenuItem(this._stopItem);

        this._restartItem = new PopupMenu.PopupMenuItem('⟳  Restart Ollama');
        this._restartItem.connect('activate', () => this._controlService('restart'));
        menu.addMenuItem(this._restartItem);

        Main.panel.addToStatusArea('llm-manager', this._indicator);
    }

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    _startPolling() {
        // Run immediately, then on interval
        this._poll();
        const interval = this._settings.get_int('poll-interval');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _poll() {
        this._fetchModels();
        this._updateStats();
        this._refreshGpuSection();
    }

    // -----------------------------------------------------------------------
    // Ollama API
    // -----------------------------------------------------------------------

    _getBaseUrl() {
        const host = this._settings.get_string('ollama-host');
        const port = this._settings.get_int('ollama-port');
        return `http://${host}:${port}`;
    }

    /**
     * Fetch running/loaded models from Ollama API.
     */
    _fetchModels() {
        const url = `${this._getBaseUrl()}/api/ps`;
        const message = Soup.Message.new('GET', url);

        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.get_status() === Soup.Status.OK) {
                        const decoder = new TextDecoder();
                        const text = decoder.decode(bytes.get_data());
                        const data = JSON.parse(text);
                        this._serviceRunning = true;
                        this._models = data.models || [];
                        this._updateUI();

                        // Also fetch full model list (available, not necessarily loaded)
                        this._fetchAvailableModels();
                    } else {
                        this._setOffline();
                    }
                } catch (_e) {
                    this._setOffline();
                }
            },
        );
    }

    /**
     * Fetch all locally available models (pulled, not necessarily running).
     */
    _fetchAvailableModels() {
        const url = `${this._getBaseUrl()}/api/tags`;
        const message = Soup.Message.new('GET', url);

        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.get_status() === Soup.Status.OK) {
                        const decoder = new TextDecoder();
                        const text = decoder.decode(bytes.get_data());
                        const data = JSON.parse(text);
                        this._availableModels = data.models || [];
                        this._updateModelSection();
                    }
                } catch (_e) {
                    // non-critical
                }
            },
        );
    }

    /**
     * Fetch detailed info for a specific model (context window, params, quant).
     */
    _fetchModelInfo(modelName, callback) {
        const url = `${this._getBaseUrl()}/api/show`;
        const message = Soup.Message.new('POST', url);
        const body = JSON.stringify({name: modelName});
        message.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(body)),
        );

        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.get_status() === Soup.Status.OK) {
                        const decoder = new TextDecoder();
                        const text = decoder.decode(bytes.get_data());
                        const data = JSON.parse(text);
                        callback(data);
                    }
                } catch (_e) {
                    // ignore
                }
            },
        );
    }

    // -----------------------------------------------------------------------
    // Service Control
    // -----------------------------------------------------------------------

    _controlService(action) {
        try {
            const proc = Gio.Subprocess.new(
                ['pkexec', 'systemctl', action, 'ollama'],
                Gio.SubprocessFlags.NONE,
            );
            proc.wait_async(null, (_proc, result) => {
                try {
                    proc.wait_finish(result);
                    // Poll immediately after control action
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                        this._poll();
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (_e) {
                    // user may have cancelled pkexec
                }
            });
        } catch (e) {
            log(`[LLM Manager] Failed to ${action} ollama: ${e.message}`);
        }
    }

    // -----------------------------------------------------------------------
    // UI Updates
    // -----------------------------------------------------------------------

    _setOffline() {
        this._serviceRunning = false;
        this._models = [];
        this._availableModels = [];
        this._updateUI();
    }

    _updateUI() {
        // Update icon style
        const styleClasses = ['system-status-icon'];
        if (!this._serviceRunning) {
            styleClasses.push('llm-icon-stopped');
            this._statusItem.label.set_text('Ollama: stopped');
        } else if (this._models.length > 0) {
            styleClasses.push('llm-icon-running');
            this._statusItem.label.set_text(`Ollama: ${this._models.length} model(s) loaded`);
        } else {
            styleClasses.push('llm-icon-idle');
            this._statusItem.label.set_text('Ollama: running (idle)');
        }
        this._icon.set_style_class_name(styleClasses.join(' '));

        // Toggle control buttons
        this._startItem.visible = !this._serviceRunning;
        this._stopItem.visible = this._serviceRunning;
        this._restartItem.visible = this._serviceRunning;

        this._updateModelSection();
    }

    _updateModelSection() {
        this._modelSection.removeAll();

        if (!this._serviceRunning) {
            this._modelSection.addMenuItem(
                new PopupMenu.PopupMenuItem('  Service not running', {reactive: false}),
            );
            return;
        }

        // ---- Active / loaded model ----------------------------------------
        const activeHeader = new PopupMenu.PopupMenuItem('⚡ Active Model', {reactive: false});
        activeHeader.label.add_style_class_name('llm-section-title');
        this._modelSection.addMenuItem(activeHeader);

        if (this._models.length > 0) {
            for (const model of this._models) {
                const name = model.name || 'unknown';
                const vramStr = model.size_vram ? `  VRAM: ${formatBytes(model.size_vram)}` : '';
                const item = new PopupMenu.PopupMenuItem(`  ● ${name}${vramStr}`);
                item.label.add_style_class_name('llm-model-name');
                item.connect('activate', () => {
                    this._fetchModelInfo(name, (info) => {
                        const params = info.details?.parameter_size || '?';
                        const quant = info.details?.quantization_level || '?';
                        let ctxLen = '?';
                        if (info.model_info) {
                            for (const key of Object.keys(info.model_info)) {
                                if (key.includes('context_length')) {
                                    ctxLen = info.model_info[key].toLocaleString();
                                    break;
                                }
                            }
                        }
                        Main.notify(
                            'LLM Manager',
                            `${name}\nParams: ${params} | Quant: ${quant} | Context: ${ctxLen}`,
                        );
                    });
                });
                this._modelSection.addMenuItem(item);

                const unloadItem = new PopupMenu.PopupMenuItem(`    ○ Unload`);
                unloadItem.label.add_style_class_name('llm-model-detail');
                unloadItem.connect('activate', () => this._unloadModel(name));
                this._modelSection.addMenuItem(unloadItem);
            }
        } else {
            const noneItem = new PopupMenu.PopupMenuItem(
                '  No model loaded — select one below to load', {reactive: false},
            );
            noneItem.label.add_style_class_name('llm-model-detail');
            this._modelSection.addMenuItem(noneItem);
        }

        // ---- Locally pulled models (switch between them) -------------------
        if (this._availableModels && this._availableModels.length > 0) {
            this._modelSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const localHeader = new PopupMenu.PopupMenuItem('📦 Local Models', {reactive: false});
            localHeader.label.add_style_class_name('llm-section-title');
            this._modelSection.addMenuItem(localHeader);

            for (const model of this._availableModels) {
                const name = model.name || 'unknown';
                const size = model.size ? `  ${formatBytes(model.size)}` : '';
                const isLoaded = this._models.some(m => m.name === name);

                if (isLoaded) {
                    const item = new PopupMenu.PopupMenuItem(`  ⚡ ${name}${size}`, {reactive: false});
                    item.label.add_style_class_name('llm-model-item');
                    this._modelSection.addMenuItem(item);
                } else {
                    const item = new PopupMenu.PopupMenuItem(`  ○ ${name}${size}`);
                    item.label.add_style_class_name('llm-model-item');
                    item.connect('activate', () => this._loadModel(name));
                    this._modelSection.addMenuItem(item);
                }
            }
        }

        // ---- Download catalog (popular models organised by family) ---------
        this._modelSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const dlHeader = new PopupMenu.PopupMenuItem('📥 Download a Model', {reactive: false});
        dlHeader.label.add_style_class_name('llm-section-title');
        this._modelSection.addMenuItem(dlHeader);

        for (const family of POPULAR_MODELS) {
            const pulledCount = family.models.filter(m =>
                this._availableModels?.some(a => a.name === m.name),
            ).length;
            const suffix = pulledCount > 0 ? `  (${pulledCount}/${family.models.length})` : '';
            const sub = new PopupMenu.PopupSubMenuMenuItem(`  ${family.family}${suffix}`);

            for (const m of family.models) {
                const isPulled = this._availableModels?.some(a => a.name === m.name);
                const isLoaded = this._models.some(a => a.name === m.name);
                const prefix = isLoaded ? '⚡' : isPulled ? '✓' : '○';
                const statusNote = isLoaded ? ' (loaded)' : isPulled ? ' (pulled)' : '';

                const modelItem = new PopupMenu.PopupMenuItem(
                    `  ${prefix} ${m.name}  ${m.desc}${statusNote}`,
                );
                if (isLoaded) {
                    modelItem.connect('activate', () => this._unloadModel(m.name));
                } else if (isPulled) {
                    modelItem.connect('activate', () => this._loadModel(m.name));
                } else {
                    modelItem.connect('activate', () => this._pullModel(m.name));
                }
                sub.menu.addMenuItem(modelItem);
            }
            this._modelSection.addMenuItem(sub);
        }

        // Link to full Ollama library
        const browseItem = new PopupMenu.PopupMenuItem('  🌐 Browse all models…');
        browseItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri_async(
                'https://ollama.com/library', null, null, null,
            );
        });
        this._modelSection.addMenuItem(browseItem);

        // ---- Search / pull entry for custom model names --------------------
        this._modelSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._modelSection.addMenuItem(this._buildPullEntry());
    }

    // -----------------------------------------------------------------------
    // Model Load / Unload / Pull
    // -----------------------------------------------------------------------

    /**
     * Load a model into Ollama memory (keep_alive = -1 → indefinite).
     */
    _loadModel(name) {
        const url = `${this._getBaseUrl()}/api/generate`;
        const message = Soup.Message.new('POST', url);
        const body = JSON.stringify({model: name, prompt: '', keep_alive: -1, stream: false});
        message.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(body)),
        );
        Main.notify('LLM Manager', `Loading ${name}…`);
        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (_session, result) => {
                try {
                    _session.send_and_read_finish(result);
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                        this._poll();
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (_e) {
                    // ignore
                }
            },
        );
    }

    /**
     * Unload a model from Ollama memory (keep_alive = 0).
     */
    _unloadModel(name) {
        const url = `${this._getBaseUrl()}/api/generate`;
        const message = Soup.Message.new('POST', url);
        const body = JSON.stringify({model: name, prompt: '', keep_alive: 0, stream: false});
        message.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(body)),
        );
        this._soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (_session, result) => {
                try {
                    _session.send_and_read_finish(result);
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                        this._poll();
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (_e) {
                    // ignore
                }
            },
        );
    }

    /**
     * Pull (download) a model using the `ollama pull` CLI.
     * Shows a start notification and refreshes when done.
     */
    _pullModel(name) {
        if (this._pullingModel) {
            Main.notify('LLM Manager', `Already pulling ${this._pullingModel}, please wait.`);
            return;
        }
        this._pullingModel = name;
        Main.notify('LLM Manager', `Pulling ${name}… (this may take a while)`);

        try {
            const proc = Gio.Subprocess.new(
                ['ollama', 'pull', name],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            );
            proc.wait_async(null, (_proc, result) => {
                try {
                    const success = proc.wait_finish(result);
                    const exitOk = proc.get_exit_status() === 0;
                    Main.notify(
                        'LLM Manager',
                        exitOk ? `✓ ${name} pulled successfully.` : `✗ Failed to pull ${name}.`,
                    );
                } catch (_e) {
                    Main.notify('LLM Manager', `Pull cancelled or failed for ${name}.`);
                } finally {
                    this._pullingModel = null;
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                        this._fetchAvailableModels();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        } catch (e) {
            this._pullingModel = null;
            Main.notify('LLM Manager', `Could not start pull: ${e.message}`);
        }
    }

    /**
     * Build a custom menu item containing a text entry + pull button.
     */
    _buildPullEntry() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});

        const box = new St.BoxLayout({
            x_expand: true,
            style_class: 'llm-pull-box',
        });

        const entry = new St.Entry({
            x_expand: true,
            hint_text: 'model:tag  (e.g. llama3:8b)',
            style_class: 'llm-pull-entry',
            can_focus: true,
        });

        const btn = new St.Button({
            label: '⬇ Pull',
            style_class: 'llm-pull-btn',
            can_focus: true,
        });

        const doPull = () => {
            const name = entry.get_text().trim();
            if (name) {
                entry.set_text('');
                this._pullModel(name);
            }
        };

        entry.clutter_text.connect('activate', doPull);
        btn.connect('clicked', doPull);

        box.add_child(entry);
        box.add_child(btn);
        item.add_child(box);
        return item;
    }

    // -----------------------------------------------------------------------
    // GPU Enumeration & Switching
    // -----------------------------------------------------------------------

    /**
     * Enumerate all AMD GPU cards in /sys/class/drm, sorted by card number.
     * Returns [{devicePath, name, rocmIndex}].
     */
    _enumerateGpus() {
        const gpus = [];
        const drmDir = '/sys/class/drm';
        try {
            const dir = Gio.File.new_for_path(drmDir);
            const enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
            const cardNames = [];
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.startsWith('card') || name.includes('-')) continue;
                cardNames.push(name);
            }
            cardNames.sort((a, b) => {
                return parseInt(a.replace('card', '')) - parseInt(b.replace('card', ''));
            });

            let rocmIdx = 0;
            for (const cardName of cardNames) {
                const devicePath = `${drmDir}/${cardName}/device`;
                if (!GLib.file_test(`${devicePath}/gpu_busy_percent`, GLib.FileTest.EXISTS))
                    continue;
                gpus.push({
                    devicePath,
                    name: getGpuName(devicePath, rocmIdx),
                    rocmIndex: rocmIdx,
                });
                rocmIdx++;
            }
        } catch (_e) {
            // ignore
        }
        return gpus;
    }

    /**
     * Re-enumerate GPUs and rebuild the GPU switcher section if the list changed.
     */
    _refreshGpuSection() {
        const newGpus = this._enumerateGpus();
        const changed =
            newGpus.length !== this._gpus.length ||
            newGpus.some((g, i) => g.devicePath !== this._gpus[i]?.devicePath);

        if (changed) {
            this._gpus = newGpus;
            // Keep primary sysfs path up to date for stats display
            const preferred = this._settings.get_int('preferred-gpu-index');
            const idx = preferred >= 0 && preferred < this._gpus.length ? preferred : 0;
            this._gpuSysfs = this._gpus[idx]?.devicePath ?? null;
            this._buildGpuSection();
        }
    }

    /**
     * Rebuild the GPU radio-button section in the menu.
     */
    _buildGpuSection() {
        this._gpuSection.removeAll();

        if (this._gpus.length === 0) return;

        const header = new PopupMenu.PopupMenuItem('🖥 GPU for Ollama', {reactive: false});
        header.label.add_style_class_name('llm-section-title');
        this._gpuSection.addMenuItem(header);

        const selectedIdx = this._settings.get_int('preferred-gpu-index');

        // "Auto" option (index = -1)
        const autoLabel = selectedIdx === -1 ? '● Auto (let Ollama decide)' : '○ Auto (let Ollama decide)';
        const autoItem = new PopupMenu.PopupMenuItem(`  ${autoLabel}`);
        autoItem.connect('activate', () => this._switchGpu(-1));
        this._gpuSection.addMenuItem(autoItem);

        for (const gpu of this._gpus) {
            const active = selectedIdx === gpu.rocmIndex;
            const prefix = active ? '●' : '○';
            const item = new PopupMenu.PopupMenuItem(`  ${prefix} ${gpu.name}`);
            item.connect('activate', () => this._switchGpu(gpu.rocmIndex));
            this._gpuSection.addMenuItem(item);
        }
    }

    /**
     * Switch Ollama to a specific AMD ROCm GPU index (or -1 for auto).
     * Writes (or removes) a systemd drop-in and restarts the service.
     */
    _switchGpu(rocmIndex) {
        this._settings.set_int('preferred-gpu-index', rocmIndex);

        // Update stats sysfs path immediately
        if (rocmIndex >= 0 && rocmIndex < this._gpus.length) {
            this._gpuSysfs = this._gpus[rocmIndex].devicePath;
        } else if (this._gpus.length > 0) {
            this._gpuSysfs = this._gpus[0].devicePath;
        }
        this._buildGpuSection();

        let script;
        if (rocmIndex >= 0) {
            script = [
                `mkdir -p "${GPU_DROPIN_DIR}"`,
                `printf '[Service]\\nEnvironment="ROCR_VISIBLE_DEVICES=${rocmIndex}"\\n'` +
                    ` > "${GPU_DROPIN_FILE}"`,
                'systemctl daemon-reload',
                'systemctl restart ollama',
            ].join(' && ');
        } else {
            script = [
                `rm -f "${GPU_DROPIN_FILE}"`,
                'systemctl daemon-reload',
                'systemctl restart ollama',
            ].join(' && ');
        }

        try {
            const proc = Gio.Subprocess.new(
                ['pkexec', 'sh', '-c', script],
                Gio.SubprocessFlags.NONE,
            );
            proc.wait_async(null, (_proc, result) => {
                try {
                    proc.wait_finish(result);
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                        this._poll();
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (_e) {
                    // user may have cancelled pkexec
                }
            });
        } catch (e) {
            log(`[LLM Manager] Failed to switch GPU: ${e.message}`);
        }
    }

    _updateStats() {
        if (!this._statsSection) return;
        this._statsSection.removeAll();

        // GPU stats
        if (this._settings.get_boolean('show-gpu-stats') && this._gpuSysfs) {
            const gpuBusy = readSysfs(`${this._gpuSysfs}/gpu_busy_percent`);
            const vramUsed = readSysfs(`${this._gpuSysfs}/mem_info_vram_used`);
            const vramTotal = readSysfs(`${this._gpuSysfs}/mem_info_vram_total`);

            if (gpuBusy !== null) {
                const gpuItem = new PopupMenu.PopupMenuItem(
                    `  GPU: ${gpuBusy}%`, {reactive: false},
                );
                gpuItem.label.add_style_class_name('llm-stat-row');
                this._statsSection.addMenuItem(gpuItem);
            }

            if (vramUsed !== null && vramTotal !== null) {
                const used = formatBytes(parseInt(vramUsed));
                const total = formatBytes(parseInt(vramTotal));
                const pct = Math.round((parseInt(vramUsed) / parseInt(vramTotal)) * 100);
                const vramItem = new PopupMenu.PopupMenuItem(
                    `  VRAM: ${used} / ${total} (${pct}%)`, {reactive: false},
                );
                vramItem.label.add_style_class_name('llm-stat-row');
                this._statsSection.addMenuItem(vramItem);
            }
        }

        // CPU stats
        if (this._settings.get_boolean('show-cpu-stats')) {
            const cpuPct = this._cpuTracker.sample();
            if (cpuPct >= 0) {
                const cpuItem = new PopupMenu.PopupMenuItem(
                    `  CPU: ${cpuPct}%`, {reactive: false},
                );
                cpuItem.label.add_style_class_name('llm-stat-row');
                this._statsSection.addMenuItem(cpuItem);
            }
        }
    }
}
