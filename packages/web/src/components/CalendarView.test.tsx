import { describe, expect, it } from "vitest";
import { CalendarView } from "./CalendarView";

// The web package has no DOM test harness yet (see the open "DOM testing
// harness" ticket), so this is a render-shape smoke check like Logo/App; the
// calendar's real logic is unit-tested in lib/calendar.test.ts.
describe("CalendarView", () => {
  it("is a renderable component", () => {
    expect(typeof CalendarView).toBe("function");
    const element = (
      <CalendarView
        mailboxId={undefined}
        mailboxLabel="All inboxes"
        mailboxes={[]}
        onAuthError={() => {}}
      />
    );
    expect(element.type).toBe(CalendarView);
  });
});
