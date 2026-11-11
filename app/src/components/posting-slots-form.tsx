"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceRole } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { MAX_POSTING_SLOTS, normalizePostingSlots, type PostingSlot } from "@/lib/postingSlots";
import { localTimeZoneLabel } from "@/lib/scheduling";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The zone never changes while the page is open; the server has none to give.
const noSubscription = () => () => {};

interface Row extends PostingSlot {
  key: number;
}

/**
 * Settings: the workspace's usual posting times (brief 11). The Create page's
 * "Next free slot" and the add-many page's "Use my posting times" read them.
 * Owners edit; members see them read-only.
 */
export function PostingSlotsForm({ slots, role }: { slots: PostingSlot[]; role: WorkspaceRole }) {
  const router = useRouter();
  const toast = useToast();
  const isOwner = role === "owner";
  const [rows, setRows] = useState<Row[]>(() => slots.map((slot, key) => ({ ...slot, key })));
  const [nextKey, setNextKey] = useState(slots.length);
  const [saving, setSaving] = useState(false);
  const zone = useSyncExternalStore(noSubscription, localTimeZoneLabel, () => null);

  const zoneLine = `Times are in your own time zone (${zone ?? "your browser's"}).`;

  if (!isOwner) {
    return (
      <Card className="p-6">
        {slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posting times are saved. An owner can add them.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-foreground">
            {slots.map((slot) => (
              <li key={`${slot.day}-${slot.time}`}>
                {WEEKDAYS[slot.day]} at {slot.time}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm text-muted-foreground">{zoneLine}</p>
      </Card>
    );
  }

  const update = (key: number, change: Partial<PostingSlot>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const addRow = () => {
    setRows((current) => [...current, { day: 1, time: "09:00", key: nextKey }]);
    setNextKey((key) => key + 1);
  };

  const save = async () => {
    const checked = normalizePostingSlots(rows.map(({ day, time }) => ({ day, time })));
    if (!checked.ok) {
      toast.error(checked.error);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postingSlots: checked.slots }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        postingSlots?: PostingSlot[];
      };
      if (!response.ok) {
        toast.error(body.error ?? "Couldn't save the posting times. Try again.");
        return;
      }
      // Show them as stored: sorted, duplicates dropped.
      const stored = body.postingSlots ?? checked.slots;
      setRows(stored.map((slot, key) => ({ ...slot, key })));
      setNextKey(stored.length);
      toast.success("Posting times saved.");
      router.refresh();
    } catch {
      toast.error("Couldn't save the posting times. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posting times yet. Add the times you usually post.</p>
        ) : null}
        {rows.map((row) => (
          <div key={row.key} className="flex flex-wrap items-center gap-2">
            <div className="w-40">
              <Select
                aria-label="Weekday"
                value={String(row.day)}
                onChange={(e) => update(row.key, { day: Number(e.target.value) })}
              >
                {WEEKDAYS.map((name, day) => (
                  <option key={name} value={day}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <Input
              type="time"
              aria-label="Time"
              className="w-32"
              value={row.time}
              onChange={(e) => update(row.key, { time: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            >
              Remove
            </Button>
          </div>
        ))}
        <p className="text-sm text-muted-foreground">{zoneLine}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={rows.length >= MAX_POSTING_SLOTS}
          >
            Add a time
          </Button>
          <Button type="button" size="sm" onClick={save} loading={saving}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}
