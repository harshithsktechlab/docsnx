'use client';

/**
 * `/business/<companyId>/follow-up` — one company's renewals and tasks.
 *
 * The SAME component as `/follow-up`, scoped by the company in the path. Two
 * of the four tabs are absent here, and deliberately: Insurance Gaps and ID
 * Document Gaps say which MEMBER is missing a PAN or has no health cover, which
 * is not a question a company can be asked. The route returns those two lists
 * empty for a company and the page hides the tabs, rather than showing two
 * panes that are permanently empty for a reason nobody can see.
 *
 * Nothing here is a permission — see the sibling `passwords/page.js`.
 */
import FollowUpPage from '@/app/follow-up/page';

export default function BusinessFollowUpPage() {
  return <FollowUpPage />;
}
