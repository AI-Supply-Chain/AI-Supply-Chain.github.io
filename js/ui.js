'use strict';

/**
 * UI helpers only: status, clear, copy, download, stats
 * Loaded BEFORE graph-logic.js
 */

window.fullGraph = window.fullGraph || {};
window.reverseGraph = window.reverseGraph || {};
window.lastDirection = window.lastDirection || 'downstream';

/* -------------------------------
   Status
-------------------------------- */
function showStatus(message, type) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = message || '';
  el.className = `status ${type || ''}`;
  el.style.display = message ? 'block' : 'none';
}
window.showStatus = showStatus;

/* -------------------------------
   Run button enable/disable
-------------------------------- */
function setRunEnabled(on) {
  const btn = document.getElementById('runBtn');
  if (!btn) return;
  btn.disabled = !on;
  btn.style.opacity = on ? '1' : '0.55';
  btn.style.cursor = on ? 'pointer' : 'not-allowed';
}
window.setRunEnabled = setRunEnabled;

/* Enable/disable Run based on typing */
window.addEventListener('DOMContentLoaded', () => {
  const typeInput = document.getElementById('startNodeTypeahead');
  if (!typeInput) return;

  // initial: if empty, disable Run
  setRunEnabled(!!typeInput.value.trim());

  typeInput.addEventListener('input', () => {
    const hasText = !!typeInput.value.trim();
    setRunEnabled(hasText); // you can require "Select" click if you prefer
  });
});

/* -------------------------------
   Clear workflow (rewritten)
-------------------------------- */
function clearResults() {
  try {
    // 1) Cancel any current traversal
    if (typeof window.cancelCurrentRun === 'function') {
      window.cancelCurrentRun();
    }

    // 2) Reset model inputs and datalist
    const typeInput = document.getElementById('startNodeTypeahead');
    const startField = document.getElementById('startNode'); // hidden
    const datalist = document.getElementById('modelOptions');

    if (typeInput) typeInput.value = '';
    if (startField) startField.value = '';
    if (datalist) datalist.innerHTML = '';

    // 3) Reset visualization surface
    if (typeof window.resetVisualization === 'function') {
      window.resetVisualization();
    } else {
      // fallback
      const container = document.getElementById('graphviz-container');
      if (container) container.innerHTML = '<div class="placeholder">Pick a model and click <em>Run Traversal</em></div>';
    }

    // 4) Clear DOT output
    const out = document.getElementById('dotOutput');
    if (out) out.value = '';

    // 5) Disable Run until a model is picked again
    setRunEnabled(false);

    // 6) Status + focus
    showStatus('Cleared. Pick a model to run a new traversal.', 'success');
    if (typeInput) typeInput.focus();
  } catch (e) {
    console.error(e);
    showStatus('Clear failed: ' + e.message, 'error');
  }
}
window.clearResults = clearResults;

/* -------------------------------
   Copy / Download / Stats
-------------------------------- */
async function copyDotFormat() {
  const ta = document.getElementById('dotOutput');
  if (!ta || !ta.value) {
    showStatus('No content to copy', 'error');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(ta.value);
    } else {
      ta.select();
      document.execCommand('copy');
    }
    showStatus('DOT copied to clipboard', 'success');
  } catch (e) {
    console.error(e);
    showStatus(`Copy failed: ${e.message}`, 'error');
  }
}
window.copyDotFormat = copyDotFormat;

function downloadDotFile() {
  const text = document.getElementById('dotOutput')?.value || '';
  if (!text) {
    showStatus('No traversal results to download', 'error');
    return;
  }

  const modelSafe = (document.getElementById('startNode')?.value || 'model')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '_');

  const algo = document.getElementById('algorithm')?.value; // 'DFS' or 'BFS'
  const filename = (algo === 'DFS')
    ? `Forward_analysis_of_${modelSafe}.dot`
    : `Backward_analysis_of_${modelSafe}.dot`;

  const blob = new Blob([text], { type: 'text/plain' });
  const link = document.createElement('a');
  link.download = filename;
  link.href = window.URL.createObjectURL(blob);
  link.click();
  window.URL.revokeObjectURL(link.href);

  showStatus(`Saved: ${filename}`, 'success');
}
window.downloadDotFile = downloadDotFile;

function showGraphStats() {
  const nodeCount = Object.keys(window.fullGraph || {}).length;
  const reverseNodeCount = Object.keys(window.reverseGraph || {}).length;
  const edgeCount = Object.values(window.fullGraph || {}).reduce(
    (s, nbrs) => s + (nbrs?.length || 0),
    0
  );
  const sampleNodes = Object.keys(window.fullGraph || {}).slice(0, 10);

  const stats = [
    'Graph Statistics:',
    `• Forward graph nodes: ${nodeCount}`,
    `• Reverse graph nodes: ${reverseNodeCount}`,
    `• Total edges: ${edgeCount}`,
    `• Sample nodes: ${sampleNodes.join(', ')}${sampleNodes.length < nodeCount ? '…' : ''}`
  ].join('\n');

  alert(stats);
  showStatus(
    `Graph: ${nodeCount} nodes, ${reverseNodeCount} reverse nodes, ${edgeCount} edges`,
    'success'
  );
}
window.showGraphStats = showGraphStats;
