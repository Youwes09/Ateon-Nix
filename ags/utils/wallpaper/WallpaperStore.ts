import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { Gdk } from "ags/gtk4";
import { Accessor } from "ags";
import { execAsync } from "ags/process";
import { timeout, Timer } from "ags/time";
import { register, property, signal } from "ags/gobject";
import { getThumbnailManager, ThumbnailManager } from "./index";
import options from "options";
import Fuse from "../fuse.js";
import type { WallpaperItem } from "utils/picker/types.ts";
import type {
  CachedThemeEntry,
  ThemeProperties,
  ThemeMode,
  ThemeScheme,
} from "./types";

/**
 * Find chromash binary in PATH
 */
function getChromashPath(): string | null {
  return GLib.find_program_in_path("chromash");
}

/**
 * Map internal scheme names to chromash CLI scheme types
 */
function mapSchemeToChromash(scheme: ThemeScheme): string {
  const schemeMap: Record<string, string> = {
    "scheme-content": "content",
    "scheme-expressive": "expressive",
    "scheme-fidelity": "fidelity",
    "scheme-fruit-salad": "fruit-salad",
    "scheme-monochrome": "monochrome",
    "scheme-neutral": "neutral",
    "scheme-rainbow": "rainbow",
    "scheme-tonal-spot": "tonal-spot",
  };
  
  return schemeMap[scheme] || "rainbow";
}

/**
 * Map chromash scheme output back to internal scheme names
 */
function mapChromashToScheme(chromashScheme: string): ThemeScheme {
  const reverseMap: Record<string, ThemeScheme> = {
    "content": "scheme-content",
    "expressive": "scheme-expressive",
    "fidelity": "scheme-fidelity",
    "fruit-salad": "scheme-fruit-salad",
    "monochrome": "scheme-monochrome",
    "neutral": "scheme-neutral",
    "rainbow": "scheme-rainbow",
    "tonal-spot": "scheme-tonal-spot",
  };
  
  return reverseMap[chromashScheme] || "scheme-rainbow";
}

@register({ GTypeName: "WallpaperStore" })
export class WallpaperStore extends GObject.Object {
  @property(Array) wallpapers: WallpaperItem[] = [];
  @property(String) currentWallpaperPath: string = "";
  @property(Boolean) includeHidden: boolean = false;
  @property(Number) maxItems: number = 12;
  @property(Object) manualMode: ThemeMode = "auto";
  @property(String) manualScheme: ThemeScheme = "auto";

  @signal([Array], GObject.TYPE_NONE, { default: false })
  wallpapersChanged(wallpapers: WallpaperItem[]): undefined {}

  @signal([String], GObject.TYPE_NONE, { default: false })
  wallpaperSet(path: string): undefined {}

  @signal([String, String], GObject.TYPE_NONE, { default: false })
  themeSettingsChanged(mode: string, scheme: string): undefined {}

  private files: Gio.File[] = [];
  private fuse!: Fuse;

  // Configuration accessors
  private wallpaperDir: Accessor<string>;
  private currentWallpaper: Accessor<string>;
  private maxThemeCacheSize: Accessor<number>;

  private unsubscribers: (() => void)[] = [];

  // Caching
  private themeCache = new Map<string, CachedThemeEntry>();

  // Debounce fast theme changes
  private themeDebounceTimer: Timer | null = null;
  private readonly THEME_DEBOUNCE_DELAY = 100;

  // Thumbnail generation
  private thumbnailManager: ThumbnailManager;

  constructor(params: { includeHidden?: boolean } = {}) {
    super();

    this.thumbnailManager = getThumbnailManager();

    this.includeHidden = params.includeHidden ?? false;

    // Setup accessors from options
    this.wallpaperDir = options["wallpaper.dir"]((wd) => String(wd));
    this.currentWallpaper = options["wallpaper.current"]((w) => String(w));
    this.maxThemeCacheSize = options["wallpaper.theme.cache-size"]((s) =>
      Number(s),
    );

    // Connect to option changes
    this.setupWatchers();

    // Init
    this.loadThemeCache();
    this.loadWallpapers();
  }

