import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Bold,
  Italic,
  Underline,
  ImagePlus,
  ImageDown,
  PenLine,
  Undo2,
  Redo2,
  Paintbrush,
  Baseline,
} from "lucide-react";
import { toast } from "sonner";

interface EmailTemplateEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  html: string;
  onApply: (html: string) => void;
}

const FONT_FAMILIES = [
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', sans-serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
];

const FONT_SIZES = [
  { label: "Small", value: "2" },
  { label: "Normal", value: "3" },
  { label: "Medium", value: "4" },
  { label: "Large", value: "5" },
  { label: "X-Large", value: "6" },
];

const TEXT_COLORS = ["#1f2937", "#0D5A9E", "#B91C1C", "#15803D", "#B45309", "#7C3AED", "#FFFFFF"];
const BG_COLORS = ["#FFFFFF", "#F8FAFC", "#F1F5F9", "#FEF9C3", "#DCFCE7", "#DBEAFE", "#FCE7F3"];

export function EmailTemplateEditor({ open, onOpenChange, html, onApply }: EmailTemplateEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const replaceImageInputRef = useRef<HTMLInputElement>(null);
  const insertImageInputRef = useRef<HTMLInputElement>(null);
  const signatureImageInputRef = useRef<HTMLInputElement>(null);

  const pendingImageElRef = useRef<HTMLImageElement | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const imageEditModeRef = useRef(false);

  const [imageEditMode, setImageEditMode] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [showSignatureForm, setShowSignatureForm] = useState(false);
  const [sig, setSig] = useState({ name: "", title: "", company: "", imageDataUrl: "" });

  // Re-mount the iframe with fresh content every time the dialog opens.
  useEffect(() => {
    if (open) {
      setIframeKey((k) => k + 1);
      setImageEditMode(false);
      setShowSignatureForm(false);
    }
  }, [open, html]);

  useEffect(() => {
    imageEditModeRef.current = imageEditMode;
    const doc = iframeRef.current?.contentDocument;
    if (doc?.body) {
      doc.body.style.cursor = imageEditMode ? "crosshair" : "";
    }
  }, [imageEditMode]);

  const getDoc = () => iframeRef.current?.contentDocument || null;

  const saveSelection = () => {
    const doc = getDoc();
    const sel = doc?.getSelection?.();
    if (sel && sel.rangeCount > 0) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    const doc = getDoc();
    const sel = doc?.getSelection?.();
    if (sel && savedRangeRef.current) {
      sel.removeAllRanges();
      sel.addRange(savedRangeRef.current);
    }
  };

  const exec = (command: string, value?: string) => {
    const doc = getDoc();
    if (!doc) return;
    restoreSelection();
    doc.execCommand(command, false, value);
    iframeRef.current?.contentWindow?.focus();
  };

  const handleIframeLoad = () => {
    const doc = getDoc();
    if (!doc) return;
    try {
      doc.designMode = "on";
    } catch {
      // Some browsers may block this cross-origin-like edge case; editing
      // still works via contentEditable fallback below.
    }
    if (doc.body) doc.body.contentEditable = "true";

    // Highlight images with a subtle outline so it's obvious they're
    // clickable while "Replace image" mode is on.
    const style = doc.createElement("style");
    style.textContent = `
      img { cursor: default; }
      body.img-edit-mode img { outline: 2px dashed #6366f1; outline-offset: 2px; cursor: pointer; }
      body.img-edit-mode img:hover { outline-color: #4338ca; }
    `;
    doc.head?.appendChild(style);

    doc.body?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (imageEditModeRef.current && target && target.tagName === "IMG") {
        e.preventDefault();
        e.stopPropagation();
        pendingImageElRef.current = target as HTMLImageElement;
        replaceImageInputRef.current?.click();
      }
    });

    doc.body?.addEventListener("mouseup", saveSelection);
    doc.body?.addEventListener("keyup", saveSelection);
  };

  useEffect(() => {
    const doc = getDoc();
    if (doc?.body) {
      doc.body.classList.toggle("img-edit-mode", imageEditMode);
    }
  }, [imageEditMode, iframeKey]);

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsDataURL(file);
    });

  const handleReplaceImageFile = async (file: File | null) => {
    if (!file || !pendingImageElRef.current) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      pendingImageElRef.current.src = dataUrl;
      toast.success("Image replaced");
    } catch (e: any) {
      toast.error(e.message || "Failed to replace image.");
    } finally {
      pendingImageElRef.current = null;
      if (replaceImageInputRef.current) replaceImageInputRef.current.value = "";
    }
  };

  const handleInsertImageFile = async (file: File | null) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      exec("insertImage", dataUrl);
      toast.success("Image inserted");
    } catch (e: any) {
      toast.error(e.message || "Failed to insert image.");
    } finally {
      if (insertImageInputRef.current) insertImageInputRef.current.value = "";
    }
  };

  const handleSignatureImageFile = async (file: File | null) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setSig((current) => ({ ...current, imageDataUrl: dataUrl }));
    } catch (e: any) {
      toast.error(e.message || "Failed to read signature image.");
    } finally {
      if (signatureImageInputRef.current) signatureImageInputRef.current.value = "";
    }
  };

  const insertSignature = () => {
    const doc = getDoc();
    if (!doc) return;
    const nameLine = sig.name ? `<strong>${escapeHtml(sig.name)}</strong><br>` : "";
    const titleLine = sig.title ? `${escapeHtml(sig.title)}<br>` : "";
    const companyLine = sig.company ? `${escapeHtml(sig.company)}` : "";
    const imageBlock = sig.imageDataUrl
      ? `<div style="margin-top:8px;"><img src="${sig.imageDataUrl}" alt="Signature" style="max-width:220px;max-height:90px;" /></div>`
      : "";
    const block = `
      <div class="signature" style="margin-top:24px;border-top:1px solid #ddd;padding-top:14px;">
        ${nameLine}${titleLine}${companyLine}
        ${imageBlock}
      </div>
    `;
    if (doc.body) {
      doc.body.insertAdjacentHTML("beforeend", block);
    }
    setShowSignatureForm(false);
    setSig({ name: "", title: "", company: "", imageDataUrl: "" });
    toast.success("Signature added to the end of the email");
  };

  const setPageBackground = (color: string) => {
    const doc = getDoc();
    if (doc?.body) doc.body.style.backgroundColor = color;
  };

  const handleApply = () => {
    const doc = getDoc();
    if (!doc || !doc.documentElement) {
      toast.error("Preview isn't ready yet.");
      return;
    }
    doc.body?.classList.remove("img-edit-mode");
    const finalHtml = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
    onApply(finalHtml);
    onOpenChange(false);
    toast.success("Template updated");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Preview &amp; edit template</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          This is how the email will look. Click directly on any text to edit it, use the toolbar to
          style text, change the background, swap pictures, or add a signature.
        </p>

        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-2">
          <ToolbarButton title="Bold" onMouseDown={() => exec("bold")}>
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton title="Italic" onMouseDown={() => exec("italic")}>
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton title="Underline" onMouseDown={() => exec("underline")}>
            <Underline className="h-4 w-4" />
          </ToolbarButton>

          <Divider />

          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            defaultValue=""
            onMouseDown={saveSelection}
            onChange={(e) => {
              if (e.target.value) exec("fontName", e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              Font
            </option>
            {FONT_FAMILIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>

          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            defaultValue=""
            onMouseDown={saveSelection}
            onChange={(e) => {
              if (e.target.value) exec("fontSize", e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              Size
            </option>
            {FONT_SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <Divider />

          <span className="mr-1 flex items-center text-xs text-muted-foreground">
            <Baseline className="mr-1 h-3.5 w-3.5" /> Text
          </span>
          {TEXT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              className="h-6 w-6 rounded-full border border-border"
              style={{ backgroundColor: color }}
              onMouseDown={(e) => {
                e.preventDefault();
                saveSelection();
                exec("foreColor", color);
              }}
            />
          ))}

          <Divider />

          <span className="mr-1 flex items-center text-xs text-muted-foreground">
            <Paintbrush className="mr-1 h-3.5 w-3.5" /> Background
          </span>
          {BG_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              className="h-6 w-6 rounded-full border border-border"
              style={{ backgroundColor: color }}
              onMouseDown={(e) => {
                e.preventDefault();
                setPageBackground(color);
              }}
            />
          ))}

          <Divider />

          <ToolbarButton
            title="Replace a picture — click a picture in the preview"
            active={imageEditMode}
            onMouseDown={() => setImageEditMode((v) => !v)}
          >
            <ImageDown className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton title="Insert a new picture" onMouseDown={() => { saveSelection(); insertImageInputRef.current?.click(); }}>
            <ImagePlus className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton title="Add signature" onMouseDown={() => setShowSignatureForm((v) => !v)}>
            <PenLine className="h-4 w-4" />
          </ToolbarButton>

          <Divider />

          <ToolbarButton title="Undo" onMouseDown={() => exec("undo")}>
            <Undo2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton title="Redo" onMouseDown={() => exec("redo")}>
            <Redo2 className="h-4 w-4" />
          </ToolbarButton>
        </div>

        {imageEditMode && (
          <p className="rounded-md bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
            Picture-swap mode is on — click any picture in the preview below to replace it. Click the
            picture icon again to turn this off.
          </p>
        )}

        {showSignatureForm && (
          <div className="grid gap-2 rounded-lg border border-border p-3">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-xs">Name</Label>
                <Input value={sig.name} onChange={(e) => setSig({ ...sig, name: e.target.value })} placeholder="Jane Doe" />
              </div>
              <div>
                <Label className="text-xs">Title</Label>
                <Input value={sig.title} onChange={(e) => setSig({ ...sig, title: e.target.value })} placeholder="Sales Manager" />
              </div>
              <div>
                <Label className="text-xs">Company</Label>
                <Input value={sig.company} onChange={(e) => setSig({ ...sig, company: e.target.value })} placeholder="Company name" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => signatureImageInputRef.current?.click()}>
                {sig.imageDataUrl ? "Change signature image" : "Add signature image (optional)"}
              </Button>
              {sig.imageDataUrl && <img src={sig.imageDataUrl} alt="Signature preview" className="h-10" />}
              <div className="ml-auto flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowSignatureForm(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={insertSignature}>
                  Insert signature
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-border bg-white">
          <iframe
            key={iframeKey}
            ref={iframeRef}
            title="Email preview"
            srcDoc={html}
            onLoad={handleIframeLoad}
            className="h-[480px] w-full"
            sandbox="allow-same-origin allow-scripts"
          />
        </div>

        {/* Hidden file inputs driven by toolbar buttons */}
        <input
          ref={replaceImageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { void handleReplaceImageFile(e.target.files?.[0] || null); }}
        />
        <input
          ref={insertImageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { void handleInsertImageFile(e.target.files?.[0] || null); }}
        />
        <input
          ref={signatureImageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { void handleSignatureImageFile(e.target.files?.[0] || null); }}
        />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" className="bg-gradient-primary shadow-glow" onClick={handleApply}>
            Use this version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToolbarButton({
  children,
  title,
  active,
  onMouseDown,
}: {
  children: React.ReactNode;
  title: string;
  active?: boolean;
  onMouseDown: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className={`flex h-8 w-8 items-center justify-center rounded-md border ${
        active ? "border-primary bg-primary/10 text-primary" : "border-transparent hover:bg-muted"
      }`}
      // preventDefault keeps focus (and the current text selection) inside
      // the preview iframe so formatting commands apply to the right spot.
      onMouseDown={(e) => {
        e.preventDefault();
        onMouseDown();
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 h-6 w-px bg-border" />;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
