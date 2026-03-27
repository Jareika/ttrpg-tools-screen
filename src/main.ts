import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { FuzzyMatch } from "obsidian";
import {
  Component,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
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
const SCREEN_CONTROLLER_VIEW_TYPE = "ttrpg-tools-screen-controller";

interface ScreenFogState {
  enabled: true;
  key: string;
  label?: string;
}

interface PdfTabState {
  currentPage: number;
  zoom: number;
  pageCount: number;
  ready: boolean;
}

interface ScreenControllerItem {
  id: string;
  title: string;
  payload: ScreenPayload;
  signature: string;
  createdAt: number;
  pdfState?: PdfTabState;
}

type VideoScreenPayload = Extract<ScreenPayload, { kind: "video" }>;
type PdfScreenPayload = Extract<ScreenPayload, { kind: "pdf" }>;

interface VideoPlaybackSnapshot {
  source: string;
  filePath?: string;
  duration: number | null;
  currentTime: number;
  paused: boolean;
  loop: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  ready: boolean;
  ended: boolean;
}

interface PdfPlaybackSnapshot {
  source: string;
  filePath?: string;
  pageCount: number;
  currentPage: number;
  zoom: number;
  ready: boolean;
}

interface PdfJsGlobalWorkerOptions {
  workerSrc: string;
}

interface PdfJsViewport {
  width: number;
  height: number;
}

interface PdfJsRenderTask {
  promise: Promise<void>;
}

interface PdfJsPageProxy {
  rotate: number;
  getViewport(params: { scale: number }): PdfJsViewport;
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfJsViewport;
  }): PdfJsRenderTask;
}

interface PdfJsDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPageProxy>;
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocumentProxy>;
}

interface PdfJsDocumentInit {
  data: Uint8Array;
  disableWorker?: boolean;
  standardFontDataUrl?: string;
  cMapUrl?: string;
  cMapPacked?: boolean;
  wasmUrl?: string;
  iccUrl?: string;
  disableFontFace?: boolean;
  useWorkerFetch?: boolean;
  useSystemFonts?: boolean;
  verbosity?: number;
}

interface PdfJsModule {
  version?: string;
  GlobalWorkerOptions: PdfJsGlobalWorkerOptions;
  getDocument(params: PdfJsDocumentInit): PdfJsLoadingTask;
}

type VideoControlCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle-play" }
  | { type: "restart" }
  | { type: "seek"; time: number }
  | { type: "set-loop"; loop: boolean }
  | { type: "set-muted"; muted: boolean }
  | { type: "set-volume"; volume: number };
  
type PdfControlCommand =
  | { type: "next-page" }
  | { type: "prev-page" }
  | { type: "set-page"; page: number }
  | { type: "set-zoom"; zoom: number };
  
const pdfjs = pdfjsLib as unknown as PdfJsModule;

function getPdfJsVersion(): string {
  return typeof pdfjs.version === "string" && pdfjs.version.trim()
    ? pdfjs.version.trim()
    : "4.10.38";
}

function getPdfJsCdnBaseUrl(): string {
  return `https://cdn.jsdelivr.net/npm/pdfjs-dist@${getPdfJsVersion()}/`;
}

let pdfJsWorkerInitPromise: Promise<void> | null = null;

function getPdfJsWorkerSrc(): string {
  return `${getPdfJsCdnBaseUrl()}legacy/build/pdf.worker.min.mjs`;
}

function getPdfJsWasmUrl(): string {
  return `${getPdfJsCdnBaseUrl()}wasm/`;
}

async function ensurePdfJsWorkerConfigured(): Promise<void> {
  if (pdfjs.GlobalWorkerOptions.workerSrc) return;

  if (!pdfJsWorkerInitPromise) {
    pdfJsWorkerInitPromise = (async () => {
      pdfjs.GlobalWorkerOptions.workerSrc = getPdfJsWorkerSrc();
    })();
  }

  await pdfJsWorkerInitPromise;
}

type ScreenPayload =
  | { kind: "note"; path: string; fog?: ScreenFogState }
  | { kind: "markdown"; markdown: string; sourcePath: string; fog?: ScreenFogState }
  | { kind: "image"; source: string; filePath?: string; fog?: ScreenFogState }
  | { kind: "video"; source: string; filePath?: string }
  | { kind: "pdf"; source: string; filePath?: string };

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
  if (x.kind === "video") return typeof x.source === "string";
  return false;
}

function isPdfPayload(payload: ScreenPayload | null | undefined): payload is PdfScreenPayload {
  return payload?.kind === "pdf";
}

function getPayloadFog(payload: ScreenPayload | null | undefined): ScreenFogState | null {
  if (!payload) return null;
  if (!("fog" in payload)) return null;
  return isScreenFogState(payload.fog) ? payload.fog : null;
}

function isVideoPayload(payload: ScreenPayload | null | undefined): payload is VideoScreenPayload {
  return payload?.kind === "video";
}

function isTransparentCssColor(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return (
    normalized === "" ||
    normalized === "transparent" ||
    normalized === "rgba(0,0,0,0)"
  );
}

type VaultMediaPickerMode = "all" | "image" | "video" | "pdf";

function mediaMatchesMode(file: TFile, mode: VaultMediaPickerMode): boolean {
  const ext = file.extension?.toLowerCase() ?? "";
  if (mode === "image") return isImageExt(ext);
  if (mode === "video") return isVideoExt(ext);
  if (mode === "pdf") return isPdfExt(ext);
  return isImageExt(ext) || isVideoExt(ext) || isPdfExt(ext);
}

function getMediaPickerPlaceholder(mode: VaultMediaPickerMode): string {
  if (mode === "image") return "Search images to send to the player screen...";
  if (mode === "video") return "Search videos to send to the player screen...";
  if (mode === "pdf") return "Search PDFs to send to the player screen...";
  return "Search images, videos, and PDFs to send to the player screen...";
}

function formatTimecode(totalSeconds: number | null | undefined): string {
  if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }

  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isImageExt(ext: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"].includes(ext);
}

function isPdfExt(ext: string): boolean {
  return ext === "pdf";
}

