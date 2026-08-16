/**
 * Mapping between character offsets and DOM positions.
 *
 * The editor renders the document as a single pre-wrap container, so a
 * character index corresponds to an offset within the concatenated text nodes.
 * That correspondence is what lets us place a remote collaborator's caret by
 * measuring a real Range instead of estimating pixel positions from font
 * metrics.
 */

function textNodesOf(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

export function offsetToDom(
  container: HTMLElement,
  offset: number,
): { node: Text; offset: number } | null {
  const nodes = textNodesOf(container);
  let remaining = offset;
  for (const node of nodes) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : null;
}

/** Current caret offset within the container, or null when it is elsewhere. */
export function getCaretOffset(container: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;

  const probe = range.cloneRange();
  probe.selectNodeContents(container);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length;
}

export function getSelectionRange(
  container: HTMLElement,
): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;

  const probe = range.cloneRange();
  probe.selectNodeContents(container);
  probe.setEnd(range.startContainer, range.startOffset);
  const start = probe.toString().length;
  return { start, end: start + range.toString().length };
}

export function setCaretOffset(container: HTMLElement, offset: number): void {
  const target = offsetToDom(container, Math.max(0, offset));
  if (!target) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(target.node, Math.min(target.offset, target.node.textContent?.length ?? 0));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export interface Box {
  top: number;
  left: number;
  height: number;
  width: number;
}

/** Caret box for a character offset, in coordinates relative to the container. */
export function boxForOffset(container: HTMLElement, offset: number): Box | null {
  const target = offsetToDom(container, offset);
  if (!target) return null;

  const range = document.createRange();
  const nodeLen = target.node.textContent?.length ?? 0;
  const at = Math.min(target.offset, nodeLen);

  // A collapsed range has no dimensions in some engines, so measure one real
  // character and take the appropriate edge.
  if (at < nodeLen) {
    range.setStart(target.node, at);
    range.setEnd(target.node, at + 1);
  } else if (nodeLen > 0) {
    range.setStart(target.node, nodeLen - 1);
    range.setEnd(target.node, nodeLen);
  } else {
    return null;
  }

  const rect = range.getBoundingClientRect();
  const base = container.getBoundingClientRect();
  const atEnd = at >= nodeLen;

  return {
    top: rect.top - base.top + container.scrollTop,
    left: (atEnd ? rect.right : rect.left) - base.left,
    height: rect.height || 20,
    width: rect.width,
  };
}

/** One box per visual line covered by a character range. */
export function boxesForRange(container: HTMLElement, start: number, end: number): Box[] {
  if (end <= start) return [];
  const from = offsetToDom(container, start);
  const to = offsetToDom(container, end);
  if (!from || !to) return [];

  const range = document.createRange();
  range.setStart(from.node, Math.min(from.offset, from.node.textContent?.length ?? 0));
  range.setEnd(to.node, Math.min(to.offset, to.node.textContent?.length ?? 0));

  const base = container.getBoundingClientRect();
  return [...range.getClientRects()].map((rect) => ({
    top: rect.top - base.top + container.scrollTop,
    left: rect.left - base.left,
    height: rect.height,
    width: rect.width,
  }));
}
