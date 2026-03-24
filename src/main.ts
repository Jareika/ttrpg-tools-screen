import {
  Component,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type {
  App,
  Editor,
  MarkdownPostProcessorContext,
  MarkdownView,
  ViewStateResult,
} from "obsidian";

interface ScreenDisplaySettings {
  autoOpenOnSend: boolean;
  savedWindowX?: number;
  savedWindowY?: number;
  savedWindowWidth?: number;
  savedWindowHeight?: number;
}

const DEFAULT_SETTINGS: ScreenDisplaySettings = {
  autoOpenOnSend: true,
  savedWindowX: undefined,
  savedWindowY: undefined,
  savedWindowWidth: undefined,
  savedWindowHeight: undefined,
};

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
};

interface MapFogViewSnapshot {
  worldWidth: number;
  worldHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  tx: number;
  ty: number;
}

interface RenderBox {
  width: number;
  height: number;
}

const SCREEN_VIEW_TYPE = "ttrpg-tools-screen-view";
const SCREEN_FOG_CONTROLLER_VIEW_TYPE = "ttrpg-tools-screen-fog-controller";

interface ScreenFogState {
  enabled: true;
  key: string;
  label?: string;
}

type ScreenPayload =
  | { kind: "note"; path: string; fog?: ScreenFogState }
  | { kind: "markdown"; markdown: string; sourcePath: string; fog?: ScreenFogState }
  | { kind: "image"; source: string; filePath?: string; fog?: ScreenFogState }
  | { kind: "pdf"; source: string; filePath?: string; fog?: ScreenFogState };

interface HeadingCacheEntry {
  heading: string;
  level: number;
  position: {
    start: { line: number };
    end: { line: number };
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isScreenFogState(x: unknown): x is ScreenFogState {
  if (!isRecord(x)) return false;
  return x.enabled === true && typeof x.key === "string";
}

function isScreenPayload(x: unknown): x is ScreenPayload {
  if (!isRecord(x) || typeof x.kind !== "string") return false;

  const fogOk =
    !("fog" in x) ||
    x.fog === undefined ||
    isScreenFogState(x.fog);
  if (!fogOk) return false;

  if (x.kind === "note") return typeof x.path === "string";
  if (x.kind === "markdown") {
    return typeof x.markdown === "string" && typeof x.sourcePath === "string";
  }
  if (x.kind === "image") return typeof x.source === "string";
  if (x.kind === "pdf") return typeof x.source === "string";
  return false;
}

function isImageExt(ext: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"].includes(ext);
}

function isPdfExt(ext: string): boolean {
  return ext === "pdf";
}

function stripFrontmatter(text: string): string {
  const m = /^---\n[\s\S]*?\n(?:---|\.\.\.)\n/.exec(text);
  if (!m) return text;
  return text.slice(m[0].length);
}

function normalizeHeadingSection(lines: string[]): string {
  return `${lines.join("\n").trimEnd()}\n`;
}

function isFinitePositiveNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function setCssProps(el: HTMLElement, props: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null) {
      el.style.removeProperty(key);
    } else {
      el.style.setProperty(key, value);
    }
  }
}

abstract class BaseRenderedScreenView extends ItemView {
  protected plugin: TTRPGToolsScreenPlugin;
  protected renderComponent: Component | null = null;
  protected renderedPayload: ScreenPayload | null = null;
  protected stageEl: HTMLElement | null = null;
  protected fogOverlay: ScreenFogOverlay | null = null;
  private stageSizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TTRPGToolsScreenPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  protected abstract getRenderHost(): HTMLElement;
  protected abstract isFogInteractive(): boolean;
  
  protected getPreferredStageSize(): RenderBox | null {
    return null;
  }

  protected onStageSizeApplied(_box: RenderBox): void {
    // subclasses may hook
  }

  public refreshStageSizeVars(): void {
    this.applyStageSizeVars();
  }

  protected teardownStageSizeSync(): void {
    this.stageSizeObserver?.disconnect();
    this.stageSizeObserver = null;
  }

  async setPayload(payload: ScreenPayload): Promise<void> {
    const statePayload = payload;
    const nextType =
      statePayload.fog?.enabled && this.isFogInteractive()
        ? SCREEN_FOG_CONTROLLER_VIEW_TYPE
        : SCREEN_VIEW_TYPE;

    await this.leaf.setViewState({
      type: nextType,
      active: true,
      state: { payload: statePayload },
    });
  }

  getState(): Record<string, unknown> {
    return this.renderedPayload ? { payload: this.renderedPayload } : {};
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    if (!isRecord(state)) return;
    const payload = state.payload;
    if (!isScreenPayload(payload)) return;
    await this.renderPayload(payload);
  }

  async renderPayload(payload: ScreenPayload): Promise<void> {
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.fogOverlay?.destroy();
    this.fogOverlay = null;
	this.teardownStageSizeSync();
    this.stageEl = null;
    this.renderedPayload = payload;

    const host = this.getRenderHost();
    host.empty();

    if (payload.kind === "note") {
      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (!(file instanceof TFile)) {
        host.createEl("div", { text: `Note not found: ${payload.path}` });
        return;
      }

      const raw = await this.app.vault.read(file);
      const markdown = stripFrontmatter(raw);
      await this.renderMarkdown(host, markdown, file.path);
      await this.setupFogIfNeeded(payload);
      return;
    }

    if (payload.kind === "markdown") {
      await this.renderMarkdown(host, payload.markdown, payload.sourcePath);
      await this.setupFogIfNeeded(payload);
      return;
    }

    if (payload.kind === "image") {
      this.renderImage(host, payload.source);
      await this.setupFogIfNeeded(payload);
      return;
    }

    if (payload.kind === "pdf") {
      this.renderPdf(host, payload.source);
      return;
    }
  }

  async onFogMaskUpdated(key: string, dataUrl: string | null): Promise<void> {
    if (!this.renderedPayload?.fog?.enabled) return;
    if (this.renderedPayload.fog.key !== key) return;
    await this.fogOverlay?.applyMaskFromDataUrl(dataUrl);
  }

  private async setupFogIfNeeded(payload: ScreenPayload): Promise<void> {
    if (!payload.fog?.enabled) return;
    if (!this.stageEl) return;

    this.fogOverlay = new ScreenFogOverlay(
      this.plugin,
      this,
      this.stageEl,
      payload.fog,
      this.isFogInteractive(),
    );
    await this.fogOverlay.attach();
  }

  protected renderImage(host: HTMLElement, source: string): void {
    const wrap = host.createDiv({ cls: "ttrpg-tools-screen-media" });
	const stage = wrap.createDiv({ cls: "ttrpg-tools-screen-media-stage ttrpg-tools-screen-stage" });
    const img = stage.createEl("img");
    img.src = source;
    this.stageEl = stage;
	this.installStageSizeSync();
  }

  protected renderPdf(host: HTMLElement, source: string): void {
    const wrap = host.createDiv({ cls: "ttrpg-tools-screen-media" });
    const iframe = wrap.createEl("iframe");
    iframe.src = source;
  }

  protected async renderMarkdown(host: HTMLElement, markdown: string, sourcePath: string): Promise<void> {
    const isMapOnly = /```zoommap[\s\S]*```/m.test(markdown.trim());

    const wrapper = host.createDiv({
      cls:
        "markdown-preview-view markdown-rendered ttrpg-tools-screen-markdown" +
        (isMapOnly ? " ttrpg-tools-screen-markdown--map" : "") +
        " ttrpg-tools-screen-stage",
    });
    this.stageEl = wrapper;

    const component = new Component();
    this.renderComponent = component;
    this.addChild(component);

    await MarkdownRenderer.render(
      this.app,
      markdown,
      wrapper,
      sourcePath,
      component,
    );

    this.installInternalLinkHandling(wrapper, sourcePath);
	this.installStageSizeSync();
  }
  
  private installStageSizeSync(): void {
    this.teardownStageSizeSync();
    if (!this.stageEl) return;

    const host = this.getRenderHost();
    const apply = () => this.applyStageSizeVars();
    apply();

    this.stageSizeObserver = new ResizeObserver(() => apply());
    if (host instanceof HTMLElement) this.stageSizeObserver.observe(host);
    if (this.stageEl !== host) this.stageSizeObserver.observe(this.stageEl);
  }

  private applyStageSizeVars(): void {
    if (!this.stageEl) return;

    const preferred = this.getPreferredStageSize();
    const host = this.getRenderHost();

    const width = Math.round(
      preferred?.width ??
      host.clientWidth ??
      this.stageEl.clientWidth ??
      0,
    );
    const height = Math.round(
      preferred?.height ??
      host.clientHeight ??
      this.stageEl.clientHeight ??
      0,
    );

    if (width < 2 || height < 2) return;

    setCssProps(this.stageEl, {
      "--ttrpg-screen-avail-w": `${width}px`,
      "--ttrpg-screen-avail-h": `${height}px`,
    });

    this.onStageSizeApplied({ width, height });
  }

  protected installInternalLinkHandling(container: HTMLElement, sourcePath: string): void {
    container.addEventListener(
      "click",
      (ev) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;

        const link = target.closest("a.internal-link");
        if (!(link instanceof HTMLAnchorElement)) return;

        const raw =
          link.getAttribute("data-href") ??
          link.getAttribute("href") ??
          link.textContent ??
          "";

        const file = this.plugin.resolveVaultFile(raw, sourcePath);
        if (!(file instanceof TFile)) return;

        ev.preventDefault();
        ev.stopPropagation();

        const ext = file.extension?.toLowerCase() ?? "";
        if (ext === "md") {
          void this.plugin.sendNoteByPath(file.path);
        } else if (isPdfExt(ext)) {
          void this.plugin.sendPdfByPath(file.path);
        } else if (isImageExt(ext)) {
          void this.plugin.sendImageByPath(file.path);
        }
      },
      { capture: true },
    );
  }
}

