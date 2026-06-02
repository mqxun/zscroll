import { App, MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";

interface ZscrollSettings {
  /** How much each wheel notch changes the zoom factor. */
  zoomStep: number;
  /** Smallest allowed zoom factor. */
  minZoom: number;
  /** Largest allowed zoom factor. */
  maxZoom: number;
}

const DEFAULT_SETTINGS: ZscrollSettings = {
  zoomStep: 0.1,
  minZoom: 0.3,
  maxZoom: 5.0,
};

/** Markdown leaf content elements whose `.view-content` we may scale. */
const MARKDOWN_LEAF_SELECTOR = '.workspace-leaf-content[data-type="markdown"]';

export default class ZscrollPlugin extends Plugin {
  settings: ZscrollSettings = DEFAULT_SETTINGS;

  /**
   * Content elements we have applied a transform to, mapped to their current zoom
   * factor. Kept so `onunload` can reset every touched element. Zoom is intentionally
   * never persisted — it resets to 100% each session.
   */
  private readonly scaled = new Map<HTMLElement, number>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new ZscrollSettingTab(this.app, this));

    // Capture phase + non-passive: we must run before the editor and be allowed to
    // preventDefault(), otherwise Electron applies its own global Ctrl+wheel zoom.
    this.registerDomEvent(document, "wheel", this.onWheel, {
      passive: false,
      capture: true,
    });

    this.addCommand({
      id: "reset-zoom",
      name: "Reset zoom of active note",
      callback: () => this.resetActiveZoom(),
    });
  }

  onunload(): void {
    for (const el of this.scaled.keys()) {
      this.clearZoom(el);
    }
    this.scaled.clear();
  }

  private readonly onWheel = (evt: WheelEvent): void => {
    if (!evt.ctrlKey) {
      return; // Plain scroll — leave it alone.
    }

    const el = this.resolveContentEl(evt.target);
    if (!el) {
      return;
    }

    // Suppress Electron's global zoom and the editor's default scroll for this event.
    evt.preventDefault();
    evt.stopPropagation();

    const current = this.scaled.get(el) ?? 1;
    const direction = evt.deltaY < 0 ? 1 : -1; // wheel up = zoom in
    const next = this.clampZoom(current + direction * this.settings.zoomStep);

    if (next === current) {
      return;
    }
    this.applyZoom(el, next);
  };

  /** Find the scalable `.view-content` of the markdown leaf under the event target. */
  private resolveContentEl(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    const leaf = target.closest(MARKDOWN_LEAF_SELECTOR);
    if (!leaf) {
      return null;
    }
    return leaf.querySelector<HTMLElement>(".view-content");
  }

  /** Round (to curb float drift) and clamp into the configured zoom range. */
  private clampZoom(value: number): number {
    const rounded = Math.round(value * 1000) / 1000;
    return Math.min(this.settings.maxZoom, Math.max(this.settings.minZoom, rounded));
  }

  private applyZoom(el: HTMLElement, factor: number): void {
    if (factor === 1) {
      this.clearZoom(el);
      this.scaled.delete(el);
      return;
    }
    // Enlarge the layout box by 1/factor so that after scaling, the element's visual
    // footprint still matches the pane and its scroll container reserves correct space.
    el.style.transformOrigin = "0 0";
    el.style.transform = `scale(${factor})`;
    el.style.width = `${100 / factor}%`;
    el.style.height = `${100 / factor}%`;
    this.scaled.set(el, factor);
  }

  private clearZoom(el: HTMLElement): void {
    el.style.removeProperty("transform");
    el.style.removeProperty("transform-origin");
    el.style.removeProperty("width");
    el.style.removeProperty("height");
  }

  private resetActiveZoom(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const el = view?.containerEl.querySelector<HTMLElement>(".view-content");
    if (el) {
      this.clearZoom(el);
      this.scaled.delete(el);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class ZscrollSettingTab extends PluginSettingTab {
  private readonly plugin: ZscrollPlugin;

  constructor(app: App, plugin: ZscrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Zoom step")
      .setDesc("How much each mouse-wheel notch changes the zoom (e.g. 0.1 = 10%).")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.zoomStep))
          .setValue(String(this.plugin.settings.zoomStep))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed) && parsed > 0) {
              this.plugin.settings.zoomStep = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Minimum zoom")
      .setDesc("Smallest allowed zoom factor (e.g. 0.3 = 30%).")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.minZoom))
          .setValue(String(this.plugin.settings.minZoom))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed) && parsed > 0) {
              this.plugin.settings.minZoom = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Maximum zoom")
      .setDesc("Largest allowed zoom factor (e.g. 5 = 500%).")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxZoom))
          .setValue(String(this.plugin.settings.maxZoom))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed) && parsed > 0) {
              this.plugin.settings.maxZoom = parsed;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
