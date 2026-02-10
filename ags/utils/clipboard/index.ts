import { execAsync, subprocess } from "ags/process";
import options from "options.ts";
import GLib from "gi://GLib?version=2.0";

export interface ClipboardEntry {
  content: string;
  preview: string;
  isImage?: boolean;
  imageType?: string;
  imagePath?: string;
  cliphistId?: string;
}

class ClipboardManager {
  entries: ClipboardEntry[] = [];
  filtered: ClipboardEntry[] = [];
  index = 0;
  mode: "select" | "delete" = "select";
  query = "";
  isVisible = false;
  window: any = null;
  updateCallbacks: (() => void)[] = [];
  focusSearch?: () => void;
  private cliphistWatcher: any = null;

  get showImages() {
    try {
      return options["clipboard.show-images"]?.value ?? true;
    } catch (e) {
      console.error("Failed to read clipboard.show-images option:", e);
      return true;
    }
  }

  constructor() {
    this.initClipboardWatcher();
  }

  private async initClipboardWatcher(): Promise<void> {
    try {
      const cliphist = GLib.find_program_in_path("cliphist");
      const wlPaste = GLib.find_program_in_path("wl-paste");

      if (!cliphist || !wlPaste) {
        console.error("cliphist / wl-paste not found. Clipboard manager will not work.");
        return;
      }

      // Check if watcher is already running
      try {
        const psOutput = await execAsync(["pgrep", "-f", "wl-paste.*cliphist"]);
        if (psOutput.trim().length > 0) {
          console.log("Clipboard watcher already running");
          return;
        }
      } catch {
        // Not running, continue to start it
      }

      this.cliphistWatcher = subprocess(
        ["wl-paste", "--watch", "cliphist", "store"],
        (stdout: string) => {
          console.debug("Clipboard watcher stdout:", stdout);
        },
        (stderr: string) => {
          console.warn("Clipboard watcher stderr:", stderr);
        },
      );
      console.log("Clipboard watcher started");
    } catch (error) {
      console.error("Failed to start clipboard watcher:", error);
    }
  }

  addUpdateCallback(callback: () => void) {
    this.updateCallbacks.push(callback);
  }

  triggerUpdate() {
    this.updateCallbacks.forEach(callback => {
      try {
        callback();
      } catch (e) {
        console.error("Update callback error:", e);
      }
    });
  }

  set onUpdate(callback: (() => void) | undefined) {
    if (callback) {
      this.updateCallbacks = [callback];
    } else {
      this.updateCallbacks = [];
    }
  }

  get onUpdate() {
    return this.updateCallbacks[0];
  }

  async load() {
    console.log("Loading clipboard entries...");
    this.entries = [];
    this.filtered = [];
    
    try {
      const clip = await execAsync(["cliphist", "list"]);
      const lines = clip.split("\n").filter(Boolean).slice(0, 50);
      console.log(`Found ${lines.length} clipboard entries`);
      
      const entryPromises = lines.map(async (line) => {
        // Parse cliphist format: "<id>\t<content>"
        const tabIndex = line.indexOf('\t');
        const cliphistId = tabIndex !== -1 ? line.substring(0, tabIndex) : "";
        const content = tabIndex !== -1 ? line.substring(tabIndex + 1) : line;
        
        // Check for image data (cliphist stores images as binary)
        const imageMatch = content.match(/\[\[ binary data (image\/[^\]]+)\]\]/);
        
        if (imageMatch) {
          const imageType = imageMatch[1];
          const extension = imageType.split('/')[1] || 'png';
          const imagePath = `/tmp/clipboard_thumb_${cliphistId}.${extension}`;
          
          try {
            // Decode and save image from cliphist
            const escapedLine = line.replace(/'/g, "'\"'\"'");
            await execAsync([
              "bash",
              "-c",
              `printf '%s' '${escapedLine}' | cliphist decode > ${imagePath}`
            ]);
            console.log(`Saved image thumbnail: ${imagePath}`);
            return {
              content: line,
              preview: `Image (${imageType})`,
              isImage: true,
              imageType,
              imagePath,
              cliphistId,
            };
          } catch (e) {
            console.error(`Failed to save image ${cliphistId}:`, e);
            return {
              content: line,
              preview: `Image (${imageType}) - failed to load`,
              isImage: true,
              imageType,
              cliphistId,
            };
          }
        }
        
        return {
          content: line,
          preview: content.length > 100 ? content.slice(0, 97) + "..." : content,
          cliphistId,
        };
      });
      
      this.entries = await Promise.all(entryPromises);
      this.filter();
    } catch (e) {
      console.error("cliphist list failed:", e);
      this.entries = [];
      this.filtered = [];
      this.triggerUpdate();
    }
  }

  filter() {
    const q = this.query.toLowerCase();
    this.filtered = this.entries.filter(e => e.content.toLowerCase().includes(q));
    this.index = Math.min(this.index, Math.max(0, this.filtered.length - 1));
    this.triggerUpdate();
  }

  async clearAll() {
    try {
      await execAsync(["cliphist", "wipe"]);
      await this.load();
    } catch (e) {
      console.error("Failed to clear clipboard:", e);
    }
  }

  async select(i = this.index) {
    const entry = this.filtered[i];
    if (!entry) return;
    
    try {
      if (this.mode === "delete") {
        // Delete from cliphist
        const escapedContent = entry.content.replace(/'/g, "'\"'\"'");
        await execAsync([
          "bash",
          "-c",
          `printf '%s' '${escapedContent}' | cliphist delete`
        ]);
        await this.load();
      } else {
        // Copy to clipboard using cliphist decode
        const escapedContent = entry.content.replace(/'/g, "'\"'\"'");
        execAsync([
          "bash",
          "-c",
          `printf '%s' '${escapedContent}' | cliphist decode | wl-copy &`
        ]);
        this.hide();
      }
    } catch (e) {
      console.error("Failed to process clipboard entry:", e);
    }
  }

  show() {
    console.log("Showing clipboard window...");
    this.isVisible = true;
    if (this.window) this.window.visible = true;
    this.load().catch(console.error);
    return Promise.resolve();
  }

  hide() {
    this.isVisible = false;
    this.mode = "select";
    this.query = "";
    this.index = 0;
    if (this.window) this.window.visible = false;
  }

  toggleMode() {
    this.mode = this.mode === "select" ? "delete" : "select";
    setTimeout(() => this.triggerUpdate(), 0);
  }

  up() {
    if (this.filtered.length > 0) {
      this.index = Math.max(0, this.index - 1);
      this.triggerUpdate();
    }
  }

  down() {
    if (this.filtered.length > 0) {
      this.index = Math.min(this.filtered.length - 1, this.index + 1);
      this.triggerUpdate();
    }
  }

  key(k: number) {
    switch (k) {
      case 65307: this.hide(); break;
      case 65293: this.select(); break;
      case 65362: this.up(); break;
      case 65364: this.down(); break;
      case 65289: this.toggleMode(); break;
      case 65535:
        if (this.mode === "select") {
          this.mode = "delete";
          setTimeout(() => this.triggerUpdate(), 0);
        }
        break;
      default:
        if (this.focusSearch) this.focusSearch();
        break;
    }
  }

  search(q: string) {
    this.query = q;
    this.filter();
  }

  clearSearch() {
    this.query = "";
    this.index = 0;
    this.filter();
  }

  dispose() {
    if (this.cliphistWatcher) {
      try {
        this.cliphistWatcher.kill();
        console.log("Clipboard watcher stopped");
      } catch (error) {
        console.error("Failed to stop clipboard watcher:", error);
      }
    }
  }
}

export const clipboard = new ClipboardManager();