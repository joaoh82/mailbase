// Realistic mock content for the demo. Mirrors the shapes the real webmail
// renders (sender, subject, snippet, body) without touching the API. The story:
// you run mailbase on `northwind.io`, an email lands in `hello@northwind.io`,
// you read it, then you add a brand-new domain `acme.dev` straight from the UI.

export const MAILBOX = "hello@northwind.io";
export const APP_URL = "mail.northwind.io";

export type Mail = {
  id: string;
  fromName: string;
  fromEmail: string;
  initials: string;
  subject: string;
  snippet: string;
  date: string;
  unread?: boolean;
  starred?: boolean;
  attachment?: boolean;
  to?: string;
  bodyParas?: string[];
};

// The message that "arrives" during the Receive beat and is opened in Read.
export const NEW_MAIL: Mail = {
  id: "m-new",
  fromName: "Sofia Reyes",
  fromEmail: "sofia.reyes@hey.com",
  initials: "SR",
  subject: "Loved the new landing page 🎉",
  snippet:
    "Hey! Just saw the redesign go live and it looks fantastic — the new pricing page finally makes the value obvious…",
  date: "09:42",
  unread: true,
  to: MAILBOX,
  bodyParas: [
    "Hey there,",
    "Just saw the redesign go live and honestly — it looks fantastic. Clean, fast, and the new pricing page finally makes the value obvious.",
    "Could we grab 20 minutes this week to talk about rolling the same look into the docs site?",
    "Thanks for making this happen. 🙌",
    "— Sofia",
  ],
};

// The inbox as it stands before the new message lands (newest first).
export const INBOX: Mail[] = [
  {
    id: "m1",
    fromName: "GitHub",
    fromEmail: "noreply@github.com",
    initials: "GH",
    subject: "[northwind/web] PR #482 merged",
    snippet: "feat: ship the new pricing page — merged into main by linnea-h",
    date: "09:14",
    unread: true,
  },
  {
    id: "m2",
    fromName: "Vercel",
    fromEmail: "notifications@vercel.com",
    initials: "▲",
    subject: "Deployment ready · northwind-web",
    snippet: "Your deployment is live in Production. Inspect the build logs…",
    date: "08:50",
    unread: true,
  },
  {
    id: "m3",
    fromName: "Linnea Holm",
    fromEmail: "linnea@figma.com",
    initials: "LH",
    subject: "Design review notes",
    snippet: "Left a few comments on the hero spacing and the CTA contrast…",
    date: "Tue",
    attachment: true,
  },
  {
    id: "m4",
    fromName: "Stripe",
    fromEmail: "receipts@stripe.com",
    initials: "S",
    subject: "Your receipt from Northwind",
    snippet: "Receipt #2451-0098 — $49.00 paid on Visa ••4242",
    date: "Mon",
  },
  {
    id: "m5",
    fromName: "Marcus Lee",
    fromEmail: "marcus@superhuman.com",
    initials: "ML",
    subject: "Re: onboarding flow",
    snippet: "Sounds good — let's lock the copy by Friday and ship Monday.",
    date: "Sun",
    starred: true,
  },
];

export const FOLDERS = [
  "Inbox",
  "Archive",
  "Sent",
  "Spam",
  "Trash",
] as const;

// Domains panel content. `northwind.io` already exists; `acme.dev` is typed in.
export const EXISTING_DOMAIN = {
  name: "northwind.io",
  detail: "1 mailbox · 1 address",
};
export const NEW_DOMAIN = "acme.dev";