function isVideoExt(ext: string): boolean {
  return ["mp4", "webm", "ogv", "mov", "m4v"].includes(ext);
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

function clampPdfPage(page: number, pageCount: number): number {
  const safeCount = Math.max(1, Math.round(pageCount));
  if (!Number.isFinite(page)) return 1;
  return Math.min(safeCount, Math.max(1, Math.round(page)));
}

function clonePdfTabState(state: PdfTabState): PdfTabState {
  return { ...state };
}

abstract class BaseRenderedScreenView extends ItemView {
  protected plugin: TTRPGToolsScreenPlugin;
  protected renderComponent: Component | null = null;
  protected renderedPayload: ScreenPayload | null = null;
  protected stageEl: HTMLElement | null = null;
  protected fogOverlay: ScreenFogOverlay | null = null;
  private stageSizeObserver: ResizeObserver | null = null;
  
  protected onRenderReset(): void {}

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
  
  protected onVideoElementCreated(_video: HTMLVideoElement): void {
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
    const nextType = this.getViewType();
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
    this.onRenderReset();
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
	
    if (payload.kind === "video") {
      this.renderVideo(host, payload.source);
      return;
    }

    if (payload.kind === "pdf") {
      this.renderPdf(host, payload.source);
      return;
    }
  }

  async onFogMaskUpdated(key: string, dataUrl: string | null): Promise<void> {
    const fog = getPayloadFog(this.renderedPayload);
    if (!fog) return;
    if (fog.key !== key) return;
    await this.fogOverlay?.applyMaskFromDataUrl(dataUrl);
  }

  private async setupFogIfNeeded(payload: ScreenPayload): Promise<void> {
    const fog = getPayloadFog(payload);
    if (!fog) return;
    if (!this.stageEl) return;

    this.fogOverlay = new ScreenFogOverlay(
      this.plugin,
      this,
      this.stageEl,
      fog,
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
  
  protected renderVideo(host: HTMLElement, source: string): void {
    const wrap = host.createDiv({ cls: "ttrpg-tools-screen-media" });
    const stage = wrap.createDiv({ cls: "ttrpg-tools-screen-media-stage ttrpg-tools-screen-stage" });
    const video = stage.createEl("video");
    video.src = source;
    video.autoplay = true;
    video.loop = false;
    video.controls = false;
    video.playsInline = true;
    video.preload = "auto";
	this.onVideoElementCreated(video);
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

  protected installStageSizeSync(): void {
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
        } else if (isVideoExt(ext)) {
          void this.plugin.sendVideoByPath(file.path);
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
  private hasUnpublishedChanges = false;
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
  
  private collectBackgroundSources(start: HTMLElement | null, maxDepth = 5): HTMLElement[] {
    const out: HTMLElement[] = [];
    let cur: HTMLElement | null = start;
    let depth = 0;

    while (cur && depth < maxDepth) {
      out.push(cur);
      cur = cur.parentElement;
      depth += 1;
    }

    return out;
  }
  
  private getFogFillStyle(): string {
    const sources: Array<HTMLElement | null> = [
      ...this.collectBackgroundSources(this.overlayHostEl, 6),
      ...this.collectBackgroundSources(this.targetEl, 4),
      ...this.collectBackgroundSources(this.stageEl, 6),
      this.overlayHostEl?.ownerDocument.body ?? null,
      this.overlayHostEl?.ownerDocument.documentElement ?? null,
    ];

    for (const source of sources) {
      if (!(source instanceof HTMLElement)) continue;
      const win = source.ownerDocument.defaultView ?? window;
      const bg = win.getComputedStyle(source).backgroundColor;
      if (!isTransparentCssColor(bg)) {
        return bg;
      }
    }

    return "black";
  }

  private getFogCoverFillStyle(): string {
    return this.getFogFillStyle();
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

    if (!dataUrl) {
      this.fillFullFogViewport();
      return;
    }

    const loaded = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });

    if (!loaded) {
      this.fillFullFogViewport();
      return;
    }

    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.ctx.drawImage(loaded, 0, 0, rect.width, rect.height);
  }

  async fillFullFogAndPublish(): Promise<void> {
    if (this.overlayMode === "map") {
      this.fillFullFogWorld();
      this.renderWorldMaskToViewport();
    } else {
      this.fillFullFogViewport();
    }
	this.hasUnpublishedChanges = true;
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
	this.hasUnpublishedChanges = true;
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
    });

    const endDraw = (ev: PointerEvent) => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      try {
        (ev.currentTarget as Element).releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
	  void this.publishNow();
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
	  this.ctx.fillStyle = this.getFogCoverFillStyle();
      this.ctx.beginPath();
      this.ctx.arc(x, y, this.brushRadius, 0, Math.PI * 2);
      this.ctx.fill();
    }
	this.hasUnpublishedChanges = true;
    this.ctx.restore();
  }

  private async publishNow(): Promise<void> {
    if (!this.hasUnpublishedChanges) return;

    if (this.overlayMode === "map") {
      if (!this.worldMaskCanvas) return;
      try {
        const dataUrl = this.worldMaskCanvas.toDataURL("image/png");
        await this.plugin.setFogMask(this.fog.key, dataUrl, this.owner);
		this.hasUnpublishedChanges = false;
      } catch {
        // ignore
      }
      return;
    }

    if (!this.canvasEl) return;
    try {
      const dataUrl = this.canvasEl.toDataURL("image/png");
      await this.plugin.setFogMask(this.fog.key, dataUrl, this.owner);
	  this.hasUnpublishedChanges = false;
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

    const loaded = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });

    if (!loaded) {
      this.fillFullFogWorld();
      return;
    }

    this.worldMaskCtx.clearRect(0, 0, this.worldMaskCanvas.width, this.worldMaskCanvas.height);
    this.worldMaskCtx.drawImage(
      loaded,
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
    this.ctx.fillStyle = this.getFogFillStyle();
    this.ctx.fillRect(0, 0, rect.width, rect.height);
  }

  private fillFullFogWorld(): void {
    if (!this.worldMaskCtx || !this.worldMaskCanvas) return;
    this.worldMaskCtx.globalCompositeOperation = "source-over";
    this.worldMaskCtx.clearRect(0, 0, this.worldMaskCanvas.width, this.worldMaskCanvas.height);
    this.worldMaskCtx.fillStyle = this.getFogFillStyle();
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
      this.worldMaskCtx.fillStyle = this.getFogCoverFillStyle();
      this.worldMaskCtx.beginPath();
      this.worldMaskCtx.arc(worldX, worldY, worldRadius, 0, Math.PI * 2);
      this.worldMaskCtx.fill();
    }
	this.hasUnpublishedChanges = true;
    this.worldMaskCtx.restore();

    this.worldMaskInitialized = true;
    this.renderWorldMaskToViewport();
  }
}

class ScreenPdfRenderer {
  private app: App;
  private hostEl: HTMLElement;
  private payload: PdfScreenPayload;
  private canvasEl: HTMLCanvasElement;
  private hintEl: HTMLDivElement;
  private ctx: CanvasRenderingContext2D | null;
  private resizeObserver: ResizeObserver | null = null;
  private pdfDoc: PdfJsDocumentProxy | null = null;
  private disposed = false;
  private renderToken = 0;
  private currentPage = 1;
  private renderQueue: Promise<void> = Promise.resolve();
  private scheduledRenderId = 0;
  private hasDeliveredInitialSnapshot = false;
  private resizeRaf: number | null = null;
  private standardFontDataUrl: string;
  private wasmUrl: string;
  private cMapUrl: string;

  private zoom = 1;
  private pageCount = 0;
  private emitSnapshots: boolean;
  private initialState: PdfTabState | null;
  private onSnapshot: (snapshot: PdfPlaybackSnapshot | null) => void;

  constructor(
    app: App,
    hostEl: HTMLElement,
    payload: PdfScreenPayload,
    onSnapshot: (snapshot: PdfPlaybackSnapshot | null) => void,
	initialState: PdfTabState | null = null,
	emitSnapshots = true,
  ) {
	this.app = app;
    this.hostEl = hostEl;
    this.payload = payload;
    this.onSnapshot = onSnapshot;
    this.standardFontDataUrl = `${getPdfJsCdnBaseUrl()}standard_fonts/`;
	this.wasmUrl = getPdfJsWasmUrl();
    this.cMapUrl = `${getPdfJsCdnBaseUrl()}cmaps/`;
	this.emitSnapshots = emitSnapshots;
	this.initialState = initialState ? clonePdfTabState(initialState) : null;

    const wrap = this.hostEl.createDiv({ cls: "ttrpg-tools-screen-pdf" });
    this.canvasEl = wrap.createEl("canvas", { cls: "ttrpg-tools-screen-pdf__canvas" });
    this.hintEl = wrap.createDiv({
      cls: "ttrpg-tools-screen-pdf__hint",
      text: "Loading PDF…",
    });
    this.ctx = this.canvasEl.getContext("2d");
  }

  async load(): Promise<void> {
    try {
	  await ensurePdfJsWorkerConfigured();

      let buffer: ArrayBuffer;
      if (this.payload.filePath) {
        buffer = await this.app.vault.adapter.readBinary(this.payload.filePath);
      } else {
        const response = await requestUrl({
          url: this.payload.source,
          method: "GET",
        });
        buffer = response.arrayBuffer;
      }

      const task = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        disableWorker: false,
		disableFontFace: true,
        standardFontDataUrl: this.standardFontDataUrl,
        cMapUrl: this.cMapUrl,
        cMapPacked: true,
		wasmUrl: this.wasmUrl,
        useWorkerFetch: true,
        useSystemFonts: false,
		verbosity: 0,
      });
      this.pdfDoc = await task.promise;
      if (this.disposed) return;
      this.pageCount = this.pdfDoc.numPages ?? 0;

      if (this.initialState) {
        this.currentPage = clampPdfPage(this.initialState.currentPage, this.pageCount);
        this.zoom = Math.min(3, Math.max(0.25, this.initialState.zoom));
      } else {
        this.currentPage = clampPdfPage(this.currentPage, this.pageCount);
      }

      await this.requestRender(true);

