// One element builder for the panels: a tag, its attributes, its text and its
// handlers in a single call, so panel code reads as the markup it produces.
// `class` and `text` are written as the properties they are, anything starting
// with `on` is assigned as a handler, everything else becomes an attribute.
export const SVG_NS = 'http://www.w3.org/2000/svg';

export function buildElement(document, tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node[key] = value;
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

// The same, for a drawing. SVG needs its own namespace, and `class` there is an
// attribute rather than a property: an SVG element's className cannot be set.
export function buildSvg(document, tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node[key] = value;
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}
