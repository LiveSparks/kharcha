import { TRANSFERS } from './model.ts';
import type { Category, CategoryDef } from './model';

// Your categories (schema v9). Pure checks shared by the SQLite ledger and the web
// preview; the writes live next to each store.

export const CATEGORY_NAME_MAX = 30;

export function validateCategoryName(name: string, existing: readonly CategoryDef[]): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Enter a name for the category.');
  if (clean.length > CATEGORY_NAME_MAX) throw new Error(`Keep the name to ${CATEGORY_NAME_MAX} characters.`);
  if (existing.some(c => !c.mergedInto && c.name.toLowerCase() === clean.toLowerCase())) throw new Error(`“${clean}” is already a category.`);
  return clean;
}

export function checkDelete(name: Category, into: Category, existing: readonly CategoryDef[]): void {
  if (name === TRANSFERS) throw new Error('Transfers can’t be deleted: transfers between your accounts use it.');
  if (name === into) throw new Error('Pick a different category to move its transactions to.');
  const live = (n: string) => existing.some(c => c.name === n && !c.mergedInto);
  if (!live(name)) throw new Error('That category is already gone.');
  if (!live(into)) throw new Error('Pick a category that still exists.');
}

export function liveCategories(all: readonly CategoryDef[]): CategoryDef[] {
  return all.filter(c => !c.mergedInto).sort((a, b) => a.position - b.position);
}

// Where a stored category now points: itself, or the category it was merged into.
export function mergeTargets(all: readonly CategoryDef[]): Map<Category, Category> {
  const map = new Map<Category, Category>();
  for (const c of all) if (c.mergedInto) map.set(c.name, c.mergedInto);
  return map;
}
