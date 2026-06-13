import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  Bold,
  Italic,
  Link2,
  List,
  ListOrdered,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

const HEADING_LEVELS = [1, 2, 3] as const;

/**
 * Lightweight WYSIWYG body editor for the composer (MAIL-2). The toolbar only
 * exposes the formatting we actually support — bold, italic, bullet & numbered
 * lists, H1–H3, and links — and StarterKit is configured so the editor can't
 * produce anything outside the outbound HTML allowlist enforced server-side in
 * `sanitizeOutboundHtml`.
 */
export function RichTextEditor({
  initialContent,
  onChange,
}: {
  /** Initial HTML to seed the editor (e.g. a quoted reply body). */
  initialContent: string;
  /** Called with the editor's HTML and plaintext on every change. */
  onChange: (html: string, text: string) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Disable everything outside our allowlist so the editor's output and
        // the server-side sanitizer agree (no code, quotes, rules, strike, or
        // underline). Bold, italic, lists, headings and links stay on.
        code: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          HTMLAttributes: { rel: "noopener noreferrer nofollow" },
        },
      }),
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class:
          "rte-content max-h-80 min-h-48 overflow-y-auto px-3 py-2 focus:outline-none",
        "aria-label": "Message body",
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML(), editor.getText()),
  });

  // Subscribe only to the toolbar's active states (avoids re-rendering on every
  // keystroke; updates on selection/format changes).
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold") ?? false,
      italic: editor?.isActive("italic") ?? false,
      bulletList: editor?.isActive("bulletList") ?? false,
      orderedList: editor?.isActive("orderedList") ?? false,
      link: editor?.isActive("link") ?? false,
      heading:
        HEADING_LEVELS.find((l) => editor?.isActive("heading", { level: l })) ??
        0,
    }),
  });

  if (!editor) return null;

  const promptForLink = () => {
    const current = editor.getAttributes("link").href as string | undefined;
    const input = window.prompt("Link URL", current ?? "https://");
    if (input === null) return; // cancelled
    const url = input.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    // Default to https:// when the user omits a scheme.
    const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  };

  return (
    <div className="rounded-md border border-slate-700 bg-slate-900 focus-within:ring-2 focus-within:ring-sky-500">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-800 px-1.5 py-1">
        <ToolbarButton
          label="Bold"
          icon={Bold}
          active={active?.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
        <ToolbarButton
          label="Italic"
          icon={Italic}
          active={active?.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
        <Divider />
        {HEADING_LEVELS.map((level) => (
          <ToolbarButton
            key={level}
            label={`Heading ${level}`}
            active={active?.heading === level}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level }).run()
            }
          >
            <span className="text-xs font-semibold">H{level}</span>
          </ToolbarButton>
        ))}
        <Divider />
        <ToolbarButton
          label="Bullet list"
          icon={List}
          active={active?.bulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        />
        <ToolbarButton
          label="Numbered list"
          icon={ListOrdered}
          active={active?.orderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        />
        <Divider />
        <ToolbarButton
          label="Link"
          icon={Link2}
          active={active?.link}
          onClick={promptForLink}
        />
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolbarButton({
  label,
  icon: Icon,
  active,
  onClick,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  active?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100",
        active && "bg-slate-700 text-slate-100",
      )}
    >
      {Icon ? <Icon className="h-4 w-4" /> : children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px bg-slate-800" />;
}