class ScreenFogOverlay {
  private plugin: TTRPGToolsScreenPlugin;
  private owner: BaseRenderedScreenView;
  private stageEl: HTMLElement;
  private overlayHostEl: HTMLElement | null = null;
  private fog: ScreenFogState;
  private interactive: boolean;

  private targetEl: HTMLElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private overlayMode: "map" | "media" = "media";
  private brushPreviewEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private publishTimer: number | null = null;
  private mapWorldEl: HTMLElement | null = null;
  private worldMaskCanvas: HTMLCanvasElement | null = null;
  private worldMaskCtx: CanvasRenderingContext2D | null = null;
  private worldMaskInitialized = false;
  private pendingMaskDataUrl: string | null | undefined = undefined;
  private mapMutationObserver: MutationObserver | null = null;
  private mapRenderRaf: number | null = null;

  private brushRadius = 40;
  private brushMode: "reveal" | "cover" = "reveal";
  private activeTool: "reveal" | "cover" = "reveal";
  private isDrawing = false;

  constructor(
    plugin: TTRPGToolsScreenPlugin,
    owner: BaseRenderedScreenView,
    stageEl: HTMLElement,
    fog: ScreenFogState,
    interactive: boolean,
  ) {
    this.plugin = plugin;
    this.owner = owner;
    this.stageEl = stageEl;
    this.fog = fog;
    this.interactive = interactive;
  }

  supportsKey(key: string): boolean {
    return this.fog.key === key;
  }

  getBrushRadius(): number {
    return this.brushRadius;
  }

  setBrushRadius(value: number): void {
    const next = Math.min(200, Math.max(5, Math.round(value)));
    this.brushRadius = next;
    this.updateBrushPreviewSize();
  }

  getBrushMode(): "reveal" | "cover" {
    return this.brushMode;
  }

  setBrushMode(mode: "reveal" | "cover"): void {
    this.brushMode = mode;
    this.updateBrushPreviewStyle();
  }

  async attach(): Promise<void> {
    const found = this.findTarget();
    if (!found) return;
    this.targetEl = found.target;
    this.overlayHostEl = found.host;
    this.overlayMode = found.mode;
	this.mapWorldEl = found.world ?? null;

    const win = this.overlayHostEl.ownerDocument.defaultView ?? window;
    const computed = win.getComputedStyle(this.overlayHostEl);
    if (computed.position === "static") {
      setCssProps(this.overlayHostEl, { position: "relative" });
    }

    this.canvasEl = this.overlayHostEl.createEl("canvas", {
      cls:
        "ttrpg-tools-screen-fog-layer" +
        (this.interactive ? " ttrpg-tools-screen-fog-layer--interactive" : ""),
    });
    setCssProps(this.canvasEl, {
      position: "absolute",
      "touch-action": "none",
      opacity: this.interactive ? "0.45" : "1",
      "pointer-events": this.interactive ? "auto" : "none",
	  "z-index": this.overlayMode === "map" ? "20" : "40",
    });

    const ctx = this.canvasEl.getContext("2d");
    if (!ctx) return;
    this.ctx = ctx;

    if (this.interactive) {
      this.brushPreviewEl = this.overlayHostEl.createDiv({
        cls: "ttrpg-tools-screen-fog-brush",
      });
      setCssProps(this.brushPreviewEl, {
        position: "absolute",
        left: "0",
        top: "0",
        opacity: "0",
        transform: "translate(-9999px, -9999px)",
		"z-index": this.overlayMode === "map" ? "61" : "41",
      });
      this.updateBrushPreviewSize();
      this.updateBrushPreviewStyle();
      this.installInteractions();
    }

    this.resizeObserver = new ResizeObserver(() => {
      void this.relayout();
    });
    if (this.overlayHostEl) {
      this.resizeObserver.observe(this.overlayHostEl);
    }
    this.resizeObserver.observe(this.targetEl);
    if (this.mapWorldEl) {
      this.resizeObserver.observe(this.mapWorldEl);
      this.installMapObservers();
    }

    await this.relayout();

    const existing = this.plugin.getFogMask(this.fog.key);
    await this.applyMaskFromDataUrl(existing);
  }

  destroy(): void {
    if (this.publishTimer !== null) {
      window.clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    if (this.mapRenderRaf !== null) {
      window.cancelAnimationFrame(this.mapRenderRaf);
      this.mapRenderRaf = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mapMutationObserver?.disconnect();
    this.mapMutationObserver = null;
    this.canvasEl?.remove();
    this.brushPreviewEl?.remove();
    this.canvasEl = null;
    this.brushPreviewEl = null;
    this.ctx = null;
    this.targetEl = null;
	this.overlayHostEl = null;
    this.mapWorldEl = null;
    this.worldMaskCanvas = null;
    this.worldMaskCtx = null;
    this.worldMaskInitialized = false;
    this.pendingMaskDataUrl = undefined;
  }

  async applyMaskFromDataUrl(dataUrl: string | null | undefined): Promise<void> {
    if (this.overlayMode === "map") {
      if (!this.ensureWorldMaskBufferFromMap()) {
        this.pendingMaskDataUrl = dataUrl ?? null;
        return;
      }

      this.pendingMaskDataUrl = undefined;
      await this.applyWorldMaskFromDataUrl(dataUrl ?? null);
      this.worldMaskInitialized = true;
      this.renderWorldMaskToViewport();
      return;
    }

    if (!this.canvasEl || !this.ctx) return;
    const rect = this.getCanvasCssRect();
    if (!rect || rect.width < 2 || rect.height < 2) return;

    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.clearRect(0, 0, rect.width, rect.height);

    if (!dataUrl) {
      this.fillFullFogViewport();
      return;
    }

    const img = new Image();
    const ok = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = dataUrl;
    });

    if (!ok) {
      this.fillFullFogViewport();
      return;
    }

    this.ctx.drawImage(img, 0, 0, rect.width, rect.height);
  }

  async fillFullFogAndPublish(): Promise<void> {
    if (this.overlayMode === "map") {
      this.fillFullFogWorld();
      this.renderWorldMaskToViewport();
    } else {
      this.fillFullFogViewport();
    }
    await this.publishNow();
  }

  async clearFogAndPublish(): Promise<void> {
    if (this.overlayMode === "map") {
      if (!this.worldMaskCtx || !this.worldMaskCanvas) return;
      this.worldMaskCtx.clearRect(0, 0, this.worldMaskCanvas.width, this.worldMaskCanvas.height);
      this.renderWorldMaskToViewport();
    } else {
      if (!this.ctx) return;
      const rect = this.getCanvasCssRect();
      if (!rect) return;
      this.ctx.clearRect(0, 0, rect.width, rect.height);
    }
    await this.publishNow();
  }

  private findTarget():
    | { target: HTMLElement; host: HTMLElement; mode: "map" | "media"; world?: HTMLElement }
    | null {
    const mapRoot = this.stageEl.querySelector(".zm-root");
    const viewport = mapRoot?.querySelector(".zm-viewport");
    const world = mapRoot?.querySelector(".zm-world");
    if (mapRoot instanceof HTMLElement && viewport instanceof HTMLElement) {
      return {
        target: viewport,
        host: mapRoot,
        mode: "map",
		world: world instanceof HTMLElement ? world : undefined,
      };
    }

    const img = this.stageEl.querySelector("img");
    if (img instanceof HTMLImageElement) {
      return {
        target: img,
        host: this.stageEl,
        mode: "media",
      };
    }

    return { target: this.stageEl, host: this.stageEl, mode: "media" };
  }

  private getTargetMetrics():
    | { left: number; top: number; width: number; height: number; borderRadius: string }
    | null {
    if (!this.targetEl) return null;
    if (!this.overlayHostEl) return null;
    const hostRect = this.overlayHostEl.getBoundingClientRect();
    const targetRect = this.targetEl.getBoundingClientRect();
    if (targetRect.width <= 0 || targetRect.height <= 0) return null;

    return {
      left: targetRect.left - hostRect.left,
      top: targetRect.top - hostRect.top,
      width: targetRect.width,
      height: targetRect.height,
      borderRadius: (this.targetEl.ownerDocument.defaultView ?? window).getComputedStyle(this.targetEl).borderRadius,
    };
  }

  private getCanvasCssRect():
    | { width: number; height: number }
    | null {
    if (!this.canvasEl) return null;
    const r = this.canvasEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { width: r.width, height: r.height };
  }

