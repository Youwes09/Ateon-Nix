// widgets/sidebar/modules/ClockWidget.tsx
import { Gtk } from "ags/gtk4";
import { With, createState } from "ags";
import { currentDate, currentTimeString } from "utils/time";
import options from "options";

function DigitStack({ timeState, index }: { timeState: any, index: number }) {
  return (
    <stack
      class="digit-stack"
      transitionDuration={400}
      transitionType={Gtk.StackTransitionType.SLIDE_UP_DOWN}
      $={(self) => (
        <With value={timeState}>
          {(time) => {
            const str = time ?? "00:00:00";
            // Set visible child to the character at index, or "0" if undefined
            self.visibleChildName = str[index] ?? "0";
            return null;
          }}
        </With>
      )}
    >
      {/* 0-9 for numbers */}
      {Array.from({ length: 10 }, (_, i) => (
        <label
          $type="named"
          name={i.toString()}
          label={i.toString()}
          halign={Gtk.Align.CENTER}
        />
      ))}
      {/* Space character if needed for padding */}
      <label $type="named" name=" " label=" " />
    </stack>
  );
}

function TimeDisplay() {
  const format = options["clock.format"].get() as "12" | "24";

  // We use the same transform logic as your Bar clock for consistency
  const timeState = currentTimeString((time, ampm) => {
    return format === "12" && ampm ? `${time} ${ampm}` : time;
  }, format);

  return (
    <box spacing={4} halign={Gtk.Align.CENTER} orientation={Gtk.Orientation.VERTICAL}>
      <box spacing={4} halign={Gtk.Align.CENTER}>
        <DigitStack timeState={timeState} index={0} />
        <DigitStack timeState={timeState} index={1} />
        <label class="colon" label=":" />
        <DigitStack timeState={timeState} index={3} />
        <DigitStack timeState={timeState} index={4} />
        <label class="colon" label=":" />
        <DigitStack timeState={timeState} index={6} />
        <DigitStack timeState={timeState} index={7} />
      </box>
      
      {format === "12" && (
        <With value={timeState}>
          {(timeStr) => {
            const ampm = timeStr?.split(" ")[1] ?? "";
            return (
              <label 
                class="ampm-label" 
                label={ampm} 
                css="font-size: 0.8em; font-weight: bold;"
              />
            );
          }}
        </With>
      )}
    </box>
  );
}

function DateDisplay() {
  return (
    <With value={currentDate}>
      {(date) => (
        <label class="date-label" label={date} halign={Gtk.Align.CENTER} />
      )}
    </With>
  );
}

export default function ClockWidget() {
  return (
    <box
      class="clock-widget"
      orientation={Gtk.Orientation.VERTICAL}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.CENTER}
      spacing={8}
    >
      <TimeDisplay />
      <Gtk.Separator orientation={Gtk.Orientation.HORIZONTAL} />
      <DateDisplay />
    </box>
  );
}