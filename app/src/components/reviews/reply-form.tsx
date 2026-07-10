import { Loader2, Star } from "lucide-react";

interface ReplyFormProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDraftAI: () => void;
  submitting: boolean;
  generatingAI: boolean;
}

/**
 * The expanded reply editor: a textarea plus "Draft AI Response", "Post Reply"
 * and "Cancel" actions.
 */
export function ReplyForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  onDraftAI,
  submitting,
  generatingAI,
}: ReplyFormProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-700">Your Reply</label>
        <button
          type="button"
          onClick={onDraftAI}
          disabled={generatingAI}
          className="inline-flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {generatingAI ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Star className="h-3 w-3 fill-purple-600" />
              Draft AI Response
            </>
          )}
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write your reply or use AI to draft one..."
        rows={4}
        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none resize-none"
      />
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Posting...
            </span>
          ) : (
            "Post Reply"
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
