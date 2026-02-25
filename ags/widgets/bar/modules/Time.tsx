// widgets/bar/modules/Time.tsx
import app from "ags/gtk4/app";
import { Gtk } from "ags/gtk4";
import { createState } from "ags";
import { currentTimeString } from "utils/time";
import options from "options";

export default function Time() {
  const [revealPower, setRevealPower] = createState(false);

  const format = options["clock.format"].get() as "12" | "24";

  const timeLabel = currentTimeString((time, ampm) => {
    const [hours, minutes] = time.split(":");
    const clock = `${hours} 󰇙 ${minutes}`;
    return format === "12" && ampm ? `${clock} ${ampm}` : clock;
  }, format);

  return (
    <box
      $={(self) => {
        const motionController = new Gtk.EventControllerMotion();

        motionController.connect("enter", () => {
          setRevealPower(true);
        });

        motionController.connect("leave", () => {
          setRevealPower(false);
        });

        self.add_controller(motionController);
      }}
    >
      <label cssClasses={["clock"]} label={timeLabel} />
      <revealer
        transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT}
        transitionDuration={300}
        revealChild={revealPower}
      >
        <button
          cssClasses={["power-button"]}
          onClicked={() => app.toggle_window("logout-menu")}
        >
          <image iconName="system-shutdown-symbolic" />
        </button>
      </revealer>
    </box>
  );
}