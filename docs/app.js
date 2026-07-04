/*
 * Blackline — client-side redaction engine.
 *
 * Zero-trust by architecture: the PDF is read with FileReader, rendered with
 * pdf.js, and rebuilt with pdf-lib entirely in this tab. On export every page
 * is flattened to a raster image with the redaction boxes burned in, so the
 * text/image data under a box is not present in the output file at all.
 * No file byte ever touches a server.
 */

(() => {
  'use strict';

  const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
  const MIN_SCALE = 0.6;
  const MAX_SCALE = 3;
  const SCALE_STEP = 0.2;
  const EXPORT_SCALE = 2; // render pages at 2x for a crisp flattened export
  const THEME_KEY = 'redactor-theme';

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    pdf: null,        // pdf.js document
    fileName: '',
    scale: 1.2,
    boxes: [],        // [{ page, x, y, w, h }] in scale-1 viewport units, insertion order
    rendering: false,
    exporting: false,
  };

  // ── Elements ─────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const dropSection = $('dropSection');
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  const workspace = $('workspace');
  const pagesEl = $('pages');
  const errorBanner = $('errorBanner');
  const errorText = $('errorText');
  const successBanner = $('successBanner');
  const successText = $('successText');
  const fileChipName = $('fileChipName');
  const fileChipMeta = $('fileChipMeta');
  const zoomLevel = $('zoomLevel');
  const zoomInBtn = $('zoomInBtn');
  const zoomOutBtn = $('zoomOutBtn');
  const boxCount = $('boxCount');
  const undoBtn = $('undoBtn');
  const clearBtn = $('clearBtn');
  const resetBtn = $('resetBtn');
  const exportBtn = $('exportBtn');
  const exportBtnLabel = $('exportBtnLabel');
  const exportHint = $('exportHint');
  const themeToggle = $('themeToggle');

  // ── Theme toggle (same pattern as ENV Vault Checker) ─────────────────────
  const SUN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';
  const MOON_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
    localStorage.setItem(THEME_KEY, theme);
  }

  applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  // ── Footer "How this works" link ─────────────────────────────────────────
  // The plain anchor felt dead: the target <details> stayed collapsed and the
  // page is often too short to scroll. Expand the section, then glide to it.
  const howSection = $('how-it-works');
  const footerLink = document.querySelector('.footer-link');
  if (footerLink && howSection) {
    footerLink.addEventListener('click', (e) => {
      e.preventDefault();
      howSection.open = true;
      howSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', '#how-it-works');
    });
  }
  if (howSection && location.hash === '#how-it-works') {
    howSection.open = true;
  }

  // ── Errors / banners ─────────────────────────────────────────────────────
  function showError(message) {
    errorText.textContent = message;
    errorBanner.hidden = false;
  }

  function clearBanners() {
    errorBanner.hidden = true;
    successBanner.hidden = true;
  }

  // ── File intake ──────────────────────────────────────────────────────────
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
    }),
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  async function handleFile(file) {
    clearBanners();

    const looksLikePdf =
      file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!looksLikePdf) {
      showError('That doesn’t look like a PDF. Please choose a .pdf file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError(
        `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 25 MB. ` +
          'Large PDFs are slow to process in the browser; try splitting it first.',
      );
      return;
    }

    let data;
    try {
      data = await file.arrayBuffer();
    } catch {
      showError('Could not read the file. Please try again.');
      return;
    }

    try {
      state.pdf = await pdfjsLib.getDocument({ data }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') {
        showError(
          'This PDF is password-protected. Remove the password (open it and re-save/print to PDF), then try again — we can’t redact what we can’t render.',
        );
      } else if (err && err.name === 'InvalidPDFException') {
        showError('This file appears to be corrupted or isn’t a valid PDF.');
      } else {
        showError('Something went wrong opening this PDF. Please try another file.');
      }
      return;
    }

    state.fileName = file.name;
    state.boxes = [];
    state.scale = 1.2;

    fileChipName.textContent = file.name;
    fileChipMeta.textContent = `${state.pdf.numPages} page${state.pdf.numPages === 1 ? '' : 's'} · ${(file.size / 1024).toFixed(0)} KB`;

    dropSection.hidden = true;
    workspace.hidden = false;
    updateControls();
    await renderAllPages();
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  async function renderAllPages() {
    if (!state.pdf || state.rendering) return;
    state.rendering = true;
    updateControls();
    pagesEl.innerHTML = '';

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    for (let n = 1; n <= state.pdf.numPages; n++) {
      const page = await state.pdf.getPage(n);
      const viewport = page.getViewport({ scale: state.scale });

      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const label = document.createElement('span');
      label.className = 'page-label';
      label.textContent = `Page ${n} / ${state.pdf.numPages}`;

      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.dataset.page = String(n);
      attachDrawHandlers(overlay, n);

      wrap.append(canvas, label, overlay);
      pagesEl.appendChild(wrap);

      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;

      renderBoxesForPage(n);
    }

    zoomLevel.textContent = `${Math.round(state.scale * 100)}%`;
    state.rendering = false;
    updateControls();
  }

  // ── Box drawing ──────────────────────────────────────────────────────────
  function attachDrawHandlers(overlay, pageNum) {
    let drag = null;

    overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || state.exporting) return;
      const rect = overlay.getBoundingClientRect();
      const ghost = document.createElement('div');
      ghost.className = 'redaction-box is-ghost';
      overlay.appendChild(ghost);
      drag = {
        x0: e.clientX - rect.left,
        y0: e.clientY - rect.top,
        ghost,
        rect,
      };
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    overlay.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x1 = clamp(e.clientX - drag.rect.left, 0, drag.rect.width);
      const y1 = clamp(e.clientY - drag.rect.top, 0, drag.rect.height);
      positionBoxEl(drag.ghost, rectFrom(drag.x0, drag.y0, x1, y1));
    });

    const finish = (e) => {
      if (!drag) return;
      const x1 = clamp(e.clientX - drag.rect.left, 0, drag.rect.width);
      const y1 = clamp(e.clientY - drag.rect.top, 0, drag.rect.height);
      const r = rectFrom(drag.x0, drag.y0, x1, y1);
      drag.ghost.remove();
      drag = null;

      // Ignore accidental clicks — a real box needs some area.
      if (r.w >= 6 && r.h >= 6) {
        state.boxes.push({
          page: pageNum,
          x: r.x / state.scale,
          y: r.y / state.scale,
          w: r.w / state.scale,
          h: r.h / state.scale,
        });
        renderBoxesForPage(pageNum);
        clearBanners();
        updateControls();
      }
    };

    overlay.addEventListener('pointerup', finish);
    overlay.addEventListener('pointercancel', () => {
      if (drag) {
        drag.ghost.remove();
        drag = null;
      }
    });
  }

  function rectFrom(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function positionBoxEl(el, r) {
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  }

  function renderBoxesForPage(pageNum) {
    const overlay = pagesEl.querySelector(`.overlay[data-page="${pageNum}"]`);
    if (!overlay) return;
    overlay.querySelectorAll('.redaction-box:not(.is-ghost)').forEach((el) => el.remove());
    for (const b of state.boxes) {
      if (b.page !== pageNum) continue;
      const el = document.createElement('div');
      el.className = 'redaction-box';
      positionBoxEl(el, {
        x: b.x * state.scale,
        y: b.y * state.scale,
        w: b.w * state.scale,
        h: b.h * state.scale,
      });
      overlay.appendChild(el);
    }
  }

  function renderAllBoxes() {
    if (!state.pdf) return;
    for (let n = 1; n <= state.pdf.numPages; n++) renderBoxesForPage(n);
  }

  // ── Toolbar actions ──────────────────────────────────────────────────────
  zoomInBtn.addEventListener('click', () => setScale(state.scale + SCALE_STEP));
  zoomOutBtn.addEventListener('click', () => setScale(state.scale - SCALE_STEP));

  async function setScale(next) {
    const scale = clamp(Math.round(next * 100) / 100, MIN_SCALE, MAX_SCALE);
    if (scale === state.scale || state.rendering) return;
    state.scale = scale;
    await renderAllPages();
  }

  undoBtn.addEventListener('click', () => {
    const removed = state.boxes.pop();
    if (removed) renderBoxesForPage(removed.page);
    updateControls();
  });

  clearBtn.addEventListener('click', () => {
    state.boxes = [];
    renderAllBoxes();
    updateControls();
  });

  resetBtn.addEventListener('click', () => {
    state.pdf = null;
    state.boxes = [];
    state.fileName = '';
    pagesEl.innerHTML = '';
    workspace.hidden = true;
    dropSection.hidden = false;
    clearBanners();
  });

  function updateControls() {
    const n = state.boxes.length;
    boxCount.textContent = `${n} box${n === 1 ? '' : 'es'}`;
    undoBtn.disabled = n === 0 || state.exporting;
    clearBtn.disabled = n === 0 || state.exporting;
    exportBtn.disabled = n === 0 || state.exporting || state.rendering;
    zoomInBtn.disabled = state.rendering || state.exporting || state.scale >= MAX_SCALE;
    zoomOutBtn.disabled = state.rendering || state.exporting || state.scale <= MIN_SCALE;
    exportHint.textContent = state.exporting
      ? 'Flattening pages locally — nothing is being uploaded.'
      : n === 0
        ? 'Draw at least one box to enable export.'
        : `${n} area${n === 1 ? '' : 's'} will be permanently removed.`;
  }

  // ── Export: flatten pages + burn in boxes + rebuild PDF ──────────────────
  exportBtn.addEventListener('click', applyRedactionAndExport);

  async function applyRedactionAndExport() {
    if (!state.pdf || state.boxes.length === 0 || state.exporting) return;
    state.exporting = true;
    clearBanners();
    updateControls();

    try {
      const outDoc = await PDFLib.PDFDocument.create();

      for (let n = 1; n <= state.pdf.numPages; n++) {
        exportBtnLabel.textContent = `Redacting page ${n} of ${state.pdf.numPages}…`;

        const page = await state.pdf.getPage(n);
        const viewport = page.getViewport({ scale: EXPORT_SCALE });

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');

        await page.render({ canvasContext: ctx, viewport }).promise;

        // Burn the redactions in as opaque black — after this, the pixels are
        // all that exists; the text layer is never copied to the new file.
        ctx.fillStyle = '#000000';
        for (const b of state.boxes) {
          if (b.page !== n) continue;
          ctx.fillRect(
            b.x * EXPORT_SCALE,
            b.y * EXPORT_SCALE,
            b.w * EXPORT_SCALE,
            b.h * EXPORT_SCALE,
          );
        }

        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const jpeg = await outDoc.embedJpg(jpegDataUrl);

        const pageWidth = viewport.width / EXPORT_SCALE;
        const pageHeight = viewport.height / EXPORT_SCALE;
        const outPage = outDoc.addPage([pageWidth, pageHeight]);
        outPage.drawImage(jpeg, { x: 0, y: 0, width: pageWidth, height: pageHeight });

        // Free the canvas early on big documents.
        canvas.width = canvas.height = 0;
      }

      const bytes = await outDoc.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = state.fileName.replace(/\.pdf$/i, '') + '-redacted.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      const areas = state.boxes.length;
      successText.textContent =
        `Redacted PDF downloaded — ${areas} area${areas === 1 ? '' : 's'} permanently removed ` +
        `across ${state.pdf.numPages} page${state.pdf.numPages === 1 ? '' : 's'}. ` +
        'The content under each box is not present in the new file.';
      successBanner.hidden = false;
    } catch (err) {
      console.error('[blackline] export failed:', err);
      showError('Export failed while rebuilding the PDF. Please try again — your file is still only in this tab.');
    } finally {
      state.exporting = false;
      exportBtnLabel.textContent = 'Apply Redaction & Export';
      updateControls();
    }
  }
})();
