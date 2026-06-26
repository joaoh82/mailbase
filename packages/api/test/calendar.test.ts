import { SELF } from "cloudflare:test";
import { eventAttendees, events } from "@mailbase/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { db, login, type LoginResult, seed } from "./seed";

let auth: LoginResult;

interface SerializedEvent {
  id: string;
  mailboxId: string;
  messageId: string | null;
  summary: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  tzid: string;
  status: string;
  attendees: {
    addr: string;
    partstat: string;
    role: string;
    isSelf: boolean;
  }[];
}

beforeEach(async () => {
  await db.delete(eventAttendees);
  await db.delete(events);
  await seed();

  await db.insert(events).values([
    {
      id: "evt-josh-1",
      mailboxId: "mbx-josh",
      messageId: "msg-1",
      uid: "uid-josh-1",
      organizerAddr: "alice@gmail.com",
      summary: "Project sync",
      location: "Room A",
      startsAt: new Date("2026-07-15T13:00:00Z"),
      endsAt: new Date("2026-07-15T13:30:00Z"),
      tzid: "America/New_York",
      method: "REQUEST",
      rawIcsR2Key: "calendar/testdomain.com/mbx-josh/msg-1.ics",
    },
    {
      id: "evt-josh-2",
      mailboxId: "mbx-josh",
      uid: "uid-josh-2",
      summary: "Later meeting",
      startsAt: new Date("2026-08-01T10:00:00Z"),
      method: "REQUEST",
    },
    {
      id: "evt-other",
      mailboxId: "mbx-other",
      uid: "uid-other",
      summary: "Other private",
      startsAt: new Date("2026-07-16T09:00:00Z"),
      method: "REQUEST",
    },
  ]);
  await db.insert(eventAttendees).values([
    {
      eventId: "evt-josh-1",
      addr: "josh@testdomain.com",
      displayName: "Josh",
      partstat: "needs-action",
      role: "REQ-PARTICIPANT",
      isSelf: true,
    },
    {
      eventId: "evt-josh-1",
      addr: "alice@gmail.com",
      displayName: "Alice",
      partstat: "accepted",
      role: "CHAIR",
      isSelf: false,
    },
  ]);

  auth = await login();
});

function get(path: string) {
  return SELF.fetch(`http://webmail.local${path}`, {
    headers: { Cookie: auth.cookie },
  });
}

describe("calendar read API", () => {
  it("lists the caller's events across all their mailboxes (not foreign ones)", async () => {
    const res = await get("/api/calendar/events");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SerializedEvent[] };
    // Ordered by start; evt-other belongs to mbx-other and must not appear.
    expect(body.events.map((e) => e.id)).toEqual(["evt-josh-1", "evt-josh-2"]);

    const first = body.events[0]!;
    expect(first.summary).toBe("Project sync");
    expect(first.mailboxId).toBe("mbx-josh");
    expect(first.messageId).toBe("msg-1");
    expect(first.startsAt).toBe("2026-07-15T13:00:00.000Z");
    expect(first.endsAt).toBe("2026-07-15T13:30:00.000Z");
    expect(first.allDay).toBe(false);
    expect(first.tzid).toBe("America/New_York");
    expect(first.status).toBe("confirmed");
    const self = first.attendees.find((a) => a.addr === "josh@testdomain.com");
    expect(self).toMatchObject({ isSelf: true, partstat: "needs-action" });
    expect(first.attendees.find((a) => a.addr === "alice@gmail.com")).toMatchObject(
      { isSelf: false, partstat: "accepted" },
    );
  });

  it("filters to events overlapping the [from, to] window", async () => {
    const res = await get(
      "/api/calendar/events?from=2026-07-01T00:00:00Z&to=2026-07-31T00:00:00Z",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SerializedEvent[] };
    // August event is outside the window.
    expect(body.events.map((e) => e.id)).toEqual(["evt-josh-1"]);
  });

  it("scopes to one mailbox via mailboxId", async () => {
    const res = await get("/api/calendar/events?mailboxId=mbx-josh");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SerializedEvent[] };
    expect(body.events.map((e) => e.id)).toEqual(["evt-josh-1", "evt-josh-2"]);
  });

  it("404s on a mailbox the caller is not a member of", async () => {
    const res = await get("/api/calendar/events?mailboxId=mbx-other");
    expect(res.status).toBe(404);
  });

  it("rejects an unparseable from/to", async () => {
    const res = await get("/api/calendar/events?from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns a single event with its attendees", async () => {
    const res = await get("/api/events/evt-josh-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: SerializedEvent };
    expect(body.event.id).toBe("evt-josh-1");
    expect(body.event.attendees).toHaveLength(2);
  });

  it("404s on an event in a mailbox the caller cannot access", async () => {
    const res = await get("/api/events/evt-other");
    expect(res.status).toBe(404);
  });

  it("requires a session", async () => {
    const res = await SELF.fetch(
      "http://webmail.local/api/calendar/events",
    );
    expect(res.status).toBe(401);
  });
});
