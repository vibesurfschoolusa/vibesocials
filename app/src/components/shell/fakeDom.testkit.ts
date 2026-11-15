/**
 * A tiny fake DOM for mounting real React trees with react-dom/client in
 * vitest's node environment (no DOM library in this repo): just what React's
 * commit uses to create, insert, update and remove nodes. Test support only.
 */
export type FakeNode = {
  nodeType: number;
  nodeName: string;
  childNodes: FakeNode[];
  parentNode: FakeNode | null;
  attributes: Record<string, string>;
  nodeValue: string | null;
  appendChild(child: FakeNode): FakeNode;
  [key: string]: unknown;
};

export function makeDocument() {
  const doc: Record<string, unknown> = {};
  const node = (nodeType: number, nodeName: string): FakeNode => {
    const self: FakeNode = {
      nodeType,
      nodeName,
      tagName: nodeName,
      childNodes: [],
      parentNode: null,
      attributes: {},
      nodeValue: null,
      ownerDocument: doc,
      namespaceURI: "http://www.w3.org/1999/xhtml",
      style: { setProperty() {}, removeProperty() {} },
      addEventListener() {},
      removeEventListener() {},
      setAttribute(name: string, value: string) {
        self.attributes[name] = String(value);
      },
      setAttributeNS(_ns: string, name: string, value: string) {
        self.attributes[name] = String(value);
      },
      removeAttribute(name: string) {
        delete self.attributes[name];
      },
      getAttribute(name: string) {
        return self.attributes[name] ?? null;
      },
      hasAttribute(name: string) {
        return name in self.attributes;
      },
      appendChild(child: FakeNode) {
        if (child.parentNode) (child.parentNode.removeChild as (c: FakeNode) => void)(child);
        child.parentNode = self;
        self.childNodes.push(child);
        return child;
      },
      insertBefore(child: FakeNode, before: FakeNode | null) {
        if (child.parentNode) (child.parentNode.removeChild as (c: FakeNode) => void)(child);
        child.parentNode = self;
        const index = before ? self.childNodes.indexOf(before) : -1;
        if (index < 0) self.childNodes.push(child);
        else self.childNodes.splice(index, 0, child);
        return child;
      },
      removeChild(child: FakeNode) {
        self.childNodes = self.childNodes.filter((c) => c !== child);
        child.parentNode = null;
        return child;
      },
      contains(other: FakeNode | null) {
        for (let n: FakeNode | null = other; n; n = n.parentNode) if (n === self) return true;
        return false;
      },
    };
    Object.defineProperty(self, "firstChild", { get: () => self.childNodes[0] ?? null });
    Object.defineProperty(self, "textContent", {
      get: (): string => (self.nodeType === 3 ? (self.nodeValue ?? "") : self.childNodes.map((c) => c.textContent as string).join("")),
      set: (value: string) => {
        if (self.nodeType === 3) self.nodeValue = value;
        else {
          self.childNodes = [];
          if (value) self.appendChild(Object.assign(node(3, "#text"), { nodeValue: value }));
        }
      },
    });
    return self;
  };
  const body = node(1, "BODY");
  const html = node(1, "HTML");
  html.appendChild(body);
  class HTMLIFrameElement {}
  Object.assign(doc, {
    nodeType: 9,
    nodeName: "#document",
    body,
    documentElement: html,
    activeElement: body,
    defaultView: { HTMLIFrameElement, document: doc },
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag: string) => node(1, tag.toUpperCase()),
    createElementNS: (ns: string, tag: string) => Object.assign(node(1, tag), { namespaceURI: ns }),
    createTextNode: (text: string) => Object.assign(node(3, "#text"), { nodeValue: text }),
  });
  const container = node(1, "DIV");
  body.appendChild(container);
  return { container, doc };
}

/** Serialises the fake tree as rough HTML so tests can look for markup. */
export function html(n: FakeNode): string {
  if (n.nodeType === 3) return n.nodeValue ?? "";
  const tag = n.nodeName.toLowerCase();
  const attrs = Object.entries(n.attributes).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${tag}${attrs}>${n.childNodes.map(html).join("")}</${tag}>`;
}