      this.resizeObserver = new ResizeObserver(() => {
        this.scheduleResizeRender();
      });
      this.resizeObserver.observe(this.hostEl);
    } catch (err) {
      console.error(err);
      this.hintEl.textContent = "PDF could not be loaded.";
      this.onSnapshot(null);
    }
  }

  destroy(): void {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    if (this.resizeRaf !== null) {
      window.cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = null;
    }
    this.resizeObserver = null;
    this.onSnapshot(null);
  }
  
  async syncToSnapshot(snapshot: PdfPlaybackSnapshot | null): Promise<void> {
    if (!snapshot) return;
    if (!this.pdfDoc || this.disposed) return;
	if (!snapshot.ready) return;

    const nextPage = clampPdfPage(snapshot.currentPage, this.pageCount);
    const nextZoom = Math.min(3, Math.max(0.25, snapshot.zoom));
    const nextPageCount = Math.max(1, snapshot.pageCount);

    if (nextPageCount !== this.pageCount) {
      this.pageCount = nextPageCount;
    }
    if (this.initialState) {
      this.initialState = { currentPage: nextPage, zoom: nextZoom, pageCount: nextPageCount, ready: snapshot.ready };
    }

    if (nextPage === this.currentPage && Math.abs(nextZoom - this.zoom) < 0.001) {
      return;
    }

    this.currentPage = nextPage;
    this.zoom = nextZoom;
    await this.requestRender(false);
  }

  async applyCommand(command: PdfControlCommand): Promise<void> {
    if (!this.pdfDoc) return;

    if (command.type === "next-page") {
      this.currentPage = Math.min(this.pageCount, this.currentPage + 1);
    } else if (command.type === "prev-page") {
      this.currentPage = Math.max(1, this.currentPage - 1);
    } else if (command.type === "set-page") {
      this.currentPage = clampPdfPage(command.page, this.pageCount);
    } else if (command.type === "set-zoom") {
      this.zoom = Math.min(3, Math.max(0.25, command.zoom));
    }

    await this.requestRender();
  }

  private scheduleResizeRender(): void {
    if (this.resizeRaf !== null) return;

    this.resizeRaf = window.requestAnimationFrame(() => {
      this.resizeRaf = null;
      void this.requestRender(false);
    });
  }

  private async requestRender(emitSnapshot = this.emitSnapshots): Promise<void> {
    const requestId = ++this.scheduledRenderId;

    this.renderQueue = this.renderQueue
      .catch(() => {
        // ignore previous render failures in queue chaining
      })
      .then(async () => {
        if (this.disposed) return;
        await this.renderCurrentPage(requestId, emitSnapshot);
      });

    await this.renderQueue;
  }

  private async renderCurrentPage(requestId: number, emitSnapshot = this.emitSnapshots): Promise<void> {
    if (!this.pdfDoc || !this.ctx || this.disposed) return;

    const token = ++this.renderToken;
    const page = await this.pdfDoc.getPage(this.currentPage);
    if (this.disposed || token !== this.renderToken) return;

    const unscaled = page.getViewport({ scale: 1 });
    const availW = Math.max(200, this.hostEl.clientWidth - 24);
    const availH = Math.max(200, this.hostEl.clientHeight - 24);
    const fitScale = Math.min(availW / unscaled.width, availH / unscaled.height);
    const cssScale = Math.max(0.1, fitScale) * this.zoom;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
	
    if (requestId !== this.scheduledRenderId) {
      return;
    }

    const viewport = page.getViewport({ scale: cssScale * dpr });
    const cssViewport = page.getViewport({ scale: cssScale });

    this.canvasEl.width = Math.max(1, Math.round(viewport.width));
    this.canvasEl.height = Math.max(1, Math.round(viewport.height));
    this.canvasEl.style.width = `${Math.round(cssViewport.width)}px`;
    this.canvasEl.style.height = `${Math.round(cssViewport.height)}px`;

    this.hintEl.textContent = `Page ${this.currentPage} / ${this.pageCount}`;

    await page.render({
      canvasContext: this.ctx,
      viewport,
    }).promise;

    if (
      this.disposed ||
      token !== this.renderToken ||
      requestId !== this.scheduledRenderId ||
      !emitSnapshot
    ) {
      return;
    }

    this.onSnapshot(
      {
        source: this.payload.source,
        filePath: this.payload.filePath,
        pageCount: this.pageCount,
		ready: true,
        currentPage: this.currentPage,
        zoom: this.zoom,
      },
    );
	this.hasDeliveredInitialSnapshot = true;
  }
}

class ScreenDisplayView extends BaseRenderedScreenView {
  private plugin: TTRPGToolsScreenPlugin;
  private windowTrackTimer: number | null = null;
  private lastTrackedBounds: WindowBounds | null = null;
  private lastTrackedWindow: Window | null = null;
  private trackedVideoEl: HTMLVideoElement | null = null;
  private videoTrackAbort: AbortController | null = null;
  private trackedPdfRenderer: ScreenPdfRenderer | null = null;
  private videoStateRaf: number | null = null;

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
  
  protected override onRenderReset(): void {
    const wasVideo = isVideoPayload(this.renderedPayload);
	const wasPdf = isPdfPayload(this.renderedPayload);
    this.teardownVideoTracking();
	this.teardownPdfTracking();
    if (wasVideo) {
      void this.plugin.updateVideoSnapshot(null);
    } else if (wasPdf) {
      void this.plugin.updatePdfSnapshot(null);
    }
  }

  protected override onVideoElementCreated(video: HTMLVideoElement): void {
    this.attachVideoTracking(video);
  }

  private attachVideoTracking(video: HTMLVideoElement): void {
    this.teardownVideoTracking();

    this.trackedVideoEl = video;
    this.videoTrackAbort = new AbortController();

    const signal = this.videoTrackAbort.signal;
    const onAny = () => this.scheduleVideoStatePush();
    const events = [
      "loadedmetadata",
      "loadeddata",
      "durationchange",
      "timeupdate",
      "play",
      "pause",
      "ended",
      "volumechange",
      "ratechange",
      "seeking",
      "seeked",
      "canplay",
      "canplaythrough",
      "waiting",
      "stalled",
      "emptied",
    ] as const;

    for (const eventName of events) {
      video.addEventListener(eventName, onAny, { signal });
    }

    void video.play().then(
      () => this.scheduleVideoStatePush(),
      () => this.scheduleVideoStatePush(),
    );
  }

  private teardownVideoTracking(): void {
    this.videoTrackAbort?.abort();
    this.videoTrackAbort = null;
    this.trackedVideoEl = null;
    if (this.videoStateRaf !== null) {
      window.cancelAnimationFrame(this.videoStateRaf);
      this.videoStateRaf = null;
    }
  }

  private teardownPdfTracking(): void {
    this.trackedPdfRenderer?.destroy();
    this.trackedPdfRenderer = null;
  }

  protected override renderPdf(host: HTMLElement, _source: string): void {
    const payload = isPdfPayload(this.renderedPayload) ? this.renderedPayload : null;
    if (!payload) return;
    const wrap = host.createDiv({ cls: "ttrpg-tools-screen-media" });
    const stage = wrap.createDiv({ cls: "ttrpg-tools-screen-media-stage ttrpg-tools-screen-stage" });
    this.stageEl = stage;
    this.installStageSizeSync();
    this.trackedPdfRenderer = new ScreenPdfRenderer(
      this.app,
      stage,
      payload,
      (snapshot) => { void this.plugin.updatePdfSnapshot(snapshot); },
      this.plugin.getActivePdfTabState(),
    );
    void this.trackedPdfRenderer.load().then(() => this.trackedPdfRenderer?.syncToSnapshot(this.plugin.getCurrentPdfSnapshot()));
  }

  public async applyPdfCommand(command: PdfControlCommand): Promise<void> {
    await this.trackedPdfRenderer?.applyCommand(command);
  }

  private readVideoSnapshot(video: HTMLVideoElement): VideoPlaybackSnapshot | null {
    const payload = isVideoPayload(this.renderedPayload) ? this.renderedPayload : null;
    if (!payload) return null;
    const duration =
      Number.isFinite(video.duration) && video.duration >= 0
        ? video.duration
        : null;
    return {
      source: payload.source,
      filePath: payload.filePath,
      duration,
      currentTime: Number.isFinite(video.currentTime) && video.currentTime >= 0 ? video.currentTime : 0,
      paused: video.paused,
      loop: video.loop,
      muted: video.muted,
      volume: Math.min(1, Math.max(0, video.volume)),
      playbackRate: video.playbackRate,
      ready: video.readyState >= 1,
      ended: video.ended,
    };
  }

