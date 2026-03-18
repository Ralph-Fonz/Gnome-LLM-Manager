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
        this._serviceRunning = false;
        this._gpuSysfs = findAmdGpuSysfs();
        this._cpuTracker = new CpuTracker();

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

        // GPU / CPU section
        this._statsSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._statsSection);

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

        // Running/loaded models
        if (this._models.length > 0) {
            const header = new PopupMenu.PopupMenuItem('⚡ Loaded Models', {reactive: false});
            header.label.add_style_class_name('llm-section-title');
            this._modelSection.addMenuItem(header);

            for (const model of this._models) {
                const name = model.name || 'unknown';
                const size = model.size ? formatBytes(model.size) : '';
                const vramStr = model.size_vram ? ` | VRAM: ${formatBytes(model.size_vram)}` : '';
                const expiresAt = model.expires_at ? ` | expires: ${new Date(model.expires_at).toLocaleTimeString()}` : '';

                const item = new PopupMenu.PopupMenuItem(`  ${name}`);
                item.label.add_style_class_name('llm-model-name');

                // Add detail sublabel
                if (size || vramStr) {
                    const detailText = `    ${size}${vramStr}${expiresAt}`;
                    const detailItem = new PopupMenu.PopupMenuItem(detailText, {reactive: false});
                    detailItem.label.add_style_class_name('llm-model-detail');
                    this._modelSection.addMenuItem(item);
                    this._modelSection.addMenuItem(detailItem);

                    // Fetch context window info on click
                    item.connect('activate', () => {
                        this._fetchModelInfo(name, (info) => {
                            const params = info.details?.parameter_size || '?';
                            const quant = info.details?.quantization_level || '?';
                            // Extract context length from model info
                            let ctxLen = '?';
                            if (info.model_info) {
                                // Look through model_info keys for context_length
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
                } else {
                    this._modelSection.addMenuItem(item);
                }
            }
        }

        // Available (pulled) models
        if (this._availableModels && this._availableModels.length > 0) {
            this._modelSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const availHeader = new PopupMenu.PopupMenuItem('📦 Available Models', {reactive: false});
            availHeader.label.add_style_class_name('llm-section-title');
            this._modelSection.addMenuItem(availHeader);

            for (const model of this._availableModels) {
                const name = model.name || 'unknown';
                const size = model.size ? formatBytes(model.size) : '';
                const isLoaded = this._models.some(m => m.name === name);
                const prefix = isLoaded ? '● ' : '○ ';

                const item = new PopupMenu.PopupMenuItem(`  ${prefix}${name}  ${size}`, {reactive: false});
                item.label.add_style_class_name('llm-model-item');
                this._modelSection.addMenuItem(item);
            }
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
