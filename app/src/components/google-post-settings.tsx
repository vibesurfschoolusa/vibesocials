"use client";

import { useState } from "react";

import { Card } from "@/components/ui/card";
import { CharacterCount } from "@/components/ui/character-count";
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
  changeGooglePostType,
  parseGooglePostMetadata,
  type GoogleButton,
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
 * R45 pages-b L1: a field longer than Google takes, counted trimmed as the
 * check (optionalText) counts, and its sentence; null while it fits.
 */
function tooLongText(text: string, label: string, max: number): string | null {
  return text.trim().length > max ? `The ${label} must be ${max.toLocaleString("en-US")} characters or fewer.` : null;
}

/**
 * The press half of CharacterCount's rule for this box: the Create form's
 * own submit is not this file's, so the browser's check refuses the press
 * while the field is over. It focuses the field and shows the box's sentence,
 * the box opens to it (GooglePostBox's onInvalidCapture), and nothing is sent.
 */
function refusedWhileOver(sentence: string | null) {
  return (field: HTMLInputElement | HTMLTextAreaElement | null) => {
    field?.setCustomValidity(sentence ?? "");
  };
}

/** The options with each counted field cut to its limit: what the alert line checks. */
function withinLimits(metadata: GoogleBusinessPostMetadata): GoogleBusinessPostMetadata {
  const fit = (text: string | undefined, max: number) => (text === undefined ? text : text.trim().slice(0, max));
  return {
    ...metadata,
    ...(metadata.event ? { event: { ...metadata.event, title: fit(metadata.event.title, GOOGLE_TITLE_MAX) ?? "" } } : {}),
    ...(metadata.offer
      ? {
          offer: {
            ...metadata.offer,
            title: fit(metadata.offer.title, GOOGLE_TITLE_MAX) ?? "",
            couponCode: fit(metadata.offer.couponCode, GOOGLE_COUPON_CODE_MAX),
            terms: fit(metadata.offer.terms, GOOGLE_TERMS_MAX),
          },
        }
      : {}),
  };
}

/** What Create's button does, as the count's hint says it. */
const ACTION = "post to Google";

/**
 * A Google Business Profile photo post's options (2026-11-10): an update, an
 * event or an offer, and a button. Only the chosen type's fields show. The
 * message under the fields is the same check POST /api/posts applies.
 */
export function GooglePostSettings({ metadata, onChange }: GooglePostSettingsProps) {
  // R45 lead review: a field over its limit is said by its count (and the
  // press refused by its validity), so the alert line keeps every other problem.
  const check = parseGooglePostMetadata(withinLimits(metadata));
  const event: EventFields = metadata.event ?? EMPTY_DATES;
  const offer: OfferFields = metadata.offer ?? EMPTY_DATES;
  const button = metadata.button;
  // The button an offer dropped, restored when the user switches back (changeGooglePostType).
  const [savedButton, setSavedButton] = useState<GoogleButton | undefined>(metadata.button);

  const setType = (postType: GooglePostType) => {
    const next = changeGooglePostType(metadata, postType, savedButton);
    setSavedButton(next.savedButton);
    onChange(next.metadata);
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
  const couponCode = offer.couponCode ?? "";
  const terms = offer.terms ?? "";

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
              ref={refusedWhileOver(tooLongText(event.title, "event title", GOOGLE_TITLE_MAX))}
              value={event.title}
              aria-describedby="google-event-title-count"
              onChange={(e) => setEvent({ title: e.target.value })}
            />
            <CharacterCount
              id="google-event-title-count"
              label="Event title"
              text={event.title}
              max={GOOGLE_TITLE_MAX}
              action={ACTION}
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
              ref={refusedWhileOver(tooLongText(offer.title, "offer title", GOOGLE_TITLE_MAX))}
              value={offer.title}
              aria-describedby="google-offer-title-count"
              onChange={(e) => setOffer({ title: e.target.value })}
            />
            <CharacterCount
              id="google-offer-title-count"
              label="Offer title"
              text={offer.title}
              max={GOOGLE_TITLE_MAX}
              action={ACTION}
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
              ref={refusedWhileOver(tooLongText(couponCode, "coupon code", GOOGLE_COUPON_CODE_MAX))}
              value={couponCode}
              aria-describedby="google-offer-coupon-count"
              onChange={(e) => setOffer({ couponCode: e.target.value || undefined })}
            />
            <CharacterCount
              id="google-offer-coupon-count"
              label="Coupon code"
              text={couponCode}
              max={GOOGLE_COUPON_CODE_MAX}
              action={ACTION}
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
              ref={refusedWhileOver(tooLongText(terms, "terms and conditions", GOOGLE_TERMS_MAX))}
              value={terms}
              aria-describedby="google-offer-terms-count"
              onChange={(e) => setOffer({ terms: e.target.value || undefined })}
            />
            <CharacterCount
              id="google-offer-terms-count"
              label="Terms and conditions"
              text={terms}
              max={GOOGLE_TERMS_MAX}
              action={ACTION}
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