  private scheduleVideoStatePush(): void {
    if (this.videoStateRaf !== null) return;
    this.videoStateRaf = window.requestAnimationFrame(() => {
      this.videoStateRaf = null;
      const video = this.trackedVideoEl;
      if (!video) return;
      const snapshot = this.readVideoSnapshot(video);
      void this.plugin.updateVideoSnapshot(snapshot);
    });
  }

  public async applyVideoCommand(command: VideoControlCommand): Promise<void> {
    const video = this.trackedVideoEl;
    if (!video) return;

    if (command.type === "play") {
      try {
        await video.play();
      } catch {
        // ignore
      }
    } else if (command.type === "pause") {
      video.pause();
    } else if (command.type === "toggle-play") {
      if (video.paused) {
        try {
          await video.play();
        } catch {
          // ignore
        }
      } else {
        video.pause();
      }
    } else if (command.type === "restart") {
      video.currentTime = 0;
      if (video.ended) {
        try {
          await video.play();
        } catch {
          // ignore
        }
      }
    } else if (command.type === "seek") {
      const duration =
        Number.isFinite(video.duration) && video.duration >= 0
          ? video.duration
          : null;
      const next =
        duration === null
          ? Math.max(0, command.time)
          : Math.min(duration, Math.max(0, command.time));
      video.currentTime = next;
    } else if (command.type === "set-loop") {
      video.loop = command.loop;
    } else if (command.type === "set-muted") {
      video.muted = command.muted;
    } else if (command.type === "set-volume") {
      video.volume = Math.min(1, Math.max(0, command.volume));
    }

    this.scheduleVideoStatePush();
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
	  this.teardownPdfTracking();
      this.teardownVideoTracking();
      if (isVideoPayload(this.renderedPayload)) {
        void this.plugin.updateVideoSnapshot(null);
      } else if (isPdfPayload(this.renderedPayload)) {
        void this.plugin.updatePdfSnapshot(null);
      }
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

class ScreenControllerView extends BaseRenderedScreenView {
  private tabsEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private controlsEl: HTMLDivElement | null = null;
  private actionsEl: HTMLDivElement | null = null;
  private renderHostEl: HTMLDivElement | null = null;

  private playBtn: HTMLButtonElement | null = null;
  private restartBtn: HTMLButtonElement | null = null;
  private loopInput: HTMLInputElement | null = null;
  private muteInput: HTMLInputElement | null = null;
  private seekInput: HTMLInputElement | null = null;
  private timeLabelEl: HTMLSpanElement | null = null;
  private volumeInput: HTMLInputElement | null = null;
  private currentVideoSnapshot: VideoPlaybackSnapshot | null = null;
  private isScrubbing = false;
  private scrubPreviewTime: number | null = null;

  private fogToolBtn: HTMLButtonElement | null = null;
  private fogRadiusInput: HTMLInputElement | null = null;
  private fogRadiusLabel: HTMLSpanElement | null = null;

  private pdfPrevBtn: HTMLButtonElement | null = null;
  private pdfNextBtn: HTMLButtonElement | null = null;
  private pdfPageInput: HTMLInputElement | null = null;
  private pdfPageLabel: HTMLSpanElement | null = null;
  private pdfZoomInput: HTMLInputElement | null = null;
  private pdfPreviewRenderer: ScreenPdfRenderer | null = null;
  private pdfZoomLabel: HTMLSpanElement | null = null;
  private currentPdfSnapshot: PdfPlaybackSnapshot | null = null;
  
  private getCurrentPdfPageCount(): number {
    return Math.max(
      1,
      this.currentPdfSnapshot?.pageCount ??
      this.plugin.getActivePdfTabState()?.pageCount ??
      1,
    );
  }

  private getCurrentPdfPage(): number {
    return clampPdfPage(Number(this.pdfPageInput?.value ?? "1"), this.getCurrentPdfPageCount());
  }

  constructor(leaf: WorkspaceLeaf, plugin: TTRPGToolsScreenPlugin) {
    super(leaf, plugin);
  }

  getViewType(): string {
    return SCREEN_CONTROLLER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Player screen controller";
  }

  getIcon(): "layout-dashboard" {
    return "layout-dashboard";
  }

  protected getRenderHost(): HTMLElement {
    if (!this.renderHostEl) {
      this.renderHostEl = this.contentEl.createDiv({
        cls: "ttrpg-tools-screen-controller__render",
      });
    }
    return this.renderHostEl;
  }

  protected isFogInteractive(): boolean {
    return true;
  }

  protected override getPreferredStageSize(): RenderBox | null {
    return this.plugin.getCurrentScreenRenderSize();
  }
  
  protected override onRenderReset(): void {
    this.pdfPreviewRenderer?.destroy();
    this.pdfPreviewRenderer = null;
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("ttrpg-tools-screen-controller");

    this.tabsEl = this.contentEl.createDiv({
      cls: "ttrpg-tools-screen-controller__tabs",
    });
    this.statusEl = this.contentEl.createDiv({
      cls: "ttrpg-tools-screen-controller__status",
      text: "No item selected.",
    });
    this.actionsEl = this.contentEl.createDiv({
      cls: "ttrpg-tools-screen-controller__actions",
    });
    const closeScreenBtn = this.actionsEl.createEl("button", {
      text: "Close player screen",
    });
    closeScreenBtn.onclick = () => {
      this.plugin.closeScreenWindow();
    };
    this.controlsEl = this.contentEl.createDiv({
      cls: "ttrpg-tools-screen-controller__controls",
    });
    this.getRenderHost();

    this.refreshTabs();

    const payload = this.plugin.getCurrentPayload();
    if (payload) {
      await this.renderPayload(payload);
    } else {
      this.showEmptyState();
    }
  }

  onClose(): Promise<void> {
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.fogOverlay?.destroy();
    this.pdfPreviewRenderer?.destroy();
    this.pdfPreviewRenderer = null;
    this.teardownStageSizeSync();
    this.plugin.notifyControllerLeafClosed(this.leaf);
    return Promise.resolve();
  }

  refreshTabs(): void {
    if (!this.tabsEl) return;
    this.tabsEl.empty();

    const items = this.plugin.getControllerItems();
    const currentId = this.plugin.getCurrentControllerItemId();

    if (!items.length) {
      this.tabsEl.createDiv({
        cls: "ttrpg-tools-screen-controller__empty-tabs",
        text: "No sent items yet.",
      });
      return;
    }

    for (const item of items) {
      const tab = this.tabsEl.createDiv({
        cls:
          "ttrpg-tools-screen-controller__tab" +
          (item.id === currentId ? " is-active" : ""),
      });
      const button = tab.createEl("button", {
        cls: "ttrpg-tools-screen-controller__tab-main",
        text: item.title,
      });
      button.onclick = () => {
        void this.plugin.activateControllerItem(item.id);
      };

      const closeBtn = tab.createEl("button", {
        cls: "ttrpg-tools-screen-controller__tab-close",
        text: "×",
      });
      closeBtn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.plugin.closeControllerItem(item.id);
      };
    }
  }

  clearSelection(): void {
    this.renderedPayload = null;
    this.getRenderHost().empty();
    this.showEmptyState();
  }

  onVideoStateUpdated(snapshot: VideoPlaybackSnapshot | null): void {
    this.currentVideoSnapshot = snapshot;
    this.syncVideoControls();
  }

  onPdfStateUpdated(snapshot: PdfPlaybackSnapshot | null): void {
    this.currentPdfSnapshot = snapshot;
    this.syncPdfControls();
    if (snapshot?.ready) {
      this.plugin.storeActivePdfTabState(snapshot);
    }
	void this.pdfPreviewRenderer?.syncToSnapshot(snapshot);
  }

  override async renderPayload(payload: ScreenPayload): Promise<void> {
    this.refreshTabs();
    this.rebuildControls(payload);

    if (payload.kind === "video") {
      this.getRenderHost().empty();
      this.renderedPayload = payload;
      if (this.statusEl) {
        this.statusEl.textContent = `Selected: ${this.plugin.getPayloadTitle(payload)}`;
      }
      this.getRenderHost().createDiv({
        cls: "ttrpg-tools-screen-controller__placeholder",
        text:
          payload.kind === "video"
            ? "Use the controls above to manage video playback."
            : "Use the controls above to navigate the PDF shown on the player screen.",
      });
      return;
    }

    await super.renderPayload(payload);

    if (payload.kind === "pdf") {
      await this.pdfPreviewRenderer?.syncToSnapshot(this.currentPdfSnapshot);
    }

    if (this.statusEl) {
      this.statusEl.textContent = `Selected: ${this.plugin.getPayloadTitle(payload)}`;
    }
  }

  private showEmptyState(): void {
    if (this.statusEl) {
      this.statusEl.textContent = "No active player screen item.";
    }
    if (this.controlsEl) {
      this.controlsEl.empty();
    }
    this.getRenderHost().empty();
    this.getRenderHost().createDiv({
      cls: "ttrpg-tools-screen-controller__placeholder",
      text: "Send something to the player screen to create a tab.",
    });
  }
  
  protected override renderPdf(host: HTMLElement, _source: string): void {
    const payload = isPdfPayload(this.renderedPayload) ? this.renderedPayload : null;
    if (!payload) return;

    const wrap = host.createDiv({ cls: "ttrpg-tools-screen-media" });
    const stage = wrap.createDiv({ cls: "ttrpg-tools-screen-media-stage ttrpg-tools-screen-stage" });
    this.stageEl = stage;
    this.installStageSizeSync();

    this.pdfPreviewRenderer = new ScreenPdfRenderer(
      this.app,
      stage,
      payload,
      () => undefined,
	  this.plugin.getActivePdfTabState(),
      false,
    );
    void this.pdfPreviewRenderer.load().then(() => this.pdfPreviewRenderer?.syncToSnapshot(this.currentPdfSnapshot));
  }

  private rebuildControls(payload: ScreenPayload): void {
    if (!this.controlsEl) return;
    this.controlsEl.empty();

    this.playBtn = null;
    this.restartBtn = null;
    this.loopInput = null;
    this.muteInput = null;
    this.seekInput = null;
    this.timeLabelEl = null;
    this.volumeInput = null;

    this.fogToolBtn = null;
    this.fogRadiusInput = null;
    this.fogRadiusLabel = null;

    this.pdfPrevBtn = null;
    this.pdfNextBtn = null;
    this.pdfPageInput = null;
    this.pdfPageLabel = null;
    this.pdfZoomInput = null;
    this.pdfZoomLabel = null;

    const fog = getPayloadFog(payload);
    if (fog) {
      const row = this.controlsEl.createDiv({
        cls: "ttrpg-tools-screen-controller__row",
      });
      this.fogToolBtn = row.createEl("button", { text: "Tool: reveal" });
      this.fogToolBtn.onclick = () => {
        const next =
          this.fogOverlay?.getBrushMode() === "cover" ? "reveal" : "cover";
        this.fogOverlay?.setBrushMode(next);
        this.syncFogControls();
      };

      row.createSpan({ text: "Brush:" });
      this.fogRadiusInput = row.createEl("input", {
        attr: { type: "range", min: "5", max: "200", value: "40" },
      });
      this.fogRadiusInput.oninput = () => {
        this.fogOverlay?.setBrushRadius(Number(this.fogRadiusInput?.value ?? "40"));
        this.syncFogControls();
      };
      this.fogRadiusLabel = row.createEl("span", { text: "40px" });

      row.createEl("button", { text: "Reset to full fog" }).onclick = () => {
        void this.fogOverlay?.fillFullFogAndPublish();
      };
      row.createEl("button", { text: "Reveal all" }).onclick = () => {
        void this.fogOverlay?.clearFogAndPublish();
      };
    }

    if (payload.kind === "video") {
      const controlsRow = this.controlsEl.createDiv({
        cls: "ttrpg-tools-screen-controller__row",
      });

      this.playBtn = controlsRow.createEl("button", { text: "Play" });
      this.playBtn.onclick = () => {
        const paused = this.currentVideoSnapshot?.paused ?? true;
        void this.plugin.applyVideoCommand({ type: paused ? "play" : "pause" });
      };

      this.restartBtn = controlsRow.createEl("button", { text: "Restart" });
      this.restartBtn.onclick = () => {
        void this.plugin.applyVideoCommand({ type: "restart" });
      };

      const loopWrap = controlsRow.createEl("label", {
        cls: "ttrpg-tools-screen-controller__toggle",
      });
      this.loopInput = loopWrap.createEl("input", { attr: { type: "checkbox" } });
      loopWrap.createSpan({ text: "Loop" });
      this.loopInput.onchange = () => {
        void this.plugin.applyVideoCommand({
          type: "set-loop",
          loop: !!this.loopInput?.checked,
        });
      };

      const muteWrap = controlsRow.createEl("label", {
        cls: "ttrpg-tools-screen-controller__toggle",
      });
      this.muteInput = muteWrap.createEl("input", { attr: { type: "checkbox" } });
      muteWrap.createSpan({ text: "Mute" });
      this.muteInput.onchange = () => {
        void this.plugin.applyVideoCommand({
          type: "set-muted",
          muted: !!this.muteInput?.checked,
        });
      };

      const timelineRow = this.controlsEl.createDiv({
        cls: "ttrpg-tools-screen-controller__row",
      });
      this.seekInput = timelineRow.createEl("input", {
        attr: { type: "range", min: "0", max: "0", step: "0.01", value: "0" },
      });
      this.timeLabelEl = timelineRow.createEl("span", { text: "0:00 / 0:00" });

      this.seekInput.addEventListener("pointerdown", () => {
        this.isScrubbing = true;
      });
      this.seekInput.addEventListener("pointerup", () => {
        this.commitSeekFromUi();
      });
      this.seekInput.addEventListener("pointercancel", () => {
        this.commitSeekFromUi();
      });
      this.seekInput.oninput = () => {
        this.scrubPreviewTime = Number(this.seekInput?.value ?? "0");
        this.syncVideoControls();
      };
      this.seekInput.onchange = () => {
        this.commitSeekFromUi();
      };

      const volumeRow = this.controlsEl.createDiv({
        cls: "ttrpg-tools-screen-controller__row",
      });
      volumeRow.createEl("span", { text: "Volume" });
      this.volumeInput = volumeRow.createEl("input", {
        attr: { type: "range", min: "0", max: "1", step: "0.01", value: "1" },
      });
      this.volumeInput.oninput = () => {
        void this.plugin.applyVideoCommand({
          type: "set-volume",
          volume: Number(this.volumeInput?.value ?? "1"),
        });
      };
    }

    if (payload.kind === "pdf") {
      const row = this.controlsEl.createDiv({
        cls: "ttrpg-tools-screen-controller__row",
      });
      this.pdfPrevBtn = row.createEl("button", { text: "Previous page" });
      this.pdfPrevBtn.onclick = () => {
        void this.plugin.applyPdfCommand({ type: "prev-page" });
      };
      this.pdfNextBtn = row.createEl("button", { text: "Next page" });
      this.pdfNextBtn.onclick = () => {
        void this.plugin.applyPdfCommand({ type: "next-page" });
      };

      row.createSpan({ text: "Page" });
      this.pdfPageInput = row.createEl("input", {
        attr: { type: "number", min: "1", value: "1" },
      });
      setCssProps(this.pdfPageInput, {
        width: "7ch",
      });
      this.pdfPageLabel = row.createEl("span", { text: "/ 1" });
      this.pdfPageInput.onchange = () => {
        void this.plugin.applyPdfCommand({
          type: "set-page",
          page: this.getCurrentPdfPage(),
        });
      };

      row.createSpan({ text: "Zoom" });
      this.pdfZoomInput = row.createEl("input", {
        attr: { type: "range", min: "0.25", max: "3", step: "0.05", value: "1" },
      });
      this.pdfZoomLabel = row.createEl("span", { text: "100%" });
      this.pdfZoomInput.oninput = () => {
        const zoom = Number(this.pdfZoomInput?.value ?? "1");
        if (this.pdfZoomLabel) this.pdfZoomLabel.textContent = `${Math.round(zoom * 100)}%`;
        void this.plugin.applyPdfCommand({ type: "set-zoom", zoom });
      };
    }

    this.syncFogControls();
    this.syncVideoControls();
    this.syncPdfControls();
  }

  private commitSeekFromUi(): void {
    const next = Number(this.seekInput?.value ?? "0");
    this.isScrubbing = false;
    this.scrubPreviewTime = null;
    void this.plugin.applyVideoCommand({ type: "seek", time: next });
  }

  private syncFogControls(): void {
    const mode = this.fogOverlay?.getBrushMode() ?? "reveal";
    const radius = this.fogOverlay?.getBrushRadius() ?? 40;
    if (this.fogToolBtn) this.fogToolBtn.textContent = mode === "cover" ? "Tool: cover" : "Tool: reveal";
    if (this.fogRadiusInput) this.fogRadiusInput.value = String(radius);
    if (this.fogRadiusLabel) this.fogRadiusLabel.textContent = `${radius}px`;
  }

  private syncVideoControls(): void {
    const snapshot = this.currentVideoSnapshot;
    if (this.playBtn) this.playBtn.textContent = snapshot?.paused ?? true ? "Play" : "Pause";
    if (this.loopInput) this.loopInput.checked = snapshot?.loop ?? false;
    if (this.muteInput) this.muteInput.checked = snapshot?.muted ?? false;
    if (this.volumeInput && snapshot) this.volumeInput.value = String(snapshot.volume);
    if (this.seekInput) {
      const duration = snapshot?.duration ?? 0;
      this.seekInput.max = String(Math.max(0, duration));
      if (!this.isScrubbing) this.seekInput.value = String(snapshot?.currentTime ?? 0);
    }
    if (this.timeLabelEl) {
      const current =
        this.isScrubbing && this.scrubPreviewTime !== null
          ? this.scrubPreviewTime
          : (snapshot?.currentTime ?? 0);
      this.timeLabelEl.textContent = `${formatTimecode(current)} / ${formatTimecode(snapshot?.duration ?? 0)}`;
    }
  }

  private syncPdfControls(): void {
    const snapshot = this.currentPdfSnapshot;
    const pageCount = Math.max(1, snapshot?.pageCount ?? this.plugin.getActivePdfTabState()?.pageCount ?? 1);
    const currentPage = clampPdfPage(snapshot?.currentPage ?? this.plugin.getActivePdfTabState()?.currentPage ?? 1, pageCount);
    const zoom = snapshot?.zoom ?? this.plugin.getActivePdfTabState()?.zoom ?? 1;
    const ready = snapshot?.ready ?? this.plugin.getActivePdfTabState()?.ready ?? false;

    if (this.pdfPageInput) {
      this.pdfPageInput.value = String(currentPage);
      this.pdfPageInput.max = String(pageCount);
      this.pdfPageInput.disabled = !ready;
    }
    if (this.pdfPageLabel) this.pdfPageLabel.textContent = `/ ${pageCount}`;
    if (this.pdfZoomInput) this.pdfZoomInput.value = String(zoom);
    if (this.pdfZoomLabel) this.pdfZoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    if (this.pdfPrevBtn) this.pdfPrevBtn.disabled = !ready || currentPage <= 1;
    if (this.pdfNextBtn) this.pdfNextBtn.disabled = !ready || currentPage >= pageCount;
    if (this.pdfZoomInput) this.pdfZoomInput.disabled = !ready;
  }
}

class VaultMediaSuggestModal extends FuzzySuggestModal<TFile> {
  private plugin: TTRPGToolsScreenPlugin;
  private items: TFile[];
  private mode: VaultMediaPickerMode;

