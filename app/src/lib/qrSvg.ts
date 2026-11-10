import qrcode from "qrcode-generator";

/**
 * A QR code as an SVG string (2026-11-10: the "Get more reviews" panel and its
 * print card). Pure, so the same text always gives the same drawing.
 *
 * One unit of the viewBox is one cell; the SVG scales to whatever box holds it.
 * The quiet zone is the 4 empty cells the QR standard asks for around the code:
 * without it phone cameras often fail to find a code printed on a busy surface.
 * Error correction M (about 15% of the code can be lost) keeps a printed card
 * readable through a scratch while keeping the code small.
 */
export const QR_QUIET_ZONE = 4;

export function qrSvg(text: string): string {
  // Type 0 picks the smallest code that holds the text. UTF-8 bytes, so a link
  // with a non-ASCII character encodes as the phone will read it.
  const code = qrcode(0, "M");
  // The library's Byte mode takes one character per byte.
  const bytes = Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join("");
  code.addData(bytes, "Byte");
  code.make();

  const count = code.getModuleCount();
  const size = count + QR_QUIET_ZONE * 2;
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) cells.push(`M${col + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h1v1h-1z`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path fill="#000000" d="${cells.join("")}"/>` +
    `</svg>`
  );
}
