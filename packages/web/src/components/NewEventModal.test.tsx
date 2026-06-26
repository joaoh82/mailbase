import { describe, expect, it } from "vitest";
import { NewEventModal } from "./NewEventModal";

// Render-shape smoke check (the web package has no DOM harness yet); the
// composer's conversion/validation logic is unit-tested in lib/calendar.test.ts.
describe("NewEventModal", () => {
  it("is a renderable component", () => {
    expect(typeof NewEventModal).toBe("function");
    const element = (
      <NewEventModal
        mailboxes={[]}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );
    expect(element.type).toBe(NewEventModal);
  });
});