  constructor(app: App, plugin: TTRPGToolsScreenPlugin, mode: VaultMediaPickerMode = "all") {
    super(app);
    this.plugin = plugin;
    this.mode = mode;
    this.setPlaceholder(getMediaPickerPlaceholder(mode));
    this.items = this.app.vault
      .getFiles()
      .filter((file) => mediaMatchesMode(file, mode))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getItems(): TFile[] {
    return this.items;
  }

  getItemText(item: TFile): string {
    return item.path;
  }
  
  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    el.empty();
    const item = match.item;
    const row = el.createDiv({ cls: "ttrpg-tools-screen-picker__row" });
    row.createSpan({ text: item.basename, cls: "ttrpg-tools-screen-picker__name" });
    row.createSpan({
      text: item.extension.toUpperCase(),
      cls: "ttrpg-tools-screen-picker__badge",
    });

    el.createDiv({
      text: item.path,
      cls: "ttrpg-tools-screen-picker__path",
    });
  }

  onChooseItem(item: TFile): void {
    const ext = item.extension?.toLowerCase() ?? "";
    if (isImageExt(ext)) {
      void this.plugin.sendImageByPath(item.path);
      return;
    }
    if (isVideoExt(ext)) {
      void this.plugin.sendVideoByPath(item.path);
      return;
    }
    if (isPdfExt(ext)) {
      void this.plugin.sendPdfByPath(item.path);
    }
  }
}

export default class TTRPGToolsScreenPlugin extends Plugin {
  settings: ScreenDisplaySettings = DEFAULT_SETTINGS;

