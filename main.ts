import { App, MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";

/** Which corner of the active pane the zoom indicator is anchored to. */
const INDICATOR_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
type IndicatorCorner = (typeof INDICATOR_CORNERS)[number];

function isIndicatorCorner(value: string): value is IndicatorCorner {
  return (INDICATOR_CORNERS as readonly string[]).includes(value);
}

interface ZscrollSettings {
  /** How much each wheel notch changes the zoom factor. */
  zoomStep: number;
  /** Smallest allowed zoom factor. */
  minZoom: number;
  /** Largest allowed zoom factor. */
  maxZoom: number;
  /** Whether to flash the zoom-percentage indicator on change. */
  showIndicator: boolean;
  /** Corner of the active pane the indicator is anchored to. */
  indicatorCorner: IndicatorCorner;
  /** Horizontal gap (px) from the chosen corner. */
  indicatorOffsetX: number;
  /** Vertical gap (px) from the chosen corner. */
  indicatorOffsetY: number;
}

const DEFAULT_SETTINGS: ZscrollSettings = {
  zoomStep: 0.1,
  minZoom: 0.3,
  maxZoom: 5.0,
  showIndicator: true,
  indicatorCorner: "top-right",
  indicatorOffsetX: 20,
  indicatorOffsetY: 40,
};

/** Where to place the indicator: a corner plus px offsets from it. */
interface IndicatorPosition {
  corner: IndicatorCorner;
  offsetX: number;
  offsetY: number;
}

/** The markdown view-content wrapper (inside a `.workspace-leaf`) whose child we scale. */
const MARKDOWN_CONTENT_SELECTOR = '.workspace-leaf-content[data-type="markdown"]';

/** How long the zoom indicator stays visible after the last change, in ms. */
const INDICATOR_HIDE_DELAY = 900;

/**
 * A small fading badge that shows the current zoom percentage in a chosen corner of the
 * pane being zoomed (a muted "zoom:" label over the accent-colored percentage). Lives on
 * `document.body` (not inside the scaled content) so it is never itself transformed. Owns a
 * `setTimeout` and a DOM element, so callers must `destroy()` it on unload to clear the
 * timer and remove the element.
 */
class ZoomIndicator {
  private readonly el: HTMLElement;
  private readonly valueEl: HTMLElement;
  private hideTimer: number | null = null;

  constructor() {
    this.el = document.body.createDiv({ cls: "zscroll-indicator" });
    this.el.createDiv({ cls: "zscroll-indicator-label", text: "Zoom:" });
    this.valueEl = this.el.createDiv({ cls: "zscroll-indicator-value" });
  }

  /** Flash `text` at the configured corner of `anchor` (the pane), then fade out. */
  show(text: string, anchor: HTMLElement, pos: IndicatorPosition): void {
    this.valueEl.setText(text);
    this.position(anchor, pos);
    this.el.addClass("is-visible");

    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
    }
    this.hideTimer = window.setTimeout(() => {
      this.el.removeClass("is-visible");
      this.hideTimer = null;
    }, INDICATOR_HIDE_DELAY);
  }

  private position(anchor: HTMLElement, pos: IndicatorPosition): void {
    const rect = anchor.getBoundingClientRect();
    // Clear all edges first so a corner change never leaves a stale one set.
    for (const edge of ["top", "bottom", "left", "right"] as const) {
      this.el.style.removeProperty(edge);
    }
    if (pos.corner.startsWith("top")) {
      this.el.style.top = `${rect.top + pos.offsetY}px`;
    } else {
      this.el.style.bottom = `${window.innerHeight - rect.bottom + pos.offsetY}px`;
    }
    if (pos.corner.endsWith("left")) {
      this.el.style.left = `${rect.left + pos.offsetX}px`;
    } else {
      this.el.style.right = `${window.innerWidth - rect.right + pos.offsetX}px`;
    }
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
      this.indicator?.show(`${Math.round(factor * 100)}%`, pane, {
        corner: this.settings.indicatorCorner,
        offsetX: this.settings.indicatorOffsetX,
        offsetY: this.settings.indicatorOffsetY,
      });
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
      .setDesc("Flash the current zoom percentage on the pane when the zoom changes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showIndicator)
          .onChange(async (value) => {
            this.plugin.settings.showIndicator = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Indicator corner")
      .setDesc("Which corner of the active pane the indicator is anchored to.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            "top-left": "Top left",
            "top-right": "Top right",
            "bottom-left": "Bottom left",
            "bottom-right": "Bottom right",
          })
          .setValue(this.plugin.settings.indicatorCorner)
          .onChange(async (value) => {
            if (isIndicatorCorner(value)) {
              this.plugin.settings.indicatorCorner = value;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Horizontal offset (px)")
      .setDesc("Gap from the chosen corner along the horizontal edge.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.indicatorOffsetX))
          .setValue(String(this.plugin.settings.indicatorOffsetX))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed) && parsed >= 0) {
              this.plugin.settings.indicatorOffsetX = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Vertical offset (px)")
      .setDesc("Gap from the chosen corner along the vertical edge.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.indicatorOffsetY))
          .setValue(String(this.plugin.settings.indicatorOffsetY))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed) && parsed >= 0) {
              this.plugin.settings.indicatorOffsetY = parsed;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
