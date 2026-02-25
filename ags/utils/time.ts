import { createPoll } from "ags/time";
import GLib from "gi://GLib?version=2.0";

// State
export const currentTime = createPoll(Date.now(), 60000, () => Date.now());

export function currentTimeString(
  transform: (time: string, ampm?: "AM" | "PM") => string,
  format: "12" | "24" = "24",
) {
  return createPoll<string>("", 1000, () => {
    const now = new Date();
    const mm = now.getMinutes().toString().padStart(2, "0");
    const ss = now.getSeconds().toString().padStart(2, "0");

    if (format === "12") {
      const raw = now.getHours();
      const hh = (raw % 12 || 12).toString().padStart(2, "0");
      const ampm: "AM" | "PM" = raw < 12 ? "AM" : "PM";
      return transform(`${hh}:${mm}:${ss}`, ampm);
    }

    const hh = now.getHours().toString().padStart(2, "0");
    return transform(`${hh}:${mm}:${ss}`);
  });
}

export const currentDate = createPoll<string>("", 60_000, () => {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
});

// Formatting
export const formatTimestamp = (timestamp: number, format = "%H:%M") =>
  GLib.DateTime.new_from_unix_local(timestamp).format(format)!;