import { App, MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";

interface ZscrollSettings {
  /** How much each wheel notch changes the zoom factor. */
  zoomStep: number;
  /** Smallest allowed zoom factor. */
  minZoom: number;
  /** Largest allowed zoom factor. */
  maxZoom: number;
  /** Whether to flash the zoom-percentage indicator on change. */
  showIndicator: boolean;
}

const DEFAULT_SETTINGS: ZscrollSettings = {
  zoomStep: 0.1,
  minZoom: 0.3,
  maxZoom: 5.0,
  showIndicator: true,
};

/** The markdown view-content wrapper (inside a `.workspace-leaf`) whose child we scale. */
const MARKDOWN_CONTENT_SELECTOR = '.workspace-leaf-content[data-type="markdown"]';

/** How long the zoom indicator stays visible after the last change, in ms. */
const INDICATOR_HIDE_DELAY = 900;

/**
 * A small fading badge that shows the current zoom percentage in the top-right corner of
 * the pane being zoomed. Lives on `document.body` (not inside the scaled content) so it is
 * never itself transformed. Owns a `setTimeout`, so callers must `destroy()` it on unload.
 */
class ZoomIndicator {
  private readonly el: HTMLElement;
  private hideTimer: number | null = null;

  constructor() {
    this.el = document.body.createDiv({ cls: "zscroll-indicator" });
  }

  /** Flash `text` at the top-right of `anchor` (the pane), then fade out. */
  show(text: string, anchor: HTMLElement): void {
    this.el.setText(text);

    const rect = anchor.getBoundingClientRect();
    this.el.style.top = `${rect.top + 16}px`;
    this.el.style.right = `${window.innerWidth - rect.right + 16}px`;
    this.el.addClass("is-visible");

    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
    }
    this.hideTimer = window.setTimeout(() => {
      this.el.removeClass("is-visible");
      this.hideTimer = null;
    }, INDICATOR_HIDE_DELAY);
  }

  destroy(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.el.remove();
  }
}

export default class ZscrollPlugin extends Plugin {
  settings: ZscrollSettings = DEFAULT_SETTINGS;

  /**
   * Content elements we have applied a transform to, mapped to their current zoom
   * factor. Kept so `onunload` can reset every touched element. Zoom is intentionally
   * never persisted — it resets to 100% each session.
   */
  private readonly scaled = new Map<HTMLElement, number>();

  private indicator: ZoomIndicator | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.indicator = new ZoomIndicator();
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
    this.indicator?.destroy();
    this.indicator = null;
  }

  private readonly onWheel = (evt: WheelEvent): void => {
    if (!evt.ctrlKey) {
      return; // Plain scroll — leave it alone.
    }

    const target = this.resolveTarget(evt.target);
    if (!target) {
      return;
    }

    // Suppress Electron's global zoom and the editor's default scroll for this event.
    evt.preventDefault();
    evt.stopPropagation();

    const { pane, content } = target;
    const current = this.scaled.get(content) ?? 1;
    const direction = evt.deltaY < 0 ? 1 : -1; // wheel up = zoom in
    const next = this.clampZoom(current + direction * this.settings.zoomStep);

    // Show feedback even when clamped at a limit, but only re-apply on an actual change.
    this.flashIndicator(next, pane);
    if (next !== current) {
      this.applyZoom(content, next);
    }
  };

  /**
   * Resolve the markdown pane under the event target along with its scalable
   * `.view-content`. The pane element is unscaled, so it anchors the indicator correctly.
   */
  private resolveTarget(
    target: EventTarget | null
  ): { pane: HTMLElement; content: HTMLElement } | null {
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    const pane = target.closest<HTMLElement>(".workspace-leaf");
    const content = pane
      ?.querySelector(MARKDOWN_CONTENT_SELECTOR)
      ?.querySelector<HTMLElement>(".view-content");
    if (!pane || !content) {
      return null;
    }
    return { pane, content };
  }

  /** Flash the zoom percentage on the given pane, when the indicator is enabled. */
  private flashIndicator(factor: number, pane: HTMLElement): void {
    if (this.settings.showIndicator) {
      this.indicator?.show(`${Math.round(factor * 100)}%`, pane);
    }
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
    if (!view) {
      return;
    }
    const el = view.containerEl.querySelector<HTMLElement>(".view-content");
    if (el) {
      this.clearZoom(el);
      this.scaled.delete(el);
    }
    // Anchor the badge to the view container itself (avoids reverse-walking the DOM).
    this.flashIndicator(1, view.containerEl);
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

    new Setting(containerEl)
      .setName("Show zoom indicator")
      .setDesc("Flash the current zoom percentage in the top-right of the pane on change.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showIndicator)
          .onChange(async (value) => {
            this.plugin.settings.showIndicator = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
