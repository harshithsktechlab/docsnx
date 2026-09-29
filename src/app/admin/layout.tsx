import { redirect } from "next/navigation";
import { getUserFromRequest } from "../../lib/auth";


export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // @ts-ignore - Mock request since getUserFromRequest only reads from next/headers cookies()
  const user = await getUserFromRequest(new Request("http://localhost"));
  
  if (!user || user.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  return (
    <div className="w-full">
      {children}
    </div>
  );
}
