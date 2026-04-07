import { boxTypeName } from "./gpi-types.js";
import { PatchEditor, SMALL_FONT, BOX_PAD_X, PORT_W, loadAbstractions } from "./patch-editor.js";

const canvas = document.getElementById("c");
const input = document.getElementById("box-input");
const tooltipEl = document.getElementById("tooltip");

const params = new URLSearchParams(location.search);
const absName = params.get("name");
if (!absName) { document.title = "no abstraction specified"; throw new Error("No ?name= param"); }

document.title = `editing: ${absName}`;
let dirty = false;

await loadAbstractions();

const editor = new PatchEditor(canvas, {
  showSynthBorder: false,
  input: input,
  tooltipEl: tooltipEl,
  onSend: () => {},
  onOpenAbstraction: (text) => {
    const name = boxTypeName(text);
    window.open(`/abs-editor.html?name=${encodeURIComponent(name)}`, `abs-${name}`, "width=800,height=600");
  },
  onDirty: () => {
    dirty = true;
    document.title = `editing: ${absName} *`;
  },
  renderOverlay: (ctx, w) => {
    ctx.font = SMALL_FONT;
    ctx.textBaseline = "top";
    ctx.fillStyle = dirty ? "#658" : "#668";
    ctx.fillText(absName + (dirty ? " *" : ""), 12, 8);
    ctx.fillStyle = "#444";
    ctx.textAlign = "right";
    ctx.fillText("Cmd+S save  |  Cmd+Z undo", w - 12, 8);
    ctx.textAlign = "left";
  }
});

editor.bindEvents();

// Load existing abstraction data (if it exists)
try {
  const res = await fetch(`/abstractions/${encodeURIComponent(absName)}`);
  if (res.ok) {
    editor.load(await res.text());
  }
} catch { /* new abstraction — start blank */ }

editor.resize(window.innerWidth, window.innerHeight);
editor.render();

// Resize handling
window.addEventListener("resize", () => editor.resize(window.innerWidth, window.innerHeight));

// --- Save ---

async function save() {
  const res = await fetch(`/abstractions/${encodeURIComponent(absName)}`, {
    method: "PUT",
    body: editor.serialize()
  });
  if (res.ok) {
    dirty = false;
    document.title = `editing: ${absName}`;
    await loadAbstractions();
    editor.render();
    console.log("Saved:", absName);
    // Notify parent ctrl window to refresh abstractions
    if (window.opener) {
      try { window.opener.postMessage({ type: "abs-saved", name: absName }, "*"); } catch {}
    }
  }
}

// --- Keyboard ---

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); editor.finishEditing(true); }
  else if (e.key === "Escape") { e.preventDefault(); editor.finishEditing(false); }
});
input.addEventListener("input", () => {
  if (editor.editingBoxId === null) return;
  const box = editor.boxes.get(editor.editingBoxId);
  if (!box) return;
  const w = Math.max(editor.measureText(input.value || " ") + BOX_PAD_X * 2,
    (Math.max(box.inlets, box.outlets) + 1) * (PORT_W + 4), 80);
  input.style.width = (w * editor.zoom) + "px";
  editor.render();
});
input.addEventListener("blur", () => editor.finishEditing(true));

window.addEventListener("keydown", (e) => {
  if (editor.mode === "editing") return;
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); editor.undo(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "c") {
    e.preventDefault();
    if (editor.selection.size === 0) return;
    const copyBoxes = [];
    const copyCables = [];
    for (const id of editor.selection) {
      const box = editor.boxes.get(id);
      if (box) copyBoxes.push([id, { ...box }]);
    }
    for (const [cid, c] of editor.cables) {
      if (editor.selection.has(c.srcBox) && editor.selection.has(c.dstBox)) {
        copyCables.push([cid, { ...c }]);
      }
    }
    localStorage.setItem("clipboard", JSON.stringify({ boxes: copyBoxes, cables: copyCables }));
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "v") {
    e.preventDefault();
    const clip = localStorage.getItem("clipboard");
    if (!clip) return;
    editor.pushUndo();
    const data = JSON.parse(clip);
    const idMap = new Map();
    const newSel = [];
    for (const [oldId, box] of data.boxes) {
      const newId = editor.nextId++;
      idMap.set(oldId, newId);
      editor.boxes.set(newId, { ...box, x: box.x + 20, y: box.y + 20 });
      newSel.push(newId);
    }
    for (const [, c] of data.cables) {
      if (idMap.has(c.srcBox) && idMap.has(c.dstBox)) {
        editor.cables.set(editor.nextId++, { srcBox: idMap.get(c.srcBox), srcOutlet: c.srcOutlet, dstBox: idMap.get(c.dstBox), dstInlet: c.dstInlet });
      }
    }
    editor.selection.clear();
    for (const id of newSel) editor.selection.add(id);
    editor.dirty = true;
    editor.onDirty();
    editor.render();
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    if (editor.selection.size > 0 || editor.cableSelection.size > 0) {
      editor.pushUndo();
      for (const id of editor.selection) {
        for (const [cid, c] of editor.cables) {
          if (c.srcBox === id || c.dstBox === id) editor.cables.delete(cid);
        }
        editor.boxes.delete(id);
      }
      for (const cid of editor.cableSelection) editor.cables.delete(cid);
      editor.selection.clear();
      editor.cableSelection.clear();
      editor.dirty = true;
      editor.onDirty();
      editor.render();
    }
    return;
  }
  if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    editor.selection.clear();
    for (const id of editor.boxes.keys()) editor.selection.add(id);
    editor.render();
    return;
  }
  if (e.key === "z" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (editor.zoom < 1) editor.resetView();
    else editor.zoomToFit();
    return;
  }
  if (e.key === " " && editor.mode !== "editing") {
    e.preventDefault();
    editor.spaceHeld = true;
    if (!editor.isPanning) editor.canvas.style.cursor = "grab";
    return;
  }
  editor.onKeyDown(e);
});

window.addEventListener("keyup", (e) => {
  if (e.key === " ") {
    editor.spaceHeld = false;
    if (!editor.isPanning) editor.canvas.style.cursor = "default";
  }
});

// Warn on close if dirty
window.addEventListener("beforeunload", (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});
