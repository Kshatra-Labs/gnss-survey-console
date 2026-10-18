// Warning boxes for operations that delete or replace something: a modal with
// a title, the consequences, and a button per choice. warningBox() resolves
// to the chosen choice's value, or null when cancelled (the cancel button,
// Esc, or a click outside). Unlike confirm() it can offer more than OK/Cancel
// and it looks like the page. Used by the console and the Site map.
//
//   warningBox({ title, body: "text" | ["paragraph", ...], cancel: "Keep them",
//                choices: [{ value, label, note?, danger? }] })
//
// With notes, each choice is a full-width button with its note under it;
// without, the buttons sit in one row after the cancel button.
(function () {
  const STYLE = `
.wb-back { position: fixed; inset: 0; z-index: 10000; background: rgba(0, 0, 0, .6); display: flex; align-items: center; justify-content: center; padding: 16px; }
.wb { width: 100%; max-width: 460px; max-height: calc(100vh - 32px); overflow-y: auto; background: var(--panel, #161c22); color: var(--text, #e6edf3);
  border: 1px solid var(--warn, #e0a63c); border-radius: 10px; padding: 16px 18px; font-size: 13.5px; line-height: 1.45; box-shadow: 0 12px 40px rgba(0, 0, 0, .5); }
.wb h2 { font-size: 15px; margin: 0 0 8px; }
.wb h2::before { content: "\\26A0  "; color: var(--warn, #e0a63c); }
.wb p { margin: 0 0 8px; color: var(--muted, #8b98a5); overflow-wrap: anywhere; }
.wb .wb-choice { margin-top: 10px; }
.wb .wb-choice button { width: 100%; margin: 0; text-align: left; }
.wb .wb-note { font-size: 12px; color: var(--muted, #8b98a5); margin-top: 4px; }
.wb .wb-row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.wb .wb-row button { margin: 0; }
.wb button.wb-danger { background: var(--bad, #e0503c); color: #fff; }
.wb button:focus-visible { outline: 2px solid var(--accent, #4fa3ff); outline-offset: 2px; }`;

  let open = null; // close() of the box on screen
  let seq = 0;

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text != null) e.textContent = text; // never HTML: labels and sources come from other devices
    return e;
  }

  function warningBox({ title, body, choices, cancel = "Cancel" }) {
    if (open) open(null);
    if (!document.getElementById("wb-style")) document.head.append(el("style", { id: "wb-style" }, STYLE));
    const id = `wb${++seq}`;
    const back = el("div", { class: "wb-back" });
    const box = el("div", { class: "wb", role: "alertdialog", "aria-modal": "true", "aria-labelledby": `${id}-t`, "aria-describedby": `${id}-b` });
    const text = el("div", { id: `${id}-b` });
    text.append(...[].concat(body || []).filter(Boolean).map((p) => el("p", {}, p)));
    box.append(el("h2", { id: `${id}-t` }, title), text);

    const stacked = choices.some((c) => c.note);
    const cancelBtn = el("button", { class: "secondary", "data-choice": "" }, cancel);
    const row = el("div", { class: "wb-row" });
    row.append(cancelBtn);
    const buttons = choices.map((c) => {
      const b = el("button", { "data-choice": c.value }, c.label);
      if (c.danger) b.className = "wb-danger";
      if (stacked) {
        const wrap = el("div", { class: "wb-choice" });
        wrap.append(b, el("div", { class: "wb-note" }, c.note || ""));
        box.append(wrap);
      } else {
        row.append(b);
      }
      return [b, c.value];
    });
    box.append(row);
    back.append(box);

    return new Promise((resolve) => {
      const before = document.activeElement;
      const focusable = () => [...box.querySelectorAll("button")];
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(null); return; }
        if (e.key !== "Tab") return;
        const f = focusable(), i = f.indexOf(document.activeElement); // keep focus inside the box
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      };
      function close(value) {
        if (open !== close) return;
        open = null;
        document.removeEventListener("keydown", onKey, true);
        back.remove();
        if (before && before.focus) before.focus();
        resolve(value);
      }
      open = close;
      cancelBtn.onclick = () => close(null);
      for (const [b, value] of buttons) b.onclick = () => close(value);
      back.addEventListener("click", (e) => { if (e.target === back) close(null); });
      document.addEventListener("keydown", onKey, true);
      document.body.append(back);
      cancelBtn.focus(); // the safe choice is the default
    });
  }

  window.warningBox = warningBox;
})();
