import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema";

describe("drizzle schema", () => {
  it("defines every table from DESIGN.md §4 (except the SQL-only FTS5 table)", () => {
    const tableNames = [
      schema.domains,
      schema.users,
      schema.sessions,
      schema.mailboxes,
      schema.addresses,
      schema.mailboxMembers,
      schema.identities,
      schema.threads,
      schema.messages,
      schema.attachments,
    ].map((table) => getTableName(table));

    expect(tableNames).toEqual([
      "domains",
      "users",
      "sessions",
      "mailboxes",
      "addresses",
      "mailbox_members",
      "identities",
      "threads",
      "messages",
      "attachments",
    ]);
  });

  it("exposes folder and direction enums", () => {
    expect(schema.MESSAGE_FOLDERS).toContain("inbox");
    expect(schema.MESSAGE_DIRECTIONS).toEqual(["inbound", "outbound"]);
  });

  it("defines the Phase 7 calendar tables (migration 0011)", () => {
    expect(getTableName(schema.events)).toBe("events");
    expect(getTableName(schema.eventAttendees)).toBe("event_attendees");
  });

  it("exposes calendar status and partstat enums", () => {
    expect(schema.EVENT_STATUSES).toEqual([
      "confirmed",
      "cancelled",
      "tentative",
    ]);
    expect(schema.ATTENDEE_PARTSTATS).toEqual([
      "needs-action",
      "accepted",
      "tentative",
      "declined",
    ]);
  });
});
