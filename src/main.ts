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

const SCREEN_VIEW_TYPE = "ttrpg-tools-screen-view";

type ScreenPayload =
  | { kind: "note"; path: string }
  | { kind: "markdown"; markdown: string; sourcePath: string }
  | { kind: "image"; source: string; filePath?: string }
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

function isScreenPayload(x: unknown): x is ScreenPayload {
  if (!isRecord(x) || typeof x.kind !== "string") return false;

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

class ScreenDisplayView extends ItemView {
  private plugin: TTRPGToolsScreenPlugin;
  private renderComponent: Component | null = null;
  private renderedPayload: ScreenPayload | null = null;
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

  async onClose(): Promise<void> {
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.persistCurrentWindowBounds();
    this.stopWindowTracking();
    try {
      this.removePlainWindowChrome();
    } catch {
      // Ignore
    } finally {
      this.plugin.notifyScreenLeafClosed(this.leaf);
    }
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

  async setPayload(payload: ScreenPayload): Promise<void> {
    await this.leaf.setViewState({
      type: SCREEN_VIEW_TYPE,
      active: true,
      state: { payload },
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
    this.contentEl.empty();
    this.renderedPayload = payload;

    if (payload.kind === "note") {
      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (!(file instanceof TFile)) {
        this.contentEl.createEl("div", { text: `Note not found: ${payload.path}` });
        return;
      }

      const raw = await this.app.vault.read(file);
      const markdown = stripFrontmatter(raw);
      await this.renderMarkdown(markdown, file.path);
      return;
    }

    if (payload.kind === "markdown") {
      await this.renderMarkdown(payload.markdown, payload.sourcePath);
      return;
    }

    if (payload.kind === "image") {
      const wrap = this.contentEl.createDiv({ cls: "ttrpg-tools-screen-media" });
      const img = wrap.createEl("img");
      img.src = payload.source;
      return;
    }

    if (payload.kind === "pdf") {
      const wrap = this.contentEl.createDiv({ cls: "ttrpg-tools-screen-media" });
      const iframe = wrap.createEl("iframe");
      iframe.src = payload.source;
    }
  }

  private async renderMarkdown(markdown: string, sourcePath: string): Promise<void> {
	const isMapOnly = /```zoommap[\s\S]*```/m.test(markdown.trim());

    const wrapper = this.contentEl.createDiv({
      cls:
        "markdown-preview-view markdown-rendered ttrpg-tools-screen-markdown" +
        (isMapOnly ? " ttrpg-tools-screen-markdown--map" : ""),
    });

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
  }

  private installInternalLinkHandling(container: HTMLElement, sourcePath: string): void {
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
  
  private getTabHeaderContainer(): HTMLElement | null {
    const leafParent = this.leaf.parent as unknown as
      | { tabHeaderContainerEl?: HTMLElement | null }
      | null
      | undefined;
    return leafParent?.tabHeaderContainerEl ?? null;
  }

  private applyPlainWindowChrome(): void {
    if (this.contentEl.win === window) return;

    const tabHeader = this.getTabHeaderContainer();
    if (tabHeader) {
      setCssProps(tabHeader, {
        opacity: "0",
        "pointer-events": "auto",
        "user-select": "none",
      });
    }

    const viewSelf = this as unknown as {
      headerEl?: HTMLElement;
    };
    if (viewSelf.headerEl) {
      setCssProps(viewSelf.headerEl, {
        display: "none",
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
}

export default class TTRPGToolsScreenPlugin extends Plugin {
  settings: ScreenDisplaySettings = DEFAULT_SETTINGS;

  private screenLeaf: WorkspaceLeaf | null = null;
  private currentPayload: ScreenPayload | null = null;
  private boundsSaveTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(SCREEN_VIEW_TYPE, (leaf) => new ScreenDisplayView(leaf, this));

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

  notifyScreenLeafClosed(leaf: WorkspaceLeaf): void {
    if (this.screenLeaf === leaf) {
      this.screenLeaf = null;
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

  public async sendNoteByPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Player Screen: note not found: ${path}`, 3000);
      return;
    }

    this.currentPayload = { kind: "note", path: file.path };
    await this.renderCurrentPayload();
  }

  public async sendMarkdown(markdown: string, sourcePath: string): Promise<void> {
    this.currentPayload = {
      kind: "markdown",
      markdown,
      sourcePath,
    };
    await this.renderCurrentPayload();
  }

  public async sendImageByPath(pathOrSource: string): Promise<void> {
    const file = this.resolveVaultFile(
      pathOrSource,
      this.app.workspace.getActiveFile()?.path ?? "",
    );

    if (file) {
      this.currentPayload = {
        kind: "image",
        source: this.app.vault.getResourcePath(file),
        filePath: file.path,
      };
    } else {
      this.currentPayload = {
        kind: "image",
        source: pathOrSource,
      };
    }

    await this.renderCurrentPayload();
  }

  public async sendPdfByPath(pathOrSource: string): Promise<void> {
    const file = this.resolveVaultFile(
      pathOrSource,
      this.app.workspace.getActiveFile()?.path ?? "",
    );

    if (file) {
      this.currentPayload = {
        kind: "pdf",
        source: this.app.vault.getResourcePath(file),
        filePath: file.path,
      };
    } else {
      this.currentPayload = {
        kind: "pdf",
        source: pathOrSource,
      };
    }

    await this.renderCurrentPayload();
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
    const sourcePath = ctx.sourcePath;
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    const markdownFile = sourceFile instanceof TFile ? sourceFile : null;

    // Images in reading view
    el.querySelectorAll("img").forEach((img) => {
      if (img.dataset.ttrpgScreenBound === "true") return;
      img.dataset.ttrpgScreenBound = "true";

      img.addEventListener("contextmenu", (ev) => {
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
        menu.showAtMouseEvent(ev);
      });
    });

    // Internal note/image/pdf links in reading view
    el.querySelectorAll("a.internal-link").forEach((node) => {
      const link = node as HTMLAnchorElement;
      if (link.dataset.ttrpgScreenBound === "true") return;
      link.dataset.ttrpgScreenBound = "true";

      link.addEventListener("contextmenu", (ev) => {
        const raw =
          link.getAttribute("data-href") ??
          link.getAttribute("href") ??
          link.textContent ??
          "";

        const file = this.resolveVaultFile(raw, sourcePath);
        if (!(file instanceof TFile)) return;

        const menu = new Menu();
        const ext = file.extension?.toLowerCase() ?? "";

        if (ext === "md") {
          menu.addItem((item) => {
            item
              .setTitle("Send note to player screen")
              .setIcon("monitor-up")
              .onClick(() => void this.sendNoteByPath(file.path));
          });
        } else if (isPdfExt(ext)) {
          menu.addItem((item) => {
            item
              .setTitle("Send PDF to player screen")
              .setIcon("file-text")
              .onClick(() => void this.sendPdfByPath(file.path));
          });
        } else if (isImageExt(ext)) {
          menu.addItem((item) => {
            item
              .setTitle("Send image to player screen")
              .setIcon("image")
              .onClick(() => void this.sendImageByPath(file.path));
          });
        } else {
          return;
        }

        ev.preventDefault();
        ev.stopPropagation();
        menu.showAtMouseEvent(ev);
      });
    });

    // Embedded PDFs in reading view
    el.querySelectorAll(".internal-embed, .pdf-embed").forEach((node) => {
      const embed = node as HTMLElement;
      if (embed.dataset.ttrpgScreenPdfBound === "true") return;
      embed.dataset.ttrpgScreenPdfBound = "true";

      embed.addEventListener("contextmenu", (ev) => {
        const src =
          embed.getAttribute("src") ??
          embed.getAttribute("data-path") ??
          "";
        if (!src) return;

        const file = this.resolveVaultFile(src, sourcePath);
        if (!(file instanceof TFile)) return;
        if (!isPdfExt(file.extension?.toLowerCase() ?? "")) return;

        ev.preventDefault();
        ev.stopPropagation();

        const menu = new Menu();
        menu.addItem((item) => {
          item
            .setTitle("Send PDF to player screen")
            .setIcon("file-text")
            .onClick(() => void this.sendPdfByPath(file.path));
        });
        menu.showAtMouseEvent(ev);
      });
    });

    // Headings in reading view: determine global index within the preview container
    if (markdownFile) {
      const cache = this.app.metadataCache.getFileCache(markdownFile);
      const headings = (cache?.headings ?? []) as HeadingCacheEntry[];
      const headingEls = Array.from(
        el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
      );

      headingEls.forEach((headingEl) => {
        if (headingEl.dataset.ttrpgScreenHeadingBound === "true") return;
        headingEl.dataset.ttrpgScreenHeadingBound = "true";

        headingEl.addEventListener("contextmenu", (ev) => {
          const previewRoot = headingEl.closest(".markdown-preview-view, .markdown-rendered");
          if (!(previewRoot instanceof HTMLElement)) return;

          const allHeadingEls = Array.from(
            previewRoot.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
          );
          const idx = allHeadingEls.indexOf(headingEl);
          const headingInfo = idx >= 0 ? headings[idx] : undefined;
          if (!headingInfo) return;

          ev.preventDefault();
          ev.stopPropagation();

          const menu = new Menu();
          menu.addItem((item) => {
            item
              .setTitle(`Send section: ${headingInfo.heading}`)
              .setIcon("heading")
              .onClick(() => {
                void this.sendHeadingSection(markdownFile, headingInfo, headings);
              });
          });
          menu.showAtMouseEvent(ev);
        });
      });
    }

    // Paragraphs / list items / blockquotes → send text block
    el.querySelectorAll("p, li, blockquote").forEach((node) => {
      const blockEl = node as HTMLElement;
      if (blockEl.dataset.ttrpgScreenBound === "true") return;
      blockEl.dataset.ttrpgScreenBound = "true";

      blockEl.addEventListener("contextmenu", (ev) => {
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
      });
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

  /* ------------------------------------------------------
   * Live refresh on file changes
   * ------------------------------------------------------ */

  private async onVaultModify(file: TFile): Promise<void> {
    if (!this.currentPayload) return;

    if (this.currentPayload.kind === "note" && file.path === this.currentPayload.path) {
      await this.renderCurrentPayload();
      return;
    }

    if (
      this.currentPayload.kind === "image" &&
      this.currentPayload.filePath &&
      file.path === this.currentPayload.filePath
    ) {
      this.currentPayload.source = this.app.vault.getResourcePath(file);
      await this.renderCurrentPayload();
      return;
    }

    if (
      this.currentPayload.kind === "pdf" &&
      this.currentPayload.filePath &&
      file.path === this.currentPayload.filePath
    ) {
      this.currentPayload.source = this.app.vault.getResourcePath(file);
      await this.renderCurrentPayload();
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