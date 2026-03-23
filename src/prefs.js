/**
 * LLM Manager — Preferences (Settings) UI
 *
 * GNOME 45+ prefs use Adw (libadwaita).
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LlmManagerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // --- Main page ---
        const page = new Adw.PreferencesPage({
            title: 'LLM Manager',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // --- Connection group ---
        const connGroup = new Adw.PreferencesGroup({
            title: 'Ollama Connection',
            description: 'Configure how the extension connects to Ollama.',
        });
        page.add(connGroup);

        // Host
        const hostRow = new Adw.EntryRow({
            title: 'Host',
            text: settings.get_string('ollama-host'),
        });
        hostRow.connect('changed', () => {
            settings.set_string('ollama-host', hostRow.get_text());
        });
        connGroup.add(hostRow);

        // Port
        const portAdj = new Gtk.Adjustment({
            lower: 1,
            upper: 65535,
            step_increment: 1,
            value: settings.get_int('ollama-port'),
        });
        const portRow = new Adw.SpinRow({
            title: 'Port',
            adjustment: portAdj,
        });
        portRow.connect('notify::value', () => {
            settings.set_int('ollama-port', portRow.get_value());
        });
        connGroup.add(portRow);

        // Poll interval
        const pollAdj = new Gtk.Adjustment({
            lower: 1,
            upper: 60,
            step_increment: 1,
            value: settings.get_int('poll-interval'),
        });
        const pollRow = new Adw.SpinRow({
            title: 'Poll Interval (seconds)',
            subtitle: 'How often to check Ollama status',
            adjustment: pollAdj,
        });
        pollRow.connect('notify::value', () => {
            settings.set_int('poll-interval', pollRow.get_value());
        });
        connGroup.add(pollRow);

        // --- Monitoring group ---
        const monGroup = new Adw.PreferencesGroup({
            title: 'Monitoring',
            description: 'Toggle hardware monitoring displays.',
        });
        page.add(monGroup);

        // GPU stats
        const gpuRow = new Adw.SwitchRow({
            title: 'Show GPU Statistics',
            subtitle: 'AMD GPU utilization and VRAM usage',
        });
        settings.bind('show-gpu-stats', gpuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        monGroup.add(gpuRow);

        // CPU stats
        const cpuRow = new Adw.SwitchRow({
            title: 'Show CPU Statistics',
            subtitle: 'Overall CPU load percentage',
        });
        settings.bind('show-cpu-stats', cpuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        monGroup.add(cpuRow);

        // --- GPU group ---
        const gpuGroup = new Adw.PreferencesGroup({
            title: 'GPU Selection',
            description: 'Choose which AMD GPU Ollama uses (sets ROCR_VISIBLE_DEVICES). ' +
                'Requires a service restart (from the panel menu) to take effect. ' +
                '-1 = Auto.',
        });
        page.add(gpuGroup);

        const gpuAdj = new Gtk.Adjustment({
            lower: -1,
            upper: 7,
            step_increment: 1,
            value: settings.get_int('preferred-gpu-index'),
        });
        const gpuRow = new Adw.SpinRow({
            title: 'GPU Index (ROCR_VISIBLE_DEVICES)',
            subtitle: '-1 = Auto  |  0 = first AMD GPU  |  1 = second AMD GPU  …',
            adjustment: gpuAdj,
        });
        gpuRow.connect('notify::value', () => {
            settings.set_int('preferred-gpu-index', gpuRow.get_value());
        });
        gpuGroup.add(gpuRow);
    }
}
