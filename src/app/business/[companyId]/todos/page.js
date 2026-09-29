'use client';

/**
 * `/business/<companyId>/todos` — one company's tasks.
 *
 * The SAME component as `/todos`, scoped by the company in the path. See the
 * sibling `passwords/page.js` for why the id here is not a permission.
 */
import TodosPage from '@/app/todos/page';

export default function BusinessTodosPage() {
  return <TodosPage />;
}
