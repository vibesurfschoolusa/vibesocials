"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function LinkedInSetupDialog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const showSetup = searchParams.get("linkedin_setup") === "true";
  
  const [vanityName, setVanityName] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);

  if (!showSetup) return null;

  const handleConnect = () => {
    if (!vanityName.trim()) {
      alert("Please enter your LinkedIn company page URL or vanity name");
      return;
    }

    // Extract vanity name/ID from full URL if user pasted the whole URL
    let cleanVanityName = vanityName.trim();
    
    // Handle various URL formats:
    // https://www.linkedin.com/company/vibe-surf-school-usa/
    // https://www.linkedin.com/company/82188987/
    // https://linkedin.com/company/vibe-surf-school-usa
    // linkedin.com/company/82188987
    // vibe-surf-school-usa
    // 82188987
    
    if (cleanVanityName.includes("linkedin.com/company/")) {
      const match = cleanVanityName.match(/linkedin\.com\/company\/([^/?#]+)/);
      if (match) {
        cleanVanityName = match[1];
      }
    }

    // Remove any trailing slashes
    cleanVanityName = cleanVanityName.replace(/\/$/, "");
    
    // Only lowercase if it's NOT a numeric ID (preserve case for numeric IDs)
    const isNumericId = /^\d+$/.test(cleanVanityName);
    if (!isNumericId) {
      cleanVanityName = cleanVanityName.toLowerCase();
      // Replace spaces with hyphens for vanity names
      cleanVanityName = cleanVanityName.replace(/\s+/g, "-");
    }
    
    console.log("[LinkedIn Setup] Extracted identifier:", cleanVanityName, "isNumeric:", isNumericId);
    
    setIsConnecting(true);
    
    // Redirect to LinkedIn OAuth start with vanity name/ID as query parameter
    window.location.href = `/api/auth/linkedin/start?vanity_name=${encodeURIComponent(cleanVanityName)}`;
  };

  const handleCancel = () => {
    router.push("/settings");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-lg w-full mx-4">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          LinkedIn Company Page Setup
        </h2>
        <p className="text-sm text-gray-600 mb-6">
          We need your LinkedIn company page URL to complete the connection.
        </p>

        <div className="bg-blue-50 border-l-4 border-blue-500 p-4 mb-6">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm text-blue-800">
                <strong>Note:</strong> This app posts ONLY to LinkedIn company pages, not personal profiles. 
                You must be an administrator of the company page.
              </p>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <label htmlFor="vanity-name" className="block text-sm font-medium text-gray-700 mb-2">
            LinkedIn Company Page URL
          </label>
          <input
            id="vanity-name"
            type="text"
            value={vanityName}
            onChange={(e) => setVanityName(e.target.value)}
            placeholder="e.g., https://www.linkedin.com/company/vibe-surf-school-usa"
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all text-sm text-gray-900 placeholder:text-gray-400"
            disabled={isConnecting}
          />
          <p className="mt-2 text-xs text-gray-500">
            You can paste the full URL (with name or number), e.g., "https://www.linkedin.com/company/82188987"
          </p>
        </div>

        <div className="bg-gray-50 rounded-lg p-4 mb-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">
            How to find your company page URL:
          </h3>
          <ol className="text-sm text-gray-700 space-y-1 list-decimal list-inside">
            <li>Go to LinkedIn and visit your company page</li>
            <li>Copy the URL from your browser's address bar</li>
            <li>Paste it here (e.g., linkedin.com/company/your-company-name)</li>
          </ol>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleCancel}
            disabled={isConnecting}
            className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            disabled={isConnecting}
            className="flex-1 px-4 py-3 bg-gradient-to-r from-blue-600 to-blue-700 rounded-lg text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isConnecting ? "Connecting..." : "Continue to LinkedIn"}
          </button>
        </div>
      </div>
    </div>
  );
}
