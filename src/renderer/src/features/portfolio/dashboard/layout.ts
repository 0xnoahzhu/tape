// The dashboard's widget layout (pure): which widgets show, in which order, and how many of the
// grid's three columns each spans. Persisted per device by layoutStore.ts.

export const WIDGET_IDS = ['eq', 'alloc', 'margin', 'greeks', 'conc', 'contrib', 'expiry', 'fills', 'events', 'bench'] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

/** Columns a widget spans in the 3-column grid: S, M, L (full row). */
export type Span = 1 | 2 | 3;
export const SPANS: readonly Span[] = [1, 2, 3];

export interface LayoutItem {
  id: WidgetId;
  span: Span;
}

export type Layout = LayoutItem[];

export interface CatalogEntry {
  id: WidgetId;
  /** Span when added (and in the default layout). */
  span: Span;
  /** Needs a market data subscription at IB (earnings: Wall Street Horizon). */
  subscription?: boolean;
}

/** Every widget in the default order (the design's catalog). */
export const CATALOG: readonly CatalogEntry[] = [
  { id: 'eq', span: 2 },
  { id: 'alloc', span: 1 },
  { id: 'margin', span: 1 },
  { id: 'greeks', span: 1 },
  { id: 'conc', span: 1 },
  { id: 'contrib', span: 2 },
  { id: 'expiry', span: 1 },
  { id: 'fills', span: 1 },
  { id: 'events', span: 1, subscription: true },
  { id: 'bench', span: 1 },
];

const DEFAULT_SPAN = new Map<WidgetId, Span>(CATALOG.map((c) => [c.id, c.span]));

export const defaultSpan = (id: WidgetId): Span => DEFAULT_SPAN.get(id) ?? 1;

/** All ten widgets at their default spans: 4 rows (eq+alloc | margin+greeks+conc | contrib+expiry | fills+events+bench). */
export function defaultLayout(): Layout {
  return CATALOG.map(({ id, span }) => ({ id, span }));
}

export const isWidgetId = (v: unknown): v is WidgetId => typeof v === 'string' && (WIDGET_IDS as readonly string[]).includes(v);
const isSpan = (v: unknown): v is Span => v === 1 || v === 2 || v === 3;

/**
 * A stored layout: an array of { id, span }. Unknown and repeated ids are dropped, a missing or
 * invalid span takes the widget's default. Anything that is not an array is null (use the default
 * layout); an empty array is a valid, empty layout.
 */
export function sanitizeLayout(raw: unknown): Layout | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<WidgetId>();
  const out: Layout = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, span } = item as Record<string, unknown>;
    if (!isWidgetId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, span: isSpan(span) ? span : defaultSpan(id) });
  }
  return out;
}

/**
 * Moves the widget `from` to where the widget `to` is (the design's rule: take the dragged item
 * out, then insert it at the target's index in what is left, i.e. before the target). Unknown ids
 * or the same id leave the layout unchanged.
 */
export function moveWidget(layout: Layout, from: WidgetId, to: WidgetId): Layout {
  if (from === to) return layout;
  const i = layout.findIndex((w) => w.id === from);
  if (i < 0 || !layout.some((w) => w.id === to)) return layout;
  const rest = layout.filter((w) => w.id !== from);
  const j = rest.findIndex((w) => w.id === to);
  return [...rest.slice(0, j), layout[i], ...rest.slice(j)];
}

export function setSpan(layout: Layout, id: WidgetId, span: Span): Layout {
  return layout.some((w) => w.id === id && w.span !== span) ? layout.map((w) => (w.id === id ? { ...w, span } : w)) : layout;
}

export function removeWidget(layout: Layout, id: WidgetId): Layout {
  return layout.some((w) => w.id === id) ? layout.filter((w) => w.id !== id) : layout;
}

/** The catalog's toggle: removes a widget on the layout, or appends it at its default span. */
export function toggleWidget(layout: Layout, id: WidgetId): Layout {
  return layout.some((w) => w.id === id) ? removeWidget(layout, id) : [...layout, { id, span: defaultSpan(id) }];
}

export const hasWidget = (layout: Layout, id: WidgetId): boolean => layout.some((w) => w.id === id);
