import { SQL, sql, ilike, or, asc, desc } from 'drizzle-orm';

export interface PaginationParams {
  page: number;
  limit: number;
  search: string;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  filters: Record<string, string>;
}

export function parseQueryParams(req: Request): PaginationParams {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = parseInt(url.searchParams.get('limit') || '10', 10);
  const search = url.searchParams.get('search') || '';
  const sortBy = url.searchParams.get('sortBy') || 'createdAt';
  const sortOrder = (url.searchParams.get('sortOrder') || 'desc') as 'asc' | 'desc';
  
  const filters: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    if (!['page', 'limit', 'search', 'sortBy', 'sortOrder'].includes(key)) {
      if(value !== '') {
        filters[key] = value;
      }
    }
  });

  return { page: page > 0 ? page : 1, limit: limit > 0 ? limit : 10, search, sortBy, sortOrder, filters };
}

export function buildListQueryHelper<T extends Record<string, any>>(
  table: T,
  params: PaginationParams,
  searchableColumns: any[]
): {
  limit: number;
  offset: number;
  orderBy: any;
  searchFilter: SQL<unknown> | undefined;
} {
  const { page, limit, search, sortBy, sortOrder } = params;
  const offset = (page - 1) * limit;

  // Build sorting
  const sortColumn = table[sortBy as keyof typeof table] || table.createdAt;
  const orderBy = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);

  // Build searching (ilike across all provided searchable columns)
  let searchFilter: SQL<unknown> | undefined = undefined;
  if (search && searchableColumns.length > 0) {
    const conditions = searchableColumns.map(col => ilike(col, `%${search}%`));
    if (conditions.length > 0) {
      searchFilter = or(...conditions);
    }
  }

  return {
    limit,
    offset,
    orderBy,
    searchFilter
  };
}