  private async relayout(): Promise<void> {
    if (!this.canvasEl || !this.ctx) return;

    const metrics = this.getTargetMetrics();
    if (!metrics) {
      setCssProps(this.canvasEl, { display: "none" });
      if (this.brushPreviewEl) setCssProps(this.brushPreviewEl, { opacity: "0" });
      return;
    }

    setCssProps(this.canvasEl, {
	  display: "block",
      left: `${metrics.left}px`,
      top: `${metrics.top}px`,
      width: `${metrics.width}px`,
      height: `${metrics.height}px`,
      "border-radius": metrics.borderRadius || "0px",
    });

    this.ensureCanvasBuffer(metrics.width, metrics.height);

    if (this.overlayMode === "map") {
      const ready = this.ensureWorldMaskBufferFromMap();
      if (!ready) return;

      if (this.pendingMaskDataUrl !== undefined) {
        const pending = this.pendingMaskDataUrl;
        this.pendingMaskDataUrl = undefined;
        await this.applyMaskFromDataUrl(pending);
        return;
      }

      if (!this.worldMaskInitialized) {
        this.fillFullFogWorld();
        this.worldMaskInitialized = true;
      }

      this.renderWorldMaskToViewport();
      return;
    }

    const dataUrl = this.plugin.getFogMask(this.fog.key);
    if (dataUrl) {
      await this.applyMaskFromDataUrl(dataUrl);
    } else {
      this.fillFullFogViewport();
    }
  }

  private ensureCanvasBuffer(width: number, height: number): void {
    if (!this.canvasEl || !this.ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const nextW = Math.max(1, Math.round(width * dpr));
    const nextH = Math.max(1, Math.round(height * dpr));

    if (this.canvasEl.width === nextW && this.canvasEl.height === nextH) return;

    this.canvasEl.width = nextW;
    this.canvasEl.height = nextH;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  }

  private installInteractions(): void {
    if (!this.canvasEl) return;

    this.canvasEl.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
    });

    this.canvasEl.addEventListener("pointerenter", () => {
      this.showBrushPreview(true);
    });
    this.canvasEl.addEventListener("pointerleave", () => {
      this.showBrushPreview(false);
    });

    this.canvasEl.addEventListener("pointermove", (ev) => {
      this.showBrushPreview(true);
      this.updateBrushPreviewPosition(ev);
      if (!this.isDrawing) return;
      this.applyBrushAtPointer(ev, this.activeTool);
      this.schedulePublish();
    });

