import { describe, expect, it } from "vitest";
import { ApiTokensSection } from "./ApiTokensSection";
import { DraftsList } from "./DraftsList";

// No DOM harness in the web package yet (see CalendarView.test.tsx), so these
// are render-shape smoke checks for the Phase 8 UI; the behaviour (token shown
// once, revoke, drafts CRUD and conflicts) is covered by the API tests.
describe("agent access UI", () => {
  it("ApiTokensSection is a renderable component", () => {
    const element = <ApiTokensSection origin="https://mail.example.com" />;
    expect(element.type).toBe(ApiTokensSection);
  });

  it("DraftsList is a renderable component", () => {
    const element = (
      <DraftsList
        drafts={[]}
        loading={false}
        error={null}
        onOpen={() => {}}
        onRefresh={() => {}}
      />
    );
    expect(element.type).toBe(DraftsList);
  });
});
