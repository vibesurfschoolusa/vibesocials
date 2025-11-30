"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, MessageCircle, MessageSquare } from "lucide-react";

type TabKey = "dms" | "comments";

type EngagementPlatform =
  | "tiktok"
  | "youtube"
  | "x"
  | "linkedin"
  | "instagram"
  | "google_business_profile"
  | "facebook_page";

interface DMItem {
  id: string;
  platform: EngagementPlatform;
  contactName: string;
  contactHandle?: string | null;
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  needsResponse: boolean;
}

interface CommentItem {
  id: string;
  platform: EngagementPlatform;
  authorName: string;
  text: string;
  createdAt: string;
  replied: boolean;
  sourceTitle?: string | null;
}

function formatPlatformLabel(platform: EngagementPlatform): string {
  switch (platform) {
    case "tiktok":
      return "TikTok";
    case "youtube":
      return "YouTube";
    case "x":
      return "X";
    case "linkedin":
      return "LinkedIn";
    case "instagram":
      return "Instagram";
    case "google_business_profile":
      return "Google Business Profile";
    case "facebook_page":
      return "Facebook Page";
    default:
      return platform;
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function EngagementPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("dms");
  const [dmItems, setDmItems] = useState<DMItem[]>([]);
  const [commentItems, setCommentItems] = useState<CommentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(
    null,
  );
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replySubmittingId, setReplySubmittingId] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab === "dms" && dmItems.length === 0) {
      void loadDms();
    }
    if (activeTab === "comments" && commentItems.length === 0) {
      void loadComments();
    }
  }, [activeTab, dmItems.length, commentItems.length]);

  async function loadDms() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/engagement/dms");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const message = (data as any)?.error || "Failed to load direct messages";
        throw new Error(message);
      }
      const data = await res.json();
      const items = ((data as any)?.dms ?? []) as DMItem[];
      setDmItems(items);
    } catch (err: any) {
      setError(err.message || "Failed to load direct messages");
    } finally {
      setLoading(false);
    }
  }

  function canReplyToComment(item: CommentItem): boolean {
    return item.platform === "instagram" || item.platform === "facebook_page";
  }

  async function submitCommentReply(item: CommentItem) {
    if (!canReplyToComment(item)) {
      setError("Replies are currently supported for Instagram and Facebook Page comments only.");
      return;
    }

    const text = replyText[item.id]?.trim();
    if (!text) {
      setError("Please enter a reply message.");
      return;
    }

    try {
      setReplySubmittingId(item.id);
      setError(null);

      const res = await fetch("/api/engagement/comments/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          commentId: item.id,
          platform: item.platform,
          message: text,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const message =
          (data as any)?.error ||
          (data as any)?.details ||
          "Failed to post reply";
        throw new Error(message);
      }

      setCommentItems((prev) =>
        prev.map((c) =>
          c.id === item.id
            ? {
                ...c,
                replied: true,
              }
            : c,
        ),
      );

      setReplyingToCommentId(null);
      setReplyText((prev) => ({ ...prev, [item.id]: "" }));
    } catch (err: any) {
      setError(err.message || "Failed to post reply");
    } finally {
      setReplySubmittingId(null);
    }
  }

  async function loadComments() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/engagement/comments");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const message = (data as any)?.error || "Failed to load comments";
        throw new Error(message);
      }
      const data = await res.json();
      const items = ((data as any)?.comments ?? []) as CommentItem[];
      setCommentItems(items);
    } catch (err: any) {
      setError(err.message || "Failed to load comments");
    } finally {
      setLoading(false);
    }
  }

  const sortedDms = [...dmItems].sort((a, b) => {
    if (a.needsResponse !== b.needsResponse) {
      return a.needsResponse ? -1 : 1;
    }
    const aTime = new Date(a.lastMessageAt).getTime();
    const bTime = new Date(b.lastMessageAt).getTime();
    return bTime - aTime;
  });

  const sortedComments = [...commentItems]
    .filter((item) => !item.replied)
    .sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return bTime - aTime;
    });

  const isDms = activeTab === "dms";
  const hasItems = isDms ? sortedDms.length > 0 : sortedComments.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 mb-4 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Dashboard</span>
          </Link>
          <h1 className="text-3xl font-bold text-gray-900">Engagement</h1>
          <p className="mt-2 text-gray-600">
            View and reply to messages and comments from your connected platforms in one place.
          </p>
        </div>

        <div className="mb-6 border-b border-gray-200">
          <nav className="flex gap-4" aria-label="Engagement views">
            <button
              type="button"
              onClick={() => setActiveTab("dms")}
              className={`inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium ${
                isDms
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <MessageCircle className="h-4 w-4" />
              <span>DMs</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("comments")}
              className={`inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium ${
                !isDms
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <MessageSquare className="h-4 w-4" />
              <span>Comments</span>
            </button>
          </nav>
        </div>

        <div className="mb-4 text-xs text-gray-500">
          Last 30 days. Unanswered items are shown first.
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        ) : !hasItems ? (
          <div className="rounded-xl border border-gray-200 bg-white p-12 text-center">
            {isDms ? (
              <>
                <MessageCircle className="h-10 w-10 text-gray-400 mx-auto mb-4" />
                <h2 className="text-lg font-semibold text-gray-900">
                  No messages to review
                </h2>
                <p className="mt-2 text-gray-600">
                  When your connected platforms support message sync, new conversations from the last 30 days will appear here.
                </p>
              </>
            ) : (
              <>
                <MessageSquare className="h-10 w-10 text-gray-400 mx-auto mb-4" />
                <h2 className="text-lg font-semibold text-gray-900">
                  No comments need replies
                </h2>
                <p className="mt-2 text-gray-600">
                  Comments from your recent posts that still need a reply will show up in this view.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {isDms
              ? sortedDms.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-semibold text-white">
                        {item.contactName.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <div className="font-semibold text-gray-900">
                            {item.contactName}
                          </div>
                          {item.contactHandle ? (
                            <div className="text-xs text-gray-500">
                              {item.contactHandle}
                            </div>
                          ) : null}
                          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                            {formatPlatformLabel(item.platform)}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-gray-700 line-clamp-2">
                          {item.lastMessagePreview}
                        </div>
                        <div className="mt-1 text-xs text-gray-400">
                          {formatTimestamp(item.lastMessageAt)}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {item.unreadCount > 0 ? (
                        <span className="inline-flex items-center justify-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                          {item.unreadCount} unread
                        </span>
                      ) : null}
                      {item.needsResponse ? (
                        <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">
                          Needs reply
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Replied</span>
                      )}
                    </div>
                  </div>
                ))
              : sortedComments.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-xs font-semibold text-white">
                          {item.authorName.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-semibold text-gray-900">
                              {item.authorName}
                            </div>
                            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                              {formatPlatformLabel(item.platform)}
                            </span>
                            {item.sourceTitle ? (
                              <span className="text-xs text-gray-500">
                                {item.sourceTitle}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 text-sm text-gray-700 line-clamp-2">
                            {item.text}
                          </div>
                          <div className="mt-1 text-xs text-gray-400">
                            {formatTimestamp(item.createdAt)}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">
                          Needs reply
                        </span>
                        {canReplyToComment(item) && (
                          <button
                            type="button"
                            onClick={() =>
                              setReplyingToCommentId((current) =>
                                current === item.id ? null : item.id,
                              )
                            }
                            className="text-xs font-medium text-blue-600 hover:text-blue-700"
                          >
                            {replyingToCommentId === item.id ? "Hide reply" : "Reply"}
                          </button>
                        )}
                      </div>
                    </div>
                    {canReplyToComment(item) && replyingToCommentId === item.id && (
                      <div className="mt-3 space-y-2">
                        <textarea
                          rows={3}
                          value={replyText[item.id] ?? ""}
                          onChange={(e) =>
                            setReplyText((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                          placeholder="Write your reply..."
                          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => submitCommentReply(item)}
                            disabled={replySubmittingId === item.id}
                            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {replySubmittingId === item.id ? "Sending..." : "Send reply"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setReplyingToCommentId(null)}
                            disabled={replySubmittingId === item.id}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
          </div>
        )}
      </div>
    </div>
  );
}
