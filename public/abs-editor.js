import { GRID, PORT_TYPES, boxTypeName, snapToGrid } from "./gpi-types.js";
import { toggleTheme } from "./theme.js";
import { PatchEditor, COLORS, SMALL_FONT, loadAbstractions } from "./patch-editor.js";

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
  showBorder: false,
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
    ctx.fillStyle = dirty ? COLORS.absTitleDirty : COLORS.absTitle;
    ctx.fillText(absName + (dirty ? " *" : ""), 12, 8);
    ctx.fillStyle = COLORS.labelDim;
    ctx.textAlign = "right";
    // Under the header panel while it shows; it lists its own key.
    if (document.getElementById("header-panel").classList.contains("hidden")) ctx.fillText("Cmd+S save  |  Cmd+Z undo  |  i header", w - 12, 8);
    ctx.textAlign = "left";
  }
});

editor.bindEvents();

// --- Header ---
// The contract in the file: side, description, args, inlets, outlets
// (notes/abstractions.md). The name is the file's; rename isn't here yet.

// `face` is null when the abstraction has none; the file then has no field.
const header = { side: params.get("side") ?? "", description: "", args: [], inlets: [], outlets: [], face: null };

// Load existing abstraction data; a 404 is a new abstraction (side from Shift+N).
{
  const res = await fetch(`/abstractions/${encodeURIComponent(absName)}`);
  if (res.ok) {
    const data = await res.json();
    for (const k of Object.keys(header)) header[k] = data[k] ?? (k === "face" ? null : undefined);
    editor.load(data);
  } else if (res.status !== 404) {
    alert(`can't load ${absName}: ${await res.text()}`);
  }
}

const panel = document.getElementById("header-panel");
const LISTS = {
  args: { title: "args", types: ["symbol", "number"], label: (i) => `$${i + 1}` },
  inlets: { title: "inlets", types: PORT_TYPES, label: (i) => String(i) },
  outlets: { title: "outlets", types: PORT_TYPES, label: (i) => String(i) },
};

function markDirty() {
  dirty = true;
  document.title = `editing: ${absName} *`;
  editor.render();
}

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) e.append(c);
  return e;
}

function renderList(key) {
  const { title, types, label } = LISTS[key];
  const list = header[key];
  const host = panel.querySelector(`[data-list="${key}"]`);
  const add = el("button", { type: "button", textContent: "+", title: `add ${title.slice(0, -1)}` });
  add.onclick = () => { list.push({ name: "", type: types[0], description: "" }); renderList(key); markDirty(); };
  host.replaceChildren(el("div", { className: "hp-head" }, [title, add]));
  list.forEach((spec, i) => {
    const name = el("input", { value: spec.name, placeholder: "name", spellcheck: false });
    name.oninput = () => { spec.name = name.value.trim(); markDirty(); };
    const type = el("select", {}, types.map((t) => el("option", { value: t, textContent: t, selected: t === spec.type })));
    type.onchange = () => { spec.type = type.value; markDirty(); };
    const del = el("button", { type: "button", textContent: "×", title: "remove" });
    del.onclick = () => { list.splice(i, 1); renderList(key); markDirty(); };
    const desc = el("input", { value: spec.description, placeholder: "description", className: "hp-desc", spellcheck: false });
    desc.oninput = () => { spec.description = desc.value; markDirty(); };
    host.append(el("div", { className: "hp-entry" }, [el("span", { className: "hp-idx", textContent: label(i) }), name, type, del, el("span"), desc]));
  });
}

function renderPanel() {
  document.getElementById("hp-name").textContent = absName;
  const side = document.getElementById("hp-side");
  side.value = header.side;
  side.onchange = () => { header.side = side.value; markDirty(); };
  const desc = document.getElementById("hp-desc");
  desc.value = header.description;
  desc.oninput = () => { header.description = desc.value; markDirty(); };
  for (const key of Object.keys(LISTS)) renderList(key);
}

// Make the inlet/outlet lists as long as the highest `inlet i`/`outlet i` box
// index + 1, keeping the entries already there.
document.getElementById("hp-sync").onclick = () => {
  for (const [kind, key] of [["inlet", "inlets"], ["outlet", "outlets"]]) {
    let max = -1;
    for (const box of editor.boxes.values()) {
      const t = box.text.trim().split(/\s+/);
      if (t[0] === kind && /^\d+$/.test(t[1] ?? "")) max = Math.max(max, Number(t[1]));
    }
    const list = header[key];
    list.splice(max + 1);
    while (list.length < max + 1) list.push({ name: `${kind === "inlet" ? "in" : "out"}${list.length}`, type: "number", description: "" });
  }
  renderPanel();
  markDirty();
};

renderPanel();

editor.resize(window.innerWidth, window.innerHeight);
editor.render();

// Resize handling
window.addEventListener("resize", () => editor.resize(window.innerWidth, window.innerHeight));

// --- Save ---

async function save() {
  const { boxes, cables, nextId } = JSON.parse(editor.serialize());
  const res = await fetch(`/abstractions/${encodeURIComponent(absName)}`, {
    method: "PUT",
    body: JSON.stringify({ name: absName, ...header, face: header.face ?? undefined, boxes, cables, nextId }),
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
  } else {
    const { error } = await res.json().catch(() => ({}));
    alert("save rejected:\n" + (error ?? res.status));
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
  const w = Math.max(editor.boxWidth(box, editor.editingBoxId), 80);
  input.style.width = (w * editor.zoom) + "px";
  editor.render();
});
input.addEventListener("blur", () => editor.finishEditing(true));

window.addEventListener("keydown", (e) => {
  if (editor.mode === "text-editing") return;
  if (e.target instanceof Element && e.target.closest("#header-panel")) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
    return;
  }
  if (e.key === "i" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); panel.classList.toggle("hidden"); editor.render(); return; }
  if (e.key === "t" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleTheme(); return; }
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
      editor.boxes.set(newId, { ...box, x: snapToGrid(box.x) + GRID, y: snapToGrid(box.y) + GRID });
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
  if (e.key === " " && editor.mode !== "text-editing") {
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
