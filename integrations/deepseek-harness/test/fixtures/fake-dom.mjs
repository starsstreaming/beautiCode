// A tiny DOM used by readability.test.mjs. It implements exactly the surface
// readability.js needs — documents/elements, data-* datasets, inline styles,
// the selector subset used by the material contracts (`tag`, `[attr]`,
// `[attr="value"]`, `a > b`, comma lists), closest(), and a MutationObserver
// that mirrors attributeFilter/subtree so the production observer wiring is
// exercised rather than bypassed. No layout is computed; getBoundingClientRect
// returns a 100x100 box unless a test pins one.
//
// This is fixture code, not a browser. Browser behavior (computed color-mix,
// backdrop-filter, stacking) lives in plugin-readability.browser.test.mjs.

const SELECTOR_CACHE = new Map();

function kebabCase(name) {
  return String(name).replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function parseCompound(text) {
  const tag = text.startsWith("*") ? "*" : (/^([a-zA-Z][\w-]*)/.exec(text)?.[1]?.toLowerCase() ?? null);
  const attrs = [];
  const pattern = /\[([^\]=~^$*|]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g;
  let match;
  while ((match = pattern.exec(text))) {
    attrs.push({
      name: match[1].trim(),
      operator: match[2] || null,
      value: match[3] ?? match[4] ?? match[5] ?? null,
    });
  }
  return { tag, attrs };
}

/** Parse the fixture's selector subset into a list of child-combinator chains. */
export function parseSelector(selector) {
  const cached = SELECTOR_CACHE.get(selector);
  if (cached) return cached;
  const parsed = String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s*>\s*/).map(parseCompound));
  SELECTOR_CACHE.set(selector, parsed);
  return parsed;
}

function matchesCompound(element, compound) {
  if (!element) return false;
  if (compound.tag && compound.tag !== "*" && element.tagName.toLowerCase() !== compound.tag) return false;
  for (const { name, operator, value } of compound.attrs) {
    if (!element.hasAttribute(name)) return false;
    if (operator == null) continue;
    const actual = element.getAttribute(name);
    if (operator === "=" && actual !== value) return false;
    if (operator === "^=" && !actual.startsWith(value)) return false;
    if (operator === "$=" && !actual.endsWith(value)) return false;
    if (operator === "*=" && !actual.includes(value)) return false;
  }
  return true;
}

/** `a > b` means: match b here, match a on the immediate parent. */
function matchesChain(element, chain) {
  let node = element;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!matchesCompound(node, chain[index])) return false;
    node = node.parentElement;
  }
  return true;
}

function matchesAny(element, chains) {
  return chains.some((chain) => matchesChain(element, chain));
}

function isAncestor(ancestor, node) {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    if (current === ancestor) return true;
  }
  return false;
}

class FakeStyle {
  constructor() {
    this.values = new Map();
    this.writes = [];
  }

  setProperty(name, value) {
    this.writes.push(["set", name, String(value)]);
    this.values.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.values.get(name) ?? "";
  }

  removeProperty(name) {
    this.writes.push(["remove", name]);
    const value = this.values.get(name) ?? "";
    this.values.delete(name);
    return value;
  }

  get cssText() {
    return [...this.values].map(([name, value]) => `${name}:${value}`).join(";");
  }

