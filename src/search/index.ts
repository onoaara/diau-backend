import { postgresSearch } from "./postgres";
import type { SearchProvider } from "./types";

/** The active search provider. Swap the implementation here. */
export const search: SearchProvider = postgresSearch;

export type * from "./types";
