/**
 * Cache tags. The backend emits them in revalidation webhooks; the frontend
 * mirrors this file in frontend/lib/cache-tags.ts and tags cached fetches with them.
 */
export const TAGS = {
  theme: "theme",
  site: "site",
  navigation: "navigation",
  categories: "categories",
  brands: "brands",
  banners: "banners",
  products: "products",
  product: (slug: string) => `product:${slug}`,
  page: (slug: string) => `page:${slug}`,
  pages: "pages",
  filters: "filters",
  promotions: "promotions",
  shipping: "shipping",
} as const;