  private screenLeaf: WorkspaceLeaf | null = null;
  private currentPayload: ScreenPayload | null = null;
  private previewContextMenuRoots = new WeakSet<HTMLElement>();
  private controllerLeaf: WorkspaceLeaf | null = null;
  private screenItems: ScreenControllerItem[] = [];
  private currentItemId: string | null = null;
  private boundsSaveTimer: number | null = null;
  private fogMasks = new Map<string, string>();
  private currentScreenRenderSize: RenderBox | null = null;
  private currentVideoSnapshot: VideoPlaybackSnapshot | null = null;
  private currentPdfSnapshot: PdfPlaybackSnapshot | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(SCREEN_VIEW_TYPE, (leaf) => new ScreenDisplayView(leaf, this));
	this.registerView(SCREEN_CONTROLLER_VIEW_TYPE, (leaf) => new ScreenControllerView(leaf, this));

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
      id: "send-selected-text-to-screen",
      name: "Send selected text to screen",
      editorCallback: (editor, view) => {
        void this.sendSelectedText(editor, view);
      },
    });

    this.addCommand({
      id: "open-player-screen-media-picker",
      name: "Open player screen media picker",
      callback: () => {
        new VaultMediaSuggestModal(this.app, this).open();
      }
    });

    this.addCommand({
      id: "open-player-screen-image-picker",
      name: "Open player screen image picker",
      callback: () => {
        new VaultMediaSuggestModal(this.app, this, "image").open();
      },
    });

    this.addCommand({
      id: "open-player-screen-video-picker",
      name: "Open player screen video picker",
      callback: () => {
        new VaultMediaSuggestModal(this.app, this, "video").open();
      },
    });

    this.addCommand({
      id: "open-player-screen-pdf-picker",
      name: "Open player screen PDF picker",
      callback: () => {
        new VaultMediaSuggestModal(this.app, this, "pdf").open();
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
      id: "open-player-screen-controller",
      name: "Open player screen controller",
      callback: () => {
        void this.openOrUpdateController();
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

    if (pdfJsWorkerInitPromise) {
      pdfJsWorkerInitPromise = null;
    }

    this.closeScreenLeaf();
	this.closeControllerLeaf();
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
    this.currentPayload = null;
    this.currentItemId = null;
    this.currentVideoSnapshot = null;
    this.currentPdfSnapshot = null;
    void this.renderBlankScreen();
    void this.refreshControllerView();
  }

  getCurrentPayload(): ScreenPayload | null {
    return this.currentPayload;
  }
  
  private getControllerItemById(id: string | null): ScreenControllerItem | null {
    if (!id) return null;
    return this.screenItems.find((item) => item.id === id) ?? null;
  }

  private getCurrentControllerItem(): ScreenControllerItem | null {
    return this.getControllerItemById(this.currentItemId);
  }
  
  getControllerItems(): ScreenControllerItem[] {
    return this.screenItems.map((item) => ({
      ...item,
      pdfState: item.pdfState ? clonePdfTabState(item.pdfState) : undefined,
    }));
  }

  getCurrentControllerItemId(): string | null {
    return this.currentItemId;
  }
  
  getActivePdfTabState(): PdfTabState | null {
    const item = this.getCurrentControllerItem();
    if (!item?.pdfState) return null;
    return clonePdfTabState(item.pdfState);
  }
  
  getCurrentVideoPayload(): VideoScreenPayload | null {
    return isVideoPayload(this.currentPayload) ? this.currentPayload : null;
  }

  getCurrentVideoSnapshot(): VideoPlaybackSnapshot | null {
    return this.currentVideoSnapshot ? { ...this.currentVideoSnapshot } : null;
  }
  
  getCurrentPdfPayload(): PdfScreenPayload | null {
    return isPdfPayload(this.currentPayload) ? this.currentPayload : null;
  }

  getCurrentPdfSnapshot(): PdfPlaybackSnapshot | null {
    return this.currentPdfSnapshot ? { ...this.currentPdfSnapshot } : null;
  }
  
  storeActivePdfTabState(snapshot: PdfPlaybackSnapshot): void {
    const item = this.getCurrentControllerItem();
    if (!item) return;
    if (!isPdfPayload(item.payload)) return;
    item.pdfState = {
      currentPage: clampPdfPage(snapshot.currentPage, snapshot.pageCount),
      pageCount: Math.max(1, snapshot.pageCount),
      zoom: Math.min(3, Math.max(0.25, snapshot.zoom)),
      ready: snapshot.ready,
    };
  }
  
  getCurrentFogPayload(): ScreenPayload | null {
    if (!getPayloadFog(this.currentPayload)) return null;
    return this.currentPayload;
  }

  notifyScreenLeafClosed(leaf: WorkspaceLeaf): void {
    if (this.screenLeaf === leaf) {
      this.screenLeaf = null;
      this.currentScreenRenderSize = null;
	  this.currentVideoSnapshot = null;
      if (this.controllerLeaf?.view instanceof BaseRenderedScreenView) {
        this.controllerLeaf.view.refreshStageSizeVars();
      }
    }
  }
  
  notifyControllerLeafClosed(leaf: WorkspaceLeaf): void {
    if (this.controllerLeaf === leaf) {
      this.controllerLeaf = null;
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

    if (this.controllerLeaf?.view instanceof BaseRenderedScreenView) {
      this.controllerLeaf.view.refreshStageSizeVars();
    }
  }
  
  async updateVideoSnapshot(snapshot: VideoPlaybackSnapshot | null): Promise<void> {
    this.currentVideoSnapshot = snapshot ? { ...snapshot } : null;
    await this.pushVideoSnapshotToOpenViews(this.currentVideoSnapshot);
  }
  
  async updatePdfSnapshot(snapshot: PdfPlaybackSnapshot | null): Promise<void> {
    this.currentPdfSnapshot = snapshot ? { ...snapshot } : null;
    if (snapshot && isPdfPayload(this.currentPayload)) {
      this.storeActivePdfTabState(snapshot);
    }
    await this.pushPdfSnapshotToOpenViews(this.currentPdfSnapshot);
  }

  async applyVideoCommand(command: VideoControlCommand): Promise<void> {
    const view = this.screenLeaf?.view;
    if (!(view instanceof ScreenDisplayView)) return;
    if (!isVideoPayload(this.currentPayload)) return;

    await view.applyVideoCommand(command);
  }
  
  async applyPdfCommand(command: PdfControlCommand): Promise<void> {
    const view = this.screenLeaf?.view;
    if (!(view instanceof ScreenDisplayView)) return;
    if (!isPdfPayload(this.currentPayload)) return;

    await view.applyPdfCommand(command);
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
    if (this.controllerLeaf?.view instanceof BaseRenderedScreenView) {
      views.push(this.controllerLeaf.view);
    }

    for (const view of views) {
      if (view === sourceView) continue;
      await view.onFogMaskUpdated(key, dataUrl);
    }
  }
  
  private async pushVideoSnapshotToOpenViews(snapshot: VideoPlaybackSnapshot | null): Promise<void> {
    const controllerView = this.controllerLeaf?.view;
    if (controllerView instanceof ScreenControllerView) {
      controllerView.onVideoStateUpdated(snapshot);
    }
  }

  private async pushPdfSnapshotToOpenViews(snapshot: PdfPlaybackSnapshot | null): Promise<void> {
    const controllerView = this.controllerLeaf?.view;
    if (controllerView instanceof ScreenControllerView) {
      controllerView.onPdfStateUpdated(snapshot);
    }
  }

  public getPayloadTitle(payload: ScreenPayload): string {
    if (payload.kind === "note") return payload.path.split("/").pop() ?? payload.path;
    if (payload.kind === "markdown") {
      const first = payload.markdown.split("\n").map((x) => x.trim()).find(Boolean);
      return first?.replace(/^#+\s*/, "").slice(0, 40) || "Snippet";
    }
    return payload.filePath?.split("/").pop() ?? payload.source.split("/").pop() ?? payload.kind;
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
  
  private makePayloadSignature(payload: ScreenPayload): string {
    if (payload.kind === "note") return `note:${payload.path}`;
    if (payload.kind === "markdown") return `markdown:${payload.sourcePath}:${payload.markdown}`;
    if (payload.kind === "image") return `image:${payload.filePath ?? payload.source}:${payload.fog?.key ?? ""}`;
    if (payload.kind === "video") return `video:${payload.filePath ?? payload.source}`;
    return `pdf:${payload.filePath ?? payload.source}`;
  }

  private makeControllerItemId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private addOrActivateControllerItem(payload: ScreenPayload): ScreenControllerItem {
    const signature = this.makePayloadSignature(payload);
    const existing = this.screenItems.find((item) => item.signature === signature);
    if (existing) {
      existing.payload = payload;
      existing.title = this.getPayloadTitle(payload);
      this.currentItemId = existing.id;
      return existing;
    }

    const item: ScreenControllerItem = {
      id: this.makeControllerItemId(),
      title: this.getPayloadTitle(payload),
      payload,
      signature,
      createdAt: Date.now(),
	  pdfState: undefined,
    };
    this.screenItems.push(item);
    this.currentItemId = item.id;
    return item;
  }

  public async activateControllerItem(id: string): Promise<void> {
    const item = this.screenItems.find((x) => x.id === id);
    if (!item) return;
    this.currentItemId = item.id;
    this.currentPayload = item.payload;
    if (item.payload.kind === "pdf") {
      this.currentPdfSnapshot = item.pdfState
        ? {
            source: item.payload.source,
            filePath: item.payload.filePath,
            ...clonePdfTabState(item.pdfState),
          }
        : null;
    } else {
      this.currentPdfSnapshot = null;
    }
    await this.renderCurrentPayload();
    await this.refreshControllerView();
  }

  public async closeControllerItem(id: string): Promise<void> {
    const idx = this.screenItems.findIndex((x) => x.id === id);
    if (idx < 0) return;

    const wasCurrent = this.currentItemId === id;
    this.screenItems.splice(idx, 1);

    if (wasCurrent) {
      this.currentItemId = null;
      this.currentPayload = null;
      this.currentVideoSnapshot = null;
      this.currentPdfSnapshot = null;

      await this.pushVideoSnapshotToOpenViews(null);
      await this.pushPdfSnapshotToOpenViews(null);
      await this.renderBlankScreen();
    }

    await this.refreshControllerView();
  }

  private async sendPayload(payload: ScreenPayload): Promise<void> {
    const item = this.addOrActivateControllerItem(payload);
    this.currentPayload = item.payload;

    await this.renderCurrentPayload();
    await this.openOrUpdateController();
    await this.refreshControllerView();
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
  
  public async sendVideoByPath(pathOrSource: string): Promise<void> {
    const file = this.resolveVaultFile(
      pathOrSource,
      this.app.workspace.getActiveFile()?.path ?? "",
    );

    if (file) {
      await this.sendPayload({
        kind: "video",
        source: this.app.vault.getResourcePath(file),
        filePath: file.path,
      });
      return;
    }

    await this.sendPayload({ kind: "video", source: pathOrSource });
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
	
    if (isVideoExt(ext)) {
      menu.addItem((item) => {
        item
          .setTitle("Send video to player screen")
          .setIcon("play")
          .onClick(() => {
            void this.sendVideoByPath(file.path);
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
    const selected = editor.getSelection();

    if (selected.trim()) {
      menu.addItem((item) => {
        item
          .setTitle("Send selected text to player screen")
          .setIcon("highlighter")
          .onClick(() => {
            void this.sendMarkdown(this.normalizeMarkdownSnippet(selected), file.path);
          });
      });
    }

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

      // Videos in reading view
      const video = target.closest("video");
      if (video instanceof HTMLVideoElement && el.contains(video)) {
        const file = this.resolveVideoElementToFile(video, sourcePath);
        const rawSrc =
          video.currentSrc ||
          video.getAttribute("src") ||
          video.querySelector("source")?.getAttribute("src") ||
          "";
        if (!file && !rawSrc) return;

        ev.preventDefault();
        ev.stopPropagation();

        const menu = new Menu();
        menu.addItem((item) => {
          item
            .setTitle("Send video to player screen")
            .setIcon("play")
            .onClick(() => {
              if (file) void this.sendVideoByPath(file.path);
              else void this.sendVideoByPath(rawSrc);
            });
        });
        menu.showAtMouseEvent(ev);
        return;
      }

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
        } else if (isVideoExt(ext)) {
          menu.addItem((item) => {
            item
              .setTitle("Send video to player screen")
              .setIcon("play")
              .onClick(() => {
                void this.sendVideoByPath(file.path);
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
  
  private normalizeMarkdownSnippet(markdown: string): string {
    return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  }

  private async sendSelectedText(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!(file instanceof TFile)) {
      new Notice("No note available.", 1500);
      return;
    }

    const selected = editor.getSelection();
    if (!selected.trim()) {
      new Notice("No selected text.", 1500);
      return;
    }

    await this.sendMarkdown(this.normalizeMarkdownSnippet(selected), file.path);
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
  
  private isControllerLeafUsable(): boolean {
    if (!this.controllerLeaf) return false;
    const leafAny = this.controllerLeaf as unknown as { parent?: unknown; view?: unknown };
    if (!leafAny.parent) return false;
    return !!leafAny.view;
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
    } catch {
      this.screenLeaf = null;
    }

    this.screenLeaf = await createLeaf();
    return this.screenLeaf;
  }

  private async ensureControllerLeaf(): Promise<WorkspaceLeaf | null> {
    const createLeaf = async (): Promise<WorkspaceLeaf | null> => {
      try {
        const anchor = await this.focusMainWindowAnchorLeaf();
        if (!anchor) {
          new Notice("Could not find a main-window leaf for the player screen controller.", 3000);
          return null;
        }

        let leaf =
          this.createLeafInSameTabGroup(anchor) ??
          this.app.workspace.getLeaf("tab");

        await leaf.setViewState({
          type: SCREEN_CONTROLLER_VIEW_TYPE,
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
          new Notice("Could not open controller in main window.", 3000);
          return null;
        }

        await this.app.workspace.revealLeaf(leaf);
        return leaf;
      } catch (e) {
        console.error(e);
        new Notice("Could not open player screen controller.", 3000);
        return null;
      }
    };

    if (!this.isControllerLeafUsable() || !this.isLeafInMainWindow(this.controllerLeaf)) {
      this.closeControllerLeaf();
      this.controllerLeaf = null;
    }

    if (!this.controllerLeaf) {
      this.controllerLeaf = await createLeaf();
      return this.controllerLeaf;
    }

    try {
      await this.app.workspace.revealLeaf(this.controllerLeaf);
      return this.controllerLeaf;
    } catch {
      this.controllerLeaf = null;
    }

    this.controllerLeaf = await createLeaf();
    return this.controllerLeaf;
  }

  private closeControllerLeaf(): void {
    if (!this.controllerLeaf) return;
    try {
      this.controllerLeaf.detach();
    } catch {
      // ignore
    }
    this.controllerLeaf = null;
  }

  private async openOrUpdateController(): Promise<void> {
    const leaf = await this.ensureControllerLeaf();
    if (!leaf) return;
    const view = leaf.view;
    if (view instanceof ScreenControllerView) {
      view.refreshTabs();
      if (this.currentPayload) {
        await view.setPayload(this.currentPayload);
      } else {
        view.clearSelection();
      }
      view.onVideoStateUpdated(this.getCurrentVideoSnapshot());
      view.onPdfStateUpdated(this.getCurrentPdfSnapshot());
      await this.app.workspace.revealLeaf(leaf);
      return;
    }
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

  private async renderBlankScreen(): Promise<void> {
    const leaf = await this.ensureScreenLeaf();
    if (!leaf) return;
    const view = leaf.view;
    if (!(view instanceof ScreenDisplayView)) return;

    await view.renderPayload({
      kind: "markdown",
      markdown: "",
      sourcePath: "",
    });
  }

  private async refreshControllerView(): Promise<void> {
    const view = this.controllerLeaf?.view;
    if (view instanceof ScreenControllerView) {
      view.refreshTabs();
      if (this.currentPayload) {
        await view.renderPayload(this.currentPayload);
      } else {
        view.clearSelection();
      }
      view.onVideoStateUpdated(this.getCurrentVideoSnapshot());
      view.onPdfStateUpdated(this.getCurrentPdfSnapshot());
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

    const video = target.closest("video");
    if (video instanceof HTMLVideoElement) {
      const sourcePath = this.getActiveMarkdownSourcePath();
      const file = this.resolveVideoElementToFile(video, sourcePath);
      const rawSrc =
        video.currentSrc ||
        video.getAttribute("src") ||
        video.querySelector("source")?.getAttribute("src") ||
        "";
      if (!file && !rawSrc) return;

      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle("Send video to player screen").setIcon("play").onClick(() => {
          if (file) void this.sendVideoByPath(file.path);
          else void this.sendVideoByPath(rawSrc);
        });
      });
      menu.showAtMouseEvent(ev);
      ev.preventDefault();
      return;
    }

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
      } else if (isVideoExt(ext)) {
        menu.addItem((item) => {
          item
            .setTitle("Send video to player screen")
            .setIcon("play")
            .onClick(() => {
              void this.sendVideoByPath(file.path);
            });
        });
      } else {
        return;
      }

      menu.showAtMouseEvent(ev);
      ev.preventDefault();
	  return;
    }
  }

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
  
  private resolveVideoElementToFile(video: HTMLVideoElement, sourcePath: string): TFile | null {
    const embed = video.closest(".internal-embed");
    const embedSrc = embed?.getAttribute("src") ?? "";
    if (embedSrc) {
      const file = this.resolveVaultFile(embedSrc, sourcePath);
      if (file) return file;
    }

    const rawSrc =
      video.currentSrc ||
      video.getAttribute("src") ||
      video.querySelector("source")?.getAttribute("src") ||
      "";
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
  
  /* ------------------------------------------------------
   * Live refresh on file changes
   * ------------------------------------------------------ */

  private async onVaultModify(file: TFile): Promise<void> {
    if (!this.currentPayload) return;

    if (this.currentPayload.kind === "note" && file.path === this.currentPayload.path) {
      await this.renderCurrentPayload();
	  await this.refreshControllerView();
      return;
    }

    if (
      this.currentPayload.kind === "video" &&
      this.currentPayload.filePath &&
      file.path === this.currentPayload.filePath
    ) {
      this.currentPayload.source = this.app.vault.getResourcePath(file);
      await this.renderCurrentPayload();
	  await this.refreshControllerView();
      return;
    }

    if (
      this.currentPayload.kind === "image" &&
      this.currentPayload.filePath &&
      file.path === this.currentPayload.filePath
    ) {
      this.currentPayload.source = this.app.vault.getResourcePath(file);
      await this.renderCurrentPayload();
	  await this.refreshControllerView();
      return;
    }

    if (
      this.currentPayload.kind === "pdf" &&
      this.currentPayload.filePath &&
      file.path === this.currentPayload.filePath
    ) {
      this.currentPayload.source = this.app.vault.getResourcePath(file);
      await this.renderCurrentPayload();
	  await this.refreshControllerView();
    }
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