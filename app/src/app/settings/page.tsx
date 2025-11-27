import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { SettingsForm } from "@/components/settings-form";
import { ConnectionsSection } from "@/components/connections-section";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/db";

export default async function SettingsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  // Fetch user connections
  const connections = await prisma.socialConnection.findMany({
    where: { userId: user.id },
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-teal-50">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
        <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-blue-600 to-teal-600 bg-clip-text text-transparent">
          Settings
        </h1>
        <p className="text-gray-600 mb-8">
          Configure your default caption footer and manage social platform connections
        </p>

        {/* Caption Settings Section */}
        <div className="mb-8">
          <h2 className="text-xl font-bold text-blue-600 mb-4">Captions Settings</h2>
          <p className="text-sm text-gray-600 mb-4">
            Configure your default caption footer for all posts
          </p>
          <SettingsForm user={user} />
        </div>

        {/* Connections Settings Section */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-blue-600">Connections Settings</h2>
            <Link href="/" className="text-xs text-gray-500 hover:text-gray-700 underline">
              Back to dashboard
            </Link>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Connect your social accounts so Vibe Socials can publish on your behalf
          </p>
          <ConnectionsSection connections={connections} />
        </div>
      </div>
    </div>
  );
}
