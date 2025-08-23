'use strict';

/**
 * UI helpers only: status, clear, copy, download, stats
 * Loaded BEFORE graph-logic.js
 */

window.fullGraph = window.fullGraph || {};
window.reverseGraph = window.reverseGraph || {};
window.lastDirection = window.lastDirection || 'downstream';

function showStatus(message, type) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = message || '';
  el.className = `status ${type || ''}`;
  el.style.display = message ? 'block' : 'none';
}

function clearResults() {
  const container = document.getElementById('graphviz-container');
  if (container) {
    container.innerHTML = '<div style="text-align:center; padding:50px; color:#666;">Enter a model and run traversal</div>';
  }
  const out = document.getElementById('dotOutput');
  if (out) out.value = '';
  showStatus('Results cleared', 'success');
}

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
  // Match graph-logic.js original naming to avoid behavior change
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

/* Expose to window for inline handlers and graph-logic.js */
window.showStatus = showStatus;
window.clearResults = clearResults;
window.copyDotFormat = copyDotFormat;
window.downloadDotFile = downloadDotFile;
window.showGraphStats = showGraphStats;
