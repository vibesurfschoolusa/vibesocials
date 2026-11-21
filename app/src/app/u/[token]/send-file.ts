import { put } from "@vercel/blob/client";

import { PrepareFileError, prepareUploadFile, type PrepareUploadDeps } from "@/lib/prepareUploadFile";
import { answerLostText } from "@/lib/answerLost";
import { waitSecondsOf, waitText } from "@/lib/tooManyTriesText";
import {
  UPLOAD_LINK_BYTES_LIMIT_MESSAGE,
  UPLOAD_LINK_BYTES_LIMIT_REASON,
  UPLOAD_LINK_BYTES_PAST_START,
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_DAILY_LIMIT_REASON,
  UPLOAD_LINK_IP_LIMIT_MESSAGE,
  UPLOAD_LINK_IP_LIMIT_REASON,
} from "@/lib/uploadLink";
import { fetchOrNoAnswer, isNoAnswer, isNoConnection } from "@/lib/requestNoAnswer";
import {
  UPLOAD_STORAGE_REFUSED_MESSAGE,
  UPLOAD_STORAGE_TOO_LARGE_MESSAGE,
  isStorageRefusal,
  isStorageTooLarge,
} from "@/lib/uploadFailure";

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

/** Prepared as on Create, with the steps of a refused file naming /u's Send more. `deps` for tests. */
export function prepareLinkFile(file: File, deps?: PrepareUploadDeps): Promise<File> {
  return prepareUploadFile(file, deps, "sendMore");
}

const browserDeps: SendFileDeps = {
  prepare: (file) => prepareLinkFile(file),
  put: (pathname, body, options) => put(pathname, body, options),
  fetch: (url, init) => fetchOrNoAnswer(url, init),
};

/** R48 client-journey L1: a preparation error that isn't prepareUploadFile's own sentence, whose words are never shown. */
const NOT_PREPARED_MESSAGE =
  "We couldn't get this file ready to send. Save it as a JPEG photo or an MP4 video, then press Send more and choose it again.";
const UPLOAD_FAILED_MESSAGE = "The upload didn't finish. Check your connection and try again.";
/**
 * R53 pages-a L1: a 5xx the page can't read (a database error's empty 500, a
 * gateway's 502 or 504) came over a working connection, so it never names it.
 */
const UPLOAD_FAILED_OUR_SIDE_MESSAGE = "The upload didn't finish: something went wrong on our side. Try again in a minute.";
/** R28 NN2: the file is in storage; only the answer to registering it was lost, so it may have arrived. */
export const CLIENT_FILE_MAYBE_ARRIVED_MESSAGE = answerLostText("the file may have arrived", "If you send it again, it may arrive twice.");

/**
 * Why a file did not arrive. "network": the request or the upload never got a
 * usable answer before the file was in storage, so nothing arrived and
 * retrying on a working connection may help. "refused": the server (link off,
 * storage full, today's limit) said no, and the sentence says why. "file"
 * (R47 client-journey L1): the file itself was refused before sending (its
 * type, a HEIC that won't convert, a photo too large to send that can't be
 * made smaller); the same File is refused again, so it is
 * never retried and the sentence names the step that works. "maybe" (R29 client-journey L1): the last step's answer was lost
 * or unreadable, so the file may have arrived and sending it again may make a
 * copy. Set where the failure is detected, so the upload page decides from the
 * kind and never from a sentence's words.
 */
export type ClientFileFailureKind = "network" | "refused" | "file" | "maybe";

export interface ClientFileFailure {
  kind: ClientFileFailureKind;
  message: string;
  /**
   * R53 pages-a L1: a "network" failure whose answer came, unreadable, from
   * our side, so the summary leaves the connection out. Set only when true.
   */
  ourSide?: true;
}

export class ClientFileError extends Error {
  constructor(
    readonly kind: ClientFileFailureKind,
    message: string,
    readonly ourSide = false,
  ) {
    super(message);
    this.name = "ClientFileError";
  }
}

type Lost = { kind: ClientFileFailureKind; message: string; ourSide?: boolean };
const NOTHING_ARRIVED: Lost = { kind: "network", message: UPLOAD_FAILED_MESSAGE };
const NOTHING_ARRIVED_OUR_SIDE: Lost = { kind: "network", message: UPLOAD_FAILED_OUR_SIDE_MESSAGE, ourSide: true };
const MAYBE_ARRIVED: Lost = { kind: "maybe", message: CLIENT_FILE_MAYBE_ARRIVED_MESSAGE };

