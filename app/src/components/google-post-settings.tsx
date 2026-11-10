"use client";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  GOOGLE_BUTTON_LABELS,
  GOOGLE_BUTTON_TYPES,
  GOOGLE_COUPON_CODE_MAX,
  GOOGLE_POST_TYPE_LABELS,
  GOOGLE_POST_TYPES,
  GOOGLE_TERMS_MAX,
  GOOGLE_TITLE_MAX,
  parseGooglePostMetadata,
  type GoogleButtonType,
  type GooglePostType,
} from "@/lib/googlePostOptions";
import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

interface GooglePostSettingsProps {
  metadata: GoogleBusinessPostMetadata;
  onChange: (metadata: GoogleBusinessPostMetadata) => void;
}

type EventFields = NonNullable<GoogleBusinessPostMetadata["event"]>;
type OfferFields = NonNullable<GoogleBusinessPostMetadata["offer"]>;

const EMPTY_DATES = { title: "", startDate: "", endDate: "" };

/**
 * A Google Business Profile photo post's options (2026-11-10): an update, an
 * event or an offer, and a button. Only the chosen type's fields show. The
 * message under the fields is the same check POST /api/posts applies.
 */
export function GooglePostSettings({ metadata, onChange }: GooglePostSettingsProps) {
  const check = parseGooglePostMetadata(metadata);
  const event: EventFields = metadata.event ?? EMPTY_DATES;
  const offer: OfferFields = metadata.offer ?? EMPTY_DATES;
  const button = metadata.button;

  const setType = (postType: GooglePostType) => {
    if (postType === "update") onChange({ postType, ...(metadata.button ? { button: metadata.button } : {}) });
    if (postType === "event") {
      onChange({ postType, event, ...(metadata.button ? { button: metadata.button } : {}) });
    }
    // Google ignores a button on an offer, so choosing an offer drops it.
    if (postType === "offer") onChange({ postType, offer });
  };
  const setButtonType = (value: string) => {
    if (!value) {
      onChange({ ...metadata, button: undefined });
      return;
    }
    const type = value as GoogleButtonType;
    onChange({ ...metadata, button: type === "CALL" ? { type } : { type, url: metadata.button?.url ?? "" } });
  };
  const setEvent = (fields: Partial<EventFields>) => onChange({ ...metadata, event: { ...event, ...fields } });
  const setOffer = (fields: Partial<OfferFields>) => onChange({ ...metadata, offer: { ...offer, ...fields } });

  return (
    <Card className="space-y-3 p-4">
      <div className="border-b border-border pb-2">
        <h3 className="text-sm font-semibold text-foreground">Google post settings</h3>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="google-post-type">Post type</Label>
        <Select
          id="google-post-type"
          value={metadata.postType}
          onChange={(e) => setType(e.target.value as GooglePostType)}
        >
          {GOOGLE_POST_TYPES.map((type) => (
            <option key={type} value={type}>
              {GOOGLE_POST_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </div>

      {metadata.postType === "event" ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="google-event-title">Event title</Label>
            <Input
              id="google-event-title"
              value={event.title}
              maxLength={GOOGLE_TITLE_MAX}
              onChange={(e) => setEvent({ title: e.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="google-event-start-date">Start date</Label>
              <Input
                id="google-event-start-date"
                type="date"
                value={event.startDate}
                onChange={(e) => setEvent({ startDate: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="google-event-start-time">Start time (optional)</Label>
              <Input
                id="google-event-start-time"
                type="time"
                value={event.startTime ?? ""}
                onChange={(e) => setEvent({ startTime: e.target.value || undefined })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="google-event-end-date">End date</Label>
              <Input
                id="google-event-end-date"
                type="date"
                value={event.endDate}
                onChange={(e) => setEvent({ endDate: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="google-event-end-time">End time (optional)</Label>
              <Input
                id="google-event-end-time"
                type="time"
                value={event.endTime ?? ""}
                onChange={(e) => setEvent({ endTime: e.target.value || undefined })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Times are the business&apos;s local time. An event without a start and end time lasts all day.
          </p>
        </div>
      ) : null}

      {metadata.postType === "offer" ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="google-offer-title">Offer title</Label>
            <Input
              id="google-offer-title"
              value={offer.title}
              maxLength={GOOGLE_TITLE_MAX}
              onChange={(e) => setOffer({ title: e.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="google-offer-start-date">Start date</Label>
              <Input
                id="google-offer-start-date"
                type="date"
                value={offer.startDate}
                onChange={(e) => setOffer({ startDate: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="google-offer-end-date">End date</Label>
              <Input
                id="google-offer-end-date"
                type="date"
                value={offer.endDate}
                onChange={(e) => setOffer({ endDate: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="google-offer-coupon">Coupon code (optional)</Label>
            <Input
              id="google-offer-coupon"
              value={offer.couponCode ?? ""}
              maxLength={GOOGLE_COUPON_CODE_MAX}
              onChange={(e) => setOffer({ couponCode: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="google-offer-redeem-url">Link to redeem online (optional)</Label>
            <Input
              id="google-offer-redeem-url"
              type="url"
              placeholder="https://"
              value={offer.redeemUrl ?? ""}
              onChange={(e) => setOffer({ redeemUrl: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="google-offer-terms">Terms and conditions (optional)</Label>
            <Textarea
              id="google-offer-terms"
              rows={3}
              value={offer.terms ?? ""}
              maxLength={GOOGLE_TERMS_MAX}
              onChange={(e) => setOffer({ terms: e.target.value || undefined })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            An offer runs for whole days. An offer can&apos;t have a button, so none is added.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="google-button-type">Button</Label>
          <Select
            id="google-button-type"
            value={metadata.button?.type ?? ""}
            onChange={(e) => setButtonType(e.target.value)}
          >
            <option value="">No button</option>
            {GOOGLE_BUTTON_TYPES.map((type) => (
              <option key={type} value={type}>
                {GOOGLE_BUTTON_LABELS[type]}
              </option>
            ))}
          </Select>
          {button && button.type !== "CALL" ? (
            <>
              <Label htmlFor="google-button-url">Button link</Label>
              <Input
                id="google-button-url"
                type="url"
                placeholder="https://"
                value={button.url ?? ""}
                onChange={(e) => onChange({ ...metadata, button: { type: button.type, url: e.target.value } })}
              />
            </>
          ) : null}
          {button?.type === "CALL" ? (
            <p className="text-xs text-muted-foreground">Calls the phone number on your Google listing.</p>
          ) : null}
        </div>
      )}

      {!check.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {check.error}
        </p>
      ) : null}
    </Card>
  );
}
