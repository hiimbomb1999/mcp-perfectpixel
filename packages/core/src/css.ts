/**
 * CSS selector helpers: cascade specificity and the "key" (last compound's
 * tag/class/id) used to bucket selectors for cheap candidate matching.
 */
import * as csstree from 'css-tree';

export interface Specificity {
  a: number; // id selectors
  b: number; // class / attribute / pseudo-class selectors
  c: number; // type / pseudo-element selectors
}

export interface SelectorKey {
  tags: string[];
  classes: string[];
  ids: string[];
}

/** Compare two specificities: >0 when x is more specific. */
export function compareSpecificity(x: Specificity, y: Specificity): number {
  if (x.a !== y.a) return x.a - y.a;
  if (x.b !== y.b) return x.b - y.b;
  return x.c - y.c;
}

function specificityOfOne(selector: csstree.CssNode): Specificity {
  const s: Specificity = { a: 0, b: 0, c: 0 };
  csstree.walk(selector, {
    enter(node: csstree.CssNode) {
      switch (node.type) {
        case 'IdSelector':
          s.a++;
          break;
        case 'ClassSelector':
        case 'AttributeSelector':
          s.b++;
          break;
        case 'PseudoClassSelector':
          // :where() has zero specificity; the others count as a class.
          if (node.name !== 'where') s.b++;
          break;
        case 'TypeSelector':
          if (node.name !== '*') s.c++;
          break;
        case 'PseudoElementSelector':
          s.c++;
          break;
        default:
          break;
      }
    },
  });
  return s;
}

/**
 * Specificity of a selector list (`a, b, c`). When a rule has several
 * selectors, the cascade uses the specificity of the one that matched, which
 * we don't know here — take the maximum (safe for patch ranking).
 * Note: the specificity of `:is()`/`:not()`/`:has()` arguments is counted as
 * a sum rather than the spec's max — a conservative approximation.
 */
export function specificityOf(selector: string): Specificity {
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(selector, { context: 'selectorList' });
  } catch {
    return { a: 0, b: 0, c: 0 };
  }
  let best: Specificity = { a: 0, b: 0, c: 0 };
  csstree.walk(ast, {
    visit: 'Selector',
    enter(node: csstree.CssNode) {
      const s = specificityOfOne(node);
      if (compareSpecificity(s, best) > 0) best = s;
    },
  });
  return best;
}

/**
 * The "key" of a selector: the tag/class/id of its last compound (the part
 * that must match the element itself). Selectors sharing a key with an
 * element are the only ones that could match it, which lets us avoid calling
 * `element.matches()` for every rule in huge stylesheets (Tailwind, ...).
 */
export function selectorKeyOf(selector: string): SelectorKey {
  const key: SelectorKey = { tags: [], classes: [], ids: [] };
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(selector, { context: 'selectorList' });
  } catch {
    return key;
  }
  // css-tree v3 flattens compounds: a Selector's children are a flat list of
  // simple selectors separated by Combinators. The "last compound" is the run
  // of simple selectors after the last Combinator.
  const childrenOf = (node: csstree.CssNode): Array<{ type: string; name?: string }> => {
    const sel = node as unknown as {
      children?: { forEach(cb: (n: csstree.CssNode) => void): void };
    };
    const out: Array<{ type: string; name?: string }> = [];
    sel.children?.forEach((child) => out.push(child as { type: string; name?: string }));
    return out;
  };
  csstree.walk(ast, {
    visit: 'Selector',
    enter(node: csstree.CssNode) {
      const children = childrenOf(node);
      let lastCombinatorIdx = -1;
      for (let i = 0; i < children.length; i++) {
        if (children[i]!.type === 'Combinator') lastCombinatorIdx = i;
      }
      for (let i = lastCombinatorIdx + 1; i < children.length; i++) {
        const child = children[i]!;
        if (child.type === 'ClassSelector') key.classes.push(child.name ?? '');
        else if (child.type === 'IdSelector') key.ids.push(child.name ?? '');
        else if (child.type === 'TypeSelector' && child.name && child.name !== '*') {
          key.tags.push(child.name);
        }
      }
    },
  });
  key.tags = [...new Set(key.tags.filter(Boolean))];
  key.classes = [...new Set(key.classes.filter(Boolean))];
  key.ids = [...new Set(key.ids.filter(Boolean))];
  return key;
}

/** All key strings (tag, .class, #id) of an element. */
export function elementKeys(tag: string, classes: string[], id: string | null): string[] {
  const keys = [tag];
  for (const c of classes) keys.push(`.${c}`);
  if (id) keys.push(`#${id}`);
  return keys;
}