    this.canvasEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 && ev.button !== 2) return;
      ev.preventDefault();
      ev.stopPropagation();

      this.showBrushPreview(true);
      this.isDrawing = true;
      this.activeTool =
        ev.button === 2 || (ev.buttons & 2) === 2 ? "cover" : this.brushMode;

      try {
        (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }

      this.applyBrushAtPointer(ev, this.activeTool);
      this.updateBrushPreviewPosition(ev);
      this.schedulePublish();
    });

    const endDraw = (ev: PointerEvent) => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      try {
        (ev.currentTarget as Element).releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      this.schedulePublish();
    };

    this.canvasEl.addEventListener("pointerup", endDraw);
    this.canvasEl.addEventListener("pointercancel", endDraw);
  }

  private applyBrushAtPointer(ev: PointerEvent, tool: "reveal" | "cover"): void {
    if (this.overlayMode === "map") {
      this.applyBrushAtPointerWorld(ev, tool);
      return;
    }

    if (!this.canvasEl || !this.ctx) return;

    const rect = this.canvasEl.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    this.ctx.save();
    if (tool === "reveal") {
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.beginPath();
      this.ctx.arc(x, y, this.brushRadius, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.fillStyle = "black";
      this.ctx.beginPath();
      this.ctx.arc(x, y, this.brushRadius, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  private schedulePublish(): void {
    if (this.publishTimer !== null) {
      window.clearTimeout(this.publishTimer);
    }
    this.publishTimer = window.setTimeout(() => {
      this.publishTimer = null;
      void this.publishNow();
    }, 75);
  }

  private async publishNow(): Promise<void> {
    if (this.overlayMode === "map") {
      if (!this.worldMaskCanvas) return;
      try {
        const dataUrl = this.worldMaskCanvas.toDataURL("image/png");
        await this.plugin.setFogMask(this.fog.key, dataUrl, this.owner);
      } catch {
        // ignore
      }
      return;
    }

    if (!this.canvasEl) return;
    try {
      const dataUrl = this.canvasEl.toDataURL("image/png");
      await this.plugin.setFogMask(this.fog.key, dataUrl, this.owner);
    } catch {
      // ignore
    }
  }

  private showBrushPreview(show: boolean): void {
    if (!this.brushPreviewEl) return;
	setCssProps(this.brushPreviewEl, { opacity: show ? "1" : "0" });
  }

  private updateBrushPreviewSize(): void {
    if (!this.brushPreviewEl) return;
    const d = Math.max(1, this.brushRadius * 2);
    setCssProps(this.brushPreviewEl, {
      width: `${d}px`,
      height: `${d}px`,
    });
  }

  private updateBrushPreviewStyle(): void {
    if (!this.brushPreviewEl) return;
    setCssProps(this.brushPreviewEl, {
      "border-style": this.brushMode === "cover" ? "dashed" : "solid",
    });
  }

  private updateBrushPreviewPosition(ev: PointerEvent): void {
    if (!this.canvasEl || !this.brushPreviewEl) return;
    const host = this.overlayHostEl ?? this.canvasEl.parentElement;
    if (!(host instanceof HTMLElement)) return;
    const rect = host.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const d = Math.max(1, this.brushRadius * 2);
    setCssProps(this.brushPreviewEl, {
      transform: `translate(${x - d / 2}px, ${y - d / 2}px)`,
    });
  }

  private installMapObservers(): void {
    if (!this.mapWorldEl || !this.targetEl) return;

    this.mapMutationObserver?.disconnect();
    this.mapMutationObserver = new MutationObserver(() => {
      this.scheduleMapRender();
    });

    this.mapMutationObserver.observe(this.mapWorldEl, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    this.mapMutationObserver.observe(this.targetEl, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
  }

  private scheduleMapRender(): void {
    if (this.overlayMode !== "map") return;
    if (this.mapRenderRaf !== null) return;

    this.mapRenderRaf = window.requestAnimationFrame(() => {
      this.mapRenderRaf = null;

      if (!this.canvasEl || !this.ctx) return;
      if (!this.ensureWorldMaskBufferFromMap()) return;

      if (this.pendingMaskDataUrl !== undefined) {
        const pending = this.pendingMaskDataUrl;
        this.pendingMaskDataUrl = undefined;
        void this.applyMaskFromDataUrl(pending);
        return;
      }

      if (!this.worldMaskInitialized) {
        const existing = this.plugin.getFogMask(this.fog.key);
        if (existing) {
          void this.applyMaskFromDataUrl(existing);
          return;
        }
        this.fillFullFogWorld();
        this.worldMaskInitialized = true;
      }

      this.renderWorldMaskToViewport();
    });
  }

  private getMapViewSnapshot(): MapFogViewSnapshot | null {
    if (!this.mapWorldEl || !this.targetEl) return null;

    const viewportRect = this.targetEl.getBoundingClientRect();
    if (viewportRect.width <= 0 || viewportRect.height <= 0) return null;

    const style = this.mapWorldEl.ownerDocument.defaultView?.getComputedStyle(this.mapWorldEl);
    const transform = style?.transform ?? this.mapWorldEl.style.transform ?? "";
    const matrix =
      !transform || transform === "none"
        ? new DOMMatrixReadOnly()
        : new DOMMatrixReadOnly(transform);

    const scale = matrix.a;
    const tx = matrix.e;
    const ty = matrix.f;

    if (!Number.isFinite(scale) || scale <= 0) return null;
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;

    let worldWidth = Number.parseFloat(this.mapWorldEl.style.width ?? "");
    let worldHeight = Number.parseFloat(this.mapWorldEl.style.height ?? "");

    if (!Number.isFinite(worldWidth) || worldWidth <= 0) {
      const rect = this.mapWorldEl.getBoundingClientRect();
      worldWidth = rect.width / scale;
    }
    if (!Number.isFinite(worldHeight) || worldHeight <= 0) {
      const rect = this.mapWorldEl.getBoundingClientRect();
      worldHeight = rect.height / scale;
    }

    if (!Number.isFinite(worldWidth) || worldWidth <= 0) return null;
    if (!Number.isFinite(worldHeight) || worldHeight <= 0) return null;

    return {
      worldWidth: Math.max(1, Math.round(worldWidth)),
      worldHeight: Math.max(1, Math.round(worldHeight)),
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height,
      scale,
      tx,
      ty,
    };
  }

  private ensureWorldMaskBufferFromMap(): boolean {
    const snap = this.getMapViewSnapshot();
    if (!snap) return false;

    if (!this.worldMaskCanvas) {
      this.worldMaskCanvas = document.createElement("canvas");
      this.worldMaskCtx = this.worldMaskCanvas.getContext("2d");
      if (!this.worldMaskCtx) {
        this.worldMaskCanvas = null;
        return false;
      }
    }

    if (
      this.worldMaskCanvas.width !== snap.worldWidth ||
      this.worldMaskCanvas.height !== snap.worldHeight
    ) {
      const prev = this.worldMaskCanvas;
      const prevW = prev.width;
      const prevH = prev.height;

      this.worldMaskCanvas.width = snap.worldWidth;
      this.worldMaskCanvas.height = snap.worldHeight;
      this.worldMaskCtx = this.worldMaskCanvas.getContext("2d");
      if (!this.worldMaskCtx) return false;

      if (this.worldMaskInitialized && prevW > 0 && prevH > 0) {
        this.worldMaskCtx.drawImage(prev, 0, 0, prevW, prevH, 0, 0, snap.worldWidth, snap.worldHeight);
      } else {
        this.worldMaskInitialized = false;
      }
    }

    return true;
  }

  private async applyWorldMaskFromDataUrl(dataUrl: string | null): Promise<void> {
    if (!this.worldMaskCanvas || !this.worldMaskCtx) return;

    this.worldMaskCtx.globalCompositeOperation = "source-over";
    this.worldMaskCtx.clearRect(0, 0, this.worldMaskCanvas.width, this.worldMaskCanvas.height);

    if (!dataUrl) {
      this.fillFullFogWorld();
      return;
    }

    const img = new Image();
    const ok = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = dataUrl;
    });

    if (!ok) {
      this.fillFullFogWorld();
      return;
    }

    this.worldMaskCtx.drawImage(
      img,
      0,
      0,
      this.worldMaskCanvas.width,
      this.worldMaskCanvas.height,
    );
  }

  private renderWorldMaskToViewport(): void {
    if (!this.canvasEl || !this.ctx || !this.worldMaskCanvas) return;

    const snap = this.getMapViewSnapshot();
    if (!snap) return;

    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.clearRect(0, 0, snap.viewportWidth, snap.viewportHeight);
    this.ctx.drawImage(
      this.worldMaskCanvas,
      snap.tx,
      snap.ty,
      snap.worldWidth * snap.scale,
      snap.worldHeight * snap.scale,
    );
  }

  private fillFullFogViewport(): void {
    if (!this.ctx) return;
    const rect = this.getCanvasCssRect();
    if (!rect) return;
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.ctx.fillStyle = "black";
    this.ctx.fillRect(0, 0, rect.width, rect.height);
  }

  private fillFullFogWorld(): void {
    if (!this.worldMaskCtx || !this.worldMaskCanvas) return;
    this.worldMaskCtx.globalCompositeOperation = "source-over";
    this.worldMaskCtx.clearRect(0, 0, this.worldMaskCanvas.width, this.worldMaskCanvas.height);
    this.worldMaskCtx.fillStyle = "black";
    this.worldMaskCtx.fillRect(0, 0, this.worldMaskCanvas.width, this.worldMaskCanvas.height);
  }

  private applyBrushAtPointerWorld(ev: PointerEvent, tool: "reveal" | "cover"): void {
    if (!this.canvasEl || !this.worldMaskCtx || !this.worldMaskCanvas) return;

    const snap = this.getMapViewSnapshot();
    if (!snap) return;

    const rect = this.canvasEl.getBoundingClientRect();
    const viewX = ev.clientX - rect.left;
    const viewY = ev.clientY - rect.top;

    const worldX = (viewX - snap.tx) / snap.scale;
    const worldY = (viewY - snap.ty) / snap.scale;
    const worldRadius = this.brushRadius / snap.scale;

    if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldRadius) || worldRadius <= 0) {
      return;
    }

    this.worldMaskCtx.save();
    if (tool === "reveal") {
      this.worldMaskCtx.globalCompositeOperation = "destination-out";
      this.worldMaskCtx.beginPath();
      this.worldMaskCtx.arc(worldX, worldY, worldRadius, 0, Math.PI * 2);
      this.worldMaskCtx.fill();
    } else {
      this.worldMaskCtx.globalCompositeOperation = "source-over";
      this.worldMaskCtx.fillStyle = "black";
      this.worldMaskCtx.beginPath();
      this.worldMaskCtx.arc(worldX, worldY, worldRadius, 0, Math.PI * 2);
      this.worldMaskCtx.fill();
    }
    this.worldMaskCtx.restore();

    this.worldMaskInitialized = true;
    this.renderWorldMaskToViewport();
  }
}

class ScreenDisplayView extends BaseRenderedScreenView {
  private plugin: TTRPGToolsScreenPlugin;
  private windowTrackTimer: number | null = null;
  private lastTrackedBounds: WindowBounds | null = null;
  private lastTrackedWindow: Window | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TTRPGToolsScreenPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SCREEN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Screen";
  }

  getIcon(): "monitor-up" {
    return "monitor-up";
  }
  
  protected getRenderHost(): HTMLElement {
    return this.contentEl;
  }

  protected isFogInteractive(): boolean {
    return false;
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("ttrpg-tools-screen-view");

    this.applyPlainWindowChrome();
    this.plugin.applySavedWindowBounds(this.contentEl.win);
    this.startWindowTracking();

    this.contentEl.onWindowMigrated(() => {
      this.applyPlainWindowChrome();
      this.plugin.applySavedWindowBounds(this.contentEl.win);
      this.startWindowTracking();
    });

    const payload = this.plugin.getCurrentPayload();
    if (payload) {
      await this.renderPayload(payload);
    }
  }

	onClose(): Promise<void> {
	  this.renderComponent?.unload();
	  this.renderComponent = null;
      this.fogOverlay?.destroy();
	  this.teardownStageSizeSync();
	  this.persistCurrentWindowBounds();
	  this.stopWindowTracking();

	  try {
		this.removePlainWindowChrome();
	  } catch {
		// Ignore
	  } finally {
		this.plugin.notifyScreenLeafClosed(this.leaf);
	  }

	  return Promise.resolve();
	}

  onResize(): void {
    this.applyPlainWindowChrome();
  }

  onPaneMenu(menu: Menu): void {
    menu.addItem((item) => {
      item
        .setTitle("Clear screen")
        .setIcon("trash")
        .onClick(() => {
          this.plugin.clearScreen();
        });
    });
  }

  private getTabHeaderContainer(): HTMLElement | null {
    const leafParent = this.leaf.parent as unknown as
      | { tabHeaderContainerEl?: HTMLElement | null }
      | null
      | undefined;
    return leafParent?.tabHeaderContainerEl ?? null;
  }
  
  private getTabCount(): number {
    const parent = this.leaf.parent as unknown as { children?: unknown[] } | null | undefined;
    return Array.isArray(parent?.children)
      ? parent.children.length
      : 1;
  }

  private applyPlainWindowChrome(): void {
    if (this.contentEl.win === window) return;
	const multipleTabs = this.getTabCount() > 1;

    const tabHeader = this.getTabHeaderContainer();
    if (tabHeader) {
      setCssProps(tabHeader, {
        opacity: multipleTabs ? null : "0",
        "pointer-events": multipleTabs ? null : "auto",
        "user-select": multipleTabs ? null : "none",
      });
    }

    const viewSelf = this as unknown as {
      headerEl?: HTMLElement;
    };
    if (viewSelf.headerEl) {
      setCssProps(viewSelf.headerEl, {
        display: multipleTabs ? null : "none",
      });
    }
  }

  private removePlainWindowChrome(): void {
    if (this.contentEl.win === window) return;

	const tabHeader = this.getTabHeaderContainer();
    if (tabHeader) {
      setCssProps(tabHeader, {
        opacity: null,
        "pointer-events": null,
        "user-select": null,
      });
    }

    const viewSelf = this as unknown as {
      headerEl?: HTMLElement;
    };
    if (viewSelf.headerEl) {
      setCssProps(viewSelf.headerEl, {
        display: null,
      });
    }
  }

  private readWindowBounds(win: Window): WindowBounds | null {
    const x = win.screenX;
    const y = win.screenY;
    const width = win.outerWidth;
    const height = win.outerHeight;

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!isFinitePositiveNumber(width) || !isFinitePositiveNumber(height)) return null;

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  private sameBounds(a: WindowBounds | null, b: WindowBounds | null): boolean {
    if (!a || !b) return false;
    return (
      Math.abs(a.x - b.x) <= 1 &&
      Math.abs(a.y - b.y) <= 1 &&
      Math.abs(a.width - b.width) <= 1 &&
      Math.abs(a.height - b.height) <= 1
    );
  }

  private startWindowTracking(): void {
    this.stopWindowTracking();

    if (this.contentEl.win === window) return;

    this.lastTrackedWindow = this.contentEl.win;
    this.lastTrackedBounds = this.readWindowBounds(this.contentEl.win);
    if (this.lastTrackedBounds) {
      this.plugin.updateSavedWindowBounds(this.lastTrackedBounds);
    }

    this.windowTrackTimer = window.setInterval(() => {
      if (!this.lastTrackedWindow) return;
      const next = this.readWindowBounds(this.lastTrackedWindow);
      if (!next) return;
      if (this.sameBounds(next, this.lastTrackedBounds)) return;
      this.lastTrackedBounds = next;
      this.plugin.updateSavedWindowBounds(next);
    }, 500);
  }

  private stopWindowTracking(): void {
    if (this.windowTrackTimer !== null) {
      window.clearInterval(this.windowTrackTimer);
      this.windowTrackTimer = null;
    }
    this.lastTrackedWindow = null;
  }

  private persistCurrentWindowBounds(): void {
    const bounds = this.readWindowBounds(this.contentEl.win);
    if (bounds) this.plugin.updateSavedWindowBounds(bounds);
  }

  protected override onStageSizeApplied(box: RenderBox): void {
    this.plugin.updateCurrentScreenRenderSize(box);
  }
}

