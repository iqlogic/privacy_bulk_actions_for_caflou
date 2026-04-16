// ==UserScript==
// @name         Caflou Privacy Bulk Actions v0.2.4
// @namespace    https://edsystem.cz/
// @version      0.2.4
// @description  Hromadné akce pro soukromí obchodního případu v Caflou
// @author       Milan Kutaj + ChatGPT
// @match        *://*.caflou.cz/*
// @match        *://*.caflou.com/*
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const RIGHTS_ORDER = ['read', 'write', 'health'];
  const ACTIONS = {
    CLEAR_ALL: 'clear_all',
    RESTORE_ALL: 'restore_all',
    GRANT_ALL: 'grant_all',
  };

  const UI = {
    toolbarId: 'tm-privacy-bulk-toolbar',
    styleId: 'tm-privacy-bulk-style',
  };

  let isRunning = false;
  let observerStarted = false;

  function log(...args) {
    console.log('[TM Privacy Bulk]', ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function safeJsonParse(text, fallback = null) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return fallback;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeRights(rights) {
    const set = new Set(Array.isArray(rights) ? rights : []);
    return RIGHTS_ORDER.filter((r) => set.has(r));
  }

  function normalizeAssociations(associations) {
    const result = {};
    const source = associations && typeof associations === 'object' ? associations : {};
    for (const key of Object.keys(source).sort()) {
      const values = Array.isArray(source[key]) ? source[key] : [];
      const normalized = normalizeRights(values);
      if (normalized.length > 0) {
        result[key] = normalized;
      }
    }
    return result;
  }

  function normalizeEntry(entry) {
    const src = entry && typeof entry === 'object' ? entry : {};
    return {
      kind: src.kind || 'manual',
      rights: normalizeRights(src.rights),
      associations: normalizeAssociations(src.associations),
    };
  }

  function entriesEqual(a, b) {
    return JSON.stringify(normalizeEntry(a)) === JSON.stringify(normalizeEntry(b));
  }

  function getPrivacyContainer() {
    return document.querySelector('#privacy-settings');
  }

  function getHiddenPrivacyInput() {
    return document.querySelector('input[name="project[privacy]"]');
  }

  function getSearchInput() {
    return document.querySelector('#privacy-settings input[name="search"]');
  }

  function getPageSelect() {
    return document.querySelector('#privacy-settings select[name="page"]');
  }

  function getPaginationRoot() {
    return (
      document.querySelector('#privacy-settings .pagination.full') ||
      document.querySelector('#privacy-settings .pagination.simplified')
    );
  }

  function getRows() {
    const root = getPrivacyContainer();
    if (!root) return [];
    return Array.from(root.querySelectorAll('.privacy-settings > .user'));
  }

  function getRowSignature() {
    return getRows().map((row) => row.id).join('|');
  }

  function getUserIdFromRow(row) {
    if (!row || !row.id) return null;
    const match = row.id.match(/^user_(\d+)$/);
    return match ? match[1] : null;
  }

  function getUserNameFromRow(row) {
    return row?.querySelector('.name')?.textContent?.trim() || '(neznámý uživatel)';
  }

  function getRootCheckbox(row, right) {
    const userId = getUserIdFromRow(row);
    if (!userId) return null;
    return row.querySelector(`input[name="${right}_${userId}"]`);
  }

  function getRootStateFromDom(row) {
    const read = getRootCheckbox(row, 'read');
    const write = getRootCheckbox(row, 'write');
    const health = getRootCheckbox(row, 'health');

    return {
      read: !!read?.checked,
      write: !!write?.checked,
      health: !!health?.checked,
    };
  }

  function getRestoreLink(row) {
    return Array.from(row.querySelectorAll('a')).find((a) => /obnovit/i.test(a.textContent || '')) || null;
  }

  function parsePageNumber(text) {
    const n = parseInt(String(text || '').trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  function getDesktopPageButtons() {
    const root = getPaginationRoot();
    if (!root) return [];

    return Array.from(root.querySelectorAll('.desktop-only button')).filter((btn) => {
      return Number.isFinite(parsePageNumber(btn.textContent));
    });
  }

  function getDesktopActivePage() {
    const root = getPaginationRoot();
    if (!root) return null;

    const activeBtn = Array.from(root.querySelectorAll('.desktop-only button'))
      .find((btn) => btn.classList.contains('active'));

    if (!activeBtn) return null;

    return parsePageNumber(activeBtn.textContent);
  }

  function getCurrentPage() {
    const desktopPage = getDesktopActivePage();
    if (Number.isFinite(desktopPage)) return desktopPage;

    const select = getPageSelect();
    if (select) {
      const n = parseInt(select.value, 10);
      if (Number.isFinite(n)) return n;
    }

    return 1;
  }

  function getTotalPages() {
    const select = getPageSelect();
    if (select) {
      const firstOption = select.options?.[0];
      const totalFromData = parseInt(firstOption?.dataset?.total || '', 10);
      if (Number.isFinite(totalFromData) && totalFromData > 0) {
        return totalFromData;
      }

      if (select.options.length > 0) {
        return select.options.length;
      }
    }

    const nums = getDesktopPageButtons()
      .map((btn) => parsePageNumber(btn.textContent))
      .filter((n) => Number.isFinite(n));

    return nums.length ? Math.max(...nums) : 1;
  }

  function getVisiblePageButton(targetPage) {
    return getDesktopPageButtons().find((btn) => parsePageNumber(btn.textContent) === targetPage) || null;
  }

  function setNativeInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeSelectValue(select, value) {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(select, value);
    } else {
      select.value = value;
    }
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getPrivacyObject() {
    const input = getHiddenPrivacyInput();
    if (!input) return null;
    return safeJsonParse(input.value, {});
  }

  function setPrivacyObject(obj) {
    const input = getHiddenPrivacyInput();
    if (!input) return;
    setNativeInputValue(input, JSON.stringify(obj));
  }

  function getPropsObject() {
    const node = getPrivacyContainer();
    if (!node) return null;
    return safeJsonParse(node.dataset.props || '{}', {});
  }

  function getDefaultPrivacy() {
    const props = getPropsObject();
    return props?.default_privacy || {};
  }

  function isSearchActive() {
    const input = getSearchInput();
    return !!(input && input.value && input.value.trim() !== '');
  }

  function hasOpenAssociationsOnCurrentPage() {
    return getRows().some((row) => {
      const allCheckboxes = row.querySelectorAll('input.check_boxes[type="checkbox"]');
      return allCheckboxes.length > 3;
    });
  }

  function syncRowCheckboxes(row, entry) {
    const normalized = normalizeEntry(entry);
    const desired = {
      read: normalized.rights.includes('read'),
      write: normalized.rights.includes('write'),
      health: normalized.rights.includes('health'),
    };

    for (const [right, checked] of Object.entries(desired)) {
      const input = getRootCheckbox(row, right);
      if (!input) continue;
      input.checked = checked;
      if (checked) {
        input.setAttribute('checked', '');
      } else {
        input.removeAttribute('checked');
      }
    }
  }

  function updateStatus(content, type = 'info', options = {}) {
    const bar = document.getElementById(UI.toolbarId);
    if (!bar) return;

    const status = bar.querySelector('.tm-privacy-status');
    if (!status) return;

    status.dataset.type = type;

    if (options.html) {
      status.innerHTML = content;
    } else {
      status.textContent = content;
    }
  }

  function buildFinalStatusHtml(report) {
    if (report.failed.length > 0) {
      return (
        `<strong>Dokončeno s chybami</strong>. Zkontroluj výsledek a pak případně klikni na Uložit.` +
        `<br>Změněno ${report.changed.length}, beze změny ${report.unchanged.length}, ` +
        `přeskočeno (zamčeno) ${report.skippedLocked.length}, chyby ${report.failed.length}.`
      );
    }

    return (
      `<strong>Hotovo</strong>. Teď můžeš ručně zaškrtnout vybrané uživatele a kliknout na Uložit.` +
      `<br>Změněno ${report.changed.length}, beze změny ${report.unchanged.length}, ` +
      `přeskočeno (zamčeno) ${report.skippedLocked.length}, chyby ${report.failed.length}.`
    );
  }

  function ensureStyles() {
    if (document.getElementById(UI.styleId)) return;

    const style = document.createElement('style');
    style.id = UI.styleId;
    style.textContent = `
      #${UI.toolbarId} {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin: 0 0 12px 0;
        padding: 10px 12px;
        border: 1px solid #d8dee8;
        background: #f7f9fc;
        border-radius: 8px;
      }
      #${UI.toolbarId} .tm-privacy-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #${UI.toolbarId} button {
        appearance: none;
        border: 1px solid #9fb0c7;
        background: #fff;
        color: #2f4058;
        padding: 6px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        line-height: 1.2;
      }
      #${UI.toolbarId} button:hover:not(:disabled) {
        background: #f0f4fa;
      }
      #${UI.toolbarId} button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      #${UI.toolbarId} .tm-privacy-status {
        min-height: 20px;
        font-size: 13px;
        color: #4a5a72;
        line-height: 1.45;
      }
      #${UI.toolbarId} .tm-privacy-status[data-type="error"] {
        color: #b42318;
      }
      #${UI.toolbarId} .tm-privacy-status[data-type="success"] {
        color: #067647;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureToolbar() {
    const root = getPrivacyContainer();
    if (!root) return;

    if (document.getElementById(UI.toolbarId)) return;

    const header = root.querySelector('.privacy-settings-header');
    if (!header || !header.parentNode) return;

    ensureStyles();

    const toolbar = document.createElement('div');
    toolbar.id = UI.toolbarId;
    toolbar.innerHTML = `
      <div class="tm-privacy-buttons">
        <button type="button" data-action="${ACTIONS.CLEAR_ALL}">Vše odškrtnout</button>
        <button type="button" data-action="${ACTIONS.RESTORE_ALL}">Vše obnovit (dle role)</button>
        <button type="button" data-action="${ACTIONS.GRANT_ALL}">Všem povolit vše</button>
      </div>
      <div class="tm-privacy-status">Připraveno.</div>
    `;

    toolbar.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      await runBulkAction(action);
    });

    header.parentNode.insertBefore(toolbar, header);
  }

  async function waitFor(predicate, timeoutMs = 2500, intervalMs = 50) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (predicate()) return true;
      } catch (e) {
        // ignore predicate errors during async render
      }
      await sleep(intervalMs);
    }
    return false;
  }

  async function clickPageStep(direction) {
    const root = document.querySelector('#privacy-settings .pagination.full') || getPaginationRoot();
    if (!root) return false;

    const btn = root.querySelector(`button.${direction}`);
    if (!btn || btn.disabled) return false;

    const prevPage = getCurrentPage();
    const prevSignature = getRowSignature();

    btn.click();

    const ok = await waitFor(() => {
      const nextPage = getCurrentPage();
      const nextSignature = getRowSignature();
      return nextPage !== prevPage || nextSignature !== prevSignature;
    }, 3000, 50);

    await sleep(80);
    return ok;
  }

  async function clickVisiblePageNumber(targetPage) {
    const btn = getVisiblePageButton(targetPage);
    if (!btn || btn.disabled) return false;

    if (btn.classList.contains('active') && getCurrentPage() === targetPage) {
      return true;
    }

    const prevPage = getCurrentPage();
    const prevSignature = getRowSignature();

    btn.click();

    const ok = await waitFor(() => {
      const nextPage = getCurrentPage();
      const nextSignature = getRowSignature();
      return nextPage === targetPage || nextSignature !== prevSignature || nextPage !== prevPage;
    }, 3000, 50);

    await sleep(80);
    return ok && getCurrentPage() === targetPage;
  }

  async function jumpToPageViaSelect(targetPage) {
    const select = getPageSelect();
    if (!select) return false;

    const targetValue = String(targetPage);
    const hasOption = Array.from(select.options || []).some((opt) => String(opt.value) === targetValue);
    if (!hasOption) return false;

    if (String(select.value) === targetValue && getCurrentPage() === targetPage) {
      return true;
    }

    const prevPage = getCurrentPage();
    const prevSignature = getRowSignature();

    setNativeSelectValue(select, targetValue);

    const ok = await waitFor(() => {
      const currentViaSelect = parseInt(select.value, 10);
      const nextPage = getCurrentPage();
      const nextSignature = getRowSignature();

      return (
        currentViaSelect === targetPage ||
        nextPage === targetPage ||
        nextSignature !== prevSignature ||
        nextPage !== prevPage
      );
    }, 4000, 50);

    await sleep(120);
    return ok && getCurrentPage() === targetPage;
  }

  async function gotoPage(targetPage, options = {}) {
    const preferDirect = options.preferDirect !== false;
    const preferSelect = !!options.preferSelect;
    let guard = 0;

    if (getCurrentPage() === targetPage) {
      return true;
    }

    if (preferDirect) {
      const directOk = await clickVisiblePageNumber(targetPage);
      if (directOk) return true;
    }

    if (preferSelect) {
      const selectOk = await jumpToPageViaSelect(targetPage);
      if (selectOk) return true;
    }

    while (getCurrentPage() !== targetPage && guard < 500) {
      if (preferDirect) {
        const directOk = await clickVisiblePageNumber(targetPage);
        if (directOk) return true;
      }

      if (preferSelect) {
        const selectOk = await jumpToPageViaSelect(targetPage);
        if (selectOk) return true;
      }

      const currentPage = getCurrentPage();
      const direction = targetPage > currentPage ? 'next' : 'prev';

      const ok = await clickPageStep(direction);
      if (!ok) return false;

      guard += 1;
    }

    return getCurrentPage() === targetPage;
  }

  async function clickAndWaitForChange(input, userId, previousEntry) {
    if (!input || input.disabled) return false;

    input.click();

    const ok = await waitFor(() => {
      const privacy = getPrivacyObject() || {};
      const nextEntry = privacy[userId];
      return !entriesEqual(previousEntry, nextEntry);
    }, 1800, 50);

    await sleep(40);
    return ok;
  }

  function desiredEntryForAction(action, defaultEntry) {
    if (action === ACTIONS.CLEAR_ALL) {
      return normalizeEntry({
        kind: 'manual',
        rights: [],
        associations: {},
      });
    }

    if (action === ACTIONS.RESTORE_ALL) {
      return normalizeEntry(defaultEntry || {
        kind: 'automatic',
        rights: [],
        associations: {},
      });
    }

    if (action === ACTIONS.GRANT_ALL) {
      return normalizeEntry({
        kind: 'manual',
        rights: ['read', 'write', 'health'],
        associations: {},
      });
    }

    throw new Error(`Unknown action: ${action}`);
  }

  async function applyActionViaUi(row, action, report) {
    const userId = getUserIdFromRow(row);
    const beforePrivacy = getPrivacyObject() || {};
    const beforeEntry = normalizeEntry(beforePrivacy[userId]);
    const dom = getRootStateFromDom(row);

    if (action === ACTIONS.CLEAR_ALL) {
      if (dom.read) {
        const input = getRootCheckbox(row, 'read');
        const changed = await clickAndWaitForChange(input, userId, beforeEntry);
        report.uiClicks += changed ? 1 : 0;
        return;
      }

      if (dom.write) {
        const input = getRootCheckbox(row, 'write');
        const changed = await clickAndWaitForChange(input, userId, beforeEntry);
        report.uiClicks += changed ? 1 : 0;
        return;
      }

      if (dom.health) {
        const input = getRootCheckbox(row, 'health');
        const changed = await clickAndWaitForChange(input, userId, beforeEntry);
        report.uiClicks += changed ? 1 : 0;
      }
      return;
    }

    if (action === ACTIONS.RESTORE_ALL) {
      const restore = getRestoreLink(row);
      if (restore) {
        const prev = normalizeEntry((getPrivacyObject() || {})[userId]);
        restore.click();
        const changed = await waitFor(() => {
          const next = normalizeEntry((getPrivacyObject() || {})[userId]);
          return !entriesEqual(prev, next);
        }, 1800, 50);

        report.uiClicks += changed ? 1 : 0;
      }
      return;
    }

    if (action === ACTIONS.GRANT_ALL) {
      if (!dom.read) {
        const prev = normalizeEntry((getPrivacyObject() || {})[userId]);
        const input = getRootCheckbox(row, 'read');
        const changed = await clickAndWaitForChange(input, userId, prev);
        report.uiClicks += changed ? 1 : 0;
      }

      if (!getRootCheckbox(row, 'write')?.checked) {
        const prev = normalizeEntry((getPrivacyObject() || {})[userId]);
        const input = getRootCheckbox(row, 'write');
        const changed = await clickAndWaitForChange(input, userId, prev);
        report.uiClicks += changed ? 1 : 0;
      }

      if (!getRootCheckbox(row, 'health')?.checked) {
        const prev = normalizeEntry((getPrivacyObject() || {})[userId]);
        const input = getRootCheckbox(row, 'health');
        const changed = await clickAndWaitForChange(input, userId, prev);
        report.uiClicks += changed ? 1 : 0;
      }
    }
  }

  function forceHiddenEntry(userId, desiredEntry) {
    const privacy = getPrivacyObject() || {};
    privacy[userId] = clone(normalizeEntry(desiredEntry));
    setPrivacyObject(privacy);
  }

  async function processRow(row, action, page, index, pageCount, report, defaultPrivacy) {
    const userId = getUserIdFromRow(row);
    const userName = getUserNameFromRow(row);
    const totalRowsOnPage = getRows().length;

    updateStatus(
      `Stránka ${page}/${pageCount} · uživatel ${index + 1}/${totalRowsOnPage} · ${userName}`,
      'info'
    );

    if (!userId) {
      report.failed.push({ page, userName, reason: 'Chybí userId v row.id' });
      return;
    }

    const readInput = getRootCheckbox(row, 'read');
    const writeInput = getRootCheckbox(row, 'write');
    const healthInput = getRootCheckbox(row, 'health');
    const isLocked = [readInput, writeInput, healthInput].every((i) => i && i.disabled);

    const currentPrivacy = getPrivacyObject() || {};
    const currentEntry = normalizeEntry(currentPrivacy[userId]);
    const defaultEntry = normalizeEntry(defaultPrivacy[userId]);
    const desiredEntry = desiredEntryForAction(action, defaultEntry);

    if (isLocked) {
      report.skippedLocked.push({ page, userId, userName });
      return;
    }

    if (entriesEqual(currentEntry, desiredEntry)) {
      syncRowCheckboxes(row, desiredEntry);
      report.unchanged.push({ page, userId, userName });
      return;
    }

    await applyActionViaUi(row, action, report);

    const afterUiEntry = normalizeEntry((getPrivacyObject() || {})[userId]);

    if (!entriesEqual(afterUiEntry, desiredEntry)) {
      forceHiddenEntry(userId, desiredEntry);
      syncRowCheckboxes(row, desiredEntry);
      report.fallback.push({
        page,
        userId,
        userName,
        before: currentEntry,
        afterUi: afterUiEntry,
        forced: desiredEntry,
      });
    }

    const finalEntry = normalizeEntry((getPrivacyObject() || {})[userId]);

    if (entriesEqual(finalEntry, desiredEntry)) {
      syncRowCheckboxes(row, desiredEntry);
      report.changed.push({
        page,
        userId,
        userName,
        final: finalEntry,
      });
    } else {
      report.failed.push({
        page,
        userId,
        userName,
        reason: 'Finální stav neodpovídá očekávání',
        expected: desiredEntry,
        actual: finalEntry,
      });
    }
  }

  function printReport(report, action, startedAt, finishedAt) {
    console.groupCollapsed(`[TM Privacy Bulk] Report · ${action}`);
    console.log('Start:', startedAt.toISOString());
    console.log('Konec:', finishedAt.toISOString());
    console.log('Trvání (s):', ((finishedAt - startedAt) / 1000).toFixed(2));
    console.log('Souhrn:', {
      changed: report.changed.length,
      unchanged: report.unchanged.length,
      fallback: report.fallback.length,
      skippedLocked: report.skippedLocked.length,
      failed: report.failed.length,
      uiClicks: report.uiClicks,
    });

    if (report.failed.length) console.table(report.failed);
    if (report.fallback.length) console.table(report.fallback);
    if (report.changed.length) console.table(report.changed);
    if (report.skippedLocked.length) console.table(report.skippedLocked);

    console.groupEnd();
  }

  async function runBulkAction(action) {
    if (isRunning) {
      updateStatus('Akce už běží.', 'error');
      return;
    }

    const root = getPrivacyContainer();
    const hidden = getHiddenPrivacyInput();
    const hasPagination = !!(getPageSelect() || getPaginationRoot());

    if (!root || !hidden || !hasPagination) {
      updateStatus('Soukromí není připravené. Otevřete záložku Soukromí.', 'error');
      return;
    }

    if (isSearchActive()) {
      updateStatus('Hromadnou akci nelze spustit, dokud je ve vyhledávání text.', 'error');
      return;
    }

    if (hasOpenAssociationsOnCurrentPage()) {
      updateStatus('Zavřete nejdřív všechny otevřené dropdowny „Přiřazené objekty“.', 'error');
      return;
    }

    isRunning = true;
    const buttons = Array.from(document.querySelectorAll(`#${UI.toolbarId} button`));
    buttons.forEach((b) => (b.disabled = true));

    const startedAt = new Date();
    const originalPage = getCurrentPage();
    const totalPages = getTotalPages();
    const defaultPrivacy = getDefaultPrivacy();

    const report = {
      changed: [],
      unchanged: [],
      fallback: [],
      skippedLocked: [],
      failed: [],
      uiClicks: 0,
    };

    let completedAllPages = true;

    try {
      if (originalPage !== 1) {
        updateStatus(`Přesouvám se na stránku 1/${totalPages}...`);
        const jumpedToFirstPage = await gotoPage(1, {
          preferDirect: true,
          preferSelect: true,
        });

        if (!jumpedToFirstPage) {
          completedAllPages = false;
          report.failed.push({
            page: 1,
            userName: '(stránka)',
            reason: 'Nepodařilo se přejít přímo na stránku 1 před spuštěním akce',
          });
        }
      }

      if (completedAllPages) {
        for (let page = 1; page <= totalPages; page++) {
          const ok = await gotoPage(page, {
            preferDirect: page === 1,
            preferSelect: page === 1,
          });

          if (!ok) {
            completedAllPages = false;
            report.failed.push({
              page,
              userName: '(stránka)',
              reason: `Nepodařilo se přepnout na stránku ${page}`,
            });
            break;
          }

          if (hasOpenAssociationsOnCurrentPage()) {
            completedAllPages = false;
            updateStatus(`Na stránce ${page} jsou otevřené „Přiřazené objekty“. Akce byla zastavena.`, 'error');
            report.failed.push({
              page,
              userName: '(stránka)',
              reason: 'Otevřené přiřazené objekty',
            });
            break;
          }

          const rows = getRows();
          for (let i = 0; i < rows.length; i++) {
            await processRow(rows[i], action, page, i, totalPages, report, defaultPrivacy);
          }
        }
      }

      const targetPageAfterRun = completedAllPages ? 1 : originalPage;

      await gotoPage(targetPageAfterRun, {
        preferDirect: true,
        preferSelect: targetPageAfterRun === 1,
      });

      updateStatus(
        buildFinalStatusHtml(report),
        report.failed.length ? 'error' : 'success',
        { html: true }
      );

      printReport(report, action, startedAt, new Date());
    } catch (error) {
      console.error('[TM Privacy Bulk] Neočekávaná chyba:', error);
      updateStatus(`Neočekávaná chyba: ${error.message}`, 'error');
      try {
        await gotoPage(originalPage, {
          preferDirect: true,
          preferSelect: originalPage === 1,
        });
      } catch (_) {
        // ignore
      }
    } finally {
      isRunning = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function boot() {
    ensureToolbar();

    if (observerStarted) return;
    observerStarted = true;

    const mo = new MutationObserver(() => {
      ensureToolbar();
    });

    mo.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  boot();
})();