  // Setup & Configuration
  private setupWatchers(): void {
    const dirUnsubscribe = this.wallpaperDir.subscribe(() => {
      this.loadWallpapers();
    });
    this.unsubscribers.push(dirUnsubscribe);
  }

  private loadThemeCache(): void {
    try {
      const persistentCache = options["wallpaper.theme.cache"].get() as Record<
        string,
        any
      >;
      for (const [path, entry] of Object.entries(persistentCache)) {
        if (typeof entry === "object" && entry.timestamp) {
          this.themeCache.set(path, entry as CachedThemeEntry);
        }
      }
    } catch (error) {
      console.warn("Failed to load theme cache:", error);
      this.emit("error", "Failed to load theme cache");
    }
  }

  private saveThemeCache(): void {
    setTimeout(() => {
      try {
        const persistentCache: Record<string, CachedThemeEntry> = {};
        for (const [path, entry] of this.themeCache) {
          persistentCache[path] = entry;
        }
        options["wallpaper.theme.cache"].value = persistentCache as any;
      } catch (error) {
        console.error("Failed to save theme cache:", error);
        this.emit("error", "Failed to save theme cache");
      }
    }, 0);
  }

  // Wallpaper Loading & Scanning
  private loadWallpapers(): void {
    try {
      const dirPath = this.wallpaperDir.get();
      if (!GLib.file_test(dirPath, GLib.FileTest.EXISTS)) {
        console.warn(`Wallpaper directory does not exist: ${dirPath}`);
        this.updateWallpapers([], []);
        return;
      }

      this.files = this.ls(dirPath, {
        level: 2,
        includeHidden: this.includeHidden,
      }).filter((file) => {
        const info = file.query_info(
          Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
          Gio.FileQueryInfoFlags.NONE,
          null,
        );
        return info.get_content_type()?.startsWith("image/") ?? false;
      });

      const items = this.files.map((file) => {
        const path = file.get_path();
        return {
          id: path || file.get_uri(),
          name: file.get_basename() || "Unknown",
          description: "Image",
          iconName: "image-x-generic",
          path: path ?? undefined,
          file: file,
        };
      });

      this.updateWallpapers(this.files, items);
      console.log(`Loaded ${this.files.length} wallpapers from ${dirPath}`);
    } catch (error) {
      console.error("Failed to load wallpapers:", error);
      this.emit("error", "Failed to load wallpapers");
      this.updateWallpapers([], []);
    }
  }

  private updateWallpapers(files: Gio.File[], items: WallpaperItem[]): void {
    this.files = files;
    this.wallpapers = items;
    this.updateFuse();
    this.emit("wallpapers-changed", items);
  }

  private ls(
    dir: string,
    props?: { level?: number; includeHidden?: boolean },
  ): Gio.File[] {
    const { level = 0, includeHidden = false } = props ?? {};
    if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
      return [];
    }

    const files: Gio.File[] = [];
    try {
      const enumerator = Gio.File.new_for_path(dir).enumerate_children(
        "standard::name,standard::type",
        Gio.FileQueryInfoFlags.NONE,
        null,
      );

      for (const info of enumerator) {
        const file = enumerator.get_child(info);
        const basename = file.get_basename();

        if (basename?.startsWith(".") && !includeHidden) {
          continue;
        }

        const type = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
        if (type === Gio.FileType.DIRECTORY && level > 0) {
          files.push(
            ...this.ls(file.get_path()!, {
              includeHidden,
              level: level - 1,
            }),
          );
        } else {
          files.push(file);
        }
      }
    } catch (error) {
      console.error(`Failed to list directory ${dir}:`, error);
    }

