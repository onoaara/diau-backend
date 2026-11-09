/**
 * Search abstraction. Routes depend on this interface only, so Postgres FTS can be
 * swapped for Meilisearch/Typesense/Algolia without touching the HTTP layer.
 * `search()` (results page with facets) joins this interface in phase 5.
 */
export type SuggestQuery = {
  q: string;
  /** Category slug; results are limited to it and its descendants. */
  category?: string;
  limit?: number;
};

export type ProductSuggestion = {
  id: string;
  title: string;
  slug: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  image: { url: string; alt: string } | null;
};

export type CategorySuggestion = { id: string; name: string; slug: string; parentName: string | null };

export type Suggestions = { products: ProductSuggestion[]; categories: CategorySuggestion[] };

export interface SearchProvider {
  suggest(query: SuggestQuery): Promise<Suggestions>;
}