class ScreenFogControllerView extends BaseRenderedScreenView {
  private renderHostEl: HTMLDivElement | null = null;
  private toolBtn: HTMLButtonElement | null = null;
  private radiusInput: HTMLInputElement | null = null;
  private radiusLabel: HTMLSpanElement | null = null;
  private targetLabelEl: HTMLDivElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TTRPGToolsScreenPlugin) {
    super(leaf, plugin);
  }

  getViewType(): string {
    return SCREEN_FOG_CONTROLLER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Fog controller";
  }

  getIcon(): "brush" {
    return "brush";
  }

  protected getRenderHost(): HTMLElement {
    if (!this.renderHostEl) {
      this.renderHostEl = this.contentEl.createDiv({
        cls: "ttrpg-tools-screen-fog-controller__render",
      });
    }
    return this.renderHostEl;
  }

  protected isFogInteractive(): boolean {
    return true;
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("ttrpg-tools-screen-fog-controller");

    this.buildControls();

    const payload = this.plugin.getCurrentFogPayload();
    if (payload) {
      await this.renderPayload(payload);
    } else {
      this.getRenderHost().createEl("div", {
        text: "Send an image or map to the player screen with fog of war first.",
      });
    }
  }

  onClose(): Promise<void> {
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.fogOverlay?.destroy();
	this.teardownStageSizeSync();
    this.plugin.notifyFogControllerLeafClosed(this.leaf);
    return Promise.resolve();
  }
  
  protected override getPreferredStageSize(): RenderBox | null {
    return this.plugin.getCurrentScreenRenderSize();
  }

  private buildControls(): void {
    this.targetLabelEl = this.contentEl.createEl("div", {
      cls: "ttrpg-tools-screen-fog-controller__target",
      text: "No fog target loaded.",
    });

    const controls = this.contentEl.createDiv({
      cls: "ttrpg-tools-screen-fog-controller__controls",
    });

    this.toolBtn = controls.createEl("button", { text: "Tool: reveal" });
    this.toolBtn.onclick = () => {
      const next =
        this.fogOverlay?.getBrushMode() === "cover" ? "reveal" : "cover";
      this.fogOverlay?.setBrushMode(next);
      this.syncFogControls();
    };

    controls.createEl("span", { text: "Brush radius:" });
    this.radiusInput = controls.createEl("input", {
      attr: { type: "range", min: "5", max: "200", value: "40" },
    });
    setCssProps(this.radiusInput, {
      width: "220px",
    });
    this.radiusInput.oninput = () => {
      const next = Number(this.radiusInput?.value ?? "40");
      this.fogOverlay?.setBrushRadius(next);
      this.syncFogControls();
    };

    this.radiusLabel = controls.createEl("span", { text: "40px" });

    const fullFogBtn = controls.createEl("button", { text: "Reset to full fog" });
    fullFogBtn.onclick = () => {
      void this.fogOverlay?.fillFullFogAndPublish();
    };

    const clearBtn = controls.createEl("button", { text: "Reveal all" });
    clearBtn.onclick = () => {
      void this.fogOverlay?.clearFogAndPublish();
    };
  }

  private syncFogControls(): void {
    const mode = this.fogOverlay?.getBrushMode() ?? "reveal";
    const radius = this.fogOverlay?.getBrushRadius() ?? 40;
    if (this.toolBtn) this.toolBtn.textContent = mode === "cover" ? "Tool: Cover" : "Tool: Reveal";
    if (this.radiusInput) this.radiusInput.value = String(radius);
    if (this.radiusLabel) this.radiusLabel.textContent = `${radius}px`;
  }

  override async renderPayload(payload: ScreenPayload): Promise<void> {
    await super.renderPayload(payload);
    if (this.targetLabelEl) {
      const label =
        payload.kind === "note"
          ? payload.path
          : payload.kind === "image"
            ? payload.filePath ?? payload.source
            : payload.kind === "markdown"
              ? payload.sourcePath
              : payload.filePath ?? payload.source;
      this.targetLabelEl.textContent = `Target: ${label}`;
    }
    this.syncFogControls();
  }
}

export default class TTRPGToolsScreenPlugin extends Plugin {
  settings: ScreenDisplaySettings = DEFAULT_SETTINGS;

  private screenLeaf: WorkspaceLeaf | null = null;
  private currentPayload: ScreenPayload | null = null;
  private previewContextMenuRoots = new WeakSet<HTMLElement>();
  private boundsSaveTimer: number | null = null;
  private fogControllerLeaf: WorkspaceLeaf | null = null;
  private fogMasks = new Map<string, string>();
  private currentScreenRenderSize: RenderBox | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(SCREEN_VIEW_TYPE, (leaf) => new ScreenDisplayView(leaf, this));
	this.registerView(SCREEN_FOG_CONTROLLER_VIEW_TYPE, (leaf) => new ScreenFogControllerView(leaf, this));

    this.registerDomEvent(document, "contextmenu", (ev: MouseEvent) => {
      this.onGlobalContextMenu(ev);
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.attachPreviewContextMenus(el, ctx);
    });

    this.addCommand({
      id: "open-screen-window",
      name: "Open screen window",
      callback: () => {
        void this.openScreenWindow();
      },
    });

    this.addCommand({
      id: "send-active-note-to-screen",
      name: "Send active note to screen",
      callback: () => {
        void this.sendActiveNote();
      },
    });

    this.addCommand({
      id: "send-current-paragraph-to-screen",
      name: "Send current paragraph/section to screen",
      editorCallback: (editor, view) => {
        void this.sendEditorContext(editor, view);
      },
    });
	
    this.addCommand({
      id: "open-fog-controller",
      name: "Open fog controller",
      callback: () => {
        const payload = this.getCurrentFogPayload();
        if (!payload) return;
        void this.openOrUpdateFogController(payload);
      },
    });

    this.addCommand({
      id: "close-screen-window",
      name: "Close screen window",
      callback: () => {
        this.closeScreenWindow();
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        this.extendFileMenu(menu, file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        this.extendEditorMenu(menu, editor, view);
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        void this.onVaultModify(file);
      }),
    );

    this.addSettingTab(new ScreenDisplaySettingTab(this.app, this));
  }

  onunload(): void {
    if (this.boundsSaveTimer !== null) {
      window.clearTimeout(this.boundsSaveTimer);
      this.boundsSaveTimer = null;
    }

    this.closeScreenLeaf();
	this.closeFogControllerLeaf();
  }