  set cssText(text) {
    this.values.clear();
    for (const part of String(text).split(";")) {
      const index = part.indexOf(":");
      if (index > 0) this.values.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
  }
}

class FakeDataset {
  constructor(element) {
    return new Proxy(this, {
      get(target, prop) {
        if (typeof prop !== "string" || prop.startsWith("__")) return undefined;
        return element.attributes.get(`data-${kebabCase(prop)}`);
      },
      set(target, prop, value) {
        element.setAttribute(`data-${kebabCase(prop)}`, value);
        return true;
      },
      deleteProperty(target, prop) {
        element.removeAttribute(`data-${kebabCase(prop)}`);
        return true;
      },
      has(target, prop) {
        return typeof prop === "string" && element.attributes.has(`data-${kebabCase(prop)}`);
      },
    });
  }
}

export class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument ?? null;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.style = new FakeStyle();
    this.dataset = new FakeDataset(this);
    this._text = "";
    this._rect = null;
  }

  get id() {
    return this.attributes.get("id") ?? "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  get hidden() {
    return this.hasAttribute("hidden");
  }

  set hidden(value) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
  }

  get childNodes() {
    return this.children;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    const text = String(value);
    if (this.attributes.get(name) === text) return;
    this.attributes.set(name, text);
    this.ownerDocument?.notify({ type: "attributes", target: this, attributeName: name });
  }

  removeAttribute(name) {
    if (!this.attributes.has(name)) return;
    this.attributes.delete(name);
    this.ownerDocument?.notify({ type: "attributes", target: this, attributeName: name });
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    if (node.parentElement) node.parentElement.removeChild(node);
    node.parentElement = this;
    node.ownerDocument = this.ownerDocument;
    this.children.push(node);
    this.ownerDocument?.notify({ type: "childList", target: this, addedNodes: [node], removedNodes: [] });
    return node;
  }

  insertBefore(node, reference) {
    if (node.parentElement) node.parentElement.removeChild(node);
    node.parentElement = this;
    node.ownerDocument = this.ownerDocument;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    this.ownerDocument?.notify({ type: "childList", target: this, addedNodes: [node], removedNodes: [] });
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index < 0) return null;
    this.children.splice(index, 1);
    node.parentElement = null;
    this.ownerDocument?.notify({ type: "childList", target: this, addedNodes: [], removedNodes: [node] });
    return node;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  matches(selector) {
    return matchesAny(this, parseSelector(selector));
  }

  closest(selector) {
    const chains = parseSelector(selector);
    for (let node = this; node; node = node.parentElement) {
      if (matchesAny(node, chains)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const chains = parseSelector(selector);
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesAny(child, chains)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    return this._rect ?? {
      x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100,
    };
  }

  /** Pin a layout box; {width: 0, height: 0} models a hidden host surface. */
  setRect(width, height) {
    this._rect = { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height };
  }
}

export class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.records = [];
    this.target = null;
    this.options = null;
  }

  observe(target, options = {}) {
    this.target = target;
    this.options = options;
    target.ownerDocument?.observers.add(this);
  }

  disconnect() {
    this.target?.ownerDocument?.observers.delete(this);
    this.target = null;
  }

  enqueue(mutation) {
    const options = this.options;
    if (!options) return;
    if (mutation.type === "attributes" && !options.attributes) return;
    if (mutation.type === "childList" && !options.childList) return;
    if (mutation.type === "attributes" && options.attributeFilter
      && !options.attributeFilter.includes(mutation.attributeName)) return;
    if (mutation.target !== this.target
      && !(options.subtree && isAncestor(this.target, mutation.target))) return;
    this.records.push(mutation);
  }

  flush() {
    const records = this.records;
    this.records = [];
    if (records.length) this.callback(records, this);
  }
}

export class FakeDocument {
  constructor({ active = false } = {}) {
    this.observers = new Set();
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.append(this.head, this.body);
    if (active) this.documentElement.dataset.bcActive = "true";
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  notify(mutation) {
    for (const observer of this.observers) observer.enqueue(mutation);
  }

  /** Deliver queued records; readability coalesces the scan into a timer. */
  flushObservers() {
    for (const observer of this.observers) observer.flush();
  }
}

/** Create an element with attributes (`id` and `hidden` are real properties). */
export function element(document, tagName, attributes = {}, children = []) {
  const node = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "id") node.id = value;
    else if (name === "hidden") node.hidden = Boolean(value);
    else node.setAttribute(name, value);
  }
  for (const child of children) node.append(child);
  return node;
}