    return files;
  }

  private updateFuse(): void {
    this.fuse = new Fuse(this.wallpapers, {
      keys: ["name"],
      includeScore: true,
      threshold: 0.6,
      location: 0,
      distance: 100,
      minMatchCharLength: 1,
      ignoreLocation: true,
      ignoreFieldNorm: false,
      useExtendedSearch: false,
      shouldSort: true,
      isCaseSensitive: false,
    });
  }

  // Public API Methods
  search(text: string): WallpaperItem[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const results = this.fuse.search(text, { limit: this.maxItems });
    return results.map((result) => result.item);
  }

  async setRandomWallpaper(): Promise<void> {
    if (this.wallpapers.length === 0) {
      console.warn("No wallpapers available for random selection");
      this.emit("error", "No wallpapers available");
      return;
    }

    const currentWallpaperPath = this.currentWallpaper.get();
    const availableWallpapers = this.wallpapers.filter(
      (item) => item.path !== currentWallpaperPath,
    );

    const wallpapers =
      availableWallpapers.length > 0 ? availableWallpapers : this.wallpapers;
    const randomIndex = Math.floor(Math.random() * wallpapers.length);
    const randomWallpaper = wallpapers[randomIndex];

    await this.setWallpaper(randomWallpaper.file);
  }

  async refresh(): Promise<void> {
    this.loadWallpapers();
  }

  // Manual Theme Control Methods
  setManualMode(mode: ThemeMode): void {
    if (this.manualMode !== mode) {
      this.manualMode = mode;
      this.emit("theme-settings-changed", mode, this.manualScheme);

      if (this.currentWallpaperPath) {
        this.applyManualThemeSettings();
      }
    }
  }

  setManualScheme(scheme: ThemeScheme): void {
    if (this.manualScheme !== scheme) {
      this.manualScheme = scheme;
      this.emit("theme-settings-changed", this.manualMode, scheme);

      if (this.currentWallpaperPath) {
        this.applyManualThemeSettings();
      }
    }
  }

  private applyManualThemeSettings(): void {
    const chromash = getChromashPath();
    if (!chromash) {
      console.warn("chromash not found in PATH, cannot apply manual theme settings");
      return;
    }

    if (!this.currentWallpaperPath) {
      console.warn("No wallpaper set, cannot apply manual theme");
      return;
    }

    // Build wallpaper command with manual overrides
    const args: string[] = ["wallpaper", this.currentWallpaperPath];
    
    if (this.manualMode !== "auto") {
      args.push("--mode", this.manualMode);
    }
    
    if (this.manualScheme !== "auto") {
      const chromashScheme = mapSchemeToChromash(this.manualScheme);
      args.push("--scheme", chromashScheme);
    }

    const cmd = `chromash ${args.map(arg => `"${arg}"`).join(" ")}`;

    execAsync(cmd)
      .then(() => {
        console.log(`Applied manual theme: mode=${this.manualMode}, scheme=${this.manualScheme}`);
        const analysis: ThemeProperties = {
          mode: this.manualMode === "auto" ? "dark" : this.manualMode,
          scheme: this.manualScheme === "auto" ? "scheme-rainbow" : this.manualScheme,
          tone: this.manualMode === "light" ? 80 : 20,
          chroma: this.getChromaForScheme(this.manualScheme),
        };
        this.sendThemeNotification(this.currentWallpaperPath, analysis);
      })
      .catch((error) => {
        console.error("Failed to apply manual theme settings:", error);
        this.emit("error", `Failed to apply theme: ${error}`);
      });
  }

  // Wallpaper Setting & Theme Application
  async setWallpaper(file: Gio.File): Promise<void> {
    const imagePath = file.get_path();
    if (!imagePath) {
      console.error("Could not get file path for wallpaper");
      this.emit("error", "Could not get file path for wallpaper");
      return;
    }

    const currentWallpaper = this.currentWallpaper.get();
    if (currentWallpaper === imagePath) {
      return;
    }

    // Update current wallpaper immediately
    options["wallpaper.current"].value = imagePath;
    this.currentWallpaperPath = imagePath;

    try {
      await this.applyWallpaperWithChromash(imagePath);
      this.emit("wallpaper-set", imagePath);
    } catch (error) {
      console.error("Wallpaper setting failed:", error);
      this.emit("error", `Wallpaper setting failed: ${error}`);
      // Revert config on failure
      options["wallpaper.current"].value = currentWallpaper;
      this.currentWallpaperPath = currentWallpaper;
    }
  }

  private async applyWallpaperWithChromash(imagePath: string): Promise<void> {
    const chromash = getChromashPath();
    if (!chromash) {
      throw new Error("chromash not found in PATH");
    }

    // Build wallpaper command with any manual overrides
    const args: string[] = ["wallpaper", imagePath];
    
    if (this.manualMode !== "auto") {
      args.push("--mode", this.manualMode);
    }
    
    if (this.manualScheme !== "auto") {
      const chromashScheme = mapSchemeToChromash(this.manualScheme);
      args.push("--scheme", chromashScheme);
    }

    const cmd = `chromash ${args.map(arg => `"${arg}"`).join(" ")}`;

    await execAsync(cmd);
    this.scheduleThemeUpdate(imagePath);
  }

  private scheduleThemeUpdate(imagePath: string): void {
    if (this.themeDebounceTimer) {
      this.themeDebounceTimer.cancel();
    }

    this.themeDebounceTimer = timeout(this.THEME_DEBOUNCE_DELAY, () => {
      this.applyThemeWithManualOverrides(imagePath).catch((error) => {
        console.error("Theme application failed:", error);
        this.emit("error", `Theme application failed: ${error}`);
      });
      this.themeDebounceTimer = null;
    });
  }

  private async applyThemeWithManualOverrides(imagePath: string): Promise<void> {
    try {
      const chromash = getChromashPath();
      if (!chromash) {
        return;
      }

      // Get the theme info from chromash
      const themeOutput = await execAsync("chromash theme");
      const autoAnalysis = this.parseChromashThemeOutput(themeOutput) ?? this.fallbackColorAnalysis(imagePath);

      // Cache the auto-detected analysis
      this.cacheThemeAnalysis(imagePath, autoAnalysis);

      // Determine final analysis based on manual overrides
      const finalAnalysis: ThemeProperties = {
        tone: autoAnalysis.tone,
        chroma: autoAnalysis.chroma,
        mode: this.manualMode === "auto" ? autoAnalysis.mode : this.manualMode,
        scheme: this.manualScheme === "auto" ? autoAnalysis.scheme : this.manualScheme,
      };

      setTimeout(() => this.sendThemeNotification(imagePath, finalAnalysis), 0);
    } catch (error) {
      console.error("Failed to apply theme with manual overrides:", error);
      throw error;
    }
  }

  private parseChromashThemeOutput(output: string): ThemeProperties | null {
    try {
      let mode: "light" | "dark" = "dark";
      let scheme: ThemeScheme = "scheme-rainbow";
      let tone = 20;
      let chroma = 40;

      const lines = output.trim().split("\n");
      for (const line of lines) {
        const lowerLine = line.toLowerCase();
        
        // Parse mode
        if (lowerLine.includes("light")) {
          mode = "light";
          tone = 80;
        } else if (lowerLine.includes("dark")) {
          mode = "dark";
          tone = 20;
        }

        // Parse scheme - check for all chromash scheme types
        if (lowerLine.includes("content")) {
          scheme = "scheme-content";
          chroma = 30;
        } else if (lowerLine.includes("expressive")) {
          scheme = "scheme-expressive";
          chroma = 50;
        } else if (lowerLine.includes("fidelity")) {
          scheme = "scheme-fidelity";
          chroma = 40;
        } else if (lowerLine.includes("fruit-salad")) {
          scheme = "scheme-fruit-salad";
          chroma = 60;
        } else if (lowerLine.includes("monochrome")) {
          scheme = "scheme-monochrome";
          chroma = 0;
        } else if (lowerLine.includes("neutral")) {
          scheme = "scheme-neutral";
          chroma = 10;
        } else if (lowerLine.includes("rainbow")) {
          scheme = "scheme-rainbow";
          chroma = 40;
        } else if (lowerLine.includes("tonal-spot")) {
          scheme = "scheme-tonal-spot";
          chroma = 35;
        }
      }

      return { tone, chroma, mode, scheme };
    } catch (error) {
      console.warn("Failed to parse chromash theme output:", error);
      return null;
    }
  }

  private fallbackColorAnalysis(imagePath: string): ThemeProperties {
    const basename = GLib.path_get_basename(imagePath).toLowerCase();

    let mode: "light" | "dark" = "dark";
    let scheme: ThemeScheme = "scheme-rainbow";

    // Filename-based heuristics for mode
    if (
      basename.includes("light") ||
      basename.includes("day") ||
      basename.includes("bright")
    ) {
      mode = "light";
    } else if (
      basename.includes("dark") ||
      basename.includes("night") ||
      basename.includes("moon")
    ) {
      mode = "dark";
    } else {
      // Time-based fallback
      const hour = new Date().getHours();
      mode = hour >= 6 && hour < 18 ? "light" : "dark";
    }

    // Filename-based heuristics for scheme
    if (
      basename.includes("neutral") ||
      basename.includes("gray") ||
      basename.includes("grey")
    ) {
      scheme = "scheme-neutral";
    } else if (
      basename.includes("mono") ||
      basename.includes("black") ||
      basename.includes("white")
    ) {
      scheme = "scheme-monochrome";
    } else if (basename.includes("rainbow") || basename.includes("colorful")) {
      scheme = "scheme-rainbow";
    } else if (basename.includes("expressive") || basename.includes("vibrant")) {
      scheme = "scheme-expressive";
    }

    return {
      tone: mode === "light" ? 80 : 20,
      chroma: this.getChromaForScheme(scheme),
      mode,
      scheme,
    };
  }

  private getChromaForScheme(scheme: ThemeScheme): number {
    const chromaMap: Record<ThemeScheme | "auto", number> = {
      "auto": 40,
      "scheme-content": 30,
      "scheme-expressive": 50,
      "scheme-fidelity": 40,
      "scheme-fruit-salad": 60,
      "scheme-monochrome": 0,
      "scheme-neutral": 10,
      "scheme-rainbow": 40,
      "scheme-tonal-spot": 35,
    };
    
    return chromaMap[scheme] || 40;
  }

  private cacheThemeAnalysis(
    imagePath: string,
    analysis: ThemeProperties,
  ): void {
    const entry: CachedThemeEntry = {
      ...analysis,
      timestamp: Date.now(),
    };

    this.themeCache.set(imagePath, entry);

    if (this.themeCache.size > this.maxThemeCacheSize.get()) {
      setTimeout(() => this.cleanupThemeCache(), 0);
    }
    this.saveThemeCache();
  }

  private cleanupThemeCache(): void {
    const maxSize = this.maxThemeCacheSize.get();
    if (this.themeCache.size <= maxSize) return;

    const entries = Array.from(this.themeCache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp,
    );

    const toRemove = this.themeCache.size - maxSize;
    for (let i = 0; i < toRemove; i++) {
      this.themeCache.delete(entries[i][0]);
    }
  }

  private sendThemeNotification(
    imagePath: string,
    analysis: ThemeProperties,
  ): void {
    try {
      const notifySend = GLib.find_program_in_path("notify-send");
      if (!notifySend) return;

      const basename = GLib.path_get_basename(imagePath);
      const message = `Theme: ${analysis.mode} ${analysis.scheme.replace("scheme-", "")}`;

      GLib.spawn_command_line_async(
        `${notifySend} "Chromash Theme Applied" "Image: ${basename}\n${message}"`,
      );
    } catch (error) {
      console.error("Failed to send notification:", error);
    }
  }

  // Thumbnail Management
  async getThumbnail(imagePath: string): Promise<Gdk.Texture | null> {
    return this.thumbnailManager.getThumbnail(imagePath);
  }

  // Utility Methods
  clearThemeCache(): void {
    this.themeCache.clear();
    options["wallpaper.theme.cache"].value = {};
    console.log("Theme cache cleared");
  }

  dispose(): void {
    console.log("Disposing WallpaperStore");

    if (this.themeDebounceTimer) {
      this.themeDebounceTimer.cancel();
      this.themeDebounceTimer = null;
    }

    this.unsubscribers.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (error) {
        console.error("Error during unsubscribe:", error);
      }
    });
    this.unsubscribers = [];

    this.themeCache.clear();
  }
}