  async loadSettings(): Promise<void> {
    const savedUnknown: unknown = await this.loadData();
    const saved = isRecord(savedUnknown) ? savedUnknown : {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  public async openScreenWindow(): Promise<void> {
    await this.ensureScreenLeaf();
  }

  public closeScreenWindow(): void {
    this.closeScreenLeaf();
  }

  public clearScreen(): void {
    this.currentPayload = {
      kind: "markdown",
      markdown: "",
      sourcePath: "",
    };
    void this.renderCurrentPayload();
  }

  getCurrentPayload(): ScreenPayload | null {
    return this.currentPayload;
  }
  
  getCurrentFogPayload(): ScreenPayload | null {
    if (!this.currentPayload?.fog?.enabled) return null;
    return this.currentPayload;
  }

  notifyScreenLeafClosed(leaf: WorkspaceLeaf): void {
    if (this.screenLeaf === leaf) {
      this.screenLeaf = null;
      this.currentScreenRenderSize = null;
      if (this.fogControllerLeaf?.view instanceof BaseRenderedScreenView) {
        this.fogControllerLeaf.view.refreshStageSizeVars();
      }
	  this.closeFogControllerLeaf();
    }
  }
  
  notifyFogControllerLeafClosed(leaf: WorkspaceLeaf): void {
    if (this.fogControllerLeaf === leaf) {
      this.fogControllerLeaf = null;
    }
  }

  getFogMask(key: string): string | null {
    return this.fogMasks.get(key) ?? null;
  }
  
  getCurrentScreenRenderSize(): RenderBox | null {
    return this.currentScreenRenderSize
      ? { ...this.currentScreenRenderSize }
      : null;
  }

  updateCurrentScreenRenderSize(box: RenderBox): void {
    if (
      !isFinitePositiveNumber(box.width) ||
      !isFinitePositiveNumber(box.height)
    ) {
      return;
    }

    const next = {
      width: Math.round(box.width),
      height: Math.round(box.height),
    };

    const prev = this.currentScreenRenderSize;
    if (
      prev &&
      Math.abs(prev.width - next.width) <= 1 &&
      Math.abs(prev.height - next.height) <= 1
    ) {
      return;
    }

    this.currentScreenRenderSize = next;

    if (this.fogControllerLeaf?.view instanceof BaseRenderedScreenView) {
      this.fogControllerLeaf.view.refreshStageSizeVars();
    }
  }

  async setFogMask(
    key: string,
    dataUrl: string,
    sourceView?: BaseRenderedScreenView,
  ): Promise<void> {
    this.fogMasks.set(key, dataUrl);
    await this.pushFogMaskToOpenViews(key, dataUrl, sourceView);
  }

  private async pushFogMaskToOpenViews(
    key: string,
    dataUrl: string | null,
    sourceView?: BaseRenderedScreenView,
  ): Promise<void> {
    const views: BaseRenderedScreenView[] = [];

    if (this.screenLeaf?.view instanceof BaseRenderedScreenView) {
      views.push(this.screenLeaf.view);
    }
    if (this.fogControllerLeaf?.view instanceof BaseRenderedScreenView) {
      views.push(this.fogControllerLeaf.view);
    }

    for (const view of views) {
      if (view === sourceView) continue;
      await view.onFogMaskUpdated(key, dataUrl);
    }
  }
  
  public applySavedWindowBounds(win: Window): void {
    if (win === window) return;

    const bounds = this.getSavedWindowBounds();
    if (!bounds) return;

    try {
      win.resizeTo(bounds.width, bounds.height);
      win.moveTo(bounds.x, bounds.y);
    } catch {
      // Ignore
    }
  }

  public updateSavedWindowBounds(bounds: WindowBounds): void {
    this.settings.savedWindowX = bounds.x;
    this.settings.savedWindowY = bounds.y;
    this.settings.savedWindowWidth = bounds.width;
    this.settings.savedWindowHeight = bounds.height;
    this.requestBoundsSave();
  }

  private getSavedWindowBounds(): WindowBounds | null {
    const x = this.settings.savedWindowX;
    const y = this.settings.savedWindowY;
    const width = this.settings.savedWindowWidth;
    const height = this.settings.savedWindowHeight;

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!isFinitePositiveNumber(width) || !isFinitePositiveNumber(height)) return null;

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  private requestBoundsSave(): void {
    if (this.boundsSaveTimer !== null) {
      window.clearTimeout(this.boundsSaveTimer);
    }

    this.boundsSaveTimer = window.setTimeout(() => {
      this.boundsSaveTimer = null;
      void this.saveSettings();
    }, 400);
  }

  /* ------------------------------------------------------
   * Public API for other plugins, especially Maps
   * ------------------------------------------------------ */
   
  private makeFogKey(kind: "note" | "image" | "markdown", id: string): string {
    return `${kind}:${id}`;
  }

  private async sendPayload(payload: ScreenPayload): Promise<void> {
    this.currentPayload = payload;

    if (payload.fog?.enabled) {
      await this.openOrUpdateFogController(payload);
    } else {
      this.closeFogControllerLeaf();
    }

    await this.renderCurrentPayload();
  }

  public async sendNoteByPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Player Screen: note not found: ${path}`, 3000);
      return;
    }

    await this.sendPayload({ kind: "note", path: file.path });
  }

  public async sendMarkdown(markdown: string, sourcePath: string): Promise<void> {
    await this.sendPayload({
      kind: "markdown",
      markdown,
      sourcePath,
    });
  }

  public async sendMarkdownWithFog(
    markdown: string,
    sourcePath: string,
    fogKey?: string,
  ): Promise<void> {
    const key = fogKey?.trim() || this.makeFogKey("markdown", sourcePath || markdown.slice(0, 64));
    await this.sendPayload({
      kind: "markdown",
      markdown,
      sourcePath,
      fog: {
        enabled: true,
        key,
        label: sourcePath || "Markdown",
      },
    });
  }

  public async sendImageByPath(pathOrSource: string): Promise<void> {
    const file = this.resolveVaultFile(
      pathOrSource,
      this.app.workspace.getActiveFile()?.path ?? "",
    );

    if (file) {
      await this.sendPayload({
        kind: "image",
        source: this.app.vault.getResourcePath(file),
        filePath: file.path,
      });
      return;
    }

    await this.sendPayload({
      kind: "image",
      source: pathOrSource,
    });
  }

  public async sendImageByPathWithFog(pathOrSource: string): Promise<void> {
    const file = this.resolveVaultFile(
      pathOrSource,
      this.app.workspace.getActiveFile()?.path ?? "",
    );

    if (file) {
      await this.sendPayload({
        kind: "image",
        source: this.app.vault.getResourcePath(file),
        filePath: file.path,
        fog: {
          enabled: true,
          key: this.makeFogKey("image", file.path),
          label: file.basename,
        },
      });
      return;
    }

    await this.sendPayload({
        kind: "image",
        source: pathOrSource,
        fog: { enabled: true, key: this.makeFogKey("image", pathOrSource), label: pathOrSource },
      });
  }

  public async sendPdfByPath(pathOrSource: string): Promise<void> {
    const file = this.resolveVaultFile(
      pathOrSource,
      this.app.workspace.getActiveFile()?.path ?? "",
    );

    if (file) {
      await this.sendPayload({
        kind: "pdf",
        source: this.app.vault.getResourcePath(file),
        filePath: file.path,
      });
      return;
    }

    await this.sendPayload({ kind: "pdf", source: pathOrSource });
  }

  /* ------------------------------------------------------
   * Context menus
   * ------------------------------------------------------ */

  private extendFileMenu(menu: Menu, file: TFile): void {
    const ext = file.extension?.toLowerCase() ?? "";

    if (ext === "md") {
      menu.addItem((item) => {
        item
          .setTitle("Send note to player screen")
          .setIcon("monitor-up")
          .onClick(() => {
            void this.sendNoteByPath(file.path);
          });
      });
      return;
    }

    if (isImageExt(ext)) {
      menu.addItem((item) => {
        item
          .setTitle("Send image to player screen")
          .setIcon("image")
          .onClick(() => {
            void this.sendImageByPath(file.path);
          });
      });
      menu.addItem((item) => {
        item
          .setTitle("Send image with fog of war to player screen")
          .setIcon("brush")
          .onClick(() => {
            void this.sendImageByPathWithFog(file.path);
          });
      });
      return;
    }

    if (isPdfExt(ext)) {
      menu.addItem((item) => {
        item
          .setTitle("Send PDF to player screen")
          .setIcon("file-text")
          .onClick(() => {
            void this.sendPdfByPath(file.path);
          });
      });
    }
  }

  private extendEditorMenu(menu: Menu, editor: Editor, view: MarkdownView): void {
    const file = view.file;
    if (!(file instanceof TFile)) return;

    menu.addItem((item) => {
      item
        .setTitle("Send note to player screen")
        .setIcon("monitor-up")
        .onClick(() => {
          void this.sendNoteByPath(file.path);
        });
    });

    const currentLine = editor.getCursor().line;
    const cache = this.app.metadataCache.getFileCache(file);
    const headings = (cache?.headings ?? []) as HeadingCacheEntry[];
    const currentHeading = headings.filter((h) => h.position.start.line === currentLine).at(0);

    if (currentHeading) {
      menu.addItem((item) => {
        item
          .setTitle(`Send heading section: ${currentHeading.heading}`)
          .setIcon("heading")
          .onClick(() => {
            void this.sendHeadingSection(file, currentHeading, headings);
          });
      });
    } else {
      menu.addItem((item) => {
        item
          .setTitle("Send current paragraph to player screen")
          .setIcon("pilcrow")
          .onClick(() => {
            const md = this.extractCurrentParagraph(editor);
            if (!md.trim()) {
              new Notice("Nothing to send.", 1500);
              return;
            }
            void this.sendMarkdown(md, file.path);
          });
      });
    }
  }

  private attachPreviewContextMenus(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    if (this.previewContextMenuRoots.has(el)) return;
    this.previewContextMenuRoots.add(el);

	const sourcePath = ctx.sourcePath;
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    const markdownFile = sourceFile instanceof TFile ? sourceFile : null;

    el.addEventListener("contextmenu", (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      // Images in reading view
      const img = target.closest("img");
      if (img instanceof HTMLImageElement && el.contains(img)) {
        const file = this.resolveImageElementToFile(img, sourcePath);
        const rawSrc = img.getAttribute("src") ?? "";
        if (!file && !rawSrc) return;

        ev.preventDefault();
        ev.stopPropagation();

        const menu = new Menu();
        menu.addItem((item) => {
          item
            .setTitle("Send image to player screen")
            .setIcon("image")
            .onClick(() => {
              if (file) void this.sendImageByPath(file.path);
              else void this.sendImageByPath(rawSrc);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("Send image with fog of war to player screen")
            .setIcon("brush")
            .onClick(() => {
              if (file) void this.sendImageByPathWithFog(file.path);
              else void this.sendImageByPathWithFog(rawSrc);
            });
        });
        menu.showAtMouseEvent(ev);
        return;
      }

      // Internal note/image/pdf links in reading view
      const link = target.closest("a.internal-link");
      if (link instanceof HTMLAnchorElement && el.contains(link)) {
        const raw =
          link.getAttribute("data-href") ??
          link.getAttribute("href") ??
          link.textContent ??
          "";

        const file = this.resolveVaultFile(raw, sourcePath);
        if (!(file instanceof TFile)) return;

        const ext = file.extension?.toLowerCase() ?? "";

        const menu = new Menu();

        if (ext === "md") {
          menu.addItem((item) => {
            item
              .setTitle("Send note to player screen")
              .setIcon("monitor-up")
              .onClick(() => {
                void this.sendNoteByPath(file.path);
              });
          });
        } else if (isPdfExt(ext)) {
          menu.addItem((item) => {
            item
              .setTitle("Send PDF to player screen")
              .setIcon("file-text")
              .onClick(() => {
                void this.sendPdfByPath(file.path);
              });
          });
        } else if (isImageExt(ext)) {
          menu.addItem((item) => {
            item
              .setTitle("Send image to player screen")
              .setIcon("image")
              .onClick(() => {
                void this.sendImageByPath(file.path);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle("Send image with fog of war to player screen")
              .setIcon("brush")
              .onClick(() => {
                void this.sendImageByPathWithFog(file.path);
              });
          });
        } else {
          return;
        }

        ev.preventDefault();
        ev.stopPropagation();
        menu.showAtMouseEvent(ev);
        return;
      }

      // Embedded PDFs in reading view
      const embed = target.closest(".internal-embed, .pdf-embed");
      if (embed instanceof HTMLElement && el.contains(embed)) {
        const src =
          embed.getAttribute("src") ??
          embed.getAttribute("data-path") ??
          "";
        if (!src) return;

        const file = this.resolveVaultFile(src, sourcePath);
        if (!(file instanceof TFile)) return;
        if (!isPdfExt(file.extension?.toLowerCase() ?? "")) return;

        const menu = new Menu();
        menu.addItem((item) => {
          item
            .setTitle("Send PDF to player screen")
            .setIcon("file-text")
            .onClick(() => void this.sendPdfByPath(file.path));
        });
        ev.preventDefault();
        ev.stopPropagation();
        menu.showAtMouseEvent(ev);
        return;
      }

      // Headings in reading view: determine global index within the preview container
      if (markdownFile) {
        const headingEl = target.closest("h1, h2, h3, h4, h5, h6");
        if (headingEl instanceof HTMLElement && el.contains(headingEl)) {
          const previewRoot = headingEl.closest(".markdown-preview-view, .markdown-rendered");
          if (!(previewRoot instanceof HTMLElement)) return;

          const cache = this.app.metadataCache.getFileCache(markdownFile);
          const headings = (cache?.headings ?? []) as HeadingCacheEntry[];
          const allHeadingEls = Array.from(
            previewRoot.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
          );
          const idx = allHeadingEls.indexOf(headingEl);
          const headingInfo = idx >= 0 ? headings[idx] : undefined;
          if (!headingInfo) return;

          const menu = new Menu();
          menu.addItem((item) => {
            item
              .setTitle(`Send section: ${headingInfo.heading}`)
              .setIcon("heading")
              .onClick(() => {
                void this.sendHeadingSection(markdownFile, headingInfo, headings);
              });
          });

          ev.preventDefault();
          ev.stopPropagation();
          menu.showAtMouseEvent(ev);
          return;
        }
      }

      // Paragraphs / list items / blockquotes → send text block
      const blockEl = target.closest("p, li, blockquote");
      if (blockEl instanceof HTMLElement && el.contains(blockEl)) {
        const text = (blockEl.textContent ?? "").trim();
        if (!text) return;

        ev.preventDefault();
        ev.stopPropagation();

        const menu = new Menu();
        menu.addItem((item) => {
          item
            .setTitle("Send paragraph to player screen")
            .setIcon("pilcrow")
            .onClick(() => {
              void this.sendMarkdown(`${text}\n`, sourcePath);
            });
        });
        menu.showAtMouseEvent(ev);
      }
    });
  }

  /* ------------------------------------------------------
   * Sending helpers
   * ------------------------------------------------------ */

  private async sendActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== "md") {
      new Notice("No active note.", 2000);
      return;
    }
    await this.sendNoteByPath(file.path);
  }

  private async sendEditorContext(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!(file instanceof TFile)) {
      new Notice("No note available.", 1500);
      return;
    }

    const currentLine = editor.getCursor().line;
    const cache = this.app.metadataCache.getFileCache(file);
    const headings = (cache?.headings ?? []) as HeadingCacheEntry[];
    const currentHeading = headings.filter((h) => h.position.start.line === currentLine).at(0);

    if (currentHeading) {
      await this.sendHeadingSection(file, currentHeading, headings);
      return;
    }

    const paragraph = this.extractCurrentParagraph(editor);
    if (!paragraph.trim()) {
      new Notice("Nothing to send.", 1500);
      return;
    }

    await this.sendMarkdown(paragraph, file.path);
  }

  private extractCurrentParagraph(editor: Editor): string {
    const lines = editor.getValue().split("\n");
    if (lines.length === 0) return "";

    const cursorLine = editor.getCursor().line;
    let start = cursorLine;
    let end = cursorLine;

    while (start > 0 && lines[start - 1].trim() !== "") start -= 1;
    while (end < lines.length - 1 && lines[end + 1].trim() !== "") end += 1;

    return `${lines.slice(start, end + 1).join("\n").trimEnd()}\n`;
  }

  private async sendHeadingSection(
    file: TFile,
    heading: HeadingCacheEntry,
    allHeadings?: HeadingCacheEntry[],
  ): Promise<void> {
    const text = await this.app.vault.read(file);
    const lines = text.split("\n");
    const headings =
      allHeadings ??
      ((this.app.metadataCache.getFileCache(file)?.headings ?? []) as HeadingCacheEntry[]);

    const start = heading.position.start.line;
    let endExclusive = lines.length;

    const idx = headings.findIndex(
      (h) =>
        h.position.start.line === heading.position.start.line &&
        h.level === heading.level &&
        h.heading === heading.heading,
    );

    if (idx >= 0) {
      for (let i = idx + 1; i < headings.length; i += 1) {
        const next = headings[i];
        if (next.level <= heading.level) {
          endExclusive = next.position.start.line;
          break;
        }
      }
    }

    const md = normalizeHeadingSection(lines.slice(start, endExclusive));
    await this.sendMarkdown(md, file.path);
  }

  /* ------------------------------------------------------
   * Popout leaf rendering
   * ------------------------------------------------------ */

  private isScreenLeafUsable(): boolean {
    if (!this.screenLeaf) return false;

    const leafAny = this.screenLeaf as unknown as {
      parent?: unknown;
      view?: unknown;
    };

    if (!leafAny.parent) return false;
    return !!leafAny.view;
  }

  private async ensureScreenLeaf(): Promise<WorkspaceLeaf | null> {
    const createLeaf = async (): Promise<WorkspaceLeaf | null> => {
      try {
        const leaf = this.app.workspace.openPopoutLeaf();
        await leaf.setViewState({
          type: SCREEN_VIEW_TYPE,
          active: true,
          state: {},
        });
        await this.app.workspace.revealLeaf(leaf);
        if (leaf.isDeferred) {
          await leaf.loadIfDeferred();
        }
        return leaf;
      } catch (e) {
        console.error(e);
        new Notice("Could not open player screen window.", 3000);
        return null;
      }
    };

    if (!this.isScreenLeafUsable()) {
      this.screenLeaf = null;
    }

    if (!this.screenLeaf) {
      this.screenLeaf = await createLeaf();
      return this.screenLeaf;
    }

    try {
      await this.screenLeaf.setViewState({
        type: SCREEN_VIEW_TYPE,
        active: true,
        state: {},
      });
      await this.app.workspace.revealLeaf(this.screenLeaf);
      if (this.screenLeaf.isDeferred) {
        await this.screenLeaf.loadIfDeferred();
      }
      return this.screenLeaf;
    } catch (e) {
        // The popout was probably closed manually and the leaf reference is stale.
        void e;
      this.screenLeaf = null;
    }

    this.screenLeaf = await createLeaf();
    return this.screenLeaf;
  }

  private closeScreenLeaf(): void {
    if (this.screenLeaf) {
      try {
        this.screenLeaf.detach();
      } catch {
        // Ignore stale leaf teardown errors.
      }
      this.screenLeaf = null;
    }
  }

  private async renderCurrentPayload(): Promise<void> {
    if (!this.currentPayload) return;

    if (!this.screenLeaf && !this.settings.autoOpenOnSend) {
      new Notice("Open the player screen window first.", 2500);
      return;
    }

    const leaf = await this.ensureScreenLeaf();
    if (!leaf) return;

    const view = leaf.view;
    if (!(view instanceof ScreenDisplayView)) {
      new Notice("Player screen view could not be initialized.", 2500);
      return;
    }

    await view.setPayload(this.currentPayload);
    await this.app.workspace.revealLeaf(leaf);
  }

  private getActiveMarkdownSourcePath(): string {
    return this.app.workspace.getActiveFile()?.path ?? "";
  }

  public resolveVaultFile(pathOrLink: string, sourcePath: string): TFile | null {
    const byPath = this.app.vault.getAbstractFileByPath(pathOrLink);
    if (byPath instanceof TFile) return byPath;

    const dest = this.app.metadataCache.getFirstLinkpathDest(pathOrLink, sourcePath);
    return dest instanceof TFile ? dest : null;
  }
  
  private isLeafInMainWindow(leaf: WorkspaceLeaf | null): boolean {
    if (!leaf) return false;
    const view = leaf.view as unknown as { contentEl?: HTMLElement };
    return !!view.contentEl && view.contentEl.win === window;
  }

  private findMainWindowAnchorLeaf(): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      if (leaf === this.screenLeaf) return;

      const view = leaf.view as unknown as { contentEl?: HTMLElement };
      if (!view.contentEl) return;
      if (view.contentEl.win !== window) return;

      found = leaf;
    });

    return found;
  }

  private async focusMainWindowAnchorLeaf(): Promise<WorkspaceLeaf | null> {
    try {
      window.focus();
    } catch {
      // ignore
    }

    const anchor = this.findMainWindowAnchorLeaf();
    if (!anchor) return null;

    try {
      this.app.workspace.setActiveLeaf(anchor, { focus: true });
    } catch {
      await this.app.workspace.revealLeaf(anchor);
    }

    return anchor;
  }

  private createLeafInSameTabGroup(anchor: WorkspaceLeaf): WorkspaceLeaf | null {
    const workspaceAny = this.app.workspace as unknown as {
      createLeafInParent?: (parent: unknown, index?: number) => WorkspaceLeaf;
    };

    const parent = (anchor as unknown as {
      parent?: { children?: unknown[] };
    }).parent;

    if (!parent || typeof workspaceAny.createLeafInParent !== "function") {
      return null;
    }

    const children = Array.isArray(parent.children) ? parent.children : [];
    const index = children.indexOf(anchor as unknown);

    try {
      return workspaceAny.createLeafInParent(parent, index >= 0 ? index + 1 : undefined);
    } catch {
      return null;
    }
  }

  private onGlobalContextMenu(ev: MouseEvent): void {
    const target = ev.target;
    if (!(target instanceof Element)) return;

    const img = target.closest("img");
    if (img instanceof HTMLImageElement) {
      const rawSrc = img.currentSrc || img.getAttribute("src") || "";
      const sourcePath = this.getActiveMarkdownSourcePath();

      const file =
        this.resolveImageElementToFile(img, sourcePath) ??
        this.resolveResourcePathToFile(rawSrc);

      if (!file && !rawSrc) return;

      const menu = new Menu();
      menu.addItem((item) => {
        item
          .setTitle("Send image to player screen")
          .setIcon("image")
          .onClick(() => {
            if (file) {
              void this.sendImageByPath(file.path);
            } else {
              void this.sendImageByPath(rawSrc);
            }
          });
      });
        menu.addItem((item) => {
          item
            .setTitle("Send image with fog of war to player screen")
            .setIcon("brush")
            .onClick(() => {
              if (file) void this.sendImageByPathWithFog(file.path);
              else void this.sendImageByPathWithFog(rawSrc);
            });
        });
      menu.showAtMouseEvent(ev);
      ev.preventDefault();
      return;
    }

    const embed = target.closest(".internal-embed, .pdf-embed");
    if (embed instanceof HTMLElement) {
      const sourcePath = this.getActiveMarkdownSourcePath();
      const src =
        embed.getAttribute("src") ??
        embed.getAttribute("data-path") ??
        "";

      if (src) {
        const file = this.resolveVaultFile(src, sourcePath);
        if (file && isPdfExt(file.extension?.toLowerCase() ?? "")) {
          const menu = new Menu();
          menu.addItem((item) => {
            item
              .setTitle("Send PDF to player screen")
              .setIcon("file-text")
              .onClick(() => {
                void this.sendPdfByPath(file.path);
              });
          });
          menu.showAtMouseEvent(ev);
          ev.preventDefault();
          return;
        }
      }
    }

    const link = target.closest("a.internal-link");
    if (link instanceof HTMLAnchorElement) {
      const raw =
        link.getAttribute("data-href") ??
        link.getAttribute("href") ??
        link.textContent ??
        "";

      const sourcePath = this.getActiveMarkdownSourcePath();
      const file = this.resolveVaultFile(raw, sourcePath);
      if (!(file instanceof TFile)) return;

      const ext = file.extension?.toLowerCase() ?? "";
      const menu = new Menu();

      if (ext === "md") {
        menu.addItem((item) => {
          item
            .setTitle("Send note to player screen")
            .setIcon("monitor-up")
            .onClick(() => {
              void this.sendNoteByPath(file.path);
            });
        });
      } else if (isPdfExt(ext)) {
        menu.addItem((item) => {
          item
            .setTitle("Send PDF to player screen")
            .setIcon("file-text")
            .onClick(() => {
              void this.sendPdfByPath(file.path);
            });
        });
      } else if (isImageExt(ext)) {
        menu.addItem((item) => {
          item
            .setTitle("Send image to player screen")
            .setIcon("image")
            .onClick(() => {
              void this.sendImageByPath(file.path);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("Send image with fog of war to player screen")
            .setIcon("brush")
            .onClick(() => {
              void this.sendImageByPathWithFog(file.path);
            });
        });
      } else {
        return;
      }

      menu.showAtMouseEvent(ev);
      ev.preventDefault();
    }
  }

  /* ------------------------------------------------------
   * File / link resolving
   * ------------------------------------------------------ */

  private resolveImageElementToFile(img: HTMLImageElement, sourcePath: string): TFile | null {
    const embed = img.closest(".internal-embed");
    const embedSrc = embed?.getAttribute("src") ?? "";
    if (embedSrc) {
      const file = this.resolveVaultFile(embedSrc, sourcePath);
      if (file) return file;
    }

    const rawSrc = img.getAttribute("src") ?? "";
    if (!rawSrc) return null;

    return this.resolveResourcePathToFile(rawSrc);
  }

  private resolveResourcePathToFile(resourcePath: string): TFile | null {
    const files = this.app.vault.getFiles();
    for (const file of files) {
      if (this.app.vault.getResourcePath(file) === resourcePath) return file;
    }
    return null;
  }
  
  private isFogControllerLeafUsable(): boolean {
    if (!this.fogControllerLeaf) return false;

    const leafAny = this.fogControllerLeaf as unknown as {
      parent?: unknown;
      view?: unknown;
    };

    if (!leafAny.parent) return false;
    return !!leafAny.view;
  }

  private async ensureFogControllerLeaf(): Promise<WorkspaceLeaf | null> {
    const createLeaf = async (): Promise<WorkspaceLeaf | null> => {
      try {
        const anchor = await this.focusMainWindowAnchorLeaf();
        if (!anchor) {
          new Notice("Could not find a main-window leaf for fog controller.", 3000);
          return null;
        }

        let leaf =
          this.createLeafInSameTabGroup(anchor) ??
          this.app.workspace.getLeaf("tab");

        await leaf.setViewState({
          type: SCREEN_FOG_CONTROLLER_VIEW_TYPE,
          active: true,
          state: {},
        });

        if (leaf.isDeferred) {
          await leaf.loadIfDeferred();
        }

        if (!this.isLeafInMainWindow(leaf)) {
          try {
            leaf.detach();
          } catch {
            // ignore
          }

          const retryAnchor = await this.focusMainWindowAnchorLeaf();
          if (!retryAnchor) {
            new Notice("Could not open fog controller in main window.", 3000);
            return null;
          }

          const retryLeaf = this.createLeafInSameTabGroup(retryAnchor);
          if (!retryLeaf) {
            new Notice("Could not create fog controller tab in main window.", 3000);
            return null;
          }

          await retryLeaf.setViewState({
            type: SCREEN_FOG_CONTROLLER_VIEW_TYPE,
            active: true,
            state: {},
          });

          if (retryLeaf.isDeferred) {
            await retryLeaf.loadIfDeferred();
          }

          if (!this.isLeafInMainWindow(retryLeaf)) {
            try {
              retryLeaf.detach();
            } catch {
              // ignore
            }
            new Notice("Fog controller was prevented from opening in the player screen window.", 3000);
            return null;
          }
          leaf = retryLeaf;
        }

        await this.app.workspace.revealLeaf(leaf);
        return leaf;
      } catch (e) {
        console.error(e);
        new Notice("Could not open fog controller.", 3000);
        return null;
      }
    };

    if (!this.isFogControllerLeafUsable() || !this.isLeafInMainWindow(this.fogControllerLeaf)) {
      this.closeFogControllerLeaf();
      this.fogControllerLeaf = null;
    }

    if (!this.fogControllerLeaf) {
      this.fogControllerLeaf = await createLeaf();
      return this.fogControllerLeaf;
    }

    try {
      await this.app.workspace.revealLeaf(this.fogControllerLeaf);
      return this.fogControllerLeaf;
    } catch {
      this.fogControllerLeaf = null;
    }

    this.fogControllerLeaf = await createLeaf();
    return this.fogControllerLeaf;
  }

  /* ------------------------------------------------------
   * Live refresh on file changes
   * ------------------------------------------------------ */

  private async onVaultModify(file: TFile): Promise<void> {
    if (!this.currentPayload) return;

    if (this.currentPayload.kind === "note" && file.path === this.currentPayload.path) {
      await this.renderCurrentPayload();
	  await this.renderFogControllerForCurrentPayload();
      return;
    }

    if (
      this.currentPayload.kind === "image" &&
      this.currentPayload.filePath &&
      file.path === this.currentPayload.filePath
    ) {
      this.currentPayload.source = this.app.vault.getResourcePath(file);
      await this.renderCurrentPayload();
	  await this.renderFogControllerForCurrentPayload();
      return;
    }

    if (
      this.currentPayload.kind === "pdf" &&
      this.currentPayload.filePath &&
      file.path === this.currentPayload.filePath
    ) {
      this.currentPayload.source = this.app.vault.getResourcePath(file);
      await this.renderCurrentPayload();
	  await this.renderFogControllerForCurrentPayload();
    }
  }

  private async openOrUpdateFogController(payload: ScreenPayload): Promise<void> {
    const leaf = await this.ensureFogControllerLeaf();
    if (!leaf) return;

    const view = leaf.view;
    if (view instanceof ScreenFogControllerView) {
      await view.setPayload(payload);
      await this.app.workspace.revealLeaf(leaf);
      return;
    }

    await leaf.setViewState({
      type: SCREEN_FOG_CONTROLLER_VIEW_TYPE,
      active: true,
      state: { payload },
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async renderFogControllerForCurrentPayload(): Promise<void> {
    const payload = this.getCurrentFogPayload();
    if (!payload) return;
    if (!this.fogControllerLeaf) return;

    const view = this.fogControllerLeaf.view;
    if (view instanceof ScreenFogControllerView) {
      await view.renderPayload(payload);
    }
  }

  private closeFogControllerLeaf(): void {
    if (!this.fogControllerLeaf) return;
    try {
      this.fogControllerLeaf.detach();
    } catch {
      // ignore
    }
    this.fogControllerLeaf = null;
  }
}

class ScreenDisplaySettingTab extends PluginSettingTab {
  private plugin: TTRPGToolsScreenPlugin;

  constructor(app: App, plugin: TTRPGToolsScreenPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Remember window placement")
      .setDesc("The player screen window remembers its last size and position automatically.")
      .addButton((b) => {
        b.setButtonText("Reset saved position").onClick(async () => {
          delete this.plugin.settings.savedWindowX;
          delete this.plugin.settings.savedWindowY;
          delete this.plugin.settings.savedWindowWidth;
          delete this.plugin.settings.savedWindowHeight;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Auto-open on send")
      .setDesc("Opens the screen window automatically when content is sent.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.autoOpenOnSend).onChange(async (v) => {
          this.plugin.settings.autoOpenOnSend = v;
          await this.plugin.saveSettings();
        });
      });

  }
}