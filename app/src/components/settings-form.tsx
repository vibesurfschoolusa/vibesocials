"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@prisma/client";

interface SettingsFormProps {
  user: User;
}

export function SettingsForm({ user }: SettingsFormProps) {
  const router = useRouter();
  const [companyWebsite, setCompanyWebsite] = useState(user.companyWebsite || "");
  const [defaultHashtags, setDefaultHashtags] = useState(user.defaultHashtags || "");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyWebsite: companyWebsite.trim(),
          defaultHashtags: defaultHashtags.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to update settings");
      }

      setMessage("Settings saved successfully!");
      router.refresh();
    } catch (error) {
      setMessage("Failed to save settings. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const previewCaption = () => {
    const sampleCaption = "Check out this amazing content!";
    const footer = [];
    
    if (companyWebsite.trim()) {
      footer.push(`For more info visit ${companyWebsite.trim()}`);
    }
    
    if (defaultHashtags.trim()) {
      footer.push(defaultHashtags.trim());
    }
    
    if (footer.length === 0) {
      return sampleCaption;
    }
    
    return `${sampleCaption}\n\n${footer.join('\n')}`;
  };

  return (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="companyWebsite" className="block text-sm font-medium text-gray-700 mb-2">
            Company Website
          </label>
          <input
            type="text"
            id="companyWebsite"
            placeholder="www.example.com"
            value={companyWebsite}
            onChange={(e) => setCompanyWebsite(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-sm text-gray-500">
            This will be appended to all your captions as: "For more info visit [your website]"
          </p>
        </div>

        <div>
          <label htmlFor="defaultHashtags" className="block text-sm font-medium text-gray-700 mb-2">
            Default Hashtags
          </label>
          <textarea
            id="defaultHashtags"
            placeholder="#YourBrand #YourIndustry #YourLocation"
            value={defaultHashtags}
            onChange={(e) => setDefaultHashtags(e.target.value)}
            rows={3}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-sm text-gray-500">
            These hashtags will be added on a new line after your website
          </p>
        </div>

        {/* Preview */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Preview</h3>
          <div className="text-sm text-gray-600 whitespace-pre-wrap border-l-4 border-blue-500 pl-4">
            {previewCaption()}
          </div>
        </div>

        {message && (
          <div
            className={`p-4 rounded-lg ${
              message.includes("success")
                ? "bg-green-50 text-green-800"
                : "bg-red-50 text-red-800"
            }`}
          >
            {message}
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-teal-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-teal-700 transition disabled:opacity-50"
        >
          {isLoading ? "Saving..." : "Save Settings"}
        </button>
      </form>
    </div>
  );
}
