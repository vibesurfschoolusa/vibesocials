"use client";

import Link from "next/link";

export default function EngagementPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 mb-4 transition-colors"
          >
            <span>Back to Dashboard</span>
          </Link>
          <h1 className="text-3xl font-bold text-gray-900">Engagement</h1>
          <p className="mt-2 text-gray-600">
            This view is no longer used for monitoring direct messages or comments.
          </p>
        </div>
      </div>
    </div>
  );
}