/** Each limit the upload routes refuse with, by its sentence: its reason. */
const LIMIT_REASONS: ReadonlyMap<string, string> = new Map([
  [UPLOAD_LINK_IP_LIMIT_MESSAGE, UPLOAD_LINK_IP_LIMIT_REASON],
  [UPLOAD_LINK_DAILY_LIMIT_MESSAGE, UPLOAD_LINK_DAILY_LIMIT_REASON],
  [UPLOAD_LINK_BYTES_LIMIT_MESSAGE, UPLOAD_LINK_BYTES_LIMIT_REASON],
]);

/** The "used up" sentence's last part, which the "past 20 GB" sentence ends with too. */
const BYTES_LIMIT_NEXT = UPLOAD_LINK_BYTES_LIMIT_MESSAGE.slice(UPLOAD_LINK_BYTES_LIMIT_REASON.length);

/**
 * R63 client-journey L1: a limit's reason. The "past 20 GB" sentence names the
 * size that can still go, so it is known by how it starts and ends.
 */
function limitReasonOf(routeSentence: string): string | undefined {
  const reason = LIMIT_REASONS.get(routeSentence);
  if (reason) return reason;
  if (routeSentence.startsWith(UPLOAD_LINK_BYTES_PAST_START) && routeSentence.endsWith(BYTES_LIMIT_NEXT)) {
    return routeSentence.slice(0, -BYTES_LIMIT_NEXT.length);
  }
  return undefined;
}

/**
 * R45 pages-a L6, lead review: a limit's refusal names the answer's real wait
 * (the routes' "tomorrow" is a UTC day), then the step that keeps the
 * client's work: the form's "Try the files that didn't send" button keeps
 * the files, the name and the note, where a reload would empty them. Another
 * refusal keeps the route's sentence.
 */
export function uploadLimitText(routeSentence: string, waitSeconds: number | undefined): string {
  const reason = limitReasonOf(routeSentence);
  if (!reason) return routeSentence;
  return waitSeconds
    ? `${reason} Wait ${waitText(waitSeconds)}, then try the files that didn't send.`
    : `${reason} Try the files that didn't send again later.`;
}

/** A refused answer: the server's sentence; `fallback` when it gave none (a gateway error). */
async function failureOf(response: Response, fallback: Lost): Promise<ClientFileError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof body?.error !== "string" || !body.error) return new ClientFileError(fallback.kind, fallback.message, fallback.ourSide);
  return new ClientFileError(
    "refused",
    response.status === 429 ? uploadLimitText(body.error, waitSecondsOf(body, response.headers.get("Retry-After"))) : body.error,
  );
}

async function postJson(deps: SendFileDeps, url: string, body: unknown, lost: Lost = NOTHING_ARRIVED): Promise<Response> {
  try {
    return await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // fetch throws only when no answer came back (offline, dropped connection,
    // or an unreadable 5xx once requestNoAnswer counts that as none). Before
    // the upload, an unreadable answer was our server's, not the connection.
    if (lost === NOTHING_ARRIVED && isNoAnswer(error) && !isNoConnection(error)) {
      throw new ClientFileError("network", UPLOAD_FAILED_OUR_SIDE_MESSAGE, true);
    }
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
    // The file itself was refused (a photo that cannot be converted, a type that is not accepted),
    // or, R48 client-journey L1, the HEIC converter didn't download: "network", so the retry is offered.
    if (error instanceof PrepareFileError) throw new ClientFileError(error.kind, error.message);
    throw new ClientFileError("file", NOT_PREPARED_MESSAGE);
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
    throw await failureOf(tokenResponse, tokenResponse.status >= 500 ? NOTHING_ARRIVED_OUR_SIDE : NOTHING_ARRIVED);
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
  } catch (error) {
    // R53 pages-a L2: storage itself answered and refused (lib/uploadFailure.ts):
    // our side, not the connection. Still "network", so Retry stays.
    // A refusal for the file's size is refused on every try: the file's own kind, no retry.
    if (isStorageTooLarge(error)) throw new ClientFileError("file", UPLOAD_STORAGE_TOO_LARGE_MESSAGE);
    if (isStorageRefusal(error)) throw new ClientFileError("network", UPLOAD_STORAGE_REFUSED_MESSAGE, true);
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
