import { put } from "@vercel/blob/client";

import { prepareUploadFile } from "@/lib/prepareUploadFile";
import { answerLostText } from "@/lib/answerLost";
import { dailyLimitSentence, limitWaitSeconds } from "@/lib/clientLinkLimit";
import { REVIEW_LINK_DAILY_LIMIT_REASON } from "@/lib/reviewLink";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";

/**
 * One file through a client upload link, in the browser (2026-11-10): prepared
 * as on Create (iPhone photos converted, big photos shrunk), uploaded straight
 * to file storage at the path the server signed, then registered. The type and
 * size are not sent: the server reads them from storage.
 *
 * The token is fetched here and the file sent with `put()`, not `upload()`:
 * `upload()` drops the body of a refused token request, and the client needs
 * the server's sentence (storage full, today's limit, link not active).
 */

export interface SendFileDeps {
  prepare: (file: File) => Promise<File>;
  put: (
    pathname: string,
    body: File,
    options: {
      access: "public";
      token: string;
      contentType: string;
      onUploadProgress: (event: { percentage: number }) => void;
    },
  ) => Promise<{ url: string }>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const browserDeps: SendFileDeps = {
  prepare: (file) => prepareUploadFile(file),
  put: (pathname, body, options) => put(pathname, body, options),
  fetch: (url, init) => fetchOrNoAnswer(url, init),
};

const UPLOAD_FAILED_MESSAGE = "The upload didn't finish. Check your connection and try again.";
/** R28 NN2: the file is in storage; only the answer to registering it was lost, so it may have arrived. */
export const CLIENT_FILE_MAYBE_ARRIVED_MESSAGE = answerLostText("the file may have arrived", "If you send it again, it may arrive twice.");

/**
 * Why a file did not arrive. "network": the request or the upload never got a
 * usable answer before the file was in storage, so nothing arrived and
 * retrying on a working connection may help. "refused": the server (link off,
 * storage full, today's limit) or the file itself said no, and the sentence
 * says why. "maybe" (R29 client-journey L1): the last step's answer was lost
 * or unreadable, so the file may have arrived and sending it again may make a
 * copy. Set where the failure is detected, so the upload page decides from the
 * kind and never from a sentence's words.
 */
export type ClientFileFailureKind = "network" | "refused" | "maybe";

export interface ClientFileFailure {
  kind: ClientFileFailureKind;
  message: string;
}

export class ClientFileError extends Error implements ClientFileFailure {
  constructor(
    readonly kind: ClientFileFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ClientFileError";
  }
}

type Lost = { kind: ClientFileFailureKind; message: string };
const NOTHING_ARRIVED: Lost = { kind: "network", message: UPLOAD_FAILED_MESSAGE };
const MAYBE_ARRIVED: Lost = { kind: "maybe", message: CLIENT_FILE_MAYBE_ARRIVED_MESSAGE };

/**
 * R45 pages-a L6: a limit's refusal, worded as /v's (clientLinkLimit) from
 * the answer's wait: the route's reason (its sentence without the last one,
 * "Try again tomorrow."), then the wait in minutes, or in hours from an hour
 * on. With no wait in the answer, the route's own sentence.
 */
export function uploadLimitText(routeSentence: string, waitSeconds: number | undefined): string {
  if (!waitSeconds) return routeSentence;
  const sentences = routeSentence.split(/(?<=\.)\s+/);
  const reason = sentences.length > 1 ? sentences.slice(0, -1).join(" ") : routeSentence;
  // dailyLimitSentence is the reason, then " Reload this page in <wait>.".
  return `${reason}${dailyLimitSentence(waitSeconds).slice(REVIEW_LINK_DAILY_LIMIT_REASON.length)}`;
}

/** A refused answer: the server's sentence; `fallback` when it gave none (a gateway error). */
async function failureOf(response: Response, fallback: Lost): Promise<ClientFileError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof body?.error !== "string" || !body.error) return new ClientFileError(fallback.kind, fallback.message);
  return new ClientFileError(
    "refused",
    response.status === 429 ? uploadLimitText(body.error, limitWaitSeconds(response, body)) : body.error,
  );
}

async function postJson(deps: SendFileDeps, url: string, body: unknown, lost: Lost = NOTHING_ARRIVED): Promise<Response> {
  try {
    return await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch throws only when no answer came back (offline, dropped connection,
    // or an unreadable 5xx once requestNoAnswer counts that as none).
    throw new ClientFileError(lost.kind, lost.message);
  }
}

/** Resolves once the file is in the library; throws a ClientFileError: its kind, and the sentence to show. */
export async function sendClientFile(
  input: {
    token: string;
    file: File;
    senderName: string;
    note: string;
    onProgress: (percentage: number) => void;
  },
  deps: SendFileDeps = browserDeps,
): Promise<void> {
  let prepared: File;
  try {
    prepared = await deps.prepare(input.file);
  } catch (error) {
    // The file itself was refused (a photo that cannot be converted, a type that is not accepted).
    throw new ClientFileError(
      "refused",
      error instanceof Error && error.message ? error.message : "This file can't be sent. Choose a photo or video.",
    );
  }
  const base = `/api/upload-link/${encodeURIComponent(input.token)}`;

  const tokenResponse = await postJson(deps, `${base}/upload`, {
    type: "blob.generate-client-token",
    payload: {
      pathname: prepared.name,
      clientPayload: JSON.stringify({ contentType: prepared.type, size: prepared.size }),
      multipart: false,
    },
  });
  if (!tokenResponse.ok) {
    throw await failureOf(tokenResponse, NOTHING_ARRIVED);
  }
  const issued = (await tokenResponse.json().catch(() => null)) as
    | { clientToken?: unknown; pathname?: unknown }
    | null;
  if (typeof issued?.clientToken !== "string" || typeof issued.pathname !== "string") {
    throw new ClientFileError("network", UPLOAD_FAILED_MESSAGE);
  }

  let blob: { url: string };
  try {
    blob = await deps.put(issued.pathname, prepared, {
      access: "public",
      token: issued.clientToken,
      contentType: prepared.type,
      onUploadProgress: (event) => input.onProgress(event.percentage),
    });
  } catch {
    throw new ClientFileError("network", UPLOAD_FAILED_MESSAGE);
  }

  const mediaResponse = await postJson(deps, `${base}/media`, {
    blobUrl: blob.url,
    filename: prepared.name,
    senderName: input.senderName,
    note: input.note,
  }, MAYBE_ARRIVED);
  if (!mediaResponse.ok) {
    // Lead review: an unreadable 5xx may come after the file was registered.
    throw await failureOf(
      mediaResponse,
      mediaResponse.status >= 500
        ? MAYBE_ARRIVED
        : { kind: "network", message: "Couldn't save the file. Check your connection and try again." },
    );
  }
